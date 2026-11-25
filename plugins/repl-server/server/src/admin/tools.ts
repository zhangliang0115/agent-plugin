/** Admin API for the tool catalog: per-server effective tools, overrides and search preview.
 *
 * Routes:
 * - `GET /servers/:id/tools` — upstream + effective values (description override, union tags)
 * - `PATCH /tools/:serverId/:name` — description/enabled/concurrency/tags/type/category
 * - `POST /tools/batch` — one transaction, one revision bump
 * - `GET /search` — same retriever as `search_tools`, optionally filtered by a binding
 * - `POST /tools/:serverId/:name/test` — real one-off call, audited but never counted as usage
 *
 * Catalog writes require `If-Match: <meta.revision>`; a mismatch is a 409
 * `REVISION_CONFLICT`. The `description` field writes `description_override`, never the
 * upstream `description`.
 * @module
 */

import {
  AdminApiError,
  adminHandler,
  adminJson,
  assertRevision,
  BUILTIN_SERVER_ID,
  expectBoolean,
  expectInteger,
  expectString,
  expectStringArray,
  invalidField,
  isPlainObject,
  OFFICIAL_SERVER_ID,
  parseIfMatch,
  queryValue,
  rejectUnknownFields,
  requestSegments,
  readJsonBody,
  requireObjectBody,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
  type ServerRecord,
  type ServerStore,
} from './servers.ts';
import { evaluateTagPolicy, formatTagPolicyIssues } from '../catalog/tag-policy.ts';
import type { CatalogTool, OfficialToolsSync } from '../ports.ts';
import { toItem } from '../tools/search.ts';

export type ToolConcurrency = 'parallel' | 'serial' | 'exclusive';

/** One row of the `tools` table, decoded to API shape. */
export interface ToolRecord {
  serverId: string;
  name: string;
  displayName: string | null;
  description: string | null;
  descriptionOverride: string | null;
  enabled: boolean;
  concurrency: ToolConcurrency;
  type: string | null;
  tags: string[];
  category: string | null;
  schema: unknown;
  /** `search` rows come from lazy-load scans; only those are warmed before a call. */
  discoveredVia: 'static' | 'search';
  stale: boolean;
  staleOverride: boolean;
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** Lifetime `tool_result` counters from `tool_usage`. */
  callCount: number;
  successCount: number;
  /** `successCount / callCount`, null until the first call. */
  successRate: number | null;
  lastCalledAt: string | null;
}

/** UTF-8 byte sizes of what the model can see for one tool; not token counts. */
export interface ToolModelBytes {
  /** `JSON.stringify` of the whole tool definition (name + description + inputSchema). */
  definition: number;
  /** `JSON.stringify` of the item `search_tools` returns for this tool. */
  searchItem: number;
  /** `JSON.stringify(inputSchema ?? {})`. */
  schema: number;
  /** Effective description string (override applied). */
  description: number;
}

/** Fields an admin may patch. `description` is the override, not the upstream text. */
export interface ToolPatch {
  description?: string | null;
  enabled?: boolean;
  concurrency?: ToolConcurrency;
  tags?: string[];
  type?: string | null;
  category?: string | null;
  staleOverride?: boolean;
}

export interface ToolUpdate {
  serverId: string;
  name: string;
  patch: ToolPatch;
}

/** Persistence contract implemented by RS-02/RS-04. */
export interface ToolStore {
  listByServer(serverId: string): Promise<ToolRecord[]>;
  get(serverId: string, name: string): Promise<ToolRecord | null>;
  revision(): Promise<number>;
  update(
    serverId: string,
    name: string,
    patch: ToolPatch,
    expectedRevision: number,
  ): Promise<{ tool: ToolRecord; revision: number }>;
  /** All-or-nothing; refreshes `index_*` and bumps `meta.revision` once. */
  batch(
    updates: ToolUpdate[],
    expectedRevision: number,
  ): Promise<{ tools: ToolRecord[]; revision: number }>;
}

export interface SearchPreviewInput {
  query: string;
  server?: string;
  category?: string;
  tag?: string;
  type?: string;
  max: number;
  /** When present, results are filtered by that binding's visibility; absent means admin view. */
  bindingId?: string;
}

export interface SearchPreviewResult {
  results: unknown[];
  notice?: string;
}

/** Implemented by the RS-05 retriever. */
export interface SearchPreview {
  search(input: SearchPreviewInput): Promise<SearchPreviewResult> | SearchPreviewResult;
}

/** One real tool call requested from the admin surface; no eval or binding owns it. */
export interface ToolTestCall {
  serverId: string;
  name: string;
  args: Record<string, unknown>;
  /** Aborted when the admin request's budget runs out. */
  signal: AbortSignal;
  /** Absolute epoch-ms deadline matching `signal`; the executor shortens to it. */
  deadline: number;
}

/** Response body of `POST /tools/:serverId/:name/test`. Failures stay HTTP 200. */
export interface ToolTestResult {
  ok: boolean;
  /** Raw tool value; omitted when the serialized result exceeded the preview budget. */
  result?: unknown;
  /** Unified failure code: `TOOL_TEST_TIMEOUT` or `TOOL_CALL_FAILED`. */
  error?: { code: string; message: string };
  durationMs: number;
  /** ISO 8601 start time of the call. */
  testedAt: string;
  /** UTF-8 bytes of `JSON.stringify(result)`, present on success only. */
  resultBytes?: number;
  /** `true` when `result` was replaced by `resultPreview`. */
  truncated?: boolean;
  /** First {@link TOOL_TEST_RESULT_LIMIT_BYTES} UTF-8 bytes of the serialized result. */
  resultPreview?: string;
}

export interface AdminToolsDeps {
  servers: ServerStore;
  tools: ToolStore;
  retrieval: SearchPreview;
  /**
   * Lazy `__official__` tool sync. `GET /servers/__official__/tools` calls
   * `ensure()` before listing; without it the route only reads stored rows.
   */
  official?: OfficialToolsSync;
  /**
   * Runs a real tool call for the admin test route. Wired to the same transport
   * the gateway uses, but outside the gateway: no `tool_result` is emitted, so
   * `tool_usage` keeps counting model/script calls only. Absent means 503.
   */
  testTool?: (call: ToolTestCall) => Promise<unknown>;
  /** Audit sink; the handler emits one `tool_test` event per executed call. */
  audit?: (event: Record<string, unknown> & { event: string }) => void;
}

const TOOL_PATCH_FIELDS: ReadonlySet<string> = new Set([
  'description',
  'enabled',
  'concurrency',
  'tags',
  'type',
  'category',
  'staleOverride',
]);

const CONCURRENCY_VALUES: ReadonlySet<string> = new Set(['parallel', 'serial', 'exclusive']);

/** Admin test defaults and hard ceiling; the request must never hang past the latter. */
const TOOL_TEST_DEFAULT_TIMEOUT_MS = 10_000;
const TOOL_TEST_MAX_TIMEOUT_MS = 60_000;
/** Larger results are previewed instead of returned: base64 media would blow up the page. */
const TOOL_TEST_RESULT_LIMIT_BYTES = 1024 * 1024;

const TOOL_TEST_FIELDS: ReadonlySet<string> = new Set(['args', 'timeoutMs']);

/** Raised by our own deadline; the pool's `MCP_CALL_TIMEOUT` means the same thing. */
class ToolTestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`tool test timed out after ${timeoutMs}ms`);
    this.name = 'ToolTestTimeoutError';
  }
}

function parseToolTestBody(request: AdminRequest): {
  args: Record<string, unknown>;
  timeoutMs: number;
} {
  const raw = readJsonBody(request);
  const body = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(body)) {
    throw new AdminApiError(400, 'INVALID_BODY', 'request body must be a JSON object');
  }
  rejectUnknownFields(body, TOOL_TEST_FIELDS);

  let args: Record<string, unknown> = {};
  if (body['args'] !== undefined) {
    if (!isPlainObject(body['args'])) {
      throw invalidField('args', 'must be a JSON object');
    }
    args = body['args'];
  }
  const timeoutMs =
    body['timeoutMs'] === undefined
      ? TOOL_TEST_DEFAULT_TIMEOUT_MS
      : expectInteger(body['timeoutMs'], 'timeoutMs', {
          min: 1,
          max: TOOL_TEST_MAX_TIMEOUT_MS,
        });
  return { args, timeoutMs };
}

/**
 * Bounds the whole call, not just the transport: a runtime that ignores the
 * signal still cannot hold the admin request open.
 */
function runWithDeadline<T>(
  run: (signal: AbortSignal, deadline: number) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ToolTestTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([run(controller.signal, deadline), expired]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isPlainObject(error) && typeof error['message'] === 'string') return error['message'];
  return String(error);
}

function isTimeoutFailure(error: unknown): boolean {
  if (error instanceof ToolTestTimeoutError) return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  if (
    (error instanceof Error || isPlainObject(error)) &&
    (error as { code?: unknown }).code === 'MCP_CALL_TIMEOUT'
  ) {
    return true;
  }
  return error instanceof Error && error.message.startsWith('serve request timed out:');
}

function toToolTestError(error: unknown): { code: string; message: string } {
  return {
    code: isTimeoutFailure(error) ? 'TOOL_TEST_TIMEOUT' : 'TOOL_CALL_FAILED',
    message: errorMessageOf(error),
  };
}

/** `result` can be `undefined`; serializing it as `null` keeps the byte count honest. */
function serializeToolResult(value: unknown): { text: string; bytes: number } {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    // Circular or BigInt values never come from JSON-RPC, but must not fail the response.
    text = JSON.stringify(String(value));
  }
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Cuts to at most `limit` UTF-8 bytes without leaving a split code point behind. */
function previewOf(text: string, limit: number): string {
  const buffer = Buffer.from(text, 'utf8');
  let end = limit;
  let preview = buffer.toString('utf8', 0, end);
  while (end > 0 && Buffer.byteLength(preview, 'utf8') > limit) {
    end -= 1;
    preview = buffer.toString('utf8', 0, end);
  }
  return preview;
}

function readConcurrency(value: unknown): ToolConcurrency {
  if (typeof value !== 'string' || !CONCURRENCY_VALUES.has(value)) {
    throw invalidField('concurrency', 'must be "parallel", "serial" or "exclusive"');
  }
  return value as ToolConcurrency;
}

function parseToolPatch(value: unknown): ToolPatch {
  if (!isPlainObject(value)) {
    throw new AdminApiError(400, 'INVALID_BODY', 'patch must be a JSON object', {
      field: 'patch',
    });
  }
  rejectUnknownFields(value, TOOL_PATCH_FIELDS);

  const patch: ToolPatch = {};
  if ('description' in value) {
    patch.description =
      value['description'] === null
        ? null
        : expectString(value['description'], 'description', {
            allowEmpty: true,
            max: 8192,
          });
  }
  if ('enabled' in value) patch.enabled = expectBoolean(value['enabled'], 'enabled');
  if ('concurrency' in value) patch.concurrency = readConcurrency(value['concurrency']);
  if ('tags' in value) {
    patch.tags = expectStringArray(value['tags'], 'tags', { maxLength: 64 });
  }
  if ('type' in value) {
    patch.type =
      value['type'] === null ? null : expectString(value['type'], 'type', { max: 64 });
  }
  if ('category' in value) {
    patch.category =
      value['category'] === null
        ? null
        : expectString(value['category'], 'category', { max: 128 });
  }
  if ('staleOverride' in value) {
    patch.staleOverride = expectBoolean(value['staleOverride'], 'staleOverride');
  }

  if (Object.keys(patch).length === 0) {
    throw new AdminApiError(422, 'EMPTY_PATCH', 'patch does not change any field');
  }
  return patch;
}

function effectiveTags(server: ServerRecord, tool: ToolRecord): string[] {
  return [...new Set([...server.tags, ...tool.tags])];
}

/**
 * Sizes the model-visible payloads. `searchItem` goes through `search_tools`'
 * own `toItem`, and category/summary/name follow the catalog snapshot rules
 * (server-level category/summary, bare names for `builtin` transports).
 */
function modelBytesOf(tool: ToolRecord, server: ServerRecord): ToolModelBytes {
  const schema = tool.schema ?? {};
  const description = tool.descriptionOverride ?? tool.description ?? '';
  const builtin = server.transport === 'builtin';
  const modelName = builtin ? tool.name : `${server.id}.${tool.name}`;
  const catalogTool: CatalogTool = {
    name: tool.name,
    kind: builtin ? 'builtin' : 'mcp',
    description,
    tags: effectiveTags(server, tool),
    inputSchema: schema,
    concurrency: tool.concurrency,
    enabled: tool.enabled,
  };
  if (!builtin) catalogTool.server = server.id;
  if (server.category !== null && server.category !== '') {
    catalogTool.category = server.category;
  }
  if (server.summary !== null && server.summary !== '') catalogTool.summary = server.summary;
  return {
    definition: Buffer.byteLength(
      JSON.stringify({ name: modelName, description, inputSchema: schema }),
      'utf8',
    ),
    searchItem: Buffer.byteLength(JSON.stringify(toItem(catalogTool, modelName)), 'utf8'),
    schema: Buffer.byteLength(JSON.stringify(schema), 'utf8'),
    description: Buffer.byteLength(description, 'utf8'),
  };
}

/** Rejects a tool patch that would break the descriptive-tag policy. */
function assertToolTagPolicy(server: ServerRecord, tool: ToolRecord, patch: ToolPatch): void {
  // A pure metadata edit cannot change the tag state; only tag writes and
  // re-enabling a tool need the check.
  if (patch.tags === undefined && patch.enabled !== true) return;
  const tags = patch.tags ?? tool.tags;
  const issues = evaluateTagPolicy(server.tags, tags).issues;
  if (issues.length === 0) return;
  throw new AdminApiError(
    422,
    'TAG_POLICY_VIOLATION',
    `tool ${tool.name} violates the tag policy`,
    {
      serverId: server.id,
      tool: tool.name,
      errors: formatTagPolicyIssues(issues),
    },
  );
}

/** Raw row plus the values the executor actually sees. */
function viewTool(tool: ToolRecord, server: ServerRecord): Record<string, unknown> {
  const description = tool.descriptionOverride ?? tool.description;
  return {
    ...tool,
    modelBytes: modelBytesOf(tool, server),
    effective: {
      description,
      enabled: tool.enabled,
      concurrency: tool.concurrency,
      tags: effectiveTags(server, tool),
      category: tool.category ?? server.category,
      stale: tool.stale,
      // Mirrors the executor gates: server enabled, tool enabled, stale blocks `search`
      // rows even when the administrator set `staleOverride` (design 07 §4.7).
      // `__builtin__` rows are display-only until composite tools get an executor.
      exposed:
        server.id !== BUILTIN_SERVER_ID &&
        server.enabled &&
        tool.enabled &&
        (!tool.stale || (tool.staleOverride && tool.discoveredVia !== 'search')),
    },
  };
}

function readSearchInput(request: AdminRequest): SearchPreviewInput {
  const rawMax = queryValue(request, 'max');
  let max = 10;
  if (rawMax !== null && rawMax !== '') {
    const parsed = Number(rawMax);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
      throw new AdminApiError(400, 'INVALID_QUERY', 'max must be an integer between 1 and 50', {
        parameter: 'max',
      });
    }
    max = parsed;
  }

  const optional = (name: string): string | undefined => {
    const value = queryValue(request, name);
    return value === null || value === '' ? undefined : value;
  };

  const input: SearchPreviewInput = {
    query: queryValue(request, 'q') ?? queryValue(request, 'query') ?? '',
    max,
  };

  const server = optional('server');
  if (server !== undefined) input.server = server;
  const category = optional('category');
  if (category !== undefined) input.category = category;
  const tag = optional('tag');
  if (tag !== undefined) input.tag = tag;
  const type = optional('type');
  if (type !== undefined) input.type = type;
  const binding = optional('binding');
  if (binding !== undefined) input.bindingId = binding;

  return input;
}

function assertServerExists(server: ServerRecord | null, serverId: string): ServerRecord {
  if (server === null) {
    throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${serverId} does not exist`, {
      serverId,
    });
  }
  return server;
}

function assertToolExists(tool: ToolRecord | null, serverId: string, name: string): ToolRecord {
  if (tool === null) {
    throw new AdminApiError(404, 'TOOL_NOT_FOUND', `tool ${serverId}/${name} does not exist`, {
      serverId,
      tool: name,
    });
  }
  return tool;
}

/**
 * `GET /servers/:id/tools`, `PATCH /tools/:serverId/:name`, `POST /tools/batch`
 * and `GET /search`.
 */
export function createAdminToolsHandler(deps: AdminToolsDeps): AdminHandler {
  async function listTools(serverId: string): Promise<AdminResponse> {
    const server = assertServerExists(await deps.servers.get(serverId), serverId);
    let notice: string | undefined;
    // First visit lists the official tools from `claude mcp serve`; the outcome
    // is cached per process. The explicit refresh route is the retry path.
    if (server.id === OFFICIAL_SERVER_ID && server.enabled && deps.official !== undefined) {
      try {
        const outcome = await deps.official.ensure();
        notice = outcome.notice;
      } catch (error) {
        // The GET contract stays 200 even when a sync implementation fails.
        notice = `官方工具同步失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const [tools, revision] = await Promise.all([
      deps.tools.listByServer(serverId),
      deps.tools.revision(),
    ]);

    const body: Record<string, unknown> = {
      server: {
        id: server.id,
        label: server.label,
        enabled: server.enabled,
        tags: server.tags,
        category: server.category,
        summary: server.summary,
      },
      tools: tools.map((tool) => viewTool(tool, server)),
      revision,
    };
    if (notice !== undefined) body['notice'] = notice;
    return adminJson(200, body);
  }

  async function patchTool(
    serverId: string,
    name: string,
    request: AdminRequest,
  ): Promise<AdminResponse> {
    const expected = parseIfMatch(request);
    const server = assertServerExists(await deps.servers.get(serverId), serverId);
    const current = assertToolExists(await deps.tools.get(serverId, name), serverId, name);

    // Validate the patch before the precondition so malformed bodies always get 400/422.
    const patch = parseToolPatch(requireObjectBody(request));
    assertToolTagPolicy(server, current, patch);
    assertRevision(await deps.tools.revision(), expected);
    const { tool, revision } = await deps.tools.update(serverId, name, patch, expected);

    return adminJson(200, { tool: viewTool(tool, server), revision });
  }

  async function batchTools(request: AdminRequest): Promise<AdminResponse> {
    const expected = parseIfMatch(request);
    const body = requireObjectBody(request);
    rejectUnknownFields(body, new Set(['updates']));

    const rawUpdates = body['updates'];
    if (!Array.isArray(rawUpdates)) {
      throw invalidField('updates', 'must be an array');
    }
    if (rawUpdates.length === 0) {
      throw new AdminApiError(422, 'EMPTY_PATCH', 'updates must contain at least one entry');
    }
    if (rawUpdates.length > 100) {
      throw invalidField('updates', 'must have at most 100 entries');
    }

    const updates: ToolUpdate[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < rawUpdates.length; index += 1) {
      const entry = rawUpdates[index];
      if (!isPlainObject(entry)) {
        throw invalidField(`updates[${index}]`, 'must be an object');
      }
      rejectUnknownFields(entry, new Set(['serverId', 'name', 'patch']));

      const serverId = expectString(entry['serverId'], `updates[${index}].serverId`, {
        max: 64,
      });
      const name = expectString(entry['name'], `updates[${index}].name`, { max: 256 });
      const key = `${serverId}\u0000${name}`;
      if (seen.has(key)) {
        throw new AdminApiError(
          422,
          'DUPLICATE_UPDATE',
          `duplicate update for ${serverId}/${name}`,
          { serverId, tool: name },
        );
      }
      seen.add(key);

      updates.push({ serverId, name, patch: parseToolPatch(entry['patch']) });
    }

    const servers = new Map<string, ServerRecord>();
    for (const serverId of new Set(updates.map((update) => update.serverId))) {
      servers.set(serverId, assertServerExists(await deps.servers.get(serverId), serverId));
    }
    for (const update of updates) {
      const server = servers.get(update.serverId);
      if (server === undefined) {
        throw new AdminApiError(
          500,
          'INTERNAL_ERROR',
          `batch update for unknown server ${update.serverId}`,
        );
      }
      const current = assertToolExists(
        await deps.tools.get(update.serverId, update.name),
        update.serverId,
        update.name,
      );
      assertToolTagPolicy(server, current, update.patch);
    }

    assertRevision(await deps.tools.revision(), expected);
    const { tools, revision } = await deps.tools.batch(updates, expected);

    return adminJson(200, {
      tools: tools.map((tool) => {
        const server = servers.get(tool.serverId);
        if (server === undefined) {
          throw new AdminApiError(
            500,
            'INTERNAL_ERROR',
            `batch returned tool for unknown server ${tool.serverId}`,
          );
        }
        return viewTool(tool, server);
      }),
      revision,
    });
  }

  async function searchPreview(request: AdminRequest): Promise<AdminResponse> {
    const input = readSearchInput(request);
    const result = await deps.retrieval.search(input);

    const body: Record<string, unknown> = {
      query: input.query,
      count: result.results.length,
      results: result.results,
    };
    if (result.notice !== undefined) body['notice'] = result.notice;
    if (input.bindingId !== undefined) body['binding'] = input.bindingId;

    return adminJson(200, body);
  }

  /**
   * One real call, deliberately outside the eval gateway: no `tool_result`, so
   * lifetime `tool_usage` counts only model/script traffic (the `tool_test`
   * audit event carries the admin-call history instead).
   */
  async function testTool(
    serverId: string,
    name: string,
    request: AdminRequest,
  ): Promise<AdminResponse> {
    const input = parseToolTestBody(request);
    const server = assertServerExists(await deps.servers.get(serverId), serverId);
    assertToolExists(await deps.tools.get(serverId, name), serverId, name);
    if (server.id === BUILTIN_SERVER_ID) {
      throw new AdminApiError(
        400,
        'TOOL_TEST_UNSUPPORTED',
        `built-in tool ${name} has no reusable pool/serve execution path`,
        { serverId, tool: name },
      );
    }
    const execute = deps.testTool;
    if (execute === undefined) {
      throw new AdminApiError(
        503,
        'TOOL_TEST_UNAVAILABLE',
        'tool testing is not wired on this server',
      );
    }

    const startedAt = Date.now();
    const testedAt = new Date(startedAt).toISOString();
    let ok = false;
    let result: unknown;
    let failure: { code: string; message: string } | undefined;
    try {
      result = await runWithDeadline(
        (signal, deadline) =>
          execute({ serverId, name, args: input.args, signal, deadline }),
        input.timeoutMs,
      );
      ok = true;
    } catch (error) {
      failure = toToolTestError(error);
    }
    const durationMs = Date.now() - startedAt;

    const body: ToolTestResult = { ok, durationMs, testedAt };
    let resultBytes: number | undefined;
    if (ok) {
      const serialized = serializeToolResult(result);
      resultBytes = serialized.bytes;
      body.resultBytes = resultBytes;
      if (resultBytes > TOOL_TEST_RESULT_LIMIT_BYTES) {
        body.truncated = true;
        body.resultPreview = previewOf(serialized.text, TOOL_TEST_RESULT_LIMIT_BYTES);
      } else {
        body.result = result === undefined ? null : result;
      }
    } else {
      body.error = failure ?? { code: 'TOOL_CALL_FAILED', message: 'tool call failed' };
    }

    // Never raw args or results: they routinely carry secrets. Audit failures
    // must not cost the caller its test result either.
    try {
      deps.audit?.({
        event: 'tool_test',
        server: serverId,
        tool: name,
        ok,
        durationMs,
        argsBytes: Buffer.byteLength(JSON.stringify(input.args), 'utf8'),
        ...(resultBytes === undefined ? {} : { resultBytes }),
        ...(failure === undefined ? {} : { error: failure }),
      });
    } catch {
      // The audit runtime itself never throws; a custom sink still must not break the route.
    }

    return adminJson(200, body);
  }

  return adminHandler(async (request): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    const method = request.method.toUpperCase();

    if (segments.length === 2 && segments[0] === 'tools' && segments[1] === 'batch') {
      return method === 'POST' ? batchTools(request) : null;
    }

    if (segments.length === 4 && segments[0] === 'tools' && segments[3] === 'test') {
      const serverId = segments[1];
      const name = segments[2];
      if (method !== 'POST' || serverId === undefined || name === undefined) return null;
      return testTool(serverId, name, request);
    }

    if (segments.length === 3 && segments[0] === 'tools') {
      const serverId = segments[1];
      const name = segments[2];
      if (method !== 'PATCH' || serverId === undefined || name === undefined) return null;
      return patchTool(serverId, name, request);
    }

    if (segments.length === 3 && segments[0] === 'servers' && segments[2] === 'tools') {
      const serverId = segments[1];
      if (method !== 'GET' || serverId === undefined) return null;
      return listTools(serverId);
    }

    if (segments.length === 1 && segments[0] === 'search') {
      return method === 'GET' ? searchPreview(request) : null;
    }

    return null;
  });
}
