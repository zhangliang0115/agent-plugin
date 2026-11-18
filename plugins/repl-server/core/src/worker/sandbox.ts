/**
 * Host-side sandbox: owns one eval worker and its lifecycle.
 *
 * Responsibilities (C03):
 * - create the worker, wait for `ready`, and hand it the restored `state`;
 * - route `call` / `procs` requests to host handlers and answer them;
 * - collect `log`, `done`, `error` per `evalId`;
 * - after a successful `done`, request and store a state snapshot (`lastGood`);
 * - terminate (3s by default, `false` + `wedged` on timeout) and rebuild.
 *
 * `runEval` (L2/L3/L4 orchestration) lives in a later task; this class only
 * exposes one eval at a time per call but keeps `evalId` routing so concurrent
 * evals share the worker safely.
 *
 * @module
 */
import { Worker, type WorkerOptions } from 'node:worker_threads';

import { LIMITS } from '../constants.ts';
import { WorkerKilledError } from '../errors.ts';
import type { TimeoutLayer, ToolCallRequest, TruncationFlags } from '../types.ts';
import {
  callResultError,
  callResultOk,
  cancelMessage,
  evalMessage,
  isWorkerToHostMessage,
  procsResultError,
  procsResultOk,
  snapshotRequest,
  type WorkerCallMessage,
  type WorkerDoneMessage,
  type WorkerErrorMessage,
  type WorkerLogMessage,
  type WorkerProcsRequest,
  type WorkerReadyMessage,
  type WorkerSnapshotReply,
  type WorkerToHostMessage,
} from './protocol.ts';
import { restoreState, type StateSnapshotSkip } from './state.ts';

export interface SandboxLimits {
  /** L0 timeout for one eval's synchronous slice. Defaults to `LIMITS.syncMs`. */
  syncMs: number;
  /** Snapshot size limit. Defaults to `LIMITS.stateBytes` (1 MiB). */
  stateBytes: number;
  /** `worker.terminate()` budget. Defaults to `LIMITS.terminateMs` (3s). */
  terminateMs: number;
}

export interface SandboxEvalOptions {
  /** Unique within the execution session. */
  evalId: number;
  /** Per-eval L0 override; defaults to the sandbox's `syncMs`. */
  syncMs?: number;
}

export interface SandboxEvalOutcome {
  evalId: number;
  epoch: number;
  ok: boolean;
  result?: unknown;
  stdout: string;
  stderr: string;
  ms: number;
  truncated: TruncationFlags;
  error?: string;
  stack?: string;
  layer?: TimeoutLayer;
  /** First result after a rebuild: variables and globals were cleared. */
  contextReset: boolean;
  stateRestored: 'lastGood' | 'none';
  stateSnapshot?: 'too-large';
}

export type ToolCallHandler = (call: ToolCallRequest) => unknown | Promise<unknown>;

export type ProcsHandler = (request: WorkerProcsRequest) => unknown | Promise<unknown>;

export type SandboxWorkerFactory = (url: URL, options: WorkerOptions) => Worker;

export interface SandboxOptions {
  sessionId?: string;
  /** Defaults to `./entry.ts` next to this module. */
  entryUrl?: URL | string;
  limits?: Partial<SandboxLimits>;
  onToolCall?: ToolCallHandler;
  /** `procs.*` is not injected into the sandbox yet; supplied for wiring later. */
  onProcs?: ProcsHandler;
  onLog?: (message: WorkerLogMessage) => void;
  /** Test seam; production uses `new Worker(url, options)`. */
  workerFactory?: SandboxWorkerFactory;
  /** Ready-wait budget. Defaults to `limits.terminateMs` (3s). */
  readyTimeoutMs?: number;
  /** Snapshot-wait budget. Defaults to `limits.terminateMs` (3s). */
  snapshotTimeoutMs?: number;
}

/** Thrown when a worker could not be terminated and the sandbox is unusable. */
export class SandboxWedgedError extends Error {
  constructor(message = 'worker did not terminate within the timeout; sandbox is wedged') {
    super(message);
    this.name = 'SandboxWedgedError';
  }
}

interface PendingEval {
  evalId: number;
  epoch: number;
  startedAt: number;
  stdout: string;
  stderr: string;
  settled: boolean;
  /** `done` arrived; only the snapshot round-trip is left. */
  doneSeen: boolean;
  resolve: (outcome: SandboxEvalOutcome) => void;
  reject: (error: unknown) => void;
}

interface SnapshotWaitResult {
  buf?: ArrayBuffer;
  skipped?: StateSnapshotSkip;
}

interface SnapshotWaiter {
  worker: Worker;
  timer: NodeJS.Timeout | undefined;
  resolve: (result: SnapshotWaitResult) => void;
}

interface ReadyWaiter {
  worker: Worker;
  timer: NodeJS.Timeout | undefined;
  resolve: (value: { epoch: number }) => void;
  reject: (error: unknown) => void;
}

type OutcomeFields = Omit<SandboxEvalOutcome, 'evalId' | 'epoch' | 'contextReset' | 'stateRestored'>;

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export class Sandbox {
  readonly sessionId: string;

  private readonly entryUrl: URL;
  private readonly syncMs: number;
  private readonly stateBytes: number;
  private readonly terminateMs: number;
  private readonly readyTimeoutMs: number;
  private readonly snapshotTimeoutMs: number;
  private readonly onToolCall: ToolCallHandler | undefined;
  private readonly onProcs: ProcsHandler | undefined;
  private readonly onLog: ((message: WorkerLogMessage) => void) | undefined;
  private readonly workerFactory: SandboxWorkerFactory;

  private worker: Worker | null = null;
  private epochValue = 0;
  private wedgedValue = false;
  private createdBefore = false;
  private pendingReset = false;
  private stateRestoredValue: 'lastGood' | 'none' = 'none';
  private lastGood: ArrayBuffer | null = null;
  private starting: Promise<{ epoch: number; stateRestored: 'lastGood' | 'none' }> | null = null;
  private readyWaiter: ReadyWaiter | null = null;
  private readonly pendingEvals = new Map<number, PendingEval>();
  private readonly snapshotWaiters = new Map<number, SnapshotWaiter>();

  constructor(options: SandboxOptions = {}) {
    const limits = options.limits ?? {};
    this.sessionId = options.sessionId ?? 'sandbox';
    if (options.entryUrl === undefined) {
      this.entryUrl = new URL('./entry.ts', import.meta.url);
    } else if (typeof options.entryUrl === 'string') {
      this.entryUrl = new URL(options.entryUrl, import.meta.url);
    } else {
      this.entryUrl = options.entryUrl;
    }
    this.syncMs = limits.syncMs ?? LIMITS.syncMs;
    this.stateBytes = limits.stateBytes ?? LIMITS.stateBytes;
    this.terminateMs = limits.terminateMs ?? LIMITS.terminateMs;
    this.readyTimeoutMs = options.readyTimeoutMs ?? this.terminateMs;
    this.snapshotTimeoutMs = options.snapshotTimeoutMs ?? this.terminateMs;
    this.onToolCall = options.onToolCall;
    this.onProcs = options.onProcs;
    this.onLog = options.onLog;
    this.workerFactory = options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions));
  }

  get epoch(): number {
    return this.epochValue;
  }

  get running(): boolean {
    return this.worker !== null;
  }

  get wedged(): boolean {
    return this.wedgedValue;
  }

  /** Size of the last good snapshot, or `null` when none is stored. */
  get snapshotBytes(): number | null {
    return this.lastGood?.byteLength ?? null;
  }

  /** Starts the worker if needed and resolves once it reported `ready`. */
  async start(): Promise<{ epoch: number; stateRestored: 'lastGood' | 'none' }> {
    if (this.starting !== null) return this.starting;
    if (this.worker !== null) {
      return { epoch: this.epochValue, stateRestored: this.stateRestoredValue };
    }
    const spawned = this.spawn();
    this.starting = spawned;
    const clear = (): void => {
      if (this.starting === spawned) this.starting = null;
    };
    void spawned.then(clear, clear);
    return spawned;
  }

  /** Sends one eval. Rejects only when the worker dies; script failures are outcomes. */
  async eval(code: string, options: SandboxEvalOptions): Promise<SandboxEvalOutcome> {
    if (this.pendingEvals.has(options.evalId)) {
      throw new Error(`duplicate evalId ${options.evalId}`);
    }
    await this.start();
    const worker = this.worker;
    if (worker === null) throw new WorkerKilledError('worker is not running');

    const epoch = this.epochValue;
    const syncMs = options.syncMs ?? this.syncMs;
    const outcome = new Promise<SandboxEvalOutcome>((resolve, reject) => {
      this.pendingEvals.set(options.evalId, {
        evalId: options.evalId,
        epoch,
        startedAt: Date.now(),
        stdout: '',
        stderr: '',
        settled: false,
        doneSeen: false,
        resolve,
        reject,
      });
    });

    try {
      worker.postMessage(evalMessage(options.evalId, epoch, code, syncMs));
    } catch (error) {
      this.pendingEvals.delete(options.evalId);
      throw error;
    }
    return outcome;
  }

  /** Cooperative abort: the worker rejects in-flight and later tool calls. */
  cancel(evalId: number): void {
    const worker = this.worker;
    if (worker === null) return;
    try {
      worker.postMessage(cancelMessage(evalId));
    } catch {
      // Worker is going away; its pending evals are rejected by terminate/exit.
    }
  }

  /**
   * Asks the worker to stop. Returns `false` when `terminate()` did not settle
   * within `terminateMs`; the sandbox is then marked wedged and cannot restart.
   */
  async terminate(): Promise<boolean> {
    const worker = this.worker;
    if (worker === null) return true;
    this.worker = null;
    this.failReady(worker, new WorkerKilledError());
    this.resolveSnapshotWaiters({});
    this.rejectPending(new WorkerKilledError());

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.terminateMs);
    });
    try {
      const terminated = await Promise.race([worker.terminate().then(() => true, () => false), timedOut]);
      if (!terminated) this.wedgedValue = true;
      return terminated;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Terminates the current worker (if any) and starts a fresh one with `lastGood`. */
  async rebuild(): Promise<{ epoch: number; stateRestored: 'lastGood' | 'none' }> {
    const terminated = await this.terminate();
    if (!terminated) throw new SandboxWedgedError();
    return this.spawn();
  }

  /** Best-effort shutdown. */
  async dispose(): Promise<boolean> {
    return this.terminate();
  }

  /** Test/recovery hook: seed the snapshot used by the next `rebuild()`. */
  seedSnapshot(buf: ArrayBuffer | null): void {
    this.lastGood = buf;
  }

  private async spawn(): Promise<{ epoch: number; stateRestored: 'lastGood' | 'none' }> {
    if (this.wedgedValue) throw new SandboxWedgedError();
    const isRestart = this.createdBefore;

    const restored = restoreState(this.lastGood, this.stateBytes);
    if (restored.restored === 'none') this.lastGood = null;
    this.stateRestoredValue = restored.restored;

    const epoch = this.epochValue + 1;
    this.epochValue = epoch;

    const worker = this.workerFactory(this.entryUrl, {
      workerData: {
        sessionId: this.sessionId,
        epoch,
        state: restored.value,
        stateBytes: this.stateBytes,
      },
    });
    this.worker = worker;

    const ready = new Promise<{ epoch: number }>((resolve, reject) => {
      const waiter: ReadyWaiter = { worker, timer: undefined, resolve, reject };
      this.readyWaiter = waiter;
      const timer = setTimeout(() => {
        this.failReady(worker, new Error(`worker did not become ready within ${this.readyTimeoutMs}ms`));
      }, this.readyTimeoutMs);
      timer.unref?.();
      waiter.timer = timer;
    });

    this.attach(worker);

    try {
      const result = await ready;
      this.createdBefore = true;
      this.pendingReset = isRestart;
      return { epoch: result.epoch, stateRestored: restored.restored };
    } catch (error) {
      await this.terminate();
      throw error;
    }
  }

  private attach(worker: Worker): void {
    worker.on('message', (raw: unknown) => {
      if (this.worker !== worker || !isWorkerToHostMessage(raw)) return;
      this.handleMessage(raw);
    });
    worker.on('error', (error: Error) => {
      if (this.worker !== worker) return;
      this.handleWorkerGone(worker, new WorkerKilledError(`worker failed: ${error.message}`));
    });
    worker.on('exit', (code: number) => {
      if (this.worker !== worker) return;
      this.handleWorkerGone(worker, new WorkerKilledError(`worker exited with code ${code}`));
    });
  }

  private handleMessage(message: WorkerToHostMessage): void {
    switch (message.t) {
      case 'ready':
        this.handleReady(message);
        return;
      case 'call':
        void this.handleCall(message);
        return;
      case 'procs':
        void this.handleProcs(message);
        return;
      case 'log':
        this.handleLog(message);
        return;
      case 'done':
        this.handleDone(message);
        return;
      case 'error':
        this.handleError(message);
        return;
      case 'snapshot':
        this.handleSnapshotReply(message);
        return;
    }
  }

  private handleReady(message: WorkerReadyMessage): void {
    const waiter = this.readyWaiter;
    if (waiter === null || message.epoch !== this.epochValue) return;
    this.readyWaiter = null;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.resolve({ epoch: message.epoch });
  }

  private handleWorkerGone(worker: Worker, error: Error): void {
    if (this.worker === worker) this.worker = null;
    this.failReady(worker, error);
    // Let a done-but-not-yet-snapshotted eval resolve from its `done` payload.
    this.resolveSnapshotWaiters({});
    this.rejectPending(error);
  }

  private failReady(worker: Worker, error: unknown): void {
    const waiter = this.readyWaiter;
    if (waiter === null || waiter.worker !== worker) return;
    this.readyWaiter = null;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private rejectPending(error: unknown): void {
    for (const [evalId, pending] of this.pendingEvals) {
      if (pending.settled || pending.doneSeen) continue;
      pending.settled = true;
      this.pendingEvals.delete(evalId);
      pending.reject(error);
    }
  }

  private async handleCall(message: WorkerCallMessage): Promise<void> {
    const worker = this.worker;
    if (worker === null || message.epoch !== this.epochValue) return;

    const request: ToolCallRequest = {
      evalId: message.evalId,
      epoch: message.epoch,
      callSeq: message.callSeq,
      tool: message.tool,
      args: message.args,
    };
    if (message.server !== undefined) request.server = message.server;

    let reply;
    try {
      if (this.onToolCall === undefined) throw new Error(`no tool handler configured for ${message.tool}`);
      reply = callResultOk(message.evalId, message.callSeq, await this.onToolCall(request));
    } catch (error) {
      reply = callResultError(message.evalId, message.callSeq, errorText(error));
    }

    if (this.worker !== worker) return;
    try {
      worker.postMessage(reply);
    } catch {
      try {
        worker.postMessage(callResultError(message.evalId, message.callSeq, 'tool result is not structured-cloneable'));
      } catch {
        // Worker vanished between the two attempts.
      }
    }
  }

  private async handleProcs(message: WorkerProcsRequest): Promise<void> {
    const worker = this.worker;
    if (worker === null) return;

    let reply;
    try {
      if (this.onProcs === undefined) throw new Error('procs is not wired yet');
      reply = procsResultOk(message.evalId, message.reqSeq, await this.onProcs(message));
    } catch (error) {
      reply = procsResultError(message.evalId, message.reqSeq, errorText(error));
    }

    if (this.worker !== worker) return;
    try {
      worker.postMessage(reply);
    } catch {
      // Worker vanished.
    }
  }

  private handleLog(message: WorkerLogMessage): void {
    const pending = this.pendingEvals.get(message.evalId);
    if (pending !== undefined && !pending.settled) {
      if (message.stream === 'stderr') pending.stderr += message.text;
      else pending.stdout += message.text;
    }
    this.onLog?.(message);
  }

  private handleDone(message: WorkerDoneMessage): void {
    const pending = this.pendingEvals.get(message.evalId);
    if (pending === undefined || pending.settled) return;
    pending.doneSeen = true;
    void this.finishDone(pending, message);
  }

  private async finishDone(pending: PendingEval, message: WorkerDoneMessage): Promise<void> {
    const snapshot = await this.requestSnapshot(pending.evalId);
    const fields: OutcomeFields = {
      ok: true,
      result: message.result,
      stdout: message.stdout,
      stderr: message.stderr,
      ms: message.ms,
      truncated: message.truncated,
    };
    if (snapshot.skipped === 'too-large') fields.stateSnapshot = 'too-large';
    this.resolveOutcome(pending, fields);
  }

  private handleError(message: WorkerErrorMessage): void {
    const pending = this.pendingEvals.get(message.evalId);
    if (pending === undefined || pending.settled) return;
    const fields: OutcomeFields = {
      ok: false,
      stdout: pending.stdout,
      stderr: pending.stderr,
      ms: Date.now() - pending.startedAt,
      truncated: {},
      error: message.message,
    };
    if (message.stack !== undefined) fields.stack = message.stack;
    if (message.layer !== undefined) fields.layer = message.layer;
    this.resolveOutcome(pending, fields);
  }

  private resolveOutcome(pending: PendingEval, fields: OutcomeFields): void {
    if (pending.settled) return;
    pending.settled = true;
    this.pendingEvals.delete(pending.evalId);
    const contextReset = this.pendingReset;
    if (contextReset) this.pendingReset = false;
    pending.resolve({
      evalId: pending.evalId,
      epoch: pending.epoch,
      contextReset,
      stateRestored: this.stateRestoredValue,
      ...fields,
    });
  }

  private requestSnapshot(evalId: number): Promise<SnapshotWaitResult> {
    const worker = this.worker;
    if (worker === null) return Promise.resolve({});
    return new Promise<SnapshotWaitResult>((resolve) => {
      const waiter: SnapshotWaiter = { worker, timer: undefined, resolve };
      this.snapshotWaiters.set(evalId, waiter);
      const timer = setTimeout(() => {
        if (this.snapshotWaiters.get(evalId) !== waiter) return;
        this.snapshotWaiters.delete(evalId);
        resolve({});
      }, this.snapshotTimeoutMs);
      timer.unref?.();
      waiter.timer = timer;
      try {
        worker.postMessage(snapshotRequest(evalId));
      } catch {
        if (this.snapshotWaiters.get(evalId) === waiter) this.snapshotWaiters.delete(evalId);
        clearTimeout(timer);
        resolve({});
      }
    });
  }

  private handleSnapshotReply(message: WorkerSnapshotReply): void {
    const waiter = this.snapshotWaiters.get(message.evalId);
    if (waiter === undefined) return;
    this.snapshotWaiters.delete(message.evalId);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);

    if (message.skipped !== undefined) {
      waiter.resolve({ skipped: message.skipped });
      return;
    }
    if (message.buf.byteLength === 0 || message.buf.byteLength > this.stateBytes) {
      waiter.resolve({ skipped: message.buf.byteLength === 0 ? undefined : 'too-large' });
      return;
    }
    this.lastGood = message.buf;
    waiter.resolve({ buf: message.buf });
  }

  private resolveSnapshotWaiters(result: SnapshotWaitResult): void {
    for (const waiter of this.snapshotWaiters.values()) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    this.snapshotWaiters.clear();
  }
}
