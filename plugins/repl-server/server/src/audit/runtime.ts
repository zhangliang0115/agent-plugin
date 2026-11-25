import type { LogFn } from '../log.ts';
/**
 * Audit runtime: owned JSONL writers plus the protocol-frame recorder.
 *
 * This is the only place in the server layer that constructs audit writers.
 * Callers record through `recordEval` / `recordToolCall` / `recordTask` /
 * `recordFrameIn` / `recordFrameOut`; every write goes through the core
 * writer's bounded queue, so a slow disk drops detail events instead of
 * blocking the request path (`docs/02 §6.1`). The same instance exposes the
 * read side as framework-free {@link AdminHandler}s for `/logs/*`
 * (`docs/03 §4.2`, `§4.6`).
 *
 * Audit failures never propagate to the caller: a broken disk is logged once,
 * an invalid event is logged and skipped, and the MCP / eval path continues.
 *
 * @module
 */

import {
  AuditWriter,
  PAYLOAD_WRITE_CONCURRENCY,
  PAYLOAD_WRITE_TIMEOUT_MS,
  PayloadStore,
  framePayloadRef,
  planPayload,
  previewOf,
  toolPayloadRef,
} from '@zhangliang0115/repl-server-core';

import {
  adminHandler,
  requestSegments,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from '../admin/servers.ts';
import { systemClock, type AuditEvent, type Clock, type RequestIdentity } from '../ports.ts';
import { LOG_MAX_TOTAL_BYTES, LOG_RETENTION_DAYS } from './retention.ts';
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
  /** The `log/` directory: daily events and the `payload/` tree below it. */
  dir: string;
  /** Diagnostics sink for dropped writes. Never receives audit payloads. */
  log?: LogFn;
  clock?: Clock;
  /** Protocol-frame mode (`docs/02 §6.6`). Default `summary`. */
  frameMode?: FrameMode;
  /**
   * Payload capture. `full` (default) moves tool arguments and results above
   * 4 KB into `payload/` blobs; `off` keeps them inline for one release cycle
   * so a payload bug can be rolled back without touching the layout.
   */
  payload?: 'full' | 'off';
  /** Root for blob refs; defaults to `dir` (both are the log root). */
  payloadDir?: string;
  /** Retention counters surfaced by `/logs/stats`, when a sweep is running. */
  retention?: () => unknown;
  /** Days kept by this writer's own prune. Default 90 (`LOG_RETENTION_DAYS`). */
  retentionDays?: number;
  /** Byte budget for this writer's own prune. Default 2 GiB. */
  maxTotalBytes?: number;
  /**
   * Called for every event accepted by the writer call. The writer may still
   * drop a detail event under backlog, so this is the live view, not proof
   * that a line reached disk. Wires `/admin/api/logs/stream`.
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
  /** Blob writes that failed, timed out or could not be serialized. */
  payloadDropped: number;
  /** Blob writes that landed on disk. */
  payloadWritten: number;
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
  /** One handler per `/logs/*` route; unmatched routes return null. */
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
  return segments.length === 4 && segments[0] === 'logs' && segments[1] === 'evals';
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
  // One stream holds eval, tool, task and frame rows. Frame bodies moved into
  // `payload/`, so both kinds of row are now the same shape: metadata plus an
  // optional ref (`09 §四`). The writer's own prune is a fallback; the log-wide
  // budget lives in `retention.ts`, so both use the same numbers.
  const writer = new AuditWriter({
    dir: options.dir,
    now: () => clock.now(),
    filePrefix: 'events',
    retentionDays: options.retentionDays ?? LOG_RETENTION_DAYS,
    maxTotalBytes: options.maxTotalBytes ?? LOG_MAX_TOTAL_BYTES,
  });
  const payloadStore = new PayloadStore(options.payloadDir ?? options.dir);
  const payloadMode = options.payload ?? 'full';
  let payloadWritten = 0;
  let payloadDropped = 0;
  const endpoints: AuditEndpoints = createAuditEndpoints({
    dir: options.dir,
    clock,
    ...(options.retention === undefined ? {} : { retention: options.retention }),
  });

  let closed = false;
  let closePromise: Promise<void> | null = null;
  let writeFailureLogged = false;

  // Frames share the events writer, so redaction and flush/close semantics
  // cannot drift between the two.
  const sink: FrameSink = {
    write(event) {
      recordFrame(event);
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
    log(`audit write failed: ${error instanceof Error ? error.message : String(error)}`, { level: 'error', scope: 'audit' });
  };

  function notify(event: AuditEvent): void {
    if (options.onEvent === undefined) return;
    try {
      options.onEvent(event);
    } catch (error) {
      log(`audit event listener failed: ${error instanceof Error ? error.message : String(error)}`, { level: 'error', scope: 'audit' });
    }
  }

  function accept(event: AuditEvent): boolean {
    if (typeof event !== 'object' || event === null || typeof event.event !== 'string' || event.event === '') {
      log('audit event dropped: missing event name', { level: 'warn', scope: 'audit' });
      return false;
    }
    try {
      writer.writeEvent(event);
    } catch (error) {
      reportFailure(error);
      return false;
    }
    return true;
  }

  /**
   * Every row goes through one FIFO. That is what makes "row never points at a
   * missing blob" true for `tool_call`/`tool_result` while keeping the file in
   * call order, so `eval_end` still lands after the tools it closes.
   */
  let chain: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void> | void): void {
    chain = chain.then(task).catch((error: unknown) => {
      reportFailure(error);
    });
  }

  /** Queues a plain row; used for eval, task and frame events (no blobs). */
  function record(event: AuditEvent): void {
    if (closed) return;
    if (!valid(event)) {
      accept(event);
      return;
    }
    enqueue(() => {
      if (accept(event)) notify(event);
    });
  }

  /**
   * Frame bodies take the same externalisation path as tool bodies, so a large
   * `tools/call` result is captured whole instead of being cut to a head
   * (`09 §四`). Frames and tools share the one FIFO, so the file still reads in
   * arrival order.
   */
  function recordFrame(event: AuditEvent): void {
    if (closed) return;
    if (!valid(event)) {
      accept(event);
      return;
    }
    const prepared: PreparedEvent =
      payloadMode === 'off' ? { index: { ...event }, blobs: [] } : prepareFrameEvent(event);
    enqueue(async () => {
      await writeBlobs(prepared.blobs, prepared.index);
      if (accept(prepared.index)) notify(prepared.index);
    });
  }

  /** One blob queued for `payload/`; `keys` are removed from the row if it fails. */
  interface PreparedBlob {
    ref: string;
    text: string;
    keys: string[];
  }

  interface PreparedEvent {
    index: AuditEvent;
    blobs: PreparedBlob[];
  }

  class PayloadTimeout extends Error {
    constructor() {
      super('payload write timed out');
      this.name = 'PayloadTimeout';
    }
  }

  async function withPayloadTimeout(write: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        write,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new PayloadTimeout()), PAYLOAD_WRITE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function valid(event: AuditEvent): boolean {
    if (typeof event !== 'object' || event === null) return false;
    if (typeof event.event !== 'string' || event.event === '') return false;
    return true;
  }

  function utcDateOf(event: AuditEvent): string {
    const ts = typeof event['ts'] === 'string' ? event['ts'] : new Date(clock.now()).toISOString();
    return ts.slice(0, 10);
  }

  /**
   * Field names each payload-bearing field writes into its row. Tool rows and
   * frame rows keep separate sizes (`outBytes` vs `resultBytes`) so a reader
   * never has to guess which envelope the number came from.
   */
  interface FieldKeys {
    bytes: string;
    preview: string;
    ref: string;
    tailRef: string;
    sha: string;
  }

  const TOOL_KEYS: Record<'args' | 'result', FieldKeys> = {
    args: { bytes: 'argsBytes', preview: 'argsPreview', ref: 'argsRef', tailRef: 'argsTailRef', sha: 'argsSha256' },
    result: { bytes: 'outBytes', preview: 'resultPreview', ref: 'resultRef', tailRef: 'resultTailRef', sha: 'resultSha256' },
  };

  const FRAME_KEYS: Record<'params' | 'result', FieldKeys> = {
    params: { bytes: 'paramsBytes', preview: 'paramsPreview', ref: 'paramsRef', tailRef: 'paramsTailRef', sha: 'paramsSha256' },
    result: { bytes: 'resultBytes', preview: 'resultPreview', ref: 'resultRef', tailRef: 'resultTailRef', sha: 'resultSha256' },
  };

  /**
   * Replaces one payload field with either an inline value, a ref plus
   * preview, or a head/tail pair, and queues the blobs that back it.
   */
  function applyPlan(
    index: AuditEvent,
    field: 'args' | 'result' | 'params',
    keys: FieldKeys,
    refOf: (part?: 'head' | 'tail') => string,
    blobs: PreparedBlob[],
  ): void {
    const value = index[field];
    const plan = planPayload(value);

    if (plan.kind === 'inline') {
      index[keys.bytes] = plan.bytes;
      return;
    }
    // The row must never carry both the value and a ref.
    delete index[field];
    if (plan.kind === 'dropped') {
      index['payloadDropped'] = plan.reason;
      return;
    }
    index[keys.preview] = plan.preview;
    index[keys.bytes] = plan.bytes;
    index[keys.sha] = plan.sha256;

    const shared = [keys.ref, keys.tailRef, keys.preview, keys.bytes, keys.sha];
    if (plan.kind === 'blob') {
      const ref = refOf();
      index[keys.ref] = ref;
      blobs.push({ ref, text: plan.text, keys: shared });
      return;
    }
    const headRef = refOf('head');
    const tailRef = refOf('tail');
    index[keys.ref] = headRef;
    index[keys.tailRef] = tailRef;
    index['truncated'] = 'size';
    blobs.push({ ref: headRef, text: plan.head, keys: shared });
    blobs.push({ ref: tailRef, text: plan.tail, keys: shared });
  }

  /** Errors are small by nature; the preview keeps the row readable. */
  function addErrorPreview(index: AuditEvent): void {
    const message = (index['error'] as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string' && message !== '') index['errorPreview'] = previewOf(message);
  }

  /** Splits a tool row into an index row plus the blobs it points at. */
  function prepareToolEvent(event: AuditEvent): PreparedEvent {
    const index: AuditEvent = { ...event };
    const blobs: PreparedBlob[] = [];
    const date = utcDateOf(index);
    const execId = typeof index['exec'] === 'string' && index['exec'] !== '' ? index['exec'] : 'no-exec';
    const evalId = Number(index['evalId'] ?? 0);
    const seq = Number(index['seq'] ?? 0);
    const tool = typeof index['tool'] === 'string' ? index['tool'] : 'tool';
    const refOf = (phase: 'call' | 'result') => (part?: 'head' | 'tail'): string =>
      toolPayloadRef(date, execId, evalId, seq, tool, phase, part);

    if (index['args'] !== undefined) applyPlan(index, 'args', TOOL_KEYS.args, refOf('call'), blobs);
    if (index['result'] !== undefined) applyPlan(index, 'result', TOOL_KEYS.result, refOf('result'), blobs);
    if (index['error'] !== undefined) addErrorPreview(index);
    return { index, blobs };
  }

  /**
   * Frames follow the same plan as tool rows; only the ref layout differs.
   * `stamp` plus a per-process counter keeps two frames with the same id (a
   * retry, or the same `id: null` seen twice) from overwriting one blob.
   */
  let frameSeq = 0;

  function prepareFrameEvent(event: AuditEvent): PreparedEvent {
    const index: AuditEvent = { ...event };
    const blobs: PreparedBlob[] = [];

    const date = utcDateOf(index);
    const ts = typeof index['ts'] === 'string' ? index['ts'] : new Date(clock.now()).toISOString();
    const stamp = ts.slice(11, 23).replace(/[:.]/gu, '');
    const phase = index['event'] === 'proto_in' ? 'in' : 'out';
    const rpcId = index['id'] === null || index['id'] === undefined ? 'notif' : String(index['id']);
    const ordinal = `${stamp}-${String(frameSeq)}`;
    frameSeq += 1;

    if (index['params'] !== undefined) {
      applyPlan(index, 'params', FRAME_KEYS.params, (part) =>
        framePayloadRef(date, ordinal, rpcId, phase, 'params', part), blobs);
    }
    if (index['result'] !== undefined) {
      // Externalising drops `result`; this bit is what the list and `result`
      // filter read afterwards (`docs/admin-api.md` §6).
      const result = index['result'];
      if (typeof result === 'object' && result !== null) {
        const isError = (result as { isError?: unknown }).isError;
        if (typeof isError === 'boolean') index['resultIsError'] = isError;
      }
      applyPlan(index, 'result', FRAME_KEYS.result, (part) =>
        framePayloadRef(date, ordinal, rpcId, phase, 'result', part), blobs);
    }
    if (index['error'] !== undefined) addErrorPreview(index);
    return { index, blobs };
  }

  /**
   * Writes one row's blobs with bounded parallelism. Rows are already serial
   * across the FIFO, so only the per-row race (`args` + `result`, or a
   * head/tail pair) is parallel: enough to keep a 2 MiB split off the critical
   * path twice as fast, bounded so a large result cannot starve the queue.
   */
  async function writeBlobs(blobs: readonly PreparedBlob[], index: AuditEvent): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < blobs.length) {
        const blob = blobs[cursor] as PreparedBlob;
        cursor += 1;
        try {
          await withPayloadTimeout(payloadStore.write(blob.ref, blob.text));
          payloadWritten += 1;
        } catch (error) {
          payloadDropped += 1;
          // `payloadDropped` is a single flag on the row, so the first failure
          // names the reason and later ones only bump the counter.
          index['payloadDropped'] ??= error instanceof PayloadTimeout ? 'timeout' : 'io';
          for (const key of blob.keys) delete index[key];
        }
      }
    };
    const width = Math.min(PAYLOAD_WRITE_CONCURRENCY, blobs.length);
    await Promise.all(Array.from({ length: width }, worker));
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
      (segments) => matchesRoute(segments, ['logs', 'query']),
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
      (segments) => matchesRoute(segments, ['logs', 'sessions']),
      (request) =>
        endpoints.sessions({ identity: ADMIN_IDENTITY, params: searchParamsOf(request) }),
    ),
    handlerFor(
      (segments) => matchesRoute(segments, ['logs', 'frames']),
      (request) =>
        endpoints.frames({ identity: ADMIN_IDENTITY, params: searchParamsOf(request) }),
    ),
    handlerFor(
      (segments) => matchesRoute(segments, ['logs', 'payload']),
      (request) =>
        endpoints.payload({ identity: ADMIN_IDENTITY, params: searchParamsOf(request) }),
    ),
    handlerFor(
      (segments) => matchesRoute(segments, ['logs', 'stats']),
      (request) =>
        endpoints.stats({ identity: ADMIN_IDENTITY, params: searchParamsOf(request) }),
    ),
    handlerFor(
      (segments) => matchesRoute(segments, ['logs', 'export']),
      (request) =>
        endpoints.export({ identity: ADMIN_IDENTITY, params: searchParamsOf(request) }),
    ),
  ];

  return {
    recordEval(event) {
      record(event);
    },
    recordToolCall(event) {
      if (closed || !valid(event)) {
        if (!valid(event)) log('audit event dropped: missing event name', { level: 'warn', scope: 'audit' });
        return;
      }
      const prepared: PreparedEvent =
        payloadMode === 'off' ? { index: { ...event }, blobs: [] } : prepareToolEvent(event);
      enqueue(async () => {
        await writeBlobs(prepared.blobs, prepared.index);
        if (accept(prepared.index)) notify(prepared.index);
      });
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
        payloadDropped,
        payloadWritten,
      };
    },
    async flush() {
      frames.flush();
      await chain;
      await writer.flush();
    },
    close() {
      if (closePromise !== null) return closePromise;
      // Flush queued frames while the sink still accepts writes, then drain the
      // payload chains so no row is written after its writer closed.
      frames.close();
      closed = true;
      closePromise = chain.then(() => writer.close()).then(() => undefined);
      return closePromise;
    },
  };
}
