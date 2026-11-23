/**
 * Concurrency gates for third-party MCP tool calls.
 *
 * - `ServerGates`: one `RwLock` per server (`parallel` = read, `serial` = write),
 *   plus one bounded `Semaphore` per binding x server pair.
 * - `ExclusiveGate`: a global admission gate. It closes admission first, waits
 *   for every admitted call to drain, then runs the exclusive call alone.
 *
 * @module
 */

import { RwLock, Semaphore } from './concurrency.ts';
import { LIMITS } from './constants.ts';
import { ReplError } from './errors.ts';

export type ConcurrencyPolicy = 'parallel' | 'serial' | 'exclusive';

/**
 * Why a call is waiting inside `ServerGates`. Observation only: it is reported
 * to the caller so the audit row can say where the time went, and never
 * changes scheduling. The per-binding quota waits one layer up, in
 * `PoolGates`, and reports `binding-quota` itself.
 */
export type ServerGateWaitReason = 'server-write-lock' | 'exclusive-gate';

/**
 * How long an exclusive call may wait for admission before `EXCLUSIVE_TIMEOUT`.
 * Frozen by docs/protocol.md §8. `LIMITS` has no field for it yet; tests inject
 * a smaller value through the constructors.
 */
export const EXCLUSIVE_TIMEOUT_MS = 30_000;

export interface ExclusiveGateOptions {
  /** Max wait to become exclusive. Defaults to `EXCLUSIVE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface ServerGatesOptions {
  /** Calls in flight per binding x server. Defaults to `LIMITS.callsPerBindingPerServer`. */
  callsPerBinding?: number;
  /** Calls waiting per binding x server. Defaults to `LIMITS.queuedPerBindingPerServer`. */
  queuedPerBinding?: number;
  /** Max wait to become exclusive. Defaults to `EXCLUSIVE_TIMEOUT_MS` (30s). */
  exclusiveTimeoutMs?: number;
}

interface AdmissionWaiter {
  resolve: () => void;
}

type ExclusiveState = 'queued' | 'draining' | 'running' | 'done';

interface ExclusiveWaiter {
  fn: () => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  state: ExclusiveState;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface ExclusiveAttempt {
  readonly waiter: ExclusiveWaiter;
}

/**
 * Global exclusive gate.
 *
 * Normal calls use {@link ExclusiveGate.admit}: they are admitted in parallel
 * while admission is open and become part of the global in-flight count.
 * {@link ExclusiveGate.run} closes admission synchronously (new calls queue),
 * waits for the in-flight count to reach zero, runs the call alone, then lets
 * the next exclusive caller in — or reopens admission when no exclusive call
 * is waiting. A wait longer than the configured timeout rejects with
 * `EXCLUSIVE_TIMEOUT` without ever starting the call.
 */
export class ExclusiveGate {
  /** Max wait used when `run` is called without an explicit timeout. */
  readonly timeoutMs: number;

  private admissionOpen = true;
  private inFlight = 0;
  private readonly admissionWaiters: AdmissionWaiter[] = [];
  private readonly drainWaiters: Array<() => void> = [];
  private readonly exclusiveQueue: ExclusiveWaiter[] = [];
  private activeAttempt: ExclusiveAttempt | null = null;

  constructor(options: ExclusiveGateOptions = {}) {
    const timeoutMs = options.timeoutMs ?? EXCLUSIVE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('timeoutMs must be a non-negative number');
    }
    this.timeoutMs = timeoutMs;
  }

  /** True while an exclusive call owns the gate and new calls are queueing. */
  get admissionClosed(): boolean {
    return !this.admissionOpen;
  }

  /** Number of admitted (non-exclusive) calls currently executing. */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /** Number of exclusive calls waiting for their turn. */
  get queuedExclusiveCount(): number {
    return this.exclusiveQueue.length;
  }

  /**
   * Runs a non-exclusive call under the global admission gate.
   * The admission check and the in-flight increment happen in one synchronous
   * block, so a call can never slip in after admission has been closed.
   */
  async admit<T>(fn: () => Promise<T> | T): Promise<T> {
    while (true) {
      if (this.admissionOpen) {
        this.inFlight += 1;
        break;
      }
      await new Promise<void>((resolve) => this.admissionWaiters.push({ resolve }));
    }

    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) this.releaseDrainWaiters();
    }
  }

  /**
   * Runs `fn` with global exclusivity.
   * Rejects with `EXCLUSIVE_TIMEOUT` if the wait (queueing behind another
   * exclusive call, draining in-flight calls, or both) exceeds `timeoutMs`.
   * The execution of `fn` itself is not bounded here.
   */
  run<T>(fn: () => Promise<T> | T, timeoutMs: number = this.timeoutMs): Promise<T> {
    return this.enqueue(fn as () => Promise<unknown> | unknown, timeoutMs) as Promise<T>;
  }

  private enqueue(fn: () => Promise<unknown> | unknown, timeoutMs: number): Promise<unknown> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new RangeError('timeoutMs must be a non-negative number'));
    }

    return new Promise<unknown>((resolve, reject) => {
      const waiter: ExclusiveWaiter = {
        fn,
        resolve,
        reject,
        state: 'queued',
        timeoutMs,
        timer: undefined,
      };
      waiter.timer = setTimeout(() => this.expire(waiter), timeoutMs);
      this.exclusiveQueue.push(waiter);
      this.pump();
    });
  }

  /** Grants the next exclusive waiter, or reopens admission when none is left. */
  private pump(): void {
    if (this.activeAttempt !== null) return;

    let waiter = this.exclusiveQueue.shift();
    while (waiter !== undefined && waiter.state !== 'queued') {
      waiter = this.exclusiveQueue.shift();
    }

    if (waiter === undefined) {
      this.admissionOpen = true;
      this.releaseAdmissionWaiters();
      return;
    }

    // Close admission before waiting: otherwise a steady stream of parallel
    // calls could keep the in-flight count above zero forever.
    this.admissionOpen = false;
    const attempt: ExclusiveAttempt = { waiter };
    this.activeAttempt = attempt;
    waiter.state = 'draining';
    void this.drainAndRun(attempt);
  }

  private async drainAndRun(attempt: ExclusiveAttempt): Promise<void> {
    try {
      await this.waitForDrain();
      // The attempt may have timed out while draining; `expire` cleared it.
      if (this.activeAttempt !== attempt) return;
      if (attempt.waiter.state !== 'draining') return;

      attempt.waiter.state = 'running';
      this.clearTimer(attempt.waiter);

      try {
        const value = await attempt.waiter.fn();
        attempt.waiter.state = 'done';
        attempt.waiter.resolve(value);
      } catch (error) {
        attempt.waiter.state = 'done';
        attempt.waiter.reject(error);
      }
    } finally {
      if (this.activeAttempt === attempt) {
        this.activeAttempt = null;
        this.pump();
      }
    }
  }

  private waitForDrain(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private releaseDrainWaiters(): void {
    if (this.drainWaiters.length === 0) return;
    const waiters = this.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private releaseAdmissionWaiters(): void {
    if (this.admissionWaiters.length === 0) return;
    const waiters = this.admissionWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  private expire(waiter: ExclusiveWaiter): void {
    waiter.timer = undefined;

    if (waiter.state === 'queued') {
      const index = this.exclusiveQueue.indexOf(waiter);
      if (index !== -1) this.exclusiveQueue.splice(index, 1);
      waiter.state = 'done';
      waiter.reject(this.timeoutError(waiter.timeoutMs));
      return;
    }

    if (waiter.state === 'draining') {
      waiter.state = 'done';
      waiter.reject(this.timeoutError(waiter.timeoutMs));
      if (this.activeAttempt?.waiter === waiter) {
        // Stop owning the gate now. The stale drain promise resolves later
        // and sees that this attempt is no longer active.
        this.activeAttempt = null;
        this.pump();
      }
    }
  }

  private clearTimer(waiter: ExclusiveWaiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
  }

  private timeoutError(timeoutMs: number): ReplError {
    return new ReplError('EXCLUSIVE_TIMEOUT', `exclusive gate wait exceeded ${timeoutMs}ms`);
  }
}

/**
 * Concurrency gates for MCP tool calls.
 *
 * `parallel` takes the server's read lock, `serial` its write lock, so a serial
 * call drains in-flight parallel calls and blocks new ones. Every non-exclusive
 * call also passes through a per binding x server `Semaphore`: at most
 * `callsPerBinding` run at once; a call that would queue beyond
 * `queuedPerBinding` rejects with `MCP_QUEUE_FULL` instead of queueing forever.
 * `exclusive` is global: it ignores the server lock and the per-binding quota,
 * and waits for every admitted call on every server to finish.
 */
export class ServerGates {
  /** In-flight limit for one binding x server pair. */
  readonly callsPerBinding: number;
  /** Queue limit for one binding x server pair. */
  readonly queuedPerBinding: number;
  /** Global exclusive gate shared by every server. */
  readonly exclusiveGate: ExclusiveGate;

  private readonly locks = new Map<string, RwLock>();
  private readonly semaphores = new Map<string, Map<string | null, Semaphore>>();

  constructor(options: ServerGatesOptions = {}) {
    this.callsPerBinding = options.callsPerBinding ?? LIMITS.callsPerBindingPerServer;
    this.queuedPerBinding = options.queuedPerBinding ?? LIMITS.queuedPerBindingPerServer;

    if (!Number.isInteger(this.callsPerBinding) || this.callsPerBinding < 1) {
      throw new RangeError('callsPerBinding must be a positive integer');
    }
    if (!Number.isInteger(this.queuedPerBinding) || this.queuedPerBinding < 0) {
      throw new RangeError('queuedPerBinding must be a non-negative integer');
    }

    this.exclusiveGate = new ExclusiveGate({ timeoutMs: options.exclusiveTimeoutMs });
  }

  /**
   * Runs one tool call under the gates.
   *
   * @param server target MCP server id (used by `parallel` / `serial`; ignored by `exclusive`)
   * @param policy concurrency policy declared for the tool
   * @param binding client binding; `null` groups unbound clients together
   * @param fn the actual call
   * @param onWait called before each await this call does on a gate, so it can
   *   fire more than once (write lock first, then admission). Callers that only
   *   want one label keep the first. The checks race the grants, so treat the
   *   result as "most likely waited because of X" rather than a proof.
   */
  async withTool<T>(
    server: string,
    policy: ConcurrencyPolicy,
    binding: string | null,
    fn: () => Promise<T> | T,
    onWait?: (reason: ServerGateWaitReason) => void,
  ): Promise<T> {
    if (policy === 'exclusive') {
      const gate = this.exclusiveGate;
      if (gate.admissionClosed || gate.inFlightCount > 0 || gate.queuedExclusiveCount > 0) {
        onWait?.('exclusive-gate');
      }
      return gate.run(fn);
    }
    if (policy !== 'parallel' && policy !== 'serial') {
      throw new ReplError('INVALID_ARGUMENT', `unknown concurrency policy: ${String(policy)}`);
    }

    const semaphore = this.semaphoreFor(server, binding);
    if (semaphore.running >= this.callsPerBinding && semaphore.queued >= this.queuedPerBinding) {
      throw new ReplError(
        'MCP_QUEUE_FULL',
        `binding ${binding ?? 'unbound'} already queues ${semaphore.queued} calls for server ${server} ` +
          `(limit ${this.queuedPerBinding})`,
      );
    }

    const lock = this.lockFor(server);
    if (policy === 'serial') {
      if (lock.writing || lock.activeReaders > 0 || lock.pendingWriters > 0) onWait?.('server-write-lock');
    } else if (lock.writing || lock.pendingWriters > 0) {
      onWait?.('server-write-lock');
    }
    if (this.exclusiveGate.admissionClosed || this.exclusiveGate.queuedExclusiveCount > 0) {
      onWait?.('exclusive-gate');
    }

    const admitted = () => this.exclusiveGate.admit(fn);
    // The binding semaphore is outermost so one binding cannot flood the
    // server's RwLock queue; admission is innermost so only calls that are
    // actually executing count toward the exclusive gate's in-flight number.
    return semaphore.run(() => (policy === 'serial' ? lock.write(admitted) : lock.read(admitted)));
  }

  private semaphoreFor(server: string, binding: string | null): Semaphore {
    let perBinding = this.semaphores.get(server);
    if (perBinding === undefined) {
      perBinding = new Map();
      this.semaphores.set(server, perBinding);
    }
    let semaphore = perBinding.get(binding);
    if (semaphore === undefined) {
      semaphore = new Semaphore(this.callsPerBinding);
      perBinding.set(binding, semaphore);
    }
    return semaphore;
  }

  private lockFor(server: string): RwLock {
    let lock = this.locks.get(server);
    if (lock === undefined) {
      lock = new RwLock();
      this.locks.set(server, lock);
    }
    return lock;
  }
}

export interface KeyedGateOptions {
  /** Calls allowed to run at once inside one lane. Default 1. */
  width?: number;
  /** Waiters allowed per lane before `MCP_QUEUE_FULL`. Default unbounded. */
  maxQueue?: number;
}

interface GateWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

interface GateLane {
  running: number;
  readonly waiters: GateWaiter[];
}

export interface KeyedGateStats {
  lanes: number;
  running: number;
  queued: number;
}

/**
 * FIFO gate with one lane per key, built for the official tool surface.
 *
 * `claude mcp serve` exports no `isConcurrencySafe`, and the agent loop that
 * used to apply it (`canExecuteTool`) does not cross the process boundary, so
 * `run_script` could fire two `Edit` calls at the same file with nothing
 * serialising them. The gateway keys this gate by `${server}:${binding}` for
 * serial tools and by a single `'exclusive'` lane for exclusive ones.
 *
 * A queued caller can be cancelled: aborting `signal` removes the waiter and
 * rejects with the signal's reason, so an eval that already timed out never
 * starts a call it would have to kill afterwards.
 */
export class KeyedGate {
  readonly width: number;
  readonly maxQueue: number;

  private readonly lanes = new Map<string, GateLane>();

  constructor(options: KeyedGateOptions = {}) {
    this.width = options.width ?? 1;
    this.maxQueue = options.maxQueue ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(this.width) || this.width < 1) {
      throw new RangeError('width must be a positive integer');
    }
    if (!(this.maxQueue >= 0)) {
      throw new RangeError('maxQueue must be zero or a positive number');
    }
  }

  /**
   * Runs `fn` in the lane `key` once a slot is free.
   *
   * `onQueue` fires only when the lane was full and this call actually queued:
   * an uncontended call still has a millisecond or two between "the script
   * asked" and "the gate let it in", and that is scheduling overhead, not a
   * wait worth explaining.
   */
  async run<T>(
    key: string,
    fn: () => Promise<T> | T,
    signal?: AbortSignal,
    onQueue?: () => void,
  ): Promise<T> {
    if (signal?.aborted === true) throw signal.reason;
    const lane = this.laneFor(key);
    if (lane.running >= this.width) {
      if (lane.waiters.length >= this.maxQueue) {
        throw new ReplError('MCP_QUEUE_FULL', `gate ${key} already queues ${lane.waiters.length} calls`);
      }
      onQueue?.();
      await this.wait(lane, signal);
    } else {
      lane.running += 1;
    }
    try {
      return await fn();
    } finally {
      this.release(lane);
    }
  }

  stats(): KeyedGateStats {
    let running = 0;
    let queued = 0;
    for (const lane of this.lanes.values()) {
      running += lane.running;
      queued += lane.waiters.length;
    }
    return { lanes: this.lanes.size, running, queued };
  }

  /** Number of calls queued behind `key`. */
  queueDepth(key: string): number {
    return this.lanes.get(key)?.waiters.length ?? 0;
  }

  private wait(lane: GateLane, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = lane.waiters.indexOf(waiter);
        if (index !== -1) lane.waiters.splice(index, 1);
        reject((signal as AbortSignal).reason);
      };
      const waiter: GateWaiter = {
        resolve: () => {
          if (signal !== undefined && onAbort !== undefined) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        },
        reject,
        signal,
        onAbort: signal === undefined ? undefined : onAbort,
      };
      lane.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(lane: GateLane): void {
    const next = lane.waiters.shift();
    if (next === undefined) {
      lane.running = Math.max(0, lane.running - 1);
      return;
    }
    // The slot passes straight to the next waiter; `running` does not change.
    next.resolve();
  }

  private laneFor(key: string): GateLane {
    let lane = this.lanes.get(key);
    if (lane === undefined) {
      lane = { running: 0, waiters: [] };
      this.lanes.set(key, lane);
    }
    return lane;
  }
}
