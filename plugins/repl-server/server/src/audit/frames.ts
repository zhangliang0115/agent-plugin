/**
 * Protocol-frame recording for the MCP transport (srv-16).
 *
 * One recorder owns one JSON-RPC session's frame stream. `recordIn` /
 * `recordOut` build audit events and pair responses to requests by
 * `(mcp session, id)` so a response frame inherits the request `method` and
 * `durMs`. Three modes are supported, matching `docs/02 §6.6`:
 * - `off`: nothing is recorded.
 * - `summary` (default): direction, id, method, duration, byte length, status.
 * - `full`: the same plus redacted and bounded `params` / `result` / `error`.
 *
 * Full-mode payload pipeline is redact -> replace base64 blobs -> bound to
 * 1MB (64KB head + `{truncated, bytes, sha256}`). The recorder never blocks
 * or throws into the MCP path: writes go through a bounded queue that drops
 * the oldest frame and aggregates `protocol_dropped` per second.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { AUDIT_SCHEMA_VERSION, type MediaInput } from '@zhangliang0115/repl-server-core';

import { systemClock, type AuditEvent, type AuditSink, type Clock } from '../ports.ts';

export const FRAME_MODES = ['off', 'summary', 'full'] as const;
export type FrameMode = (typeof FRAME_MODES)[number];

/** Independent frame write queue length (docs/02 §6.6). */
export const FRAME_QUEUE_LIMIT = 10_000;
/** Upper bound on remembered unanswered requests. */
export const FRAME_PENDING_LIMIT = 10_000;

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
const URL_KEY = /^(url|uri|href|endpoint)$/i;
const BLOB_TYPES = new Set(['image', 'audio', 'document', 'file', 'pdf']);
const MAX_DEPTH = 64;

const VALUE_SECRET: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  /(authorization|api[-_]?key|token|secret|password)\s*[:=]\s*\S+/gi,
  /(?:^|\s)--?(?:token|api[-_]?key|password)[=\s]+\S+/gi,
  /\?[^\s#]*\b(?:token|key|secret)=[^&\s]+/gi,
];

/** Sink the recorder writes to. `AuditSink` is assignable to this. */
export interface FrameSink {
  /** `media` holds the decoded blobs the redaction replaced; the sink stores them. */
  write(event: AuditEvent, media?: readonly MediaInput[]): void | Promise<void>;
}

export interface ProtocolFrameRecorderOptions {
  mode?: FrameMode;
  sink: FrameSink | AuditSink;
  clock?: Clock;
  /** Queue length before the oldest frame is dropped. Default 10000. */
  maxQueue?: number;
  /** Maximum remembered unanswered requests. Default 10000. */
  maxPending?: number;
}

/** Fields every frame shares. `binding`/`client` are display-only identity. */
export interface FrameContext {
  mcp: string;
  identity?: 'bound' | 'unbound';
  binding?: string | null;
  client?: string;
  clientName?: string;
  clientVersion?: string;
  exec?: string;
  evalId?: number;
}

export interface FrameInInput extends FrameContext {
  id?: string | number | null;
  method: string;
  params?: unknown;
  /** Raw payload length; computed from `params` when omitted. */
  bytes?: number;
}

export interface FrameOutInput extends FrameContext {
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: unknown;
  ok?: boolean;
  bytes?: number;
  /** Only needed when the request frame was not observed. */
  durMs?: number;
}

export interface FrameRecorderStats {
  mode: FrameMode;
  queued: number;
  written: number;
  dropped: number;
  pending: number;
  healthy: boolean;
}

interface PendingFrame {
  method: string;
  startedAt: number;
  identity?: 'bound' | 'unbound';
  binding?: string | null;
  client?: string;
  clientName?: string;
  clientVersion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Payload keys may be `__proto__`; defineProperty keeps them own data. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function sha256Buffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  let text: string;
  try {
    text = JSON.stringify(value) ?? '';
  } catch {
    return 0;
  }
  return Buffer.byteLength(text, 'utf8');
}

/** Redacts secret-looking fragments inside free-form strings (docs/02 §6.4). */
export function redactText(text: string): string {
  let out = text;
  for (const pattern of VALUE_SECRET) {
    out = out.replace(pattern, (match) => match.replace(/\S+$/, '<redacted>'));
  }
  return out;
}

/** Strips the query string and fragment from URL-shaped values. */
export function stripUrlQuery(value: string): string {
  const hash = value.indexOf('#');
  const withoutHash = hash >= 0 ? value.slice(0, hash) : value;
  const query = withoutHash.indexOf('?');
  return query >= 0 ? withoutHash.slice(0, query) : withoutHash;
}

interface BlobReplacement {
  mimeType: string | null;
  bytes: number;
  sha256: string;
}

function replaceBlob(data: string, mimeType: unknown, media?: MediaInput[]): BlobReplacement {
  const buffer = Buffer.from(data, 'base64');
  if (media !== undefined && buffer.byteLength > 0) {
    media.push({ buffer, mimeType: typeof mimeType === 'string' && mimeType !== '' ? mimeType : null });
  }
  return {
    mimeType: typeof mimeType === 'string' ? mimeType : null,
    bytes: buffer.byteLength,
    sha256: sha256Buffer(buffer),
  };
}

const DATA_URI = /^data:([^;,]*)(;base64)?,([\s\S]*)$/;

function isBlobObject(value: Record<string, unknown>): boolean {
  return (
    typeof value.base64 === 'string' ||
    (typeof value.data === 'string' && typeof value.type === 'string' && BLOB_TYPES.has(value.type)) ||
    (typeof value.blob === 'string' && (typeof value.mimeType === 'string' || typeof value.mediaType === 'string'))
  );
}

function replaceBlobMembers(
  value: Record<string, unknown>,
  depth: number,
  media?: MediaInput[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === 'base64' && typeof member === 'string') {
      out.base64 = replaceBlob(member, value.mediaType ?? value.mimeType, media);
    } else if (
      key === 'data' &&
      typeof member === 'string' &&
      typeof value.type === 'string' &&
      BLOB_TYPES.has(value.type)
    ) {
      out.data = replaceBlob(member, value.mimeType ?? value.mediaType, media);
    } else if (
      key === 'blob' &&
      typeof member === 'string' &&
      (typeof value.mimeType === 'string' || typeof value.mediaType === 'string')
    ) {
      out.blob = replaceBlob(member, value.mimeType ?? value.mediaType, media);
    } else {
      setOwn(out, key, transformValue(member, depth + 1, media));
    }
  }
  return out;
}

/** Redacts keys and values, and rewrites base64 blobs to `{mimeType, bytes, sha256}`. */
function transformValue(value: unknown, depth = 0, media?: MediaInput[]): unknown {
  if (depth > MAX_DEPTH) return '<depth-limit>';
  if (typeof value === 'string') {
    const dataUri = DATA_URI.exec(value);
    if (dataUri !== null && dataUri[2] !== undefined) {
      return replaceBlob(dataUri[3] ?? '', dataUri[1], media);
    }
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((member) => transformValue(member, depth + 1, media));
  }
  if (!isRecord(value)) return value;
  if (isBlobObject(value)) return replaceBlobMembers(value, depth, media);
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      setOwn(out, key, '<redacted>');
      continue;
    }
    if (URL_KEY.test(key) && typeof member === 'string') {
      setOwn(out, key, stripUrlQuery(member));
      continue;
    }
    setOwn(out, key, transformValue(member, depth + 1, media));
  }
  return out;
}

/**
 * Full-mode payload: redact keys and values, replace base64 blobs, and hand
 * the result to the audit runtime. Size policy is *not* decided here: the
 * runtime applies the same inline/blob/split plan it uses for tool rows, so a
 * 300 KB `tools/call` result is captured whole in `payload/` instead of being
 * cut to a 1 MiB head (`09 §四`).
 */
export function prepareFramePayload(value: unknown, media?: MediaInput[]): unknown {
  return transformValue(value, 0, media);
}

/** Decoded blobs of one frame, handed to the sink next to the (already redacted) event. */
const frameMedia = new WeakMap<AuditEvent, readonly MediaInput[]>();

/** Pairing key; the id type is part of the key because JSON-RPC ids are typed. */
export function frameKey(mcp: string, id: string | number): string {
  return `${mcp}\u0000${typeof id}:${String(id)}`;
}

function baseEvent(ts: number, name: 'proto_in' | 'proto_out', context: FrameContext): AuditEvent {
  const event: AuditEvent = {
    v: AUDIT_SCHEMA_VERSION,
    ts: new Date(ts).toISOString(),
    event: name,
    mcp: context.mcp,
  };
  if (context.identity !== undefined) event.identity = context.identity;
  if (context.binding !== undefined) event.binding = context.binding;
  if (context.client !== undefined) event.client = context.client;
  if (context.clientName !== undefined) event.clientName = context.clientName;
  if (context.clientVersion !== undefined) event.clientVersion = context.clientVersion;
  if (context.exec !== undefined) event.exec = context.exec;
  if (context.evalId !== undefined) event.evalId = context.evalId;
  return event;
}

function asPromise(value: Promise<void> | void): Promise<void> | null {
  if (value !== null && typeof value === 'object' && typeof (value as Promise<void>).then === 'function') {
    return value as Promise<void>;
  }
  return null;
}

/**
 * Records JSON-RPC frames for one transport session.
 *
 * Requests are paired to responses by `(mcp, id)`. Notifications (`id: null`)
 * are recorded without pairing. Writes are asynchronous (microtask) so a
 * burst within one tick exercises the bounded queue; call `flush()` when an
 * immediate, deterministic drain is needed.
 */
export class ProtocolFrameRecorder {
  private mode: FrameMode;
  private readonly sink: FrameSink | AuditSink;
  private readonly clock: Clock;
  private readonly maxQueue: number;
  private readonly maxPending: number;
  private readonly queue: AuditEvent[] = [];
  private readonly pending = new Map<string, PendingFrame[]>();
  private pendingCount = 0;
  private dropBuckets = new Map<number, number>();
  private scheduled = false;
  private written = 0;
  private dropped = 0;
  private healthy = true;

  constructor(options: ProtocolFrameRecorderOptions) {
    this.mode = options.mode ?? 'summary';
    this.sink = options.sink;
    this.clock = options.clock ?? systemClock;
    this.maxQueue = Math.max(1, options.maxQueue ?? FRAME_QUEUE_LIMIT);
    this.maxPending = Math.max(1, options.maxPending ?? FRAME_PENDING_LIMIT);
  }

  get currentMode(): FrameMode {
    return this.mode;
  }

  setMode(mode: FrameMode): void {
    this.mode = mode;
  }

  recordIn(input: FrameInInput): void {
    if (this.mode === 'off') return;
    const now = this.clock.now();
    const id = input.id ?? null;
    const event = baseEvent(now, 'proto_in', input);
    event.id = id;
    event.method = input.method;
    event.bytes = input.bytes ?? jsonBytes(input.params);
    if (this.mode === 'full' && input.params !== undefined) {
      const media: MediaInput[] = [];
      event.params = prepareFramePayload(input.params, media);
      if (media.length > 0) frameMedia.set(event, media);
    }
    if (id !== null) this.remember(id, input, now);
    this.enqueue(event);
  }

  recordOut(input: FrameOutInput): void {
    if (this.mode === 'off') return;
    const now = this.clock.now();
    const id = input.id ?? null;
    const pending = id === null ? undefined : this.takePending(input.mcp, id);
    const context: FrameContext = {
      mcp: input.mcp,
      identity: input.identity ?? pending?.identity,
      binding: input.binding === undefined ? pending?.binding : input.binding,
      client: input.client ?? pending?.client,
      clientName: input.clientName ?? pending?.clientName,
      clientVersion: input.clientVersion ?? pending?.clientVersion,
      exec: input.exec,
      evalId: input.evalId,
    };
    const event = baseEvent(now, 'proto_out', context);
    event.id = id;
    event.method = input.method ?? pending?.method ?? null;
    event.bytes = input.bytes ?? jsonBytes(input.error !== undefined ? input.error : input.result);
    event.ok = input.ok ?? input.error === undefined;
    const durMs = input.durMs ?? (pending === undefined ? undefined : Math.max(0, now - pending.startedAt));
    if (durMs !== undefined) event.durMs = durMs;
    if (this.mode === 'full') {
      const media: MediaInput[] = [];
      if (input.result !== undefined) event.result = prepareFramePayload(input.result, media);
      if (input.error !== undefined) event.error = prepareFramePayload(input.error, media);
      if (media.length > 0) frameMedia.set(event, media);
    }
    this.enqueue(event);
  }

  /** Number of frames discarded because the queue was full. */
  get droppedFrames(): number {
    return this.dropped;
  }

  /** False once any sink write failed; the MCP path is never affected. */
  get auditHealthy(): boolean {
    return this.healthy;
  }

  /** Drains the queue synchronously and emits pending `protocol_dropped` events. */
  flush(): void {
    this.emitDropBuckets();
    while (this.queue.length > 0) {
      const event = this.queue.shift();
      if (event === undefined) break;
      try {
        const outcome = this.sink.write(event, frameMedia.get(event));
        const promise = asPromise(outcome);
        if (promise !== null) {
          promise.catch(() => {
            this.healthy = false;
          });
        }
        this.written += 1;
      } catch {
        this.healthy = false;
      }
    }
  }

  close(): void {
    this.flush();
    this.pending.clear();
    this.pendingCount = 0;
  }

  stats(): FrameRecorderStats {
    return {
      mode: this.mode,
      queued: this.queue.length,
      written: this.written,
      dropped: this.dropped,
      pending: this.pendingCount,
      healthy: this.healthy,
    };
  }

  private remember(id: string | number, input: FrameInInput, now: number): void {
    const key = frameKey(input.mcp, id);
    const entry: PendingFrame = {
      method: input.method,
      startedAt: now,
      identity: input.identity,
      binding: input.binding,
      client: input.client,
      clientName: input.clientName,
      clientVersion: input.clientVersion,
    };
    const list = this.pending.get(key);
    if (list === undefined) {
      this.pending.set(key, [entry]);
    } else {
      list.push(entry);
    }
    this.pendingCount += 1;
    while (this.pendingCount > this.maxPending) {
      const oldestKey = this.pending.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.pending.get(oldestKey);
      if (oldest === undefined) break;
      oldest.shift();
      this.pendingCount -= 1;
      if (oldest.length === 0) this.pending.delete(oldestKey);
    }
  }

  private takePending(mcp: string, id: string | number): PendingFrame | undefined {
    const key = frameKey(mcp, id);
    const list = this.pending.get(key);
    if (list === undefined) return undefined;
    const entry = list.shift();
    if (entry === undefined) {
      this.pending.delete(key);
      return undefined;
    }
    this.pendingCount -= 1;
    if (list.length === 0) this.pending.delete(key);
    return entry;
  }

  private enqueue(event: AuditEvent, control = false): void {
    if (!control && this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
      const second = Math.floor(this.clock.now() / 1000);
      this.dropBuckets.set(second, (this.dropBuckets.get(second) ?? 0) + 1);
    }
    this.queue.push(event);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private emitDropBuckets(): void {
    if (this.dropBuckets.size === 0) return;
    const buckets = [...this.dropBuckets.entries()].sort((left, right) => left[0] - right[0]);
    this.dropBuckets = new Map();
    for (const [second, count] of buckets) {
      this.enqueue(
        {
          v: AUDIT_SCHEMA_VERSION,
          ts: new Date(second * 1000).toISOString(),
          event: 'protocol_dropped',
          count,
          windowMs: 1000,
        },
        true,
      );
    }
  }
}

export function createProtocolFrameRecorder(
  options: ProtocolFrameRecorderOptions,
): ProtocolFrameRecorder {
  return new ProtocolFrameRecorder(options);
}

/** Removes the (potentially large) payload fields for `detail=summary`. */
export function stripFrameDetail(event: AuditEvent): AuditEvent {
  const { params: _params, result: _result, error: _error, ...rest } = event;
  return rest;
}

export interface ProtocolFramePair {
  mcp: string;
  id: string | number | null;
  method: string | null;
  request: AuditEvent | null;
  response: AuditEvent | null;
  durMs?: number;
  ok?: boolean;
}

/**
 * Pairs proto_in/proto_out events read back from `protocol-*.jsonl`. Requests
 * without a response, responses whose request fell outside the scan range, and
 * notifications each produce a pair with the missing side set to null.
 */
export function pairProtocolFrames(events: Iterable<AuditEvent>): ProtocolFramePair[] {
  const open = new Map<string, ProtocolFramePair[]>();
  const pairs: ProtocolFramePair[] = [];

  for (const event of events) {
    if (event.event !== 'proto_in' && event.event !== 'proto_out') continue;
    const mcp = typeof event.mcp === 'string' ? event.mcp : '';
    const rawId = event.id;
    const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
    if (id === null) {
      pairs.push({
        mcp,
        id: null,
        method: typeof event.method === 'string' ? event.method : null,
        request: event.event === 'proto_in' ? event : null,
        response: event.event === 'proto_out' ? event : null,
        durMs: typeof event.durMs === 'number' ? event.durMs : undefined,
        ok: typeof event.ok === 'boolean' ? event.ok : undefined,
      });
      continue;
    }
    const key = frameKey(mcp, id);
    if (event.event === 'proto_in') {
      const pair: ProtocolFramePair = {
        mcp,
        id,
        method: typeof event.method === 'string' ? event.method : null,
        request: event,
        response: null,
      };
      const list = open.get(key);
      if (list === undefined) {
        open.set(key, [pair]);
      } else {
        list.push(pair);
      }
      continue;
    }
    const list = open.get(key);
    const pair = list?.shift();
    if (list !== undefined && list.length === 0) open.delete(key);
    if (pair !== undefined) {
      pair.response = event;
      pair.method = pair.method ?? (typeof event.method === 'string' ? event.method : null);
      pair.durMs = typeof event.durMs === 'number' ? event.durMs : pair.durMs;
      pair.ok = typeof event.ok === 'boolean' ? event.ok : pair.ok;
      pairs.push(pair);
    } else {
      pairs.push({
        mcp,
        id,
        method: typeof event.method === 'string' ? event.method : null,
        request: null,
        response: event,
        durMs: typeof event.durMs === 'number' ? event.durMs : undefined,
        ok: typeof event.ok === 'boolean' ? event.ok : undefined,
      });
    }
  }

  for (const list of open.values()) {
    for (const pair of list) pairs.push(pair);
  }

  const timestampOf = (pair: ProtocolFramePair): string => {
    const event = pair.request ?? pair.response;
    return typeof event?.ts === 'string' ? event.ts : '';
  };
  pairs.sort((left, right) => {
    const a = timestampOf(left);
    const b = timestampOf(right);
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
  return pairs;
}
