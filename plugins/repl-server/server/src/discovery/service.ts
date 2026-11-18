/**
 * Discovery preview/apply service (design 07 §3).
 *
 * A preview calls the upstream search tool on the shared pooled connection and
 * stores an in-memory snapshot (`discoveryId`, 10 minutes). Apply writes that
 * snapshot — never a client-supplied schema — in one transaction and then
 * rebuilds the catalog. The two steps are deliberately separate: scanning is a
 * management action, calling is a runtime action.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { AdminApiError } from '../admin/servers.ts';
import { getTool, listTools } from '../db/tools.ts';
import { getRevision } from '../db/meta.ts';
import type { AuditSink, Clock } from '../ports.ts';
import { systemClock } from '../ports.ts';
import type { PoolPrepareProvider } from '../pool/runtime.ts';
import type { PoolCallPrepare } from '../pool/pool.ts';
import {
  decodeStoredDiscovery,
  mergeToolDiscovery,
  parseToolDiscoveryConfig,
  type ToolDiscoveryOverride,
} from './config.ts';
import { parseDiscoveryResult, type DiscoveryShape, type ParsedDiscoveryTool } from './parse.ts';import { buildPrepareCall, buildSearchArgs } from './prepare.ts';
import {
  applyDiscoveredTools,
  demoteDiscoveredTools,
  type ApplyResult,
} from './store.ts';
import {
  DiscoveryConfigError,
  type DiscoverySkippedTool,
  type ToolDiscoveryConfig,
  type ToolDiscoveryMode,
} from './types.ts';

export const DISCOVERY_PREVIEW_TTL_MS = 10 * 60 * 1000;
export const DISCOVERY_PREVIEW_LIMIT = 32;
export const DISCOVERY_DEFAULT_TIMEOUT_MS = 15_000;

/** The slice of a server row the service reads. */
export interface DiscoveryServerRecord {
  id: string;
  transport: 'stdio' | 'http' | 'builtin';
  enabled: boolean;
  toolDiscovery?: ToolDiscoveryConfig | null;
  /** Fallback for adapters that pass the raw column instead of the decoded field. */
  discoveryJson?: string | null;
}

export interface DiscoveryServerSource {
  get(id: string): Promise<DiscoveryServerRecord | null> | DiscoveryServerRecord | null;
  revision?(): Promise<number> | number;
}

export interface DiscoveryToolSource {
  revision?(): Promise<number> | number;
}

/** The pool surface discovery needs. */
export interface DiscoveryPoolPort {
  discoverTools(
    serverId: string,
    options: { tool: string; args: unknown; signal: AbortSignal; timeoutMs: number },
  ): Promise<unknown>;
  invalidatePrepared(serverId: string): void;
}

export interface DiscoveryCatalogPort {
  refreshServer(serverId: string): unknown;
}

export interface DiscoveryServiceDeps {
  db: DatabaseSync;
  servers: DiscoveryServerSource;
  /** Optional tool-store revision source (the server store is preferred). */
  tools?: DiscoveryToolSource;
  catalog: DiscoveryCatalogPort;
  pool: DiscoveryPoolPort;
  clock?: Clock;
  audit?: AuditSink;
}

export interface DiscoverRequest {
  preview?: boolean;
  mode?: ToolDiscoveryMode;
  searchTool?: string;
  query?: string;
  args?: Record<string, unknown>;
  maxTools?: number;
  prepareOnCall?: boolean;
  timeoutMs?: number;
  cursor?: string | null;
  includeRaw?: boolean;
  discoveryId?: string;
  accept?: string[];
  overwriteStatic?: boolean;
  staleOthers?: boolean;
  confirmPartialStale?: boolean;
  allowEmpty?: boolean;
}

export type DiscoveryConflict = 'none' | 'static' | 'search';
export type DiscoveryAction = 'create' | 'update' | 'skip_static';

export interface DiscoveryToolView {
  name: string;
  description: string | null;
  inputSchema: unknown;
  schemaMissing: boolean;
  descriptionTruncated: boolean;
  conflict: DiscoveryConflict;
  action: DiscoveryAction;
}

export interface DiscoveryPreviewResponse {
  discoveryId: string;
  serverId: string;
  searchTool: string;
  query: string;
  effectiveConfig: ToolDiscoveryConfig;
  parsed: boolean;
  shape: DiscoveryShape;
  tools: DiscoveryToolView[];
  skipped: DiscoverySkippedTool[];
  omitted: number;
  partial: boolean;
  willStale: string[];
  willStaleCount: number;
  nextCursor: string | null;
  raw: string | null;
  rawTruncated: boolean;
  elapsedMs: number;
  previewExpiresAt: string;
}

export interface DiscoveryApplyRequest {
  discoveryId: string;
  expectedRevision: number;
  accept?: string[];
  overwriteStatic?: boolean;
  staleOthers?: boolean;
  confirmPartialStale?: boolean;
  allowEmpty?: boolean;
}

export interface DiscoveryService {
  preview(serverId: string, request: DiscoverRequest): Promise<DiscoveryPreviewResponse>;
  apply(serverId: string, request: DiscoveryApplyRequest): Promise<ApplyResult>;
  /** Marks every discovered row stale after `PATCH` switched the mode to static. */
  demote(serverId: string): Promise<number>;
  /** Builds the call-time preparation descriptor, or `null` when none applies. */
  prepareFor(serverId: string, toolName: string): Promise<PoolPrepareDescriptor | null>;
  readonly prepareProvider: PoolPrepareProvider;
  revision(): Promise<number>;
}

/** Matches `PoolRuntimePrepareInfo` structurally without importing runtime values. */
export interface PoolPrepareDescriptor {
  prepare: PoolCallPrepare;
  searchTool: string;
  query: string;
  args: unknown;
}

interface StoredPreview {
  discoveryId: string;
  serverId: string;
  createdAt: number;
  expiresAt: number;
  config: ToolDiscoveryConfig;
  parsed: boolean;
  shape: DiscoveryShape;
  allNames: string[];
  tools: ParsedDiscoveryTool[];
  skipped: DiscoverySkippedTool[];
  omitted: number;
  partial: boolean;
  nextCursor: string | null;
  raw: string | null;
  rawTruncated: boolean;
}

interface Tombstone {
  state: 'expired' | 'applied';
  at: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  if (!isPlainObject(error)) return undefined;
  return typeof error['code'] === 'string' ? (error as { code: string }).code : undefined;
}

function detailOf(error: unknown): unknown {
  return isPlainObject(error) ? (error as { detail?: unknown }).detail : undefined;
}

/** Reads the decoded config, falling back to the raw column for thin adapters. */
function recordDiscovery(record: DiscoveryServerRecord): ToolDiscoveryConfig | null {
  if (record.toolDiscovery !== undefined) {
    try {
      return parseToolDiscoveryConfig(record.toolDiscovery);
    } catch {
      return null;
    }
  }
  return decodeStoredDiscovery(record.discoveryJson ?? null);
}

function toAdminError(error: DiscoveryConfigError): AdminApiError {
  return new AdminApiError(error.status, error.code, error.message, error.details);
}

function mapPoolError(
  error: unknown,
  serverId: string,
  timeoutMs: number,
): AdminApiError | Error {
  if (error instanceof AdminApiError || error instanceof DiscoveryConfigError) return error;
  const code = codeOf(error);
  const message = messageOf(error);
  if (code === 'MCP_CALL_TIMEOUT' || code === 'MCP_CALL_CANCELLED') {
    return new AdminApiError(
      503,
      'DISCOVERY_TIMEOUT',
      `discovery search for ${serverId} timed out after ${timeoutMs}ms`,
      { serverId, timeoutMs },
    );
  }
  if (
    code === 'MCP_TOOL_ERROR' ||
    code === 'MCP_TOOL_NOT_FOUND' ||
    code === 'METHOD_NOT_FOUND' ||
    code === 'MCP_METHOD_NOT_FOUND'
  ) {
    return new AdminApiError(
      503,
      'DISCOVERY_SEARCH_TOOL_ERROR',
      `the discovery search tool failed: ${message}`,
      { serverId, cause: { code, message }, detail: detailOf(error) },
    );
  }
  return new AdminApiError(
    503,
    'MCP_SERVER_UNAVAILABLE',
    `MCP server ${serverId} is unavailable: ${message}`,
    { serverId, cause: { code: code ?? null, message } },
  );
}

function runWithTimeout<T>(
  controller: AbortController,
  timeoutMs: number,
  run: () => Promise<T>,
  onTimeout: () => AdminApiError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        controller.abort(new Error('discovery timeout'));
      } catch {
        // still reject below
      }
      reject(onTimeout());
    }, timeoutMs);
    const candidate = timer as unknown as { unref?: () => void };
    candidate.unref?.();
    Promise.resolve()
      .then(run)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/**
 * Creates the process-wide discovery service. Preview snapshots are in-memory:
 * a restart loses active previews (404) and tombstones (also 404, because expiry
 * and applied cannot be told apart after restart).
 */
export function createDiscoveryService(deps: DiscoveryServiceDeps): DiscoveryService {
  const { db, servers, catalog, pool } = deps;
  const clock = deps.clock ?? systemClock;

  const previews = new Map<string, StoredPreview>();
  const tombstones = new Map<string, Tombstone>();
  const busy = new Set<string>();

  function evict(now: number): void {
    for (const [id, preview] of previews) {
      if (preview.expiresAt <= now) {
        previews.delete(id);
        tombstones.set(id, { state: 'expired', at: now });
      }
    }
    for (const [id, tombstone] of tombstones) {
      if (now - tombstone.at > DISCOVERY_PREVIEW_TTL_MS) tombstones.delete(id);
    }
    while (previews.size > DISCOVERY_PREVIEW_LIMIT) {
      const oldest = previews.keys().next();
      if (oldest.done === true) break;
      const preview = previews.get(oldest.value);
      previews.delete(oldest.value);
      if (preview !== undefined) {
        tombstones.set(oldest.value, { state: 'expired', at: now });
      }
    }
  }

  async function readServer(serverId: string): Promise<DiscoveryServerRecord> {
    const record = await servers.get(serverId);
    if (record === null) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${serverId} does not exist`, {
        serverId,
      });
    }
    return record;
  }

  function audit(event: { event: string; [key: string]: unknown }): void {
    if (deps.audit === undefined) return;
    try {
      deps.audit.write({ ...event, ts: new Date(clock.now()).toISOString() });
    } catch {
      // Audit must never fail a request.
    }
  }

  async function revision(): Promise<number> {
    if (servers.revision !== undefined) {
      return await servers.revision();
    }
    if (deps.tools?.revision !== undefined) {
      return await deps.tools.revision();
    }
    return getRevision(db);
  }

  async function preview(
    serverId: string,
    request: DiscoverRequest,
  ): Promise<DiscoveryPreviewResponse> {
    const startedAt = clock.now();
    const record = await readServer(serverId);
    if (record.transport === 'builtin') {
      throw new AdminApiError(
        422,
        'NOT_CONNECTABLE',
        'builtin servers have no connection to discover',
        { serverId },
      );
    }
    if (!record.enabled) {
      throw new AdminApiError(409, 'SERVER_DISABLED', `server ${serverId} is disabled`, {
        serverId,
      });
    }

    let config: ToolDiscoveryConfig;
    try {
      const override: ToolDiscoveryOverride = {};
      if (request.mode !== undefined) override.mode = request.mode;
      if (request.searchTool !== undefined) override.searchTool = request.searchTool;
      if (request.query !== undefined) override.query = request.query;
      if (request.args !== undefined) override.args = request.args;
      if (request.maxTools !== undefined) override.maxTools = request.maxTools;
      if (request.prepareOnCall !== undefined) override.prepareOnCall = request.prepareOnCall;
      config = mergeToolDiscovery(recordDiscovery(record), override);
    } catch (error) {
      if (error instanceof DiscoveryConfigError) throw toAdminError(error);
      throw error;
    }
    if (config.mode !== 'search') {
      throw new AdminApiError(
        422,
        'DISCOVERY_CONFIG_INVALID',
        'toolDiscovery.mode must be "search" (or provide searchTool) to scan for tools',
        { field: 'toolDiscovery.mode' },
      );
    }
    const searchTool = config.searchTool ?? '';

    const rows = listTools(db, serverId);
    if (rows.length === 0) {
      throw new AdminApiError(
        422,
        'DISCOVERY_NO_TOOLS',
        `server ${serverId} has no tool rows yet; connect or refresh tools first`,
        { serverId },
      );
    }
    const staticNames = rows
      .filter((row) => row.discoveredVia === 'static')
      .map((row) => row.name)
      .sort();
    if (!staticNames.includes(searchTool)) {
      throw new AdminApiError(
        422,
        'DISCOVERY_SEARCH_TOOL_NOT_FOUND',
        `searchTool ${JSON.stringify(searchTool)} is not a static tool of server ${serverId}`,
        { availableTools: staticNames },
      );
    }

    if (busy.has(serverId)) {
      throw new AdminApiError(
        409,
        'DISCOVERY_BUSY',
        `another discovery request is running for ${serverId}`,
        { serverId, retryAfterMs: 1000 },
      );
    }

    const timeoutMs = request.timeoutMs ?? DISCOVERY_DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    busy.add(serverId);
    let searchMayHaveRun = false;
    let rawResult: unknown;
    try {
      const args = buildSearchArgs(config, config.query ?? '');
      if (request.cursor !== undefined && request.cursor !== null) {
        args['cursor'] = request.cursor;
      }
      searchMayHaveRun = true;
      rawResult = await runWithTimeout(
        controller,
        timeoutMs,
        () =>
          pool.discoverTools(serverId, {
            tool: searchTool,
            args,
            signal: controller.signal,
            timeoutMs,
          }),
        () =>
          new AdminApiError(
            503,
            'DISCOVERY_TIMEOUT',
            `discovery search for ${serverId} timed out after ${timeoutMs}ms`,
            { serverId, timeoutMs },
          ),
      );
    } catch (error) {
      throw mapPoolError(error, serverId, timeoutMs);
    } finally {
      busy.delete(serverId);
      if (searchMayHaveRun) pool.invalidatePrepared(serverId);
    }

    const parsed = parseDiscoveryResult(rawResult, serverId);
    const maxTools = config.maxTools ?? 50;
    const shownTools = parsed.tools.slice(0, maxTools);
    const allNames = parsed.tools.map((tool) => tool.name);
    const omitted = parsed.omitted + Math.max(0, parsed.tools.length - maxTools);
    const partial = omitted > 0 || parsed.nextCursor !== null;

    const existing = new Map(rows.map((row) => [row.name, row]));
    const overwriteStatic = request.overwriteStatic === true;
    const tools: DiscoveryToolView[] = shownTools.map((tool) => {
      const current = existing.get(tool.name);
      const conflict: DiscoveryConflict =
        current === undefined ? 'none' : current.discoveredVia;
      const action: DiscoveryAction =
        conflict === 'none'
          ? 'create'
          : conflict === 'search' || overwriteStatic
            ? 'update'
            : 'skip_static';
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        schemaMissing: tool.schemaMissing,
        descriptionTruncated: tool.descriptionTruncated,
        conflict,
        action,
      };
    });

    const allSet = new Set(allNames);
    const willStaleAll = rows
      .filter(
        (row) =>
          row.discoveredVia === 'search' &&
          !row.stale &&
          !row.staleOverride &&
          !allSet.has(row.name),
      )
      .map((row) => row.name)
      .sort();

    const discoveryId = `disc_${randomUUID()}`;
    const now = clock.now();
    const expiresAt = now + DISCOVERY_PREVIEW_TTL_MS;
    const snapshot: StoredPreview = {
      discoveryId,
      serverId,
      createdAt: now,
      expiresAt,
      config,
      parsed: parsed.parsed,
      shape: parsed.shape,
      allNames,
      tools: shownTools,
      skipped: parsed.skipped,
      omitted,
      partial,
      nextCursor: parsed.nextCursor,
      raw: parsed.raw,
      rawTruncated: parsed.rawTruncated,
    };
    evict(now);
    previews.set(discoveryId, snapshot);

    const elapsedMs = Math.max(0, clock.now() - startedAt);
    audit({
      event: 'discovery_preview',
      server: serverId,
      searchTool,
      queryLength: (config.query ?? '').length,
      shape: parsed.shape,
      count: shownTools.length,
      elapsedMs,
    });

    return {
      discoveryId,
      serverId,
      searchTool,
      query: config.query ?? '',
      effectiveConfig: config,
      parsed: parsed.parsed,
      shape: parsed.shape,
      tools,
      skipped: parsed.skipped,
      omitted,
      partial,
      willStale: willStaleAll.slice(0, 100),
      willStaleCount: willStaleAll.length,
      nextCursor: parsed.nextCursor,
      raw: !parsed.parsed || request.includeRaw === true ? parsed.raw : null,
      rawTruncated: parsed.rawTruncated,
      elapsedMs,
      previewExpiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Returns the stored preview or throws the frozen 404/410 pair. */
  function takePreview(discoveryId: string, serverId: string): StoredPreview {
    const now = clock.now();
    const preview = previews.get(discoveryId);
    if (preview !== undefined) {
      if (preview.serverId !== serverId) {
        throw new AdminApiError(
          404,
          'DISCOVERY_PREVIEW_NOT_FOUND',
          `discovery preview ${discoveryId} does not belong to server ${serverId}`,
          { discoveryId },
        );
      }
      if (preview.expiresAt <= now) {
        previews.delete(discoveryId);
        tombstones.set(discoveryId, { state: 'expired', at: now });
        throw new AdminApiError(
          410,
          'DISCOVERY_PREVIEW_EXPIRED',
          `discovery preview ${discoveryId} has expired`,
          { discoveryId, reason: 'expired' },
        );
      }
      return preview;
    }

    const tombstone = tombstones.get(discoveryId);
    if (tombstone !== undefined && now - tombstone.at <= DISCOVERY_PREVIEW_TTL_MS) {
      throw new AdminApiError(
        410,
        'DISCOVERY_PREVIEW_EXPIRED',
        `discovery preview ${discoveryId} can no longer be applied`,
        { discoveryId, reason: tombstone.state },
      );
    }
    throw new AdminApiError(
      404,
      'DISCOVERY_PREVIEW_NOT_FOUND',
      `discovery preview ${discoveryId} does not exist`,
      { discoveryId },
    );
  }

  async function apply(
    serverId: string,
    request: DiscoveryApplyRequest,
  ): Promise<ApplyResult> {
    const preview = takePreview(request.discoveryId, serverId);

    if (request.accept !== undefined) {
      const known = new Set(preview.tools.map((tool) => tool.name));
      const unknown = request.accept.filter((name) => !known.has(name));
      if (unknown.length > 0) {
        throw new AdminApiError(
          422,
          'DISCOVERY_UNKNOWN_TOOL',
          `accept contains names that are not in the preview: ${unknown.join(', ')}`,
          { names: unknown },
        );
      }
    }

    const staleOthers = request.staleOthers !== false;
    if (preview.partial && staleOthers && request.confirmPartialStale !== true) {
      throw new AdminApiError(
        422,
        'DISCOVERY_PARTIAL_STALE_UNCONFIRMED',
        'the preview is incomplete; confirm partial stale marking or disable staleOthers',
        { nextCursor: preview.nextCursor, omitted: preview.omitted },
      );
    }

    // From here on the work is synchronous, so two applies of one preview can
    // never both pass the lookup.
    previews.delete(preview.discoveryId);
    let result;
    try {
      result = applyDiscoveredTools(db, serverId, {
        snapshot: {
          discoveryId: preview.discoveryId,
          config: preview.config,
          parsed: preview.parsed,
          allNames: preview.allNames,
          tools: preview.tools,
          partial: preview.partial,
          nextCursor: preview.nextCursor,
          omitted: preview.omitted,
        },
        ...(request.accept === undefined ? {} : { accept: request.accept }),
        overwriteStatic: request.overwriteStatic === true,
        staleOthers,
        confirmPartialStale: request.confirmPartialStale === true,
        allowEmpty: request.allowEmpty === true,
        expectedRevision: request.expectedRevision,
      });
    } catch (error) {
      previews.set(preview.discoveryId, preview);
      throw error;
    }

    tombstones.set(preview.discoveryId, { state: 'applied', at: clock.now() });
    if (result.changed) catalog.refreshServer(serverId);

    audit({
      event: 'discovery_apply',
      server: serverId,
      created: result.created,
      updated: result.updated,
      skippedStatic: result.skippedStatic,
      stale: result.stale,
      revision: result.revision,
    });

    return {
      serverId: result.serverId,
      applied: result.applied,
      created: result.created,
      updated: result.updated,
      skippedStatic: result.skippedStatic,
      skippedOther: result.skippedOther,
      stale: result.stale,
      revision: result.revision,
    };
  }

  async function demote(serverId: string): Promise<number> {
    const count = demoteDiscoveredTools(db, serverId);
    catalog.refreshServer(serverId);
    return count;
  }

  async function prepareFor(
    serverId: string,
    toolName: string,
  ): Promise<PoolPrepareDescriptor | null> {
    const record = await servers.get(serverId);
    if (record === null) return null;
    const config = recordDiscovery(record);
    if (config === null || config.mode !== 'search' || config.prepareOnCall === false) {
      return null;
    }

    const row = getTool(db, serverId, toolName);
    if (row === null || row.discoveredVia !== 'search' || row.stale) return null;

    const call = buildPrepareCall(config, toolName);
    return {
      prepare: {
        tool: call.tool,
        args: call.args,
        cacheKey: toolName,
        // Replace-style cache update: an overwrite-style upstream invalidates
        // every older key after this search.
        onPrepared: (result: unknown): readonly string[] | undefined => {
          const parsed = parseDiscoveryResult(result, serverId);
          if (!parsed.parsed) return undefined;
          return parsed.tools.map((tool) => tool.name);
        },
      },
      searchTool: call.tool,
      query: toolName,
      args: call.args,
    };
  }

  return {
    preview,
    apply,
    demote,
    prepareFor,
    prepareProvider: (serverId, toolName) => prepareFor(serverId, toolName),
    revision,
  };
}
