/**
 * Worker entry for one execution session.
 *
 * Creates the vm context exactly once, serves `eval` messages sequentially
 * (JS is single-threaded; concurrent evals interleave at `await`), and routes
 * `tools.*` calls to the host. Every tool call and console line is attributed
 * to its eval through `AsyncLocalStorage`, so two in-flight evals sharing the
 * context do not steal each other's output.
 *
 * `cancel` is cooperative: it rejects in-flight and future tool calls of that
 * eval; `snapshot` serializes the live `state` object on request.
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';

import { LIMITS } from '../constants.ts';
import { StaleEvalError } from '../errors.ts';
import type { TimeoutLayer, ToolCallRequest } from '../types.ts';
import { createSandboxConsole } from './console.ts';
import {
  callMessage,
  doneMessage,
  errorMessage,
  isHostToWorkerMessage,
  logMessage,
  readyMessage,
  snapshotReply,
  type CallResultMessage,
  type HostEvalMessage,
  type HostToWorkerMessage,
  type WorkerDoneMessage,
  type WorkerToHostMessage,
} from './protocol.ts';
import { serializeState } from './state.ts';
import { createVmContext, runEvalScript } from './vm-context.ts';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface EvalRun {
  evalId: number;
  startedAt: number;
  stdout: string;
  stderr: string;
  callSeq: number;
  accepting: boolean;
  cancelRequested: boolean;
  closed: boolean;
  pending: Map<number, PendingCall>;
}

interface WorkerBootstrap {
  sessionId?: string;
  epoch?: number;
  state?: unknown;
  stateBytes?: number;
}

class EvalCancelledError extends Error {
  constructor() {
    super('eval cancelled');
    this.name = 'EvalCancelledError';
  }
}

class ToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallError';
  }
}

const port = parentPort;
if (port === null) throw new Error('worker/entry.ts must be started as a Worker');
const messagePort: MessagePort = port;

// Scripts can leave unawaited promises behind. When the eval settles, their
// in-flight tool calls are rejected, which would otherwise surface here as an
// unhandled rejection and kill the worker. learn-ai 02 §1.6 swallows the same
// case at the process level.
process.on('unhandledRejection', () => {});

const bootstrap = (workerData ?? {}) as WorkerBootstrap;
const epoch = typeof bootstrap.epoch === 'number' && Number.isFinite(bootstrap.epoch) ? bootstrap.epoch : 0;
const stateBytes =
  typeof bootstrap.stateBytes === 'number' && bootstrap.stateBytes > 0 ? bootstrap.stateBytes : LIMITS.stateBytes;

const runs = new Map<number, EvalRun>();
const evalScope = new AsyncLocalStorage<EvalRun>();

function post(message: WorkerToHostMessage, transfer: ArrayBuffer[] = []): void {
  try {
    messagePort.postMessage(message, transfer);
  } catch {
    // The host is gone (terminated worker); nothing useful left to report.
  }
}

function errorFields(error: unknown): { message: string; stack?: string } {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; stack?: unknown };
    const message = typeof candidate.message === 'string' ? candidate.message : String(error);
    if (typeof candidate.stack === 'string') return { message, stack: candidate.stack };
    return { message };
  }
  return { message: String(error) };
}

function isSyncTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
  );
}

function rejectPending(run: EvalRun, error: unknown): void {
  for (const pending of run.pending.values()) pending.reject(error);
  run.pending.clear();
}

function closeRun(run: EvalRun): void {
  run.closed = true;
  run.accepting = false;
  runs.delete(run.evalId);
}

function settleDone(run: EvalRun, result: unknown): void {
  if (run.closed) return;
  closeRun(run);
  rejectPending(run, new StaleEvalError());

  const ms = Date.now() - run.startedAt;
  const message: WorkerDoneMessage = doneMessage(run.evalId, {
    result,
    stdout: run.stdout,
    stderr: run.stderr,
    ms,
    truncated: {},
  });
  try {
    messagePort.postMessage(message);
  } catch {
    // `result` is not structured-cloneable (function, symbol, ...). Keep the
    // eval successful and drop only the value.
    run.stderr += '[result omitted: not structured-cloneable]\n';
    post(
      doneMessage(run.evalId, {
        stdout: run.stdout,
        stderr: run.stderr,
        ms,
        truncated: {},
      }),
    );
  }
}

function settleError(run: EvalRun, fields: { message: string; stack?: string }, layer?: TimeoutLayer): void {
  if (run.closed) return;
  closeRun(run);
  rejectPending(run, new StaleEvalError());
  post(errorMessage(run.evalId, fields.message, { stack: fields.stack, layer }));
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (typeof args === 'object' && args !== null) return args as Record<string, unknown>;
  return {};
}

function invokeTool(tool: string, server: string | undefined, args: unknown): Promise<unknown> {
  const run = evalScope.getStore();
  if (run === undefined || run.closed) return Promise.reject(new StaleEvalError());
  if (!run.accepting) {
    return Promise.reject(run.cancelRequested ? new EvalCancelledError() : new StaleEvalError());
  }

  const callSeq = run.callSeq + 1;
  run.callSeq = callSeq;
  return new Promise<unknown>((resolve, reject) => {
    run.pending.set(callSeq, { resolve, reject });
    const request: ToolCallRequest = {
      evalId: run.evalId,
      epoch,
      callSeq,
      tool,
      args: normalizeArgs(args),
    };
    if (server !== undefined) request.server = server;
    try {
      messagePort.postMessage(callMessage(request));
    } catch (error) {
      run.pending.delete(callSeq);
      reject(error);
    }
  });
}

function toolFunction(tool: string, server?: string): (args?: unknown) => Promise<unknown> {
  return (args?: unknown) => invokeTool(tool, server, args);
}

function createTools(): object {
  const mcp = new Proxy(
    {},
    {
      get: (_target, server: string | symbol) => {
        if (typeof server !== 'string') return undefined;
        return new Proxy(
          {},
          {
            get: (_inner, tool: string | symbol) => {
              if (typeof tool !== 'string' || tool === 'then') return undefined;
              return toolFunction(tool, server);
            },
          },
        );
      },
    },
  );

  return new Proxy(
    {},
    {
      get: (_target, property: string | symbol) => {
        if (property === 'mcp') return mcp;
        if (typeof property !== 'string' || property === 'then') return undefined;
        return toolFunction(property);
      },
    },
  );
}

const sandboxConsole = createSandboxConsole((stream, text) => {
  const run = evalScope.getStore();
  if (run === undefined || run.closed) return;
  if (stream === 'stderr') run.stderr += text;
  else run.stdout += text;
  post(logMessage(run.evalId, 'console', text));
});

const handle = createVmContext({
  tools: createTools(),
  console: sandboxConsole,
  state: bootstrap.state,
});
const stateRef = handle.state;

function handleEval(message: HostEvalMessage): void {
  if (message.epoch !== epoch) return;

  const run: EvalRun = {
    evalId: message.evalId,
    startedAt: Date.now(),
    stdout: '',
    stderr: '',
    callSeq: 0,
    accepting: true,
    cancelRequested: false,
    closed: false,
    pending: new Map(),
  };
  runs.set(run.evalId, run);

  let value: unknown;
  try {
    value = evalScope.run(run, () => runEvalScript(handle.context, message.code, message.evalId, message.syncMs));
  } catch (error) {
    settleError(run, errorFields(error), isSyncTimeout(error) ? 'sync' : undefined);
    return;
  }

  Promise.resolve(value).then(
    (result) => settleDone(run, result),
    (error: unknown) => {
      const cancelled = run.cancelRequested && error instanceof EvalCancelledError;
      settleError(run, errorFields(error), cancelled ? 'soft' : undefined);
    },
  );
}

function handleCancel(evalId: number): void {
  const run = runs.get(evalId);
  if (run === undefined || run.closed) return;
  run.cancelRequested = true;
  run.accepting = false;
  rejectPending(run, new EvalCancelledError());
}

function handleSnapshot(evalId: number): void {
  const snapshot = serializeState(stateRef, stateBytes);
  post(snapshotReply(evalId, snapshot.buf, snapshot.skipped), snapshot.buf.byteLength > 0 ? [snapshot.buf] : []);
}

function handleCallResult(message: CallResultMessage): void {
  const run = runs.get(message.evalId);
  if (run === undefined || run.closed) return;
  const pending = run.pending.get(message.callSeq);
  if (pending === undefined) return;
  run.pending.delete(message.callSeq);
  if (message.ok) pending.resolve(message.value);
  else pending.reject(new ToolCallError(message.error));
}

function dispatch(message: HostToWorkerMessage): void {
  switch (message.t) {
    case 'eval':
      handleEval(message);
      return;
    case 'cancel':
      handleCancel(message.evalId);
      return;
    case 'snapshot':
      handleSnapshot(message.evalId);
      return;
    case 'call-result':
      handleCallResult(message);
      return;
    case 'procs-result':
      // `procs` is not injected into the sandbox yet; no request can be pending.
      return;
  }
}

messagePort.on('message', (raw: unknown) => {
  if (!isHostToWorkerMessage(raw)) return;
  dispatch(raw);
});

post(readyMessage(epoch));
