/** Admin API for the tool catalog: per-server effective tools, overrides and search preview.
 *
 * Routes:
 * - `GET /servers/:id/tools` — upstream + effective values (description override, union tags)
 * - `PATCH /tools/:serverId/:name` — description/enabled/concurrency/tags/type/category
 * - `POST /tools/batch` — one transaction, one revision bump
 * - `GET /search` — same retriever as `search_tools`, optionally filtered by a binding
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
  expectBoolean,
  expectString,
  expectStringArray,
  invalidField,
  isPlainObject,
  parseIfMatch,
  queryValue,
  rejectUnknownFields,
  requestSegments,
  requireObjectBody,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
  type ServerRecord,
  type ServerStore,
} from './servers.ts';

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
  stale: boolean;
  staleOverride: boolean;
  firstSeenAt?: string;
  lastSeenAt?: string;
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

export interface AdminToolsDeps {
  servers: ServerStore;
  tools: ToolStore;
  retrieval: SearchPreview;
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

/** Raw row plus the values the executor actually sees. */
function viewTool(tool: ToolRecord, server: ServerRecord): Record<string, unknown> {
  const description = tool.descriptionOverride ?? tool.description;
  return {
    ...tool,
    effective: {
      description,
      enabled: tool.enabled,
      concurrency: tool.concurrency,
      tags: effectiveTags(server, tool),
      category: tool.category ?? server.category,
      stale: tool.stale,
      // Mirrors the four visibility gates: server enabled, tool enabled, stale override.
      exposed: server.enabled && tool.enabled && (!tool.stale || tool.staleOverride),
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
    const [tools, revision] = await Promise.all([
      deps.tools.listByServer(serverId),
      deps.tools.revision(),
    ]);

    return adminJson(200, {
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
    });
  }

  async function patchTool(
    serverId: string,
    name: string,
    request: AdminRequest,
  ): Promise<AdminResponse> {
    const expected = parseIfMatch(request);
    const server = assertServerExists(await deps.servers.get(serverId), serverId);
    assertToolExists(await deps.tools.get(serverId, name), serverId, name);

    // Validate the patch before the precondition so malformed bodies always get 400/422.
    const patch = parseToolPatch(requireObjectBody(request));
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
      assertToolExists(await deps.tools.get(update.serverId, update.name), update.serverId, update.name);
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

  return adminHandler(async (request): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    const method = request.method.toUpperCase();

    if (segments.length === 2 && segments[0] === 'tools' && segments[1] === 'batch') {
      return method === 'POST' ? batchTools(request) : null;
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
