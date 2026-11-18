/**
 * Audit log querying over UTC-daily JSONL files (srv-17).
 *
 * Files live directly under the audit directory:
 * - `audit-YYYY-MM-DD.jsonl` for eval/tool events (`docs/02 §6`),
 * - `protocol-YYYY-MM-DD.jsonl` for protocol frames (`docs/02 §6.6`).
 *
 * Everything is streamed: files are read in date order, parsed line by line,
 * and filtered server-side. Cursors carry `(file, byte offset)` instead of an
 * offset so pagination survives file growth. Aggregated statistics run in a
 * worker thread with hard row (200k) and time (10s) ceilings; saturation is
 * surfaced as `AuditStatsSaturatedError`.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { systemClock, type AuditEvent, type Clock } from '../ports.ts';

export const AUDIT_PAGE_SIZE = 100;
export const AUDIT_MAX_PAGE_SIZE = 1000;
export const AUDIT_EXPORT_MAX_ROWS = 100_000;
export const AUDIT_STATS_MAX_ROWS = 200_000;
export const AUDIT_STATS_TIMEOUT_MS = 10_000;
export const AUDIT_STATS_CACHE_TTL_MS = 10_000;
/** Extra time the main thread gives the worker to report its own saturation. */
export const AUDIT_STATS_TIMEOUT_GRACE_MS = 250;

const DAY_MS = 86_400_000;
const AUDIT_FILE = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const PROTOCOL_FILE = /^protocol-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const READ_CHUNK = 64 * 1024;

export type AuditLogKind = 'audit' | 'protocol';
export const AUDIT_STATUSES = ['ok', 'error', 'timeout'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export interface InvalidAuditFilterDetails {
  [key: string]: unknown;
}

export class InvalidAuditFilterError extends Error {
  readonly code = 'INVALID_ARGUMENT';
  readonly details: InvalidAuditFilterDetails | undefined;

  constructor(message: string, details?: InvalidAuditFilterDetails) {
    super(message);
    this.name = 'InvalidAuditFilterError';
    this.details = details;
  }
}

export class InvalidCursorError extends Error {
  readonly code = 'INVALID_CURSOR';

  constructor(message = 'cursor is not a valid audit cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

export interface AuditFilterInput {
  from?: string | number | Date;
  to?: string | number | Date;
  /** Single value, array, or comma-separated string. */
  event?: string | string[];
  /** Alias accepted from already-normalized filters. */
  events?: string[];
  client?: string;
  binding?: string;
  exec?: string;
  evalId?: number | string;
  taskId?: string;
  tool?: string;
  server?: string;
  status?: string;
  minMs?: number | string;
  minQueueMs?: number | string;
  mcp?: string;
  id?: string | number;
  method?: string;
}

/** Normalized filter; timestamps are epoch milliseconds. */
export interface AuditFilter {
  from?: number;
  to?: number;
  events?: string[];
  client?: string;
  binding?: string;
  exec?: string;
  evalId?: number;
  taskId?: string;
  tool?: string;
  server?: string;
  status?: AuditStatus;
  minMs?: number;
  minQueueMs?: number;
  mcp?: string;
  id?: string;
  method?: string;
}

function parseTimestampValue(value: string | number | Date): number {
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isFinite(time)) return time;
    throw new InvalidAuditFilterError('invalid date value', { value: String(value) });
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new InvalidAuditFilterError('invalid epoch milliseconds', { value });
  }
  const text = value.trim();
  if (text === '') throw new InvalidAuditFilterError('empty timestamp');
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new InvalidAuditFilterError('invalid timestamp', { value: text });
  return parsed;
}

function parseIntegerValue(name: string, value: number | string, minimum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new InvalidAuditFilterError(`${name} must be an integer >= ${minimum}`, { [name]: value });
  }
  return parsed;
}

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Validates and normalizes filter input. `evalId` requires `exec`. */
export function normalizeFilter(input: AuditFilterInput = {}): AuditFilter {
  const filter: AuditFilter = {};
  if (input.from !== undefined) filter.from = parseTimestampValue(input.from);
  if (input.to !== undefined) filter.to = parseTimestampValue(input.to);
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) {
    throw new InvalidAuditFilterError('from must not be after to', {
      from: filter.from,
      to: filter.to,
    });
  }
  if (input.event !== undefined || input.events !== undefined) {
    const raw =
      input.event !== undefined
        ? Array.isArray(input.event)
          ? input.event
          : [input.event]
        : (input.events ?? []);
    const events = raw
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (events.length > 0) filter.events = events;
  }
  const client = optionalText(input.client);
  if (client !== undefined) filter.client = client;
  const binding = optionalText(input.binding);
  if (binding !== undefined) filter.binding = binding;
  const exec = optionalText(input.exec);
  if (exec !== undefined) filter.exec = exec;
  const taskId = optionalText(input.taskId);
  if (taskId !== undefined) filter.taskId = taskId;
  const tool = optionalText(input.tool);
  if (tool !== undefined) filter.tool = tool;
  const server = optionalText(input.server);
  if (server !== undefined) filter.server = server;
  const mcp = optionalText(input.mcp);
  if (mcp !== undefined) filter.mcp = mcp;
  const method = optionalText(input.method);
  if (method !== undefined) filter.method = method;
  if (input.id !== undefined) {
    const id = String(input.id).trim();
    if (id !== '') filter.id = id;
  }
  if (input.evalId !== undefined) {
    filter.evalId = parseIntegerValue('evalId', input.evalId, 0);
    if (filter.exec === undefined) {
      throw new InvalidAuditFilterError('evalId requires exec; it is only unique within an exec session', {
        evalId: filter.evalId,
      });
    }
  }
  if (input.status !== undefined) {
    const status = optionalText(input.status);
    if (status !== undefined) {
      if (!(AUDIT_STATUSES as readonly string[]).includes(status)) {
        throw new InvalidAuditFilterError(`status must be one of ${AUDIT_STATUSES.join(', ')}`, { status });
      }
      filter.status = status as AuditStatus;
    }
  }
  if (input.minMs !== undefined) filter.minMs = parseIntegerValue('minMs', input.minMs, 0);
  if (input.minQueueMs !== undefined) {
    filter.minQueueMs = parseIntegerValue('minQueueMs', input.minQueueMs, 0);
  }
  return filter;
}

function firstParam(params: URLSearchParams, name: string): string | undefined {
  return optionalText(params.get(name) ?? undefined);
}

export type AuditFilterLike = AuditFilter | AuditFilterInput;

/** Accepts a raw or already-normalized filter and returns the normalized form. */
export function ensureAuditFilter(filter: AuditFilterLike = {}): AuditFilter {
  return normalizeFilter(filter);
}

/** Parses `/audit/*` query parameters into a normalized filter. */
export function parseAuditQueryParams(params: URLSearchParams): AuditFilter {
  const input: AuditFilterInput = {};
  const assign = <K extends keyof AuditFilterInput>(
    name: K,
    value: AuditFilterInput[K],
  ): void => {
    if (value !== undefined) input[name] = value;
  };
  assign('from', firstParam(params, 'from'));
  assign('to', firstParam(params, 'to'));
  assign('client', firstParam(params, 'client'));
  assign('binding', firstParam(params, 'binding'));
  assign('exec', firstParam(params, 'exec'));
  assign('evalId', firstParam(params, 'evalId'));
  assign('taskId', firstParam(params, 'taskId'));
  assign('tool', firstParam(params, 'tool'));
  assign('server', firstParam(params, 'server'));
  assign('status', firstParam(params, 'status'));
  assign('minMs', firstParam(params, 'minMs'));
  assign('minQueueMs', firstParam(params, 'minQueueMs'));
  assign('mcp', firstParam(params, 'mcp'));
  assign('id', firstParam(params, 'id'));
  assign('method', firstParam(params, 'method'));
  const events = params.getAll('event');
  if (events.length > 0) input.event = events;
  return normalizeFilter(input);
}

export function parseLimit(
  value: string | null | undefined,
  fallback: number = AUDIT_PAGE_SIZE,
  maximum: number = AUDIT_MAX_PAGE_SIZE,
): number {
  if (value === null || value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new InvalidAuditFilterError(`limit must be an integer between 1 and ${maximum}`, {
      limit: value,
    });
  }
  return parsed;
}

function filePattern(kind: AuditLogKind): RegExp {
  return kind === 'protocol' ? PROTOCOL_FILE : AUDIT_FILE;
}

/**
 * Lists `audit-*` / `protocol-*` files intersecting the day range, oldest
 * first. A missing directory is an empty log, not an error.
 */
export async function listAuditFiles(
  dir: string,
  kind: AuditLogKind,
  from?: number,
  to?: number,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const pattern = filePattern(kind);
  const matched: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = pattern.exec(entry.name);
    if (match === null) continue;
    const day = match[1];
    if (day === undefined) continue;
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(dayStart)) continue;
    if (from !== undefined && dayStart + DAY_MS - 1 < from) continue;
    if (to !== undefined && dayStart > to) continue;
    matched.push(entry.name);
  }
  matched.sort();
  return matched.map((name) => join(dir, name));
}

export interface AuditCursor {
  v: 1;
  /** File name relative to the audit directory. */
  file: string;
  /** Byte offset of the next line to read. */
  offset: number;
  /** Timestamp of the last returned event, kept for diagnostics. */
  ts?: string;
}

export function encodeAuditCursor(file: string, offset: number, ts?: string): string {
  const cursor: AuditCursor = { v: 1, file, offset };
  if (ts !== undefined) cursor.ts = ts;
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeAuditCursor(cursor: string): AuditCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidCursorError();
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.file !== 'string' ||
    typeof record.offset !== 'number' ||
    !Number.isInteger(record.offset) ||
    record.offset < 0
  ) {
    throw new InvalidCursorError();
  }
  return { v: 1, file: record.file, offset: record.offset };
}

interface RawAuditLine {
  offset: number;
  endOffset: number;
  text: string;
}

async function* readFileLines(path: string, start: number): AsyncGenerator<RawAuditLine> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(READ_CHUNK);
    let position = start;
    let pending: Buffer = Buffer.alloc(0);
    let pendingOffset = start;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const chunk =
        pending.length === 0
          ? buffer.subarray(0, bytesRead)
          : Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let rest = chunk;
      let base = pendingOffset;
      let newline = rest.indexOf(0x0a);
      while (newline >= 0) {
        yield {
          offset: base,
          endOffset: base + newline + 1,
          text: rest.subarray(0, newline).toString('utf8').replace(/\r$/, ''),
        };
        rest = rest.subarray(newline + 1);
        base += newline + 1;
        newline = rest.indexOf(0x0a);
      }
      pending = Buffer.from(rest);
      pendingOffset = base;
    }
    if (pending.length > 0) {
      yield {
        offset: pendingOffset,
        endOffset: pendingOffset + pending.length,
        text: pending.toString('utf8').replace(/\r$/, ''),
      };
    }
  } finally {
    await handle.close();
  }
}

export interface AuditLine extends RawAuditLine {
  /** File name relative to the audit directory. */
  file: string;
}

export interface ReadAuditLinesOptions {
  from?: number;
  to?: number;
  cursor?: AuditCursor | null;
}

/**
 * Streams raw JSONL lines across files. `offset` values are absolute byte
 * offsets inside `file` and can be fed back as a cursor.
 */
export async function* readAuditLines(
  dir: string,
  kind: AuditLogKind,
  options: ReadAuditLinesOptions = {},
): AsyncGenerator<AuditLine> {
  const files = await listAuditFiles(dir, kind, options.from, options.to);
  if (files.length === 0) return;
  const names = files.map((file) => basename(file));
  let startIndex = 0;
  let startOffset = 0;
  const cursor = options.cursor;
  if (cursor !== undefined && cursor !== null) {
    const exact = names.indexOf(cursor.file);
    if (exact >= 0) {
      startIndex = exact;
      startOffset = cursor.offset;
    } else {
      const next = names.findIndex((name) => name > cursor.file);
      startIndex = next >= 0 ? next : names.length;
    }
  }
  for (let index = startIndex; index < files.length; index += 1) {
    const file = files[index];
    if (file === undefined) continue;
    const start = index === startIndex ? startOffset : 0;
    try {
      for await (const line of readFileLines(file, start)) {
        yield { file: basename(file), offset: line.offset, endOffset: line.endOffset, text: line.text };
      }
    } catch (error) {
      // A concurrent retention sweep may delete an old day between listing and
      // opening; that day simply has no data left to return.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

/** Parses one line; malformed lines (including a torn tail) are skipped. */
export function parseAuditEvent(text: string): AuditEvent | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.event !== 'string' || typeof record.ts !== 'string') return null;
    return record as unknown as AuditEvent;
  } catch {
    return null;
  }
}

/** Status mapping frozen in `docs/03 §4.6`. */
export function eventStatus(event: AuditEvent): AuditStatus {
  if (event.event === 'tool_result') return event.ok === false ? 'error' : 'ok';
  if (event.event === 'eval_end') return event.outcome === 'timeout' ? 'timeout' : 'ok';
  return 'ok';
}

export function matchesFilter(event: AuditEvent, filter: AuditFilter): boolean {
  if (filter.from !== undefined || filter.to !== undefined) {
    const ts = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
    if (!Number.isFinite(ts)) return false;
    if (filter.from !== undefined && ts < filter.from) return false;
    if (filter.to !== undefined && ts > filter.to) return false;
  }
  if (filter.events !== undefined && !filter.events.includes(event.event)) return false;
  if (filter.client !== undefined && event.client !== filter.client) return false;
  if (filter.binding !== undefined && event.binding !== filter.binding) return false;
  if (filter.exec !== undefined && event.exec !== filter.exec) return false;
  if (filter.evalId !== undefined && Number(event.evalId) !== filter.evalId) return false;
  if (
    filter.taskId !== undefined &&
    event.evalTaskId !== filter.taskId &&
    event.taskId !== filter.taskId
  ) {
    return false;
  }
  if (filter.tool !== undefined && event.tool !== filter.tool) return false;
  if (filter.server !== undefined && event.server !== filter.server) return false;
  if (filter.status !== undefined && eventStatus(event) !== filter.status) return false;
  if (filter.minMs !== undefined) {
    if (typeof event.ms !== 'number' || event.ms < filter.minMs) return false;
  }
  if (filter.minQueueMs !== undefined) {
    if (typeof event.queueMs !== 'number' || event.queueMs < filter.minQueueMs) return false;
  }
  if (filter.mcp !== undefined && event.mcp !== filter.mcp) return false;
  if (filter.id !== undefined && String(event.id) !== filter.id) return false;
  if (filter.method !== undefined && event.method !== filter.method) return false;
  return true;
}

export interface LocatedAuditEvent {
  event: AuditEvent;
  file: string;
  offset: number;
  endOffset: number;
}

export interface StreamAuditOptions extends ReadAuditLinesOptions {}

/** Streams parsed events that pass `filter`. Bad lines are skipped. */
export async function* streamAuditEvents(
  dir: string,
  kind: AuditLogKind,
  filter: AuditFilterLike = {},
  options: StreamAuditOptions = {},
): AsyncGenerator<LocatedAuditEvent> {
  const normalized = ensureAuditFilter(filter);
  const cursor = options.cursor;
  for await (const line of readAuditLines(dir, kind, {
    from: options.from ?? normalized.from,
    to: options.to ?? normalized.to,
    cursor,
  })) {
    const event = parseAuditEvent(line.text);
    if (event === null || !matchesFilter(event, normalized)) continue;
    yield { event, file: line.file, offset: line.offset, endOffset: line.endOffset };
  }
}

export interface QueryAuditOptions {
  cursor?: string;
  limit?: number;
}

export interface AuditQueryResult {
  events: AuditEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Cursor-paginated query. The cursor points at the byte just past the last
 * returned event, so concurrent appends do not shift the next page.
 */
export async function queryAudit(
  dir: string,
  filter: AuditFilterLike,
  options: QueryAuditOptions = {},
): Promise<AuditQueryResult> {
  const normalized = ensureAuditFilter(filter);
  const limit = options.limit ?? AUDIT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_PAGE_SIZE) {
    throw new InvalidAuditFilterError(`limit must be an integer between 1 and ${AUDIT_MAX_PAGE_SIZE}`, {
      limit,
    });
  }
  const cursor = options.cursor === undefined ? null : decodeAuditCursor(options.cursor);
  const events: AuditEvent[] = [];
  let last: LocatedAuditEvent | null = null;
  let hasMore = false;
  for await (const located of streamAuditEvents(dir, 'audit', normalized, { cursor })) {
    if (events.length >= limit) {
      hasMore = true;
      break;
    }
    events.push(located.event);
    last = located;
  }
  return {
    events,
    nextCursor:
      hasMore && last !== null ? encodeAuditCursor(last.file, last.endOffset, last.event.ts) : null,
    hasMore,
  };
}

/** Complete ordered trace for one `(exec, evalId)` pair. */
export async function readEvalTrace(
  dir: string,
  exec: string,
  evalId: number,
): Promise<AuditEvent[]> {
  if (typeof exec !== 'string' || exec === '' || !Number.isInteger(evalId)) {
    throw new InvalidAuditFilterError('exec and evalId are required', { exec, evalId });
  }
  const events: AuditEvent[] = [];
  for await (const { event } of streamAuditEvents(dir, 'audit', normalizeFilter({ exec, evalId }))) {
    events.push(event);
  }
  events.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  return events;
}

export interface ExecSessionSummary {
  exec: string;
  binding: string | null;
  client: string | null;
  mcp: string | null;
  workspace: string | null;
  servePid: number | null;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  endReason: string | null;
  ms: number | null;
  evals: number;
  toolCalls: number;
  toolErrors: number;
}

interface SessionAccumulator {
  exec: string;
  binding: string | null;
  client: string | null;
  mcp: string | null;
  workspace: string | null;
  servePid: number | null;
  startedAt: number;
  lastAt: number;
  endedAt: number | null;
  endReason: string | null;
  ms: number | null;
  evals: number;
  toolCalls: number;
  toolErrors: number;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Aggregates `exec_start` / `exec_end` and per-exec activity into session rows. */
export async function listExecSessions(
  dir: string,
  filter: AuditFilterLike = {},
): Promise<ExecSessionSummary[]> {
  const normalized = ensureAuditFilter(filter);
  const sessions = new Map<string, SessionAccumulator>();
  for await (const { event } of streamAuditEvents(dir, 'audit', normalized)) {
    const exec = typeof event.exec === 'string' ? event.exec : null;
    if (exec === null || exec === '') continue;
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts)) continue;
    let session = sessions.get(exec);
    if (session === undefined) {
      session = {
        exec,
        binding: stringOrNull(event.binding),
        client: stringOrNull(event.client),
        mcp: stringOrNull(event.mcp),
        workspace: null,
        servePid: null,
        startedAt: ts,
        lastAt: ts,
        endedAt: null,
        endReason: null,
        ms: null,
        evals: 0,
        toolCalls: 0,
        toolErrors: 0,
      };
      sessions.set(exec, session);
    }
    if (ts < session.startedAt) session.startedAt = ts;
    if (ts > session.lastAt) session.lastAt = ts;
    if (session.binding === null && typeof event.binding === 'string') session.binding = event.binding;
    if (session.client === null && typeof event.client === 'string') session.client = event.client;
    if (session.mcp === null && typeof event.mcp === 'string') session.mcp = event.mcp;
    switch (event.event) {
      case 'exec_start': {
        session.workspace = stringOrNull(event.workspace);
        session.servePid = typeof event.servePid === 'number' ? event.servePid : null;
        break;
      }
      case 'exec_end': {
        session.endedAt = ts;
        session.endReason = stringOrNull(event.reason);
        session.ms = typeof event.ms === 'number' ? event.ms : null;
        break;
      }
      case 'eval_start': {
        session.evals += 1;
        break;
      }
      case 'tool_call': {
        session.toolCalls += 1;
        break;
      }
      case 'tool_result': {
        if (event.ok === false) session.toolErrors += 1;
        break;
      }
      default:
        break;
    }
  }
  const rows = [...sessions.values()].map((session) => ({
    exec: session.exec,
    binding: session.binding,
    client: session.client,
    mcp: session.mcp,
    workspace: session.workspace,
    servePid: session.servePid,
    startedAt: new Date(session.startedAt).toISOString(),
    lastActivityAt: new Date(session.lastAt).toISOString(),
    endedAt: session.endedAt === null ? null : new Date(session.endedAt).toISOString(),
    endReason: session.endReason,
    ms: session.ms,
    evals: session.evals,
    toolCalls: session.toolCalls,
    toolErrors: session.toolErrors,
  } satisfies ExecSessionSummary));
  rows.sort((left, right) => {
    if (left.lastActivityAt === right.lastActivityAt) return left.exec.localeCompare(right.exec);
    return left.lastActivityAt < right.lastActivityAt ? 1 : -1;
  });
  return rows;
}

export interface CountAuditOptions {
  /** Return as soon as this many matches were seen. */
  stopAfter?: number;
}

export interface CountAuditResult {
  count: number;
  /** True when `stopAfter` was reached (there may be more matches). */
  truncated: boolean;
}

/** Counts matching events without materializing them. */
export async function countAudit(
  dir: string,
  filter: AuditFilterLike,
  options: CountAuditOptions = {},
): Promise<CountAuditResult> {
  const normalized = ensureAuditFilter(filter);
  const stopAfter = options.stopAfter;
  let count = 0;
  for await (const _event of streamAuditEvents(dir, 'audit', normalized)) {
    count += 1;
    if (stopAfter !== undefined && count >= stopAfter) {
      return { count, truncated: true };
    }
  }
  return { count, truncated: false };
}

export interface ExportAuditOptions {
  maxRows?: number;
}

/**
 * Exports matching events as JSONL. The generator hard-stops at `maxRows`;
 * callers should preflight with `countAudit` to reject oversized exports.
 */
export async function* exportAuditJsonl(
  dir: string,
  filter: AuditFilterLike,
  options: ExportAuditOptions = {},
): AsyncGenerator<string> {
  const normalized = ensureAuditFilter(filter);
  const maxRows = options.maxRows ?? AUDIT_EXPORT_MAX_ROWS;
  let emitted = 0;
  for await (const { event } of streamAuditEvents(dir, 'audit', normalized)) {
    if (emitted >= maxRows) return;
    yield `${JSON.stringify(event)}\n`;
    emitted += 1;
  }
}

// ---------------------------------------------------------------------------
// Stats aggregation (worker thread)
// ---------------------------------------------------------------------------

export const STATS_GROUP_BYS = ['server', 'tool', 'client', 'status'] as const;
export type StatsGroupBy = (typeof STATS_GROUP_BYS)[number];

export interface AuditStatsGroup {
  key: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
  queueAvgMs: number | null;
}

export interface AuditStatsResult {
  snapshotId: string;
  computedAt: string;
  cached: boolean;
  tookMs: number;
  from: string | null;
  to: string | null;
  groupBy: StatsGroupBy | null;
  scannedRows: number;
  calls: number;
  errors: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
  queueAvgMs: number | null;
  groups: AuditStatsGroup[];
}

export interface AuditStatsSaturationDetails {
  reason: 'rows' | 'timeout';
  scannedRows: number;
  maxRows: number;
  timeoutMs: number;
}

export class AuditStatsSaturatedError extends Error {
  readonly code = 'AUDIT_STATS_SATURATED';
  readonly details: AuditStatsSaturationDetails;

  constructor(details: AuditStatsSaturationDetails) {
    super(
      details.reason === 'rows'
        ? `audit stats scan exceeded ${details.maxRows} rows; narrow the time range`
        : `audit stats scan exceeded ${details.timeoutMs}ms; narrow the time range`,
    );
    this.name = 'AuditStatsSaturatedError';
    this.details = details;
  }
}

export class AuditStatsError extends Error {
  readonly code = 'AUDIT_STATS_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'AuditStatsError';
  }
}

interface StatsWorkerFilter {
  from: number | null;
  to: number | null;
  events: string[] | null;
  client?: string;
  binding?: string;
  exec?: string;
  evalId?: number;
  taskId?: string;
  tool?: string;
  server?: string;
  status?: AuditStatus;
  minMs?: number;
  minQueueMs?: number;
}

export interface StatsWorkerData {
  files: string[];
  filter: StatsWorkerFilter;
  groupBy: StatsGroupBy | null;
  maxRows: number;
  timeoutMs: number;
}

interface WorkerStatsBucket {
  key: string;
  calls: number;
  errors: number;
  p50: number | null;
  p95: number | null;
  queueAvgMs: number | null;
}

interface WorkerStatsResult {
  scannedRows: number;
  calls: number;
  errors: number;
  p50: number | null;
  p95: number | null;
  queueAvgMs: number | null;
  groups: WorkerStatsBucket[];
}

type StatsWorkerMessage =
  | { ok: true; result: WorkerStatsResult }
  | { ok: false; saturated: { reason: 'rows' | 'timeout'; scannedRows: number } }
  | { ok: false; error: string };

/** Minimal worker surface; tests inject a fake implementation. */
export interface StatsWorkerLike {
  postMessage(value: unknown): void;
  terminate(): unknown;
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

export type StatsWorkerFactory = (data: StatsWorkerData) => StatsWorkerLike;

/**
 * Worker source is inline because the package ships as a single esbuild bundle
 * (`scripts/build.mjs`); a separate `.ts` worker entry would not be copied to
 * `dist/`. The worker mirrors `matchesFilter` for `tool_result` events and
 * enforces the row/time ceilings itself before the main-thread timer fires.
 */
const STATS_WORKER_SOURCE = [
  "'use strict';",
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const fs = require('node:fs');",
  "const readline = require('node:readline');",
  '',
  'const data = workerData;',
  'const filter = data.filter;',
  '',
  'function statusOf(event) {',
  "  if (event.event === 'tool_result') return event.ok === false ? 'error' : 'ok';",
  "  if (event.event === 'eval_end') return event.outcome === 'timeout' ? 'timeout' : 'ok';",
  "  return 'ok';",
  '}',
  '',
  'function matches(event) {',
  '  if (filter.from !== null || filter.to !== null) {',
  '    const ts = typeof event.ts === "string" ? Date.parse(event.ts) : NaN;',
  '    if (!Number.isFinite(ts)) return false;',
  '    if (filter.from !== null && ts < filter.from) return false;',
  '    if (filter.to !== null && ts > filter.to) return false;',
  '  }',
  '  if (filter.events !== null && filter.events.indexOf(event.event) === -1) return false;',
  '  if (filter.client !== undefined && event.client !== filter.client) return false;',
  '  if (filter.binding !== undefined && event.binding !== filter.binding) return false;',
  '  if (filter.exec !== undefined && event.exec !== filter.exec) return false;',
  '  if (filter.evalId !== undefined && Number(event.evalId) !== filter.evalId) return false;',
  '  if (filter.taskId !== undefined && event.evalTaskId !== filter.taskId && event.taskId !== filter.taskId) return false;',
  '  if (filter.tool !== undefined && event.tool !== filter.tool) return false;',
  '  if (filter.server !== undefined && event.server !== filter.server) return false;',
  '  if (filter.status !== undefined && statusOf(event) !== filter.status) return false;',
  '  if (filter.minMs !== undefined) {',
  '    if (typeof event.ms !== "number" || event.ms < filter.minMs) return false;',
  '  }',
  '  if (filter.minQueueMs !== undefined) {',
  '    if (typeof event.queueMs !== "number" || event.queueMs < filter.minQueueMs) return false;',
  '  }',
  '  return true;',
  '}',
  '',
  'function emptyBucket() {',
  '  return { calls: 0, errors: 0, durations: [], queues: [] };',
  '}',
  '',
  'function addTo(bucket, event) {',
  '  bucket.calls += 1;',
  '  if (event.ok === false) bucket.errors += 1;',
  '  if (typeof event.ms === "number" && Number.isFinite(event.ms)) bucket.durations.push(event.ms);',
  '  if (typeof event.queueMs === "number" && Number.isFinite(event.queueMs)) bucket.queues.push(event.queueMs);',
  '}',
  '',
  'function percentile(sorted, p) {',
  '  if (sorted.length === 0) return null;',
  '  const rank = Math.ceil((p / 100) * sorted.length);',
  '  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));',
  '  return sorted[index];',
  '}',
  '',
  'function finishBucket(bucket) {',
  '  const sorted = bucket.durations.slice().sort(function (a, b) { return a - b; });',
  '  let queueSum = 0;',
  '  for (const value of bucket.queues) queueSum += value;',
  '  return {',
  '    calls: bucket.calls,',
  '    errors: bucket.errors,',
  '    errorRate: bucket.calls === 0 ? 0 : bucket.errors / bucket.calls,',
  '    p50: percentile(sorted, 50),',
  '    p95: percentile(sorted, 95),',
  '    queueAvgMs: bucket.queues.length === 0 ? null : queueSum / bucket.queues.length,',
  '  };',
  '}',
  '',
  'function groupKeyOf(event) {',
  '  const groupBy = data.groupBy;',
  '  if (groupBy === null) return null;',
  "  if (groupBy === 'server') return String(event.server === undefined ? 'unknown' : event.server);",
  "  if (groupBy === 'tool') return String(event.tool === undefined ? 'unknown' : event.tool);",
  "  if (groupBy === 'client') return String(event.client === undefined ? 'unknown' : event.client);",
  "  if (groupBy === 'status') return statusOf(event);",
  "  return 'unknown';",
  '}',
  '',
  'async function main() {',
  '  const startedAt = Date.now();',
  '  const total = emptyBucket();',
  '  const groups = new Map();',
  '  let scanned = 0;',
  '  for (const file of data.files) {',
  '    const input = fs.createReadStream(file);',
  '    const lines = readline.createInterface({ input: input, crlfDelay: Infinity });',
  '    for await (const line of lines) {',
  '      if (Date.now() - startedAt >= data.timeoutMs) {',
  "        parentPort.postMessage({ ok: false, saturated: { reason: 'timeout', scannedRows: scanned } });",
  '        return;',
  '      }',
  '      scanned += 1;',
  '      if (scanned > data.maxRows) {',
  "        parentPort.postMessage({ ok: false, saturated: { reason: 'rows', scannedRows: scanned } });",
  '        return;',
  '      }',
  '      let event;',
  '      try { event = JSON.parse(line); } catch { continue; }',
  '      if (event === null || typeof event !== "object" || Array.isArray(event)) continue;',
  "      if (event.event !== 'tool_result') continue;",
  '      if (!matches(event)) continue;',
  '      addTo(total, event);',
  '      const key = groupKeyOf(event);',
  '      if (key !== null) {',
  '        let bucket = groups.get(key);',
  '        if (bucket === undefined) { bucket = emptyBucket(); groups.set(key, bucket); }',
  '        addTo(bucket, event);',
  '      }',
  '    }',
  '  }',
  '  const summary = finishBucket(total);',
  '  const groupList = [];',
  '  for (const entry of groups.entries()) {',
  '    const bucket = finishBucket(entry[1]);',
  '    groupList.push({ key: entry[0], calls: bucket.calls, errors: bucket.errors, p50: bucket.p50, p95: bucket.p95, queueAvgMs: bucket.queueAvgMs });',
  '  }',
  '  groupList.sort(function (a, b) {',
  '    if (a.calls !== b.calls) return b.calls - a.calls;',
  '    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;',
  '  });',
  '  parentPort.postMessage({',
  '    ok: true,',
  '    result: {',
  '      scannedRows: scanned,',
  '      calls: summary.calls,',
  '      errors: summary.errors,',
  '      p50: summary.p50,',
  '      p95: summary.p95,',
  '      queueAvgMs: summary.queueAvgMs,',
  '      groups: groupList,',
  '    },',
  '  });',
  '}',
  '',
  'main().catch(function (error) {',
  '  parentPort.postMessage({ ok: false, error: String(error && error.stack ? error.stack : error) });',
  '});',
].join('\n');

function defaultStatsWorkerFactory(data: StatsWorkerData): StatsWorkerLike {
  return new Worker(STATS_WORKER_SOURCE, { eval: true, workerData: data }) as unknown as StatsWorkerLike;
}

function statsWorkerFilter(filter: AuditFilter): StatsWorkerFilter {
  const out: StatsWorkerFilter = {
    from: filter.from ?? null,
    to: filter.to ?? null,
    events: filter.events ?? null,
  };
  if (filter.client !== undefined) out.client = filter.client;
  if (filter.binding !== undefined) out.binding = filter.binding;
  if (filter.exec !== undefined) out.exec = filter.exec;
  if (filter.evalId !== undefined) out.evalId = filter.evalId;
  if (filter.taskId !== undefined) out.taskId = filter.taskId;
  if (filter.tool !== undefined) out.tool = filter.tool;
  if (filter.server !== undefined) out.server = filter.server;
  if (filter.status !== undefined) out.status = filter.status;
  if (filter.minMs !== undefined) out.minMs = filter.minMs;
  if (filter.minQueueMs !== undefined) out.minQueueMs = filter.minQueueMs;
  return out;
}

function isStatsWorkerMessage(value: unknown): value is StatsWorkerMessage {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

export interface AuditStatsOptions {
  groupBy?: StatsGroupBy | null;
  maxRows?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  timeoutGraceMs?: number;
  clock?: Clock;
  workerFactory?: StatsWorkerFactory;
}

export interface AuditStatsServiceOptions extends AuditStatsOptions {}

interface CacheEntry {
  at: number;
  result: AuditStatsResult;
}

function validateGroupBy(value: string | null | undefined): StatsGroupBy | null {
  if (value === null || value === undefined || value === '') return null;
  if (!(STATS_GROUP_BYS as readonly string[]).includes(value)) {
    throw new InvalidAuditFilterError(`groupBy must be one of ${STATS_GROUP_BYS.join(', ')}`, {
      groupBy: value,
    });
  }
  return value as StatsGroupBy;
}

/** Validates the `groupBy` query parameter; null means no grouping. */
export function parseStatsGroupBy(value: string | null | undefined): StatsGroupBy | null {
  return validateGroupBy(value);
}

function percentileOf(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

/**
 * Owns the 10s stats cache. Aggregation itself always runs in a worker; this
 * class only seeds the worker with file names and normalized filters.
 */
export class AuditStatsService {
  private readonly defaults: AuditStatsOptions;
  private readonly clock: Clock;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: AuditStatsServiceOptions = {}) {
    this.defaults = options;
    this.clock = options.clock ?? systemClock;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async compute(
    dir: string,
    filter: AuditFilterLike,
    options: AuditStatsOptions = {},
  ): Promise<AuditStatsResult> {
    const normalized = ensureAuditFilter(filter);
    const groupBy = validateGroupBy(
      options.groupBy !== undefined ? options.groupBy : this.defaults.groupBy,
    );
    const maxRows = options.maxRows ?? this.defaults.maxRows ?? AUDIT_STATS_MAX_ROWS;
    const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs ?? AUDIT_STATS_TIMEOUT_MS;
    const cacheTtlMs = options.cacheTtlMs ?? this.defaults.cacheTtlMs ?? AUDIT_STATS_CACHE_TTL_MS;
    const timeoutGraceMs =
      options.timeoutGraceMs ?? this.defaults.timeoutGraceMs ?? AUDIT_STATS_TIMEOUT_GRACE_MS;
    const workerFactory =
      options.workerFactory ?? this.defaults.workerFactory ?? defaultStatsWorkerFactory;
    if (!Number.isInteger(maxRows) || maxRows < 1) {
      throw new InvalidAuditFilterError('maxRows must be a positive integer', { maxRows });
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new InvalidAuditFilterError('timeoutMs must be >= 0', { timeoutMs });
    }
    const files = await listAuditFiles(dir, 'audit', normalized.from, normalized.to);
    const workerFilter = statsWorkerFilter(normalized);
    const cacheKey = createHash('sha256')
      .update(JSON.stringify({ dir, files, filter: workerFilter, groupBy }))
      .digest('hex');
    const now = this.clock.now();
    const cachedEntry = this.cache.get(cacheKey);
    if (cachedEntry !== undefined && cacheTtlMs > 0 && now - cachedEntry.at <= cacheTtlMs) {
      return { ...cachedEntry.result, cached: true };
    }

    const workerData: StatsWorkerData = { files, filter: workerFilter, groupBy, maxRows, timeoutMs };
    const startedAt = this.clock.now();
    const workerResult = await runStatsWorker(workerData, workerFactory, timeoutMs, timeoutGraceMs);
    const finishedAt = this.clock.now();
    const groups: AuditStatsGroup[] = workerResult.groups.map((group) => ({
      key: group.key,
      calls: group.calls,
      errors: group.errors,
      errorRate: group.calls === 0 ? 0 : group.errors / group.calls,
      p50: group.p50,
      p95: group.p95,
      queueAvgMs: group.queueAvgMs,
    }));
    const result: AuditStatsResult = {
      snapshotId: createHash('sha256')
        .update(`${cacheKey}:${finishedAt}`)
        .digest('hex')
        .slice(0, 32),
      computedAt: new Date(finishedAt).toISOString(),
      cached: false,
      tookMs: Math.max(0, finishedAt - startedAt),
      from: normalized.from === undefined ? null : new Date(normalized.from).toISOString(),
      to: normalized.to === undefined ? null : new Date(normalized.to).toISOString(),
      groupBy,
      scannedRows: workerResult.scannedRows,
      calls: workerResult.calls,
      errors: workerResult.errors,
      errorRate: workerResult.calls === 0 ? 0 : workerResult.errors / workerResult.calls,
      p50: workerResult.p50,
      p95: workerResult.p95,
      queueAvgMs: workerResult.queueAvgMs,
      groups,
    };
    this.cache.set(cacheKey, { at: finishedAt, result });
    if (this.cache.size > 128) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return result;
  }
}

function runStatsWorker(
  data: StatsWorkerData,
  factory: StatsWorkerFactory,
  timeoutMs: number,
  timeoutGraceMs: number,
): Promise<WorkerStatsResult> {
  return new Promise<WorkerStatsResult>((resolve, reject) => {
    let worker: StatsWorkerLike;
    try {
      worker = factory(data);
    } catch (error) {
      reject(new AuditStatsError(error instanceof Error ? error.message : String(error)));
      return;
    }
    let settled = false;
    const close = (): void => {
      try {
        void Promise.resolve(worker.terminate()).catch(() => undefined);
      } catch {
        void 0;
      }
    };
    const succeed = (result: WorkerStatsResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(
        new AuditStatsSaturatedError({
          reason: 'timeout',
          scannedRows: 0,
          maxRows: data.maxRows,
          timeoutMs,
        }),
      );
    }, Math.max(0, timeoutMs) + Math.max(0, timeoutGraceMs));
    worker.on('message', (message) => {
      if (!isStatsWorkerMessage(message)) {
        fail(new AuditStatsError('worker sent an unexpected message'));
        return;
      }
      if (message.ok) {
        succeed(message.result);
        return;
      }
      if ('saturated' in message) {
        fail(
          new AuditStatsSaturatedError({
            reason: message.saturated.reason,
            scannedRows: message.saturated.scannedRows,
            maxRows: data.maxRows,
            timeoutMs,
          }),
        );
        return;
      }
      fail(new AuditStatsError(message.error));
    });
    worker.on('error', (error) => {
      fail(new AuditStatsError(error instanceof Error ? error.message : String(error)));
    });
    worker.on('exit', (code) => {
      if (!settled) fail(new AuditStatsError(`stats worker exited with code ${code}`));
    });
    try {
      worker.postMessage({ start: true });
    } catch (error) {
      fail(new AuditStatsError(error instanceof Error ? error.message : String(error)));
    }
  });
}

/** Convenience wrapper; endpoints use `AuditStatsService` to keep the cache. */
export async function computeAuditStats(
  dir: string,
  filter: AuditFilterLike,
  options: AuditStatsOptions = {},
): Promise<AuditStatsResult> {
  const service = new AuditStatsService(options);
  return service.compute(dir, filter, options);
}

export { percentileOf as auditPercentile };
