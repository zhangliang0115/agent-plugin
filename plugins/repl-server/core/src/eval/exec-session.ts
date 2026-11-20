/**
 * One execution session: eval ids, the synchronous lock, worker epochs and
 * tool-call acceptance.
 *
 * Contract (learn-ai `claude-code/自建设计/02-执行体与进程治理.md` §1.4–1.5, §5.5):
 *
 * - `lock` serializes synchronous evals. Asynchronous evals hold it only while
 *   they are dispatched and release it immediately afterwards.
 * - At most `limits.inFlightLimit` (frozen default 8) evals may be in flight;
 *   the next registration is `CAPACITY_EXCEEDED` instead of queueing.
 * - A worker message is accepted only when `(epoch, evalId, callSeq)` matches a
 *   live, accepting eval whose epoch is current and whose `callSeq` has never
 *   been seen. Everything else is dropped.
 * - `settleEval` is idempotent: `ev.settled` is the only gate, so a normal
 *   finish and a hard wall can race without settling one eval twice.
 *
 * This module owns no audit and no process bookkeeping; `onEvent` is the seam
 * the assembly layer uses for both.
 * @module
 */
import { LIMITS } from '../constants.ts';
import { ReplError, StaleEvalError } from '../errors.ts';
import type { TimeoutInfo, TimeoutLayer, ToolCallRequest, TruncationFlags } from '../types.ts';
import { hardStop, type HardStopReport } from './stop.ts';

/** Terminal classification of one eval, aligned with `eval_end.outcome`. */
export type EvalOutcome = 'ok' | 'error' | 'timeout' | 'cancelled' | 'worker_dead';

/** Final state of one eval. Shared by synchronous results, task events and audit. */
export interface EvalSettlement {
  evalId: number;
  epoch: number;
  async: boolean;
  ok: boolean;
  outcome: EvalOutcome;
  result?: unknown;
  stdout: string;
  stderr: string;
  ms: number;
  truncated: TruncationFlags;
  error?: string;
  stack?: string;
  layer?: TimeoutLayer;
  timeout?: TimeoutInfo;
  contextReset: boolean;
  stateRestored: 'lastGood' | 'none';
  stateSnapshot?: 'too-large';
  budget: { calls: number };
  evalTaskId?: string;
  stoppedBy?: 'user' | 'refusal';
  neverRan?: 'person' | 'other';
  /** Present only on the immediate `async: true` dispatch receipt. */
  asyncDispatched?: boolean;
}

/** Fields a settlement call supplies; the session fills defaults and counters. */
export interface EvalSettlementFields {
  ok: boolean;
  outcome?: EvalOutcome;
  result?: unknown;
  stdout?: string;
  stderr?: string;
  ms?: number;
  truncated?: TruncationFlags;
  error?: string;
  stack?: string;
  layer?: TimeoutLayer;
  contextReset?: boolean;
  stateRestored?: 'lastGood' | 'none';
  stateSnapshot?: 'too-large';
  stoppedBy?: 'user' | 'refusal';
  neverRan?: 'person' | 'other';
}

/** The slice of an executor outcome this layer consumes. */
export interface EvalExecutorOutcome {
  ok: boolean;
  result?: unknown;
  stdout?: string;
  stderr?: string;
  ms?: number;
  truncated?: TruncationFlags;
  error?: string;
  stack?: string;
  layer?: TimeoutLayer;
  contextReset?: boolean;
  stateRestored?: 'lastGood' | 'none';
  stateSnapshot?: 'too-large';
}

/**
 * The executor seam. `Sandbox` satisfies it structurally: `start()` is
 * idempotent and reports the current worker epoch, `eval` resolves script
 * failures as outcomes, `cancel` is cooperative and `terminate` destroys the
 * worker (returning `false` when it stayed alive).
 */
export interface EvalExecutor {
  readonly epoch: number;
  start(): Promise<{ epoch: number }>;
  eval(code: string, options: { evalId: number; syncMs?: number }): Promise<EvalExecutorOutcome>;
  cancel(evalId: number): void;
  terminate(timeoutMs?: number): Promise<boolean>;
}

/** One accepted tool call. `complete()` is idempotent. */
export interface InflightCall {
  readonly callSeq: number;
  readonly controller: AbortController;
  readonly startedAt: number;
}

/** Live eval record. Only the session and the stop helpers mutate it. */
export interface ActiveEval {
  readonly evalId: number;
  readonly epoch: number;
  readonly async: boolean;
  /** Omitted means the eval has no wall-clock deadline. */
  readonly timeoutMs?: number;
  readonly deadline?: number;
  readonly startedAt: number;
  /** L2 soft wall clears this; no new tool calls are accepted afterwards. */
  accepting: boolean;
  readonly abort: AbortController;
  readonly inflight: Map<number, InflightCall>;
  /** Call sequences that already produced a result, so a replay is dropped. */
  readonly completedCallSeqs: Set<number>;
  calls: number;
  /** Set by `softStop`; drives "always rebuild after L2" in the run loop. */
  stopLayer?: TimeoutLayer;
  /** Set by `hardStop` so the same eval cannot trigger a second worker reset. */
  stopped: boolean;
  settled: boolean;
  settlement?: EvalSettlement;
  readonly completed: Promise<EvalSettlement>;
  readonly resolveCompleted: (settlement: EvalSettlement) => void;
  evalTaskId?: string;
  softTimer?: ReturnType<typeof setTimeout>;
  hardTimer?: ReturnType<typeof setTimeout>;
}

/** Why a tool-call message was dropped instead of executed. */
export type ToolCallDropReason =
  | 'unknown_eval'
  | 'stale_epoch'
  | 'not_accepting'
  | 'invalid_call_seq'
  | 'duplicate_call';

/** Accepted `(epoch, evalId, callSeq)` triple handed to the tool bridge. */
export interface AcceptedToolCall {
  readonly request: ToolCallRequest;
  readonly signal: AbortSignal;
  readonly evalId: number;
  readonly callSeq: number;
  complete(): void;
}

/** Wiring hook for audit and admin events; observer errors never escape. */
export type EvalSessionEvent =
  | { type: 'eval_start'; evalId: number; epoch: number; async: boolean; timeoutMs?: number }
  | { type: 'eval_settle'; settlement: EvalSettlement }
  | { type: 'tool_call_dropped'; evalId: number; epoch: number; callSeq: number; reason: ToolCallDropReason }
  | { type: 'worker_reset'; report: HardStopReport };

/** Kadence and quota knobs. Defaults are frozen in `constants.ts`. */
export interface ExecSessionLimits {
  /** L0 synchronous slice. Defaults to `LIMITS.syncMs`. */
  syncMs: number;
  /** Observation window between the soft and hard walls. Defaults to `LIMITS.graceMs`. */
  graceMs: number;
  /** `worker.terminate()` budget. Defaults to `LIMITS.terminateMs`. */
  terminateMs: number;
  /** In-flight evals per execution session. Defaults to `LIMITS.inFlightPerExecSession`. */
  inFlightLimit: number;
}

export const DEFAULT_EXEC_SESSION_LIMITS: ExecSessionLimits = {
  syncMs: LIMITS.syncMs,
  graceMs: LIMITS.graceMs,
  terminateMs: LIMITS.terminateMs,
  inFlightLimit: LIMITS.inFlightPerExecSession,
};

/** The serve handle a hard wall may restart. */
export interface EvalServe {
  healthy(): boolean;
  restart(): Promise<void> | void;
}

/**
 * Resolves the serve handle for one execution session. The gateway passes a
 * resolver so every session inspects its own serve process instead of a
 * process-wide flag.
 */
export type ServeResolver = (execSessionId: string) => EvalServe | undefined;

export interface ExecSessionOptions {
  /** `es_...`; unique per process. */
  id: string;
  /** Workspace realpath this session is bound to; informational here. */
  workspace?: string;
  /**
   * Creates the worker on first use and again after a hard wall. Returning the
   * same rebuildable executor (for example one `Sandbox`) is allowed; its
   * `start()` must be idempotent and respawn with the last `state` snapshot.
   */
  createExecutor: (session: ExecSession) => EvalExecutor;
  /** Serve handle or per-session resolver, used by the L3 hard wall. */
  serve?: EvalServe | ServeResolver;
  limits?: Partial<ExecSessionLimits>;
  /** Time source for deadlines and timestamps. Defaults to `Date.now`. */
  now?: () => number;
  onEvent?: (event: EvalSessionEvent) => void;
}

export interface BeginEvalOptions {
  async: boolean;
  /** Omitted means no wall-clock deadline. */
  timeoutMs?: number;
  evalTaskId?: string;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function assertLimit(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite number >= ${minimum}, got ${String(value)}`);
  }
}

/**
 * FIFO one-at-a-time lock. Unlike `RwLock` this is *not* reentrant and is meant
 * for the session's synchronous eval lane.
 */
export class EvalLock {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  get held(): boolean {
    return this.locked;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.locked = true;
    }

    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next === undefined) {
        this.locked = false;
      } else {
        // The lock stays held across the handoff.
        next();
      }
    }
  }
}

/**
 * One execution session.
 *
 * `beginEval` registers the eval and lazily creates/restarts the executor;
 * `settleEval` is the only terminal transition. Tool messages go through
 * `acceptToolCall`, which enforces the `(epoch, evalId, callSeq)` triple.
 */
export class ExecSession {
  readonly id: string;
  readonly workspace: string;
  readonly limits: ExecSessionLimits;
  readonly lock = new EvalLock();

  private readonly createExecutor: (session: ExecSession) => EvalExecutor;
  private readonly resolveServe: ServeResolver;
  private readonly nowFn: () => number;
  private readonly onEvent: ((event: EvalSessionEvent) => void) | undefined;

  private executorValue: EvalExecutor | null = null;
  private starting: Promise<EvalExecutor> | null = null;
  private resetRun: Promise<unknown> | null = null;
  private workerEpochValue = 0;
  private evalSeq = 0;
  private inFlight = 0;
  private lastEvalAtValue = 0;
  private lastWorkerResetValue: HardStopReport | undefined;
  private readonly active = new Map<number, ActiveEval>();

  constructor(options: ExecSessionOptions) {
    if (typeof options.id !== 'string' || options.id === '') {
      throw new TypeError('exec session id must be a non-empty string');
    }
    this.id = options.id;
    this.workspace = options.workspace ?? '';
    this.createExecutor = options.createExecutor;
    const serve = options.serve;
    this.resolveServe =
      typeof serve === 'function'
        ? serve
        : () => serve;
    this.nowFn = options.now ?? (() => Date.now());
    this.onEvent = options.onEvent;

    const limits: ExecSessionLimits = { ...DEFAULT_EXEC_SESSION_LIMITS, ...options.limits };
    assertLimit('syncMs', limits.syncMs, 1);
    assertLimit('graceMs', limits.graceMs, 0);
    assertLimit('terminateMs', limits.terminateMs, 1);
    assertLimit('inFlightLimit', limits.inFlightLimit, 1);
    this.limits = limits;
    this.lastEvalAtValue = this.nowFn();
  }

  get executor(): EvalExecutor | null {
    return this.executorValue;
  }

  /**
   * Hot-applies limits that do not affect an eval already in flight. Today this
   * is the per-session in-flight quota (`PATCH /settings` capacity changes);
   * timeout budgets stay fixed for the process lifetime.
   */
  updateLimits(limits: Partial<ExecSessionLimits>): ExecSessionLimits {
    if (limits.inFlightLimit !== undefined) {
      assertLimit('inFlightLimit', limits.inFlightLimit, 1);
      this.limits.inFlightLimit = limits.inFlightLimit;
    }
    return this.limits;
  }

  /** Current worker generation. Messages from another epoch are dropped. */
  get workerEpoch(): number {
    return this.workerEpochValue;
  }

  get inFlightEvals(): number {
    return this.inFlight;
  }

  get lastEvalAt(): number {
    return this.lastEvalAtValue;
  }

  get activeEvals(): ReadonlyMap<number, ActiveEval> {
    return this.active;
  }

  /** The reset currently in progress, if any. Lazy executor creation waits on it. */
  get resetting(): Promise<unknown> | null {
    return this.resetRun;
  }

  get lastWorkerReset(): HardStopReport | undefined {
    return this.lastWorkerResetValue;
  }

  now(): number {
    return this.nowFn();
  }

  /**
   * Registers one eval and makes sure a worker exists.
   *
   * The capacity check runs before any worker is started, and the registration
   * itself is synchronous, so the in-flight count can never exceed the limit
   * even when several dispatches interleave.
   */
  async beginEval(options: BeginEvalOptions): Promise<ActiveEval> {
    if (this.inFlight >= this.limits.inFlightLimit) {
      throw new ReplError(
        'CAPACITY_EXCEEDED',
        `execution session ${this.id} has ${this.inFlight} evals in flight (limit ${this.limits.inFlightLimit})`,
      );
    }
    // Reserve the slot before the first `await`: registration stays exact even
    // if a caller bypasses the session lock.
    this.inFlight += 1;

    try {
      await this.ensureExecutor();
    } catch (error) {
      this.inFlight -= 1;
      throw error;
    }
    const evalId = this.evalSeq + 1;
    this.evalSeq = evalId;

    const startedAt = this.nowFn();
    const completion = deferred<EvalSettlement>();
    const ev: ActiveEval = {
      evalId,
      epoch: this.workerEpochValue,
      async: options.async,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs, deadline: startedAt + options.timeoutMs }),
      startedAt,
      accepting: true,
      abort: new AbortController(),
      inflight: new Map(),
      completedCallSeqs: new Set(),
      calls: 0,
      stopped: false,
      settled: false,
      completed: completion.promise,
      resolveCompleted: completion.resolve,
    };
    if (options.evalTaskId !== undefined) ev.evalTaskId = options.evalTaskId;

    this.active.set(evalId, ev);
    this.lastEvalAtValue = startedAt;
    this.emit({
      type: 'eval_start',
      evalId,
      epoch: ev.epoch,
      async: ev.async,
      ...(ev.timeoutMs === undefined ? {} : { timeoutMs: ev.timeoutMs }),
    });
    return ev;
  }

  /**
   * Terminal transition. Idempotent: a replay returns the first settlement
   * without touching counters, timers or the task table.
   */
  settleEval(ev: ActiveEval, fields: EvalSettlementFields): EvalSettlement {
    if (ev.settled && ev.settlement !== undefined) return ev.settlement;

    ev.settled = true;
    ev.accepting = false;
    this.clearTimers(ev);
    // No call can belong to a settled eval; abort the stragglers so the bridge
    // does not keep waiting on a result the worker will never route.
    const stale = new StaleEvalError();
    for (const call of ev.inflight.values()) {
      try {
        call.controller.abort(stale);
      } catch {
        // An already-aborted controller keeps its original reason.
      }
    }
    ev.inflight.clear();
    if (this.active.get(ev.evalId) === ev) this.active.delete(ev.evalId);
    if (this.inFlight > 0) this.inFlight -= 1;
    this.lastEvalAtValue = this.nowFn();

    const settlement: EvalSettlement = {
      evalId: ev.evalId,
      epoch: ev.epoch,
      async: ev.async,
      ok: fields.ok,
      outcome: fields.outcome ?? (fields.ok ? 'ok' : 'error'),
      stdout: fields.stdout ?? '',
      stderr: fields.stderr ?? '',
      ms: fields.ms ?? Math.max(0, this.nowFn() - ev.startedAt),
      truncated: fields.truncated ?? {},
      contextReset: fields.contextReset ?? false,
      stateRestored: fields.stateRestored ?? 'none',
      budget: { calls: ev.calls },
    };
    if (fields.result !== undefined) settlement.result = fields.result;
    if (fields.error !== undefined) settlement.error = fields.error;
    if (fields.stack !== undefined) settlement.stack = fields.stack;
    if (fields.stateSnapshot !== undefined) settlement.stateSnapshot = fields.stateSnapshot;
    if (fields.stoppedBy !== undefined) settlement.stoppedBy = fields.stoppedBy;
    if (fields.neverRan !== undefined) settlement.neverRan = fields.neverRan;
    if (ev.evalTaskId !== undefined) settlement.evalTaskId = ev.evalTaskId;

    const layer = fields.layer;
    if (layer !== undefined) {
      settlement.layer = layer;
      const limitMs = layer === 'sync' ? this.limits.syncMs : ev.timeoutMs;
      if (limitMs !== undefined) settlement.timeout = { layer, limitMs };
    }

    ev.settlement = settlement;
    ev.resolveCompleted(settlement);
    this.emit({ type: 'eval_settle', settlement });
    return settlement;
  }

  /**
   * Accepts one tool-call message.
   *
   * Returns `undefined` — and emits `tool_call_dropped` — for an unknown eval, a
   * stale worker epoch, a soft-stopped eval, or a call sequence that is either
   * still in flight or already completed.
   */
  acceptToolCall(request: ToolCallRequest): AcceptedToolCall | undefined {
    const ev = this.active.get(request.evalId);
    if (ev === undefined || ev.settled) {
      this.drop(request, 'unknown_eval');
      return undefined;
    }
    if (request.epoch !== this.workerEpochValue) {
      this.drop(request, 'stale_epoch');
      return undefined;
    }
    if (!ev.accepting) {
      this.drop(request, 'not_accepting');
      return undefined;
    }
    if (!Number.isInteger(request.callSeq) || request.callSeq <= 0) {
      this.drop(request, 'invalid_call_seq');
      return undefined;
    }
    if (ev.inflight.has(request.callSeq) || ev.completedCallSeqs.has(request.callSeq)) {
      this.drop(request, 'duplicate_call');
      return undefined;
    }
    ev.calls += 1;
    const controller = new AbortController();
    const call: InflightCall = {
      callSeq: request.callSeq,
      controller,
      startedAt: this.nowFn(),
    };
    ev.inflight.set(request.callSeq, call);

    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      ev.inflight.delete(request.callSeq);
      ev.completedCallSeqs.add(request.callSeq);
    };

    return {
      request,
      signal: controller.signal,
      evalId: request.evalId,
      callSeq: request.callSeq,
      complete,
    };
  }

  /**
   * Convenience wrapper for the sandbox bridge: validates the triple, runs the
   * call, and retires the sequence even when the tool fails.
   * A dropped message throws `StaleEvalError`; the worker ignores the answer.
   */
  async handleToolCall<T>(
    request: ToolCallRequest,
    execute: (call: AcceptedToolCall) => Promise<T> | T,
  ): Promise<T> {
    const call = this.acceptToolCall(request);
    if (call === undefined) throw new StaleEvalError();
    try {
      return await execute(call);
    } finally {
      call.complete();
    }
  }

  clearTimers(ev: ActiveEval): void {
    if (ev.softTimer !== undefined) {
      clearTimeout(ev.softTimer);
      ev.softTimer = undefined;
    }
    if (ev.hardTimer !== undefined) {
      clearTimeout(ev.hardTimer);
      ev.hardTimer = undefined;
    }
  }

  /** Sends the cooperative `cancel` message; a gone worker is ignored. */
  cancelExecutorEval(evalId: number): void {
    const executor = this.executorValue;
    if (executor === null) return;
    try {
      executor.cancel(evalId);
    } catch {
      // The worker is already terminating; its pending evals are rejected there.
    }
  }

  /** Increments the epoch before a terminate so late messages are invalid. */
  bumpWorkerEpoch(): number {
    this.workerEpochValue += 1;
    return this.workerEpochValue;
  }

  /** Detaches the executor so the next eval lazily builds a fresh worker. */
  detachExecutor(): EvalExecutor | null {
    const executor = this.executorValue;
    this.executorValue = null;
    return executor;
  }

  /**
   * Coalesces concurrent hard stops. The first caller runs `fn`; later callers
   * await the same reset instead of terminating the worker twice.
   */
  runWorkerReset<T>(fn: () => Promise<T>): Promise<T> {
    if (this.resetRun !== null) return this.resetRun as Promise<T>;
    const run = fn();
    this.resetRun = run as Promise<unknown>;
    const clear = (): void => {
      if (this.resetRun === run) this.resetRun = null;
    };
    void run.then(clear, clear);
    return run;
  }

  private serveHandle(): EvalServe | undefined {
    try {
      return this.resolveServe(this.id);
    } catch {
      return undefined;
    }
  }

  serveHealthy(): boolean {
    const serve = this.serveHandle();
    if (serve === undefined) return true;
    try {
      return serve.healthy();
    } catch {
      return false;
    }
  }

  /** Returns true when a restart was attempted and did not throw. */
  async restartServe(): Promise<boolean> {
    const serve = this.serveHandle();
    if (serve === undefined) return false;
    try {
      await serve.restart();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Idle hibernation: terminates the worker but keeps the executor attached, so
   * the next eval respawns it through `start()` and restores the last `state`
   * snapshot. A no-op while any eval is registered or when no worker was ever
   * built. Returns true when a live worker was terminated cleanly.
   */
  async hibernateWorker(): Promise<boolean> {
    const reset = this.resetRun;
    if (reset !== null) {
      try {
        await reset;
      } catch {
        // The reset owner already observed the failure.
      }
    }
    if (this.inFlight > 0 || this.active.size > 0) return false;
    const executor = this.executorValue;
    if (executor === null) return false;

    let terminated = true;
    try {
      terminated = await executor.terminate(this.limits.terminateMs);
    } catch {
      terminated = false;
    }
    // A request may have started an eval while the old worker was terminating;
    // its new epoch is valid, so it must not be bumped away.
    if (this.inFlight > 0 || this.active.size > 0) return false;
    // A wedged worker keeps the executor; its next start() reports the problem.
    this.bumpWorkerEpoch();
    return terminated;
  }

  notifyWorkerReset(report: HardStopReport): void {
    this.lastWorkerResetValue = report;
    this.emit({ type: 'worker_reset', report });
  }

  /**
   * Session teardown: terminates any running eval, then disposes an idle worker.
   * Safe to call twice.
   */
  async dispose(): Promise<void> {
    for (let round = 0; round < 3 && this.active.size > 0; round += 1) {
      const first = this.active.values().next().value;
      if (first === undefined) break;
      try {
        await hardStop(this, first, 'wall');
      } catch {
        // Fall through to the direct settlement below; teardown must finish.
      }
    }

    for (const ev of [...this.active.values()]) {
      this.settleEval(ev, { ok: false, outcome: 'worker_dead', error: 'session disposed' });
    }

    const reset = this.resetRun;
    if (reset !== null) {
      try {
        await reset;
      } catch {
        // The reset owner already observed the failure.
      }
    }

    const executor = this.detachExecutor();
    if (executor !== null) {
      try {
        await executor.terminate(this.limits.terminateMs);
      } catch {
        // A wedged worker is accepted here; the process layer owns escalation.
      }
    }
    this.bumpWorkerEpoch();
  }

  private drop(request: ToolCallRequest, reason: ToolCallDropReason): void {
    this.emit({
      type: 'tool_call_dropped',
      evalId: request.evalId,
      epoch: request.epoch,
      callSeq: request.callSeq,
      reason,
    });
  }

  private emit(event: EvalSessionEvent): void {
    if (this.onEvent === undefined) return;
    try {
      this.onEvent(event);
    } catch {
      // Observers must never break eval bookkeeping.
    }
  }

  private async ensureExecutor(): Promise<EvalExecutor> {
    const reset = this.resetRun;
    if (reset !== null) {
      try {
        await reset;
      } catch {
        // The reset owner already observed the failure.
      }
    }

    if (this.executorValue !== null) {
      const started = await this.executorValue.start();
      this.workerEpochValue = started.epoch;
      return this.executorValue;
    }
    if (this.starting !== null) return this.starting;

    const executor = this.createExecutor(this);
    const starting = (async (): Promise<EvalExecutor> => {
      const started = await executor.start();
      this.executorValue = executor;
      this.workerEpochValue = started.epoch;
      return executor;
    })();
    const clear = (): void => {
      if (this.starting === starting) this.starting = null;
    };
    void starting.then(clear, clear);
    this.starting = starting;
    return starting;
  }
}
