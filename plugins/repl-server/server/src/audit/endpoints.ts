/**
 * Admin audit endpoints (srv-17), exported as plain functions.
 *
 * These functions accept a `RequestIdentity` plus already-parsed parameters,
 * and return either a JSON body or an async line stream. They do not import
 * the HTTP server, router, or `IncomingMessage`; the admin base layer is
 * responsible for authentication, CSRF, routing and response writing.
 *
 * Endpoint mapping (`docs/03 §4.2`, `§4.6`):
 * - `auditQueryEndpoint`          GET /admin/api/logs/query
 * - `auditEvalTraceEndpoint`      GET /admin/api/logs/evals/:exec/:evalId
 * - `auditSessionsEndpoint`       GET /admin/api/logs/sessions
 * - `auditFramesEndpoint`         GET /admin/api/logs/frames
 * - `auditPayloadEndpoint`        GET /admin/api/logs/payload
 * - `auditStatsEndpoint`          GET /admin/api/logs/stats
 * - `auditExportEndpoint`         GET /admin/api/logs/export
 *
 * Path parameters (`exec`, `evalId`) are expected in `params`; the HTTP
 * adapter merges them before calling.
 *
 * @module
 */

import { PAYLOAD_RANGE_LIMIT, readPayload, type PayloadReadMode } from '@zhangliang0115/repl-server-core';

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
  listParam,
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
  /** Retention counters, merged into the stats response when present. */
  retention?: () => unknown;
}

export interface AuditEndpoints {
  query(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
  evalTrace(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
  sessions(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
  frames(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
  payload(request: AuditEndpointRequest): Promise<AuditEndpointResult>;
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

/** GET /admin/api/logs/query */
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

/** GET /admin/api/logs/evals/:exec/:evalId */
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

/** GET /admin/api/logs/sessions */
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
  // Frame rows are excluded from the default audit view, so name them here
  // instead of relying on the caller's filter.
  const frameFilter: AuditFilter =
    filter.events === undefined ? { ...filter, events: ['proto_in', 'proto_out'] } : filter;
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
      if (!matchesFilter(event, { from: range.from, to: range.to, events: ['protocol_dropped'] })) continue;
      if (typeof event.count === 'number') state.droppedFrames += event.count;
      continue;
    }
    if (event.event !== 'proto_in' && event.event !== 'proto_out') continue;
    const key = frameDedupeKey(event);
    if (state.frameKeys.has(key)) continue;
    state.frameKeys.add(key);
    if (!matchesFilter(event, frameFilter)) continue;
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
  // One stream: frames live in `events-*.jsonl` next to the control events.
  await collectProtocolFrames(dir, 'events', filter, range, state, maxLines);
  return {
    frames: pairProtocolFrames(state.events),
    droppedFrames: state.droppedFrames,
    truncated: state.truncated,
  };
}

type FrameStatusFilter = 'ok' | 'error' | 'none';
const FRAME_STATUSES: ReadonlySet<string> = new Set(['ok', 'error', 'none']);

function frameStatusList(
  params: URLSearchParams,
  name: string,
): FrameStatusFilter[] | undefined {
  const values = listParam(params, name);
  if (values === undefined) return undefined;
  for (const value of values) {
    if (!FRAME_STATUSES.has(value)) {
      throw new InvalidAuditFilterError(`${name} must be one of ok, error, none`, { [name]: value });
    }
  }
  return values as FrameStatusFilter[];
}

/** `params.name` of a `tools/call` request; other methods have no tool. */
function pairToolName(pair: ProtocolFramePair): string | null {
  if (pair.method !== 'tools/call') return null;
  const params = pair.request?.['params'];
  if (typeof params !== 'object' || params === null) return null;
  const name = (params as Record<string, unknown>)['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

/** JSON-RPC outcome: no response, error response, or success. */
function pairProtocol(pair: ProtocolFramePair): FrameStatusFilter {
  if (pair.response === null) return 'none';
  return pair.ok === false ? 'error' : 'ok';
}

/**
 * Tool-level outcome from `result.isError`; non-tool requests have none. Once
 * the body is externalised, the row keeps `resultIsError` for this decision.
 */
function pairResult(pair: ProtocolFramePair): FrameStatusFilter {
  if (pair.method !== 'tools/call') return 'none';
  const result = pair.response?.['result'];
  const inline = typeof result === 'object' && result !== null
    ? (result as { isError?: unknown }).isError
    : undefined;
  const isError = typeof inline === 'boolean' ? inline : pair.response?.['resultIsError'];
  if (typeof isError !== 'boolean') return 'none';
  return isError ? 'error' : 'ok';
}

function matchesPairFilters(
  pair: ProtocolFramePair,
  tools: readonly string[] | undefined,
  protocols: readonly FrameStatusFilter[] | undefined,
  results: readonly FrameStatusFilter[] | undefined,
): boolean {
  if (tools !== undefined) {
    const name = pairToolName(pair);
    if (name === null || !tools.includes(name)) return false;
  }
  if (protocols !== undefined && !protocols.includes(pairProtocol(pair))) return false;
  if (results !== undefined && !results.includes(pairResult(pair))) return false;
  return true;
}

/** GET /admin/api/logs/frames?mcp=&id=&detail=summary|full */
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
      binding: listParam(request.params, 'binding'),
      client: param(request.params, 'client'),
      clientName: listParam(request.params, 'clientName'),
      clientVersion: listParam(request.params, 'clientVersion'),
      method: listParam(request.params, 'method'),
    });
    // Tool and outcome live on the paired request/response, not on a single line.
    const tools = listParam(request.params, 'tool');
    const protocols = frameStatusList(request.params, 'protocol');
    const results = frameStatusList(request.params, 'result');
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
    // Pairing needs the response frame, so the page is cut after pairing and
    // after the pair-level filters.
    const matched = frames.filter((pair) =>
      matchesPairFilters(pair, tools, protocols, results),
    );
    const page = matched.slice(0, limit).map((pair) => {
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
      hasMore: matched.length > limit,
      droppedFrames,
      truncated,
    });
  } catch (error) {
    return endpointError(error);
  }
}

const PAYLOAD_MODES: ReadonlySet<string> = new Set(['full', 'head', 'tail', 'range']);

/**
 * GET /admin/api/logs/payload?ref=&mode=full|head|tail|range&offset=&limit=
 *
 * Serves one blob named by a `*Ref` field on an audit row. Rows never carry a
 * body above `INLINE_MAX_BYTES`, so this is the only way the UI can show a
 * large tool result; `ref` is resolved strictly below the log root.
 */
export async function auditPayloadEndpoint(
  options: AuditEndpointsOptions,
  request: AuditEndpointRequest,
): Promise<AuditEndpointResult> {
  try {
    const ref = param(request.params, 'ref');
    if (ref === undefined) throw new InvalidAuditFilterError('ref is required');
    const rawMode = param(request.params, 'mode') ?? 'full';
    if (!PAYLOAD_MODES.has(rawMode)) {
      throw new InvalidAuditFilterError('mode must be full, head, tail or range', { mode: rawMode });
    }
    const mode = rawMode as PayloadReadMode;
    const limit = param(request.params, 'limit');
    const offset = param(request.params, 'offset');
    const numeric = (name: string, value: string | undefined): number | undefined => {
      if (value === undefined) return undefined;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new InvalidAuditFilterError(`${name} must be a non-negative safe integer`, { [name]: value });
      }
      return parsed;
    };
    const slice = await readPayload(options.dir, ref, {
      mode,
      limit: Math.min(numeric('limit', limit) ?? PAYLOAD_RANGE_LIMIT, PAYLOAD_RANGE_LIMIT),
      offset: numeric('offset', offset),
    });
    if (slice === null) {
      return errorResult(404, 'PAYLOAD_NOT_FOUND', 'no payload blob for this ref', { ref });
    }
    return jsonResult(200, {
      ref,
      mode,
      total: slice.total,
      start: slice.start,
      end: slice.end,
      truncated: slice.truncated,
      // Decoded text: every blob is written from a JSON serialization.
      body: slice.body.toString('utf8'),
    });
  } catch (error) {
    return endpointError(error);
  }
}

/** GET /admin/api/logs/stats?from=&to=&groupBy= */
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
    // The retention sweep owns the on-disk budget; surfacing it here keeps
    // "why did yesterday disappear" answerable without a second endpoint.
    return jsonResult(
      200,
      options.retention === undefined ? result : { ...result, retention: options.retention() },
    );
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

/** GET /admin/api/logs/export */
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
    payload: (request) => auditPayloadEndpoint(options, request),
    stats: (request) => auditStatsEndpoint(options, request, statsService),
    export: (request) => auditExportEndpoint(options, request),
  };
}
