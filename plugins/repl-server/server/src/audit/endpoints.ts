/**
 * Admin audit endpoints (srv-17), exported as plain functions.
 *
 * These functions accept a `RequestIdentity` plus already-parsed parameters,
 * and return either a JSON body or an async line stream. They do not import
 * the HTTP server, router, or `IncomingMessage`; the admin base layer is
 * responsible for authentication, CSRF, routing and response writing.
 *
 * Endpoint mapping (`docs/03 §4.2`, `§4.6`):
 * - `auditQueryEndpoint`          GET /admin/api/audit/query
 * - `auditEvalTraceEndpoint`      GET /admin/api/audit/evals/:exec/:evalId
 * - `auditSessionsEndpoint`       GET /admin/api/audit/sessions
 * - `auditFramesEndpoint`         GET /admin/api/audit/frames
 * - `auditStatsEndpoint`          GET /admin/api/audit/stats
 * - `auditExportEndpoint`         GET /admin/api/audit/export
 *
 * Path parameters (`exec`, `evalId`) are expected in `params`; the HTTP
 * adapter merges them before calling.
 *
 * @module
 */

import type { AuditEvent, Clock, RequestIdentity } from '../ports.ts';

import {
  AuditStatsError,
  AuditStatsSaturatedError,
  AuditStatsService,
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_PAGE_SIZE,
  countAudit,
  exportAuditJsonl,
  InvalidAuditFilterError,
  InvalidCursorError,
  listExecSessions,
  matchesFilter,
  normalizeFilter,
  parseAuditEvent,
  parseAuditQueryParams,
  parseLimit,
  parseStatsGroupBy,
  queryAudit,
  readAuditLines,
  readEvalTrace,
  type AuditFilter,
  type AuditLogKind,
  type AuditStatsOptions,
} from './query.ts';
import {
  pairProtocolFrames,
  stripFrameDetail,
  type ProtocolFramePair,
} from './frames.ts';

export interface AuditEndpointRequest {
  identity: RequestIdentity;
  params: URLSearchParams;
}

export interface JsonEndpointResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface StreamEndpointResult {
  status: number;
  headers: Record<string, string>;
  stream: AsyncIterable<string>;
}

export type AuditEndpointResult = JsonEndpointResult | StreamEndpointResult;

/** Line ceiling for one frames request, across protocol-* and audit-* files. */
export const AUDIT_FRAME_SCAN_MAX_LINES = 100_000;

export interface AuditEndpointsOptions {
  /** Directory holding `audit-*.jsonl` and `protocol-*.jsonl`. */
  dir: string;
  clock?: Clock;
  stats?: AuditStatsOptions;
  /** Export row ceiling; clients cannot raise it. Default 100000. */
  exportMaxRows?: number;
  /** Protocol-frame page size. Default 200. */
  framePageSize?: number;
  /** Protocol-frame page ceiling. Default 1000. */
  frameMaxPageSize?: number;
  /** Frame scan row ceiling; reaching it marks the response truncated. Default 100000. */
  frameScanMaxLines?: number;
}

export interface AuditEndpoints {
  query(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
  evalTrace(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
  sessions(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
  frames(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
  stats(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
  export(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
}

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const NDJSON_HEADERS: Record<string, string> = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
};

function jsonResult(status: number, body: unknown): JsonEndpointResult {
  return { status, headers: { ...JSON_HEADERS }, body };
}

function errorResult(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): JsonEndpointResult {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) error.details = details;
  return jsonResult(status, { error });
}

function endpointError(error: unknown): JsonEndpointResult {
  if (error instanceof InvalidAuditFilterError) {
    return errorResult(400, error.code, error.message, error.details);
  }
  if (error instanceof InvalidCursorError) {
    return errorResult(400, error.code, error.message);
  }
  if (error instanceof AuditStatsSaturatedError) {
    return errorResult(503, error.code, error.message, error.details);
  }
  if (error instanceof AuditStatsError) {
    return errorResult(500, error.code, error.message);
  }
  return errorResult(500, 'AUDIT_INTERNAL', error instanceof Error ? error.message : String(error));
}

function param(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseEvalId(params: URLSearchParams): number {
  const raw = param(params, 'evalId');
  if (raw === undefined) {
    throw new InvalidAuditFilterError('evalId is required');
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidAuditFilterError('evalId must be a non-negative integer', { evalId: raw });
  }
  return parsed;
}

/** GET /admin/api/audit/query */
export async function auditQueryEndpoint(
  options: AuditEndpointsOptions,
  request: AuditEndpointRequest,
): Promise<AuditEndpointResult> {
  try {
    const filter = parseAuditQueryParams(request.params);
    const limit = parseLimit(
      request.params.get('limit'),
      AUDIT_PAGE_SIZE,
      AUDIT_MAX_PAGE_SIZE,
    );
    const cursor = param(request.params, 'cursor');
    const result = await queryAudit(options.dir, filter, { limit, cursor });
    return jsonResult(200, result);
  } catch (error) {
    return endpointError(error);
  }
}

/** GET /admin/api/audit/evals/:exec/:evalId */
export async function auditEvalTraceEndpoint(
  options: AuditEndpointsOptions,
  request: AuditEndpointRequest,
): Promise<AuditEndpointResult> {
  try {
    const exec = param(request.params, 'exec');
    if (exec === undefined) throw new InvalidAuditFilterError('exec is required');
    const evalId = parseEvalId(request.params);
    const events = await readEvalTrace(options.dir, exec, evalId);
    if (events.length === 0) {
      return errorResult(404, 'EVAL_NOT_FOUND', 'no audit events for this eval', { exec, evalId });
    }
    return jsonResult(200, { exec, evalId, events, count: events.length });
  } catch (error) {
    return endpointError(error);
  }
}

/** GET /admin/api/audit/sessions */
export async function auditSessionsEndpoint(
  options: AuditEndpointsOptions,
  request: AuditEndpointRequest,
): Promise<AuditEndpointResult> {
  try {
    const filter = normalizeFilter({
      from: param(request.params, 'from'),
      to: param(request.params, 'to'),
      binding: param(request.params, 'binding'),
      client: param(request.params, 'client'),
      clientName: param(request.params, 'clientName'),
      clientVersion: param(request.params, 'clientVersion'),
      exec: param(request.params, 'exec'),
    });
    const sessions = await listExecSessions(options.dir, filter);
    return jsonResult(200, { sessions });
  } catch (error) {
    return endpointError(error);
  }
}

interface FrameEndpointFilter {
  from?: number;
  to?: number;
}

interface CollectedFrames {
  events: AuditEvent[];
  droppedFrames: number;
  frameKeys: Set<string>;
  droppedKeys: Set<string>;
  /** Lines inspected so far, across both log kinds. */
  scannedLines: number;
  /** True once `frameScanMaxLines` stopped the scan early. */
  truncated: boolean;
}

function frameDedupeKey(event: AuditEvent): string {
  return JSON.stringify([
    event.event,
    event.mcp ?? null,
    event.id ?? null,
    event.ts,
    event.method ?? null,
    event.bytes ?? null,
  ]);
}

function droppedDedupeKey(event: AuditEvent): string {
  return JSON.stringify([event.event, event.ts, event.count ?? null]);
}

async function collectProtocolFrames(
  dir: string,
  kind: AuditLogKind,
  filter: AuditFilter,
  range: FrameEndpointFilter,
  state: CollectedFrames,
  maxLines: number,
): Promise<void> {
  for await (const line of readAuditLines(dir, kind, { from: range.from, to: range.to })) {
    if (state.scannedLines >= maxLines) {
      state.truncated = true;
      return;
    }
    state.scannedLines += 1;
    const event = parseAuditEvent(line.text);
    if (event === null) continue;
    if (event.event === 'protocol_dropped') {
      const key = droppedDedupeKey(event);
      if (state.droppedKeys.has(key)) continue;
      state.droppedKeys.add(key);
      // Drop counters are process-global, so only the request window applies.
      // A ts that cannot be parsed cannot be placed in the window.
      if (!matchesFilter(event, { from: range.from, to: range.to })) continue;
      if (typeof event.count === 'number') state.droppedFrames += event.count;
      continue;
    }
    if (event.event !== 'proto_in' && event.event !== 'proto_out') continue;
    const key = frameDedupeKey(event);
    if (state.frameKeys.has(key)) continue;
    state.frameKeys.add(key);
    if (!matchesFilter(event, filter)) continue;
    state.events.push(event);
  }
}

async function readProtocolFrames(
  dir: string,
  filter: AuditFilter,
  range: FrameEndpointFilter,
  maxLines: number,
): Promise<{ frames: ProtocolFramePair[]; droppedFrames: number; truncated: boolean }> {
  const state: CollectedFrames = {
    events: [],
    droppedFrames: 0,
    frameKeys: new Set(),
    droppedKeys: new Set(),
    scannedLines: 0,
    truncated: false,
  };
  // Frame storage moved from audit-*.jsonl to protocol-*.jsonl, so read both:
  // old records stay visible after a restart writes the first protocol file,
  // and the overlap is deduped by a stable event key. The line budget spans
  // both files; once it is spent the legacy file is skipped.
  await collectProtocolFrames(dir, 'protocol', filter, range, state, maxLines);
  if (!state.truncated) {
    await collectProtocolFrames(dir, 'audit', filter, range, state, maxLines);
  }
  return {
    frames: pairProtocolFrames(state.events),
    droppedFrames: state.droppedFrames,
    truncated: state.truncated,
  };
}

/** GET /admin/api/audit/frames?mcp=&id=&detail=summary|full */
export async function auditFramesEndpoint(
  options: AuditEndpointsOptions,
  request: AuditEndpointRequest,
): Promise<AuditEndpointResult> {
  try {
    const detail = param(request.params, 'detail') ?? 'summary';
    if (detail !== 'summary' && detail !== 'full') {
      throw new InvalidAuditFilterError('detail must be summary or full', { detail });
    }
    const filter = normalizeFilter({
      from: param(request.params, 'from'),
      to: param(request.params, 'to'),
      mcp: param(request.params, 'mcp'),
      id: param(request.params, 'id'),
      binding: param(request.params, 'binding'),
      client: param(request.params, 'client'),
      clientName: param(request.params, 'clientName'),
      clientVersion: param(request.params, 'clientVersion'),
      method: param(request.params, 'method'),
    });
    const pageSize = options.framePageSize ?? 200;
    const pageMax = options.frameMaxPageSize ?? 1000;
    const scanMaxLines = options.frameScanMaxLines ?? AUDIT_FRAME_SCAN_MAX_LINES;
    const limit = parseLimit(request.params.get('limit'), pageSize, pageMax);
    const { frames, droppedFrames, truncated } = await readProtocolFrames(
      options.dir,
      filter,
      { from: filter.from, to: filter.to },
      scanMaxLines,
    );
    // Pairing needs the response frame, so the page is cut after pairing.
    const page = frames.slice(0, limit).map((pair) => {
      if (detail === 'full') return pair;
      return {
        ...pair,
        request: pair.request === null ? null : stripFrameDetail(pair.request),
        response: pair.response === null ? null : stripFrameDetail(pair.response),
      };
    });
    return jsonResult(200, {
      detail,
      frames: page,
      hasMore: frames.length > limit,
      droppedFrames,
      truncated,
    });
  } catch (error) {
    return endpointError(error);
  }
}

/** GET /admin/api/audit/stats?from=&to=&groupBy= */
export async function auditStatsEndpoint(
  options: AuditEndpointsOptions,
  request: AuditEndpointRequest,
  statsService?: AuditStatsService,
): Promise<AuditEndpointResult> {
  try {
    const filter = parseAuditQueryParams(request.params);
    const groupBy = parseStatsGroupBy(param(request.params, 'groupBy'));
    const service = statsService ?? defaultStatsService(options);
    const result = await service.compute(options.dir, filter, { groupBy });
    return jsonResult(200, result);
  } catch (error) {
    return endpointError(error);
  }
}

/**
 * Keeps the 10s stats cache for callers that use the standalone functions and
 * reuse the same options object. `createAuditEndpoints` passes its own service.
 */
const statsServices = new WeakMap<AuditEndpointsOptions, AuditStatsService>();

function defaultStatsService(options: AuditEndpointsOptions): AuditStatsService {
  const existing = statsServices.get(options);
  if (existing !== undefined) return existing;
  const service = new AuditStatsService({
    ...options.stats,
    clock: options.clock ?? options.stats?.clock,
  });
  statsServices.set(options, service);
  return service;
}

/** GET /admin/api/audit/export */
export async function auditExportEndpoint(
  options: AuditEndpointsOptions,
  request: AuditEndpointRequest,
): Promise<AuditEndpointResult> {
  try {
    const filter = parseAuditQueryParams(request.params);
    const maxRows = options.exportMaxRows ?? AUDIT_EXPORT_MAX_ROWS;
    const counted = await countAudit(options.dir, filter, { stopAfter: maxRows + 1 });
    if (counted.count > maxRows) {
      return errorResult(
        400,
        'EXPORT_LIMIT_EXCEEDED',
        `export exceeds ${maxRows} rows; narrow the time range`,
        { maxRows, matchedAtLeast: counted.count },
      );
    }
    return {
      status: 200,
      headers: { ...NDJSON_HEADERS },
      stream: exportAuditJsonl(options.dir, filter, { maxRows }),
    };
  } catch (error) {
    return endpointError(error);
  }
}

/** Binds options (and the stats cache) to the six endpoint functions. */
export function createAuditEndpoints(options: AuditEndpointsOptions): AuditEndpoints {
  const statsService = new AuditStatsService({
    ...options.stats,
    clock: options.stats?.clock ?? options.clock,
  });
  return {
    query: (request) => auditQueryEndpoint(options, request),
    evalTrace: (request) => auditEvalTraceEndpoint(options, request),
    sessions: (request) => auditSessionsEndpoint(options, request),
    frames: (request) => auditFramesEndpoint(options, request),
    stats: (request) => auditStatsEndpoint(options, request, statsService),
    export: (request) => auditExportEndpoint(options, request),
  };
}
