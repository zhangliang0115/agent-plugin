/**
 * Server-Sent Events hub for one admin stream.
 *
 * `/admin/api/events` (server_state, catalog_changed, eval, operation — `docs/03
 * §4.5`) and `/admin/api/logs/stream` each get their own hub, matching the
 * design rule that every stream keeps its own buffer and `Last-Event-ID`
 * replay window (`docs/03 §4.7`):
 * - ids are process-local and strictly increasing;
 * - the newest `bufferSize` events (and only the last 5 minutes by default)
 *   are replayed to a reconnecting client;
 * - when the requested id fell out of the window, a `gap` event with
 *   `oldestEventId` precedes the replay so the UI can do a full refresh;
 * - every subscriber receives a comment heartbeat every 15s.
 *
 * Publishing is non-throwing for well-formed events; a subscriber whose
 * socket is gone is dropped silently. Only a programming error (an empty or
 * multi-line event name) is rejected loudly.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { systemClock, type Clock } from '../ports.ts';

/** Events kept per stream for `Last-Event-ID` replay (`docs/03 §4.7`). */
export const SSE_BUFFER_SIZE = 1000;
/** Replay window per stream. */
export const SSE_BUFFER_TTL_MS = 5 * 60_000;
/** Heartbeat interval; comments keep proxies and idle timers from closing the stream. */
export const SSE_HEARTBEAT_MS = 15_000;

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

export interface EventHubOptions {
  /** Events kept for `Last-Event-ID` replay. Default 1000. */
  bufferSize?: number;
  /** Heartbeat comment interval in milliseconds. Default 15000. */
  heartbeatMs?: number;
  /** Replay window in milliseconds; 0 keeps count-based retention only. Default 300000. */
  bufferTtlMs?: number;
  clock?: Clock;
}

export interface EventHubStats {
  clients: number;
  buffered: number;
  lastEventId: number;
  closed: boolean;
}

export interface EventHub {
  /**
   * Appends one event to the stream and pushes it to every subscriber.
   * Returns the event id, or null after `close()`.
   */
  publish(type: string, data: unknown): number | null;
  /** Attaches an SSE response. The caller must already have authenticated the request. */
  subscribe(req: IncomingMessage, res: ServerResponse): void;
  stats(): EventHubStats;
  /** Ends every subscriber and clears the replay buffer. Idempotent. */
  close(): void;
}

interface BufferedEvent {
  id: number;
  at: number;
  /** Pre-rendered SSE frame, shared by replay and live delivery. */
  text: string;
}

interface Connection {
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
}

function serializeData(data: unknown): string {
  try {
    return JSON.stringify(data) ?? 'null';
  } catch {
    return '{"error":"unserializable"}';
  }
}

function sseFrame(event: { id?: number; type: string; data?: unknown }): string {
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  lines.push(`event: ${event.type}`);
  lines.push(`data: ${serializeData(event.data)}`);
  return `${lines.join('\n')}\n\n`;
}

function parseLastEventId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Reconnect position. `Last-Event-ID` wins; browsers that cannot set headers
 * (manual `EventSource` reconnects through a proxy) may pass `?lastEventId=`.
 */
function lastEventIdOf(req: IncomingMessage): number | null {
  const headerId = parseLastEventId(req.headers['last-event-id']);
  if (headerId !== null) return headerId;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    return parseLastEventId(url.searchParams.get('lastEventId') ?? undefined);
  } catch {
    return null;
  }
}

function safeWrite(res: ServerResponse, text: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(text);
    return true;
  } catch {
    return false;
  }
}

class SseHub implements EventHub {
  private readonly bufferSize: number;
  private readonly heartbeatMs: number;
  private readonly bufferTtlMs: number;
  private readonly clock: Clock;
  private readonly buffer: BufferedEvent[] = [];
  private readonly connections = new Set<Connection>();
  private nextId = 1;
  private closed = false;

  constructor(options: EventHubOptions) {
    const bufferSize = options.bufferSize ?? SSE_BUFFER_SIZE;
    const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
    const bufferTtlMs = options.bufferTtlMs ?? SSE_BUFFER_TTL_MS;
    if (!Number.isInteger(bufferSize) || bufferSize < 1) {
      throw new RangeError('bufferSize must be a positive integer');
    }
    if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
      throw new RangeError('heartbeatMs must be a positive number');
    }
    if (!Number.isFinite(bufferTtlMs) || bufferTtlMs < 0) {
      throw new RangeError('bufferTtlMs must be zero or a positive number');
    }
    this.bufferSize = bufferSize;
    this.heartbeatMs = heartbeatMs;
    this.bufferTtlMs = bufferTtlMs;
    this.clock = options.clock ?? systemClock;
  }

  publish(type: string, data: unknown): number | null {
    if (this.closed) return null;
    if (typeof type !== 'string' || type.trim() === '' || /[\r\n]/.test(type)) {
      throw new TypeError('SSE event type must be a non-empty single-line string');
    }

    const id = this.nextId;
    this.nextId += 1;
    const at = this.clock.now();
    const text = sseFrame({ id, type, data });
    this.buffer.push({ id, at, text });
    this.prune(at);

    for (const connection of [...this.connections]) {
      if (!safeWrite(connection.res, text)) this.drop(connection);
    }
    return id;
  }

  subscribe(req: IncomingMessage, res: ServerResponse): void {
    if (this.closed) {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ error: { code: 'SSE_CLOSED', message: 'event stream is closed' } }));
      return;
    }

    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();

    this.prune(this.clock.now());
    const lastId = lastEventIdOf(req);
    if (!this.replay(lastId, res)) {
      try {
        res.end();
      } catch {
        // The socket already went away.
      }
      return;
    }

    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(': ping\n\n');
      } catch {
        // The close handler removes the connection.
      }
    }, this.heartbeatMs);
    heartbeat.unref();

    const connection: Connection = { res, heartbeat };
    this.connections.add(connection);
    const cleanup = (): void => {
      if (!this.connections.delete(connection)) return;
      clearInterval(heartbeat);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  stats(): EventHubStats {
    return {
      clients: this.connections.size,
      buffered: this.buffer.length,
      lastEventId: this.nextId - 1,
      closed: this.closed,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const connection of [...this.connections]) {
      clearInterval(connection.heartbeat);
      try {
        connection.res.end();
      } catch {
        // Already closed by the peer.
      }
    }
    this.connections.clear();
    this.buffer.length = 0;
  }

  private replay(lastId: number | null, res: ServerResponse): boolean {
    if (lastId === null) return true;
    const oldest = this.buffer[0];
    if (oldest !== undefined && oldest.id > lastId + 1) {
      // The requested position fell out of the retention window: say so
      // instead of pretending the stream is continuous.
      if (!safeWrite(res, sseFrame({ type: 'gap', data: { oldestEventId: oldest.id } }))) {
        return false;
      }
    }
    for (const event of this.buffer) {
      if (event.id <= lastId) continue;
      if (!safeWrite(res, event.text)) return false;
    }
    return true;
  }

  private prune(now: number): void {
    while (this.buffer.length > this.bufferSize) this.buffer.shift();
    if (this.bufferTtlMs === 0) return;
    const cutoff = now - this.bufferTtlMs;
    while (this.buffer.length > 0) {
      const oldest = this.buffer[0];
      if (oldest === undefined || oldest.at >= cutoff) break;
      this.buffer.shift();
    }
  }

  private drop(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    clearInterval(connection.heartbeat);
    try {
      connection.res.end();
    } catch {
      // Already unreachable.
    }
  }
}

/** Creates one independent SSE stream hub. */
export function createEventHub(options: EventHubOptions = {}): EventHub {
  return new SseHub(options);
}
