/**
 * Worker wire protocol.
 *
 * `types.ts` fixes the two base unions (`HostToWorker` / `WorkerToHost`).
 * This module adds the pieces those unions do not declare yet:
 * `call-result`, `procs-result`, the worker's `procs` request, and the
 * `skipped` marker on a `snapshot` reply. The extra `skipped` field is
 * optional, so every message here stays assignable to the frozen unions.
 *
 * Builders and guards are the only supported way to create or accept a
 * message; both sides import this module so the two shapes cannot drift.
 *
 * @module
 */
import type { HostToWorker, TimeoutLayer, ToolCallRequest, TruncationFlags, WorkerToHost } from '../types.ts';
import type { StateSnapshotSkip } from './state.ts';

export type LogStream = 'stdout' | 'stderr' | 'console';

export type ProcsOp = 'list' | 'kill' | 'lease';

/** Worker → host request from `procs.*` (not injected into the sandbox yet). */
export interface WorkerProcsRequest {
  t: 'procs';
  evalId: number;
  reqSeq: number;
  op: ProcsOp;
  handle?: string;
  ms?: number;
}

/**
 * Worker → host state snapshot reply.
 * An empty `buf` means "no snapshot"; `skipped` says why.
 */
export interface WorkerSnapshotReply {
  t: 'snapshot';
  evalId: number;
  buf: ArrayBuffer;
  skipped?: StateSnapshotSkip;
}

/** Host → worker answer to one `call` message. */
export type CallResultMessage =
  | { t: 'call-result'; evalId: number; callSeq: number; ok: true; value?: unknown }
  | { t: 'call-result'; evalId: number; callSeq: number; ok: false; error: string };

/** Host → worker answer to one `procs` message. */
export type ProcsResultMessage =
  | { t: 'procs-result'; evalId: number; reqSeq: number; ok: true; value?: unknown }
  | { t: 'procs-result'; evalId: number; reqSeq: number; ok: false; error: string };

export type HostEvalMessage = Extract<HostToWorker, { t: 'eval' }>;
export type HostCancelMessage = Extract<HostToWorker, { t: 'cancel' }>;
export type HostSnapshotMessage = Extract<HostToWorker, { t: 'snapshot' }>;
export type WorkerReadyMessage = Extract<WorkerToHost, { t: 'ready' }>;
export type WorkerCallMessage = Extract<WorkerToHost, { t: 'call' }>;
export type WorkerLogMessage = Extract<WorkerToHost, { t: 'log' }>;
export type WorkerDoneMessage = Extract<WorkerToHost, { t: 'done' }>;
export type WorkerErrorMessage = Extract<WorkerToHost, { t: 'error' }>;

export type WorkerToHostMessage =
  | WorkerReadyMessage
  | WorkerCallMessage
  | WorkerLogMessage
  | WorkerDoneMessage
  | WorkerErrorMessage
  | WorkerProcsRequest
  | WorkerSnapshotReply;

export type HostToWorkerMessage = HostToWorker | CallResultMessage | ProcsResultMessage;

export function evalMessage(evalId: number, epoch: number, code: string, syncMs: number): HostEvalMessage {
  return { t: 'eval', evalId, epoch, code, syncMs };
}

export function cancelMessage(evalId: number): HostCancelMessage {
  return { t: 'cancel', evalId };
}

export function snapshotRequest(evalId: number): HostSnapshotMessage {
  return { t: 'snapshot', evalId };
}

export function readyMessage(epoch: number): WorkerReadyMessage {
  return { t: 'ready', epoch };
}

export function callMessage(request: ToolCallRequest): WorkerCallMessage {
  if (request.server === undefined) {
    return {
      t: 'call',
      evalId: request.evalId,
      epoch: request.epoch,
      callSeq: request.callSeq,
      tool: request.tool,
      args: request.args,
    };
  }
  return {
    t: 'call',
    evalId: request.evalId,
    epoch: request.epoch,
    callSeq: request.callSeq,
    tool: request.tool,
    server: request.server,
    args: request.args,
  };
}

export function logMessage(evalId: number, stream: LogStream, text: string): WorkerLogMessage {
  return { t: 'log', evalId, stream, text };
}

export function doneMessage(
  evalId: number,
  fields: { result?: unknown; stdout: string; stderr: string; ms: number; truncated?: TruncationFlags },
): WorkerDoneMessage {
  return {
    t: 'done',
    evalId,
    result: fields.result,
    stdout: fields.stdout,
    stderr: fields.stderr,
    ms: fields.ms,
    truncated: fields.truncated ?? {},
  };
}

export function errorMessage(
  evalId: number,
  message: string,
  options: { stack?: string; layer?: TimeoutLayer } = {},
): WorkerErrorMessage {
  const reply: WorkerErrorMessage = { t: 'error', evalId, message };
  if (options.stack !== undefined) reply.stack = options.stack;
  if (options.layer !== undefined) reply.layer = options.layer;
  return reply;
}

export function snapshotReply(evalId: number, buf: ArrayBuffer, skipped?: StateSnapshotSkip): WorkerSnapshotReply {
  if (skipped === undefined) return { t: 'snapshot', evalId, buf };
  return { t: 'snapshot', evalId, buf, skipped };
}

export function callResultOk(evalId: number, callSeq: number, value?: unknown): CallResultMessage {
  return { t: 'call-result', evalId, callSeq, ok: true, value };
}

export function callResultError(evalId: number, callSeq: number, error: string): CallResultMessage {
  return { t: 'call-result', evalId, callSeq, ok: false, error };
}

export function procsResultOk(evalId: number, reqSeq: number, value?: unknown): ProcsResultMessage {
  return { t: 'procs-result', evalId, reqSeq, ok: true, value };
}

export function procsResultError(evalId: number, reqSeq: number, error: string): ProcsResultMessage {
  return { t: 'procs-result', evalId, reqSeq, ok: false, error };
}

const TIMEOUT_LAYERS: readonly TimeoutLayer[] = ['sync', 'tool', 'soft', 'wall', 'budget', 'output'];
const PROCS_OPS: readonly ProcsOp[] = ['list', 'kill', 'lease'];
const LOG_STREAMS: readonly LogStream[] = ['stdout', 'stderr', 'console'];
const SNAPSHOT_SKIPS: readonly StateSnapshotSkip[] = ['serialize', 'too-large'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTimeoutLayer(value: unknown): value is TimeoutLayer {
  return typeof value === 'string' && (TIMEOUT_LAYERS as readonly string[]).includes(value);
}

function isTruncationFlags(value: unknown): value is TruncationFlags {
  if (!isRecord(value)) return false;
  for (const key of ['result', 'stdout', 'stderr'] as const) {
    const flag = value[key];
    if (flag !== undefined && typeof flag !== 'boolean') return false;
  }
  return true;
}

/** Accepts only a message the worker is allowed to send. */
export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
  if (!isRecord(value)) return false;
  switch (value.t) {
    case 'ready':
      return isFiniteNumber(value.epoch);
    case 'call':
      return (
        isFiniteNumber(value.evalId) &&
        isFiniteNumber(value.epoch) &&
        isFiniteNumber(value.callSeq) &&
        typeof value.tool === 'string' &&
        (value.server === undefined || typeof value.server === 'string') &&
        isRecord(value.args)
      );
    case 'log':
      return (
        isFiniteNumber(value.evalId) &&
        typeof value.stream === 'string' &&
        (LOG_STREAMS as readonly string[]).includes(value.stream) &&
        typeof value.text === 'string'
      );
    case 'done':
      return (
        isFiniteNumber(value.evalId) &&
        typeof value.stdout === 'string' &&
        typeof value.stderr === 'string' &&
        isFiniteNumber(value.ms) &&
        isTruncationFlags(value.truncated)
      );
    case 'error':
      return (
        isFiniteNumber(value.evalId) &&
        typeof value.message === 'string' &&
        (value.stack === undefined || typeof value.stack === 'string') &&
        (value.layer === undefined || isTimeoutLayer(value.layer))
      );
    case 'snapshot':
      return (
        isFiniteNumber(value.evalId) &&
        value.buf instanceof ArrayBuffer &&
        (value.skipped === undefined ||
          (typeof value.skipped === 'string' && (SNAPSHOT_SKIPS as readonly string[]).includes(value.skipped)))
      );
    case 'procs':
      return (
        isFiniteNumber(value.evalId) &&
        isFiniteNumber(value.reqSeq) &&
        typeof value.op === 'string' &&
        (PROCS_OPS as readonly string[]).includes(value.op) &&
        (value.handle === undefined || typeof value.handle === 'string') &&
        (value.ms === undefined || isFiniteNumber(value.ms))
      );
    default:
      return false;
  }
}

/** Accepts only a message the host is allowed to send. */
export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
  if (!isRecord(value)) return false;
  switch (value.t) {
    case 'eval':
      return (
        isFiniteNumber(value.evalId) &&
        isFiniteNumber(value.epoch) &&
        typeof value.code === 'string' &&
        isFiniteNumber(value.syncMs)
      );
    case 'cancel':
      return isFiniteNumber(value.evalId);
    case 'snapshot':
      return isFiniteNumber(value.evalId) && value.buf === undefined && value.skipped === undefined;
    case 'call-result':
      return (
        isFiniteNumber(value.evalId) &&
        isFiniteNumber(value.callSeq) &&
        (value.ok === true || (value.ok === false && typeof value.error === 'string'))
      );
    case 'procs-result':
      return (
        isFiniteNumber(value.evalId) &&
        isFiniteNumber(value.reqSeq) &&
        (value.ok === true || (value.ok === false && typeof value.error === 'string'))
      );
    default:
      return false;
  }
}
