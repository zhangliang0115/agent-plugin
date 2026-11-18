/**
 * Audit runtime: one owned JSONL writer plus the protocol-frame recorder.
 *
 * This is the only place in the server layer that constructs an audit writer.
 * Callers record through `recordEval` / `recordToolCall` / `recordTask` /
 * `recordFrameIn` / `recordFrameOut`; every write goes through the core
 * writer's bounded queue, so a slow disk drops detail events instead of
 * blocking the request path (`docs/02 §6.1`). The same instance exposes the
 * read side as framework-free {@link AdminHandler}s for `/audit/*`
 * (`docs/03 §4.2`, `§4.6`).
 *
 * Audit failures never propagate to the caller: a broken disk is logged once,
 * an invalid event is logged and skipped, and the MCP / eval path continues.
 *
 * @module
 */

import { AuditWriter } from '@zhangliang0115/repl-server-core';

import {
  adminHandler,
  requestSegments,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from '../admin/servers.ts';
import { systemClock, type AuditEvent, type Clock, type RequestIdentity } from '../ports.ts';
import {
  createAuditEndpoints,
  type AuditEndpointResult,
  type AuditEndpoints,
} from './endpoints.ts';
import {
  createProtocolFrameRecorder,
  type FrameInInput,
  type FrameMode,
  type FrameOutInput,
  type FrameRecorderStats,
  type FrameSink,
} from './frames.ts';

export interface AuditRuntimeOptions {
  /** Directory holding `audit-*.jsonl` and `protocol-*.jsonl`. Created when missing. */
  dir: string;
  /** Diagnostics sink for dropped writes. Never receives audit payloads. */
  log?: (line: string) => void;
  clock?: Clock;
  /** Protocol-frame mode (`docs/02 §6.6`). Default `summary`. */
  frameMode?: FrameMode;
  /**
   * Called for every event accepted by the writer call. The writer may still
   * drop a detail event under backlog, so this is the live view, not proof
   * that a line reached disk. Wires `/admin/api/audit/stream`.
   */
  onEvent?: (event: AuditEvent) => void;
}

export interface AuditRuntimeStats {
  dir: string;
  /** Current daily file; null before the first write and after `close()`. */
  file: string | null;
  queueBytes: number;
  droppedEvents: number;
  healthy: boolean;
  frames: FrameRecorderStats;
}

export interface AuditRuntime {
  /** `eval_start` / `eval_end` / `exec_start` / `exec_end`. */
  recordEval(event: AuditEvent): void;
  /** `tool_call` / `tool_result` / `tool_denied`. */
  recordToolCall(event: AuditEvent): void;
  /** `async_dispatch` / `task_cancel` and other task lifecycle events. */
  recordTask(event: AuditEvent): void;
  recordFrameIn(input: FrameInInput): void;
  recordFrameOut(input: FrameOutInput): void;
  /** One handler per `/audit/*` route; unmatched routes return null. */
  handlers(): AdminHandler[];
  stats(): AuditRuntimeStats;
  /** Drains the frame queue and waits for the writer backlog. */
  flush(): Promise<void>;
  /** Drains everything and closes the writer. Idempotent. */
  close(): Promise<void>;
}

/**
 * Admin requests are authenticated by the admin layer; audit endpoints only
 * read files, so the request identity is a placeholder and never serialized.
 */
const ADMIN_IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'admin',
  mcp: 'admin',
};

function searchParamsOf(request: AdminRequest): URLSearchParams {
  const params = new URLSearchParams();
  const query = request.query;
  if (query instanceof URLSearchParams) {
    for (const [key, value] of query) params.append(key, value);
  } else if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, item);
      } else {
        params.append(key, value);
      }
    }
  }
  // The shell normally passes a parsed bag, but a direct caller may leave the
  // query string on the path; `requestSegments` strips it before routing.
  const queryStart = request.path.indexOf('?');
  if (queryStart !== -1) {
    for (const [key, value] of new URLSearchParams(request.path.slice(queryStart + 1))) {
      if (!params.has(key)) params.append(key, value);
    }
  }
  return params;
}

function matchesRoute(segments: readonly string[], expected: readonly string[]): boolean {
  return (
    segments.length === expected.length &&
    expected.every((part, index) => segments[index] === part)
  );
}

function isEvalTraceRoute(segments: readonly string[]): boolean {
  return segments.length === 4 && segments[0] === 'audit' && segments[1] === 'evals';
}

/**
 * The admin layer only knows `{ status, body, headers }`; export responses are
 * collected here. The export endpoint already enforces the row ceiling.
 */
async function toAdminResponse(result: AuditEndpointResult): Promise<AdminResponse> {
  if ('stream' in result) {
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk, 'utf8'));
    return { status: result.status, headers: result.headers, body: Buffer.concat(chunks) };
  }
  return { status: result.status, headers: result.headers, body: result.body };
}

/** Builds the audit runtime. The writer directory is created eagerly. */
export function createAuditRuntime(options: AuditRuntimeOptions): AuditRuntime {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? ((): void => undefined);
  const writer = new AuditWriter({ dir: options.dir, now: () => clock.now() });
  const endpoints: AuditEndpoints = createAuditEndpoints({ dir: options.dir, clock });

  let closed = false;
  let closePromise: Promise<void> | null = null;
  let writeFailureLogged = false;

  // The frame recorder's own sink is the writer, so frame events share the
  // writer's redaction and flush/close semantics.
  const sink: FrameSink = {
    write(event) {
      record(event);
    },
  };

  const frames = createProtocolFrameRecorder({
    mode: options.frameMode ?? 'summary',
    sink,
    clock,
  });

  const reportFailure = (error: unknown): void => {
    if (writeFailureLogged) return;
    writeFailureLogged = true;
    log(`repl-server: audit write failed: ${error instanceof Error ? error.message : String(error)}`);
  };

  function record(event: AuditEvent): void {
    if (closed) return;
    if (typeof event !== 'object' || event === null || typeof event.event !== 'string' || event.event === '') {
      log('repl-server: audit event dropped: missing event name');
      return;
    }
    try {
      writer.writeEvent(event);
    } catch (error) {
      reportFailure(error);
      return;
    }
    if (options.onEvent !== undefined) {
      try {
        options.onEvent(event);
      } catch (error) {
        log(`repl-server: audit event listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const handlerFor = (
    match: (segments: readonly string[]) => boolean,
    run: (request: AdminRequest, segments: readonly string[]) => Promise<AuditEndpointResult>,
  ): AdminHandler =>
    adminHandler(async (request) => {
      if (request.method.toUpperCase() !== 'GET') return null;
      const segments = requestSegments(request);
      if (!match(segments)) return null;
      const result = await run(request, segments);
      return await toAdminResponse(result);
    });

  const handlers: AdminHandler[] = [
    handlerFor(
      (segments) => matchesRoute(segments, ['audit', 'query']),
      (request) =>
        endpoints.query({ identity: ADMIN_IDENTITY, params: searchParamsOf(request) }),
    ),
    handlerFor(isEvalTraceRoute, (request, segments) => {
      const params = searchParamsOf(request);
      // Path parameters win over query parameters of the same name.
      params.set('exec', segments[2] ?? '');
      params.set('evalId', segments[3] ?? '');
      return endpoints.evalTrace({ identity: ADMIN_IDENTITY, params });
    }),
    handlerFor(
      (segments) => matchesRoute(segments, ['audit', 'sessions']),
      (request) =>
        endpoints.sessions({ identity: ADMIN_IDENTITY, params: searchParamsOf(request) }),
    ),
    handlerFor(
      (segments) => matchesRoute(segments, ['audit', 'frames']),
      (request) =>
        endpoints.frames({ identity: ADMIN_IDENTITY, params: searchParamsOf(request) }),
    ),
    handlerFor(
      (segments) => matchesRoute(segments, ['audit', 'stats']),
      (request) =>
        endpoints.stats({ identity: ADMIN_IDENTITY, params: searchParamsOf(request) }),
    ),
    handlerFor(
      (segments) => matchesRoute(segments, ['audit', 'export']),
      (request) =>
        endpoints.export({ identity: ADMIN_IDENTITY, params: searchParamsOf(request) }),
    ),
  ];

  return {
    recordEval(event) {
      record(event);
    },
    recordToolCall(event) {
      record(event);
    },
    recordTask(event) {
      record(event);
    },
    recordFrameIn(input) {
      if (!closed) frames.recordIn(input);
    },
    recordFrameOut(input) {
      if (!closed) frames.recordOut(input);
    },
    handlers() {
      return handlers;
    },
    stats() {
      return {
        dir: options.dir,
        file: writer.currentFile ?? null,
        queueBytes: writer.queueBytes,
        droppedEvents: writer.droppedEvents,
        healthy: writer.healthy,
        frames: frames.stats(),
      };
    },
    async flush() {
      frames.flush();
      await writer.flush();
    },
    close() {
      if (closePromise !== null) return closePromise;
      // Flush queued frames while the sink still accepts writes, then close
      // the writer and wait for its stream to finish.
      frames.close();
      closed = true;
      closePromise = writer.close();
      return closePromise;
    },
  };
}
