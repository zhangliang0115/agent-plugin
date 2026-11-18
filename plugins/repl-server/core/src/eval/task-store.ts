/**
 * In-process eval task table behind `wait_tasks`: id allocation, terminal states,
 * TTL retention and one-shot result consumption.
 *
 * Semantics frozen in `docs/protocol.md` §3.4 and learn-ai `自建设计/02` §4.3–4.4:
 * - `owner` is `bindingId ?? mcpSessionId`; every read is scoped to one owner.
 * - `wait` only observes: it resolves when every id in the set is terminal or the
 *   deadline fires. `consume` performs the one-shot collection the `wait_tasks`
 *   handler reports; the handler composes `await wait(...)` then `consume(...)`.
 * - `tasks/get` maps to `get`, which never consumes.
 * - Unknown ids throw `UNKNOWN_TASK`, expired ids `TASK_EXPIRED`, a second
 *   collection `ALREADY_CONSUMED`; none of these consume any other result.
 * @module
 */
import { LIMITS } from '../constants.ts';
import { ReplError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { EvalTaskEvent, FinishedTaskStatus, StructuredToolError, TaskStatus } from '../types.ts';

/** Time source. Tests inject a manual clock and advance it past the TTL. */
export interface TaskClock {
  now(): number;
}

export interface TaskStoreOptions {
  /** Time source; all timestamps and TTL checks go through it. */
  clock: TaskClock;
  /** How long a task stays addressable after creation. Defaults to `LIMITS.taskTtlMs`. */
  ttlMs?: number;
  /** Maximum retained tasks. Defaults to `LIMITS.inFlightPerExecSession`. */
  capacity?: number;
}

/** Result of `wait`: terminal tasks in the set plus how many are still `working`. */
export interface TaskWaitResult {
  /** True only when the deadline fired with at least one task still `working`. */
  timedOut: boolean;
  /** Terminal tasks in the wait set, in the order the ids were selected. Not consumed. */
  events: EvalTaskEvent[];
  /** Tasks in the wait set that had not reached a terminal state yet. */
  pending: number;
}

/** Result of one-shot `consume`: collected terminal tasks and leftovers still `working`. */
export interface TaskConsumeResult {
  events: EvalTaskEvent[];
  pending: number;
}

/** Read-only view for `tasks/get`. `get` is idempotent and never consumes. */
export interface TaskSnapshot {
  taskId: string;
  evalId: number;
  /** Includes `working`; `wait`/`consume` events only carry terminal states. */
  status: TaskStatus;
  result?: string;
  stdout?: string;
  error?: StructuredToolError;
  elapsedMs: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  consumed: boolean;
}

/** Data a settled eval contributes to its task event. */
export interface TaskOutcome {
  /** Serialized `<result>` body, when the eval produced one. */
  result?: string;
  /** Collected stdout (and stderr) for the event. */
  stdout?: string;
}

/** The id does not exist in this store or belongs to another owner. */
export class UnknownTaskError extends ReplError {
  readonly unknownIds: string[];

  constructor(unknownIds: readonly string[]) {
    super('UNKNOWN_TASK', `unknown task id${unknownIds.length === 1 ? '' : 's'}: ${unknownIds.join(', ')}`);
    this.name = 'UnknownTaskError';
    this.unknownIds = [...unknownIds];
  }
}

/** The task outlived `ttlMs`; its result is gone. */
export class TaskExpiredError extends ReplError {
  readonly taskIds: string[];

  constructor(taskIds: readonly string[]) {
    super('TASK_EXPIRED', `task expired${taskIds.length === 1 ? '' : 's'}: ${taskIds.join(', ')}`);
    this.name = 'TaskExpiredError';
    this.taskIds = [...taskIds];
  }
}

/** A second collection of an already consumed id. */
export class AlreadyConsumedError extends ReplError {
  readonly taskIds: string[];

  constructor(taskIds: readonly string[]) {
    super('ALREADY_CONSUMED', `task result already consumed: ${taskIds.join(', ')}`);
    this.name = 'AlreadyConsumedError';
    this.taskIds = [...taskIds];
  }
}

interface TaskRecord {
  taskId: string;
  evalId: number;
  owner: string;
  status: TaskStatus;
  result?: string;
  stdout?: string;
  error?: StructuredToolError;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Frozen at the terminal transition; `undefined` while `working`. */
  elapsedMs?: number;
  consumed: boolean;
}

function assertOwner(owner: string): void {
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new TypeError('owner must be a non-empty string (bindingId or mcpSessionId)');
  }
}

function isFinishedStatus(status: TaskStatus): status is FinishedTaskStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export class TaskStore {
  private readonly clock: TaskClock;
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly listeners = new Set<() => void>();

  constructor(options: TaskStoreOptions) {
    if (options === undefined || options.clock === undefined) {
      throw new TypeError('TaskStore requires a clock');
    }
    const ttlMs = options.ttlMs ?? LIMITS.taskTtlMs;
    const capacity = options.capacity ?? LIMITS.inFlightPerExecSession;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be a positive number');
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.clock = options.clock;
    this.ttlMs = ttlMs;
    this.capacity = capacity;
  }

  /** Number of retained records, including terminal and expired ones awaiting eviction. */
  get size(): number {
    return this.tasks.size;
  }

  /**
   * Allocate an `evalTaskId` for an async eval. Reaches `CAPACITY_EXCEEDED` when
   * the table is full of working or unconsumed tasks and no expired/consumed
   * record can be evicted.
   */
  create(evalId: number, owner: string): string {
    assertOwner(owner);
    if (!Number.isInteger(evalId) || evalId < 0) {
      throw new TypeError('evalId must be a non-negative integer');
    }
    this.makeRoom();

    const now = this.clock.now();
    const taskId = newId('task');
    const record: TaskRecord = {
      taskId,
      evalId,
      owner,
      status: 'working',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      consumed: false,
    };
    this.tasks.set(taskId, record);
    this.changed();
    return taskId;
  }

  /** Mark the eval `completed`. Returns false for an unknown, expired or already settled task. */
  complete(taskId: string, outcome: TaskOutcome = {}): boolean {
    return this.settle(taskId, 'completed', outcome);
  }

  /** Mark the eval `failed` with its structured error. Returns false when not applicable. */
  fail(taskId: string, error: StructuredToolError, outcome: TaskOutcome = {}): boolean {
    return this.settle(taskId, 'failed', outcome, error);
  }

  /** Mark the eval `cancelled` (user or client cancel). Returns false when not applicable. */
  cancel(taskId: string, outcome: TaskOutcome = {}): boolean {
    return this.settle(taskId, 'cancelled', outcome);
  }

  /**
   * Idempotent read for `tasks/get`. Does not consume the result, so a task stays
   * readable after `consume`. Unknown → `UNKNOWN_TASK`, expired → `TASK_EXPIRED`.
   */
  get(owner: string, taskId: string): TaskSnapshot {
    assertOwner(owner);
    return this.snapshot(this.resolveOne(owner, taskId, true));
  }

  /**
   * Wait until every task in the set is terminal or `timeoutMs` elapses.
   * `ids` omitted (or `undefined`) selects every unconsumed, unexpired task of
   * the owner at call time. An empty set resolves immediately with
   * `{ timedOut: false, events: [], pending: 0 }`.
   *
   * Observation only: completed tasks stay unconsumed until `consume`.
   * Unknown / expired / consumed ids reject before anything is consumed.
   */
  async wait(owner: string, ids: readonly string[] | undefined, timeoutMs: number): Promise<TaskWaitResult> {
    assertOwner(owner);
    const waitIds = this.resolveIds(owner, ids);
    if (waitIds.length === 0) return { timedOut: false, events: [], pending: 0 };

    const initial = this.collect(owner, waitIds);
    if (initial.pending === 0) return { timedOut: false, ...initial };

    return await this.awaitAll(owner, waitIds, timeoutMs);
  }

  /**
   * One-shot collection. Consumes every terminal task in the set and returns its
   * events; still-working tasks stay in the table and are counted in `pending`.
   * `ids` omitted selects every unconsumed, unexpired task of the owner.
   * A second explicit collection of the same ids throws `ALREADY_CONSUMED`
   * without consuming any other result.
   */
  consume(owner: string, ids?: readonly string[]): TaskConsumeResult {
    assertOwner(owner);
    const consumeIds = this.resolveIds(owner, ids);
    const events: EvalTaskEvent[] = [];
    let pending = 0;

    for (const taskId of consumeIds) {
      const record = this.resolveOne(owner, taskId, false);
      if (record.status === 'working') {
        pending += 1;
        continue;
      }
      record.consumed = true;
      events.push(this.toEvent(record));
    }

    if (events.length > 0) this.changed();
    return { events, pending };
  }

  private settle(
    taskId: string,
    status: FinishedTaskStatus,
    outcome: TaskOutcome,
    error?: StructuredToolError,
  ): boolean {
    const record = this.tasks.get(taskId);
    if (record === undefined || record.status !== 'working') return false;

    const now = this.clock.now();
    if (now >= record.expiresAt) return false;

    record.status = status;
    record.updatedAt = now;
    record.elapsedMs = Math.max(0, now - record.createdAt);
    if (outcome.result !== undefined) record.result = outcome.result;
    if (outcome.stdout !== undefined) record.stdout = outcome.stdout;
    if (error !== undefined) record.error = error;
    this.changed();
    return true;
  }

  /**
   * Validate an id set and return ids in selection order.
   * Omitted ids: all unconsumed, unexpired tasks of this owner, in creation order.
   * Explicit ids: deduped; unknown, then expired, then consumed ids reject the
   * whole call before anything is collected.
   */
  private resolveIds(owner: string, ids: readonly string[] | undefined): string[] {
    if (ids === undefined) {
      const now = this.clock.now();
      return [...this.tasks.values()]
        .filter((record) => record.owner === owner && !record.consumed && now < record.expiresAt)
        .map((record) => record.taskId);
    }

    const unique = [...new Set(ids)];
    const unknown: string[] = [];
    const expired: string[] = [];
    const consumed: string[] = [];
    for (const taskId of unique) {
      const record = this.tasks.get(taskId);
      if (record === undefined || record.owner !== owner) {
        unknown.push(taskId);
        continue;
      }
      if (this.isExpired(record)) {
        expired.push(taskId);
        continue;
      }
      if (record.consumed) consumed.push(taskId);
    }

    if (unknown.length > 0) throw new UnknownTaskError(unknown);
    if (expired.length > 0) throw new TaskExpiredError(expired);
    if (consumed.length > 0) throw new AlreadyConsumedError(consumed);
    return unique;
  }

  private resolveOne(owner: string, taskId: string, allowConsumed: boolean): TaskRecord {
    const record = this.tasks.get(taskId);
    if (record === undefined || record.owner !== owner) throw new UnknownTaskError([taskId]);
    if (this.isExpired(record)) throw new TaskExpiredError([taskId]);
    if (!allowConsumed && record.consumed) throw new AlreadyConsumedError([taskId]);
    return record;
  }

  /** Snapshot the current state of an id set; working tasks are counted, not emitted. */
  private collect(owner: string, ids: readonly string[]): { events: EvalTaskEvent[]; pending: number } {
    const events: EvalTaskEvent[] = [];
    let pending = 0;
    for (const taskId of ids) {
      const record = this.resolveOne(owner, taskId, false);
      if (record.status === 'working') {
        pending += 1;
      } else {
        events.push(this.toEvent(record));
      }
    }
    return { events, pending };
  }

  private awaitAll(owner: string, ids: readonly string[], timeoutMs: number): Promise<TaskWaitResult> {
    return new Promise<TaskWaitResult>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        this.listeners.delete(check);
      };

      const finish = (timedOut: boolean): void => {
        if (done) return;
        let outcome: TaskWaitResult;
        try {
          const current = this.collect(owner, ids);
          if (!timedOut && current.pending > 0) return;
          outcome = { timedOut: timedOut && current.pending > 0, ...current };
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        cleanup();
        resolve(outcome);
      };

      const check = (): void => finish(false);
      const waitMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
      timer = setTimeout(() => finish(true), waitMs);
      this.listeners.add(check);
    });
  }

  private toEvent(record: TaskRecord): EvalTaskEvent {
    if (!isFinishedStatus(record.status)) throw new Error('a non-terminal task has no terminal event');
    const event: EvalTaskEvent = {
      taskId: record.taskId,
      evalId: record.evalId,
      status: record.status,
      elapsedMs: record.elapsedMs ?? Math.max(0, this.clock.now() - record.createdAt),
    };
    if (record.result !== undefined) event.result = record.result;
    if (record.stdout !== undefined) event.stdout = record.stdout;
    if (record.error !== undefined) event.error = record.error;
    return event;
  }

  private snapshot(record: TaskRecord): TaskSnapshot {
    const snapshot: TaskSnapshot = {
      taskId: record.taskId,
      evalId: record.evalId,
      status: record.status,
      elapsedMs: record.elapsedMs ?? Math.max(0, this.clock.now() - record.createdAt),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      consumed: record.consumed,
    };
    if (record.result !== undefined) snapshot.result = record.result;
    if (record.stdout !== undefined) snapshot.stdout = record.stdout;
    if (record.error !== undefined) snapshot.error = record.error;
    return snapshot;
  }

  private isExpired(record: TaskRecord): boolean {
    return this.clock.now() >= record.expiresAt;
  }

  /** Drop expired records first, then consumed ones, so `create` stays bounded. */
  private makeRoom(): void {
    if (this.tasks.size < this.capacity) return;

    const now = this.clock.now();
    for (const [taskId, record] of this.tasks) {
      if (now >= record.expiresAt) this.tasks.delete(taskId);
    }

    while (this.tasks.size >= this.capacity) {
      let victim: string | undefined;
      for (const [taskId, record] of this.tasks) {
        if (record.consumed) {
          victim = taskId;
          break;
        }
      }
      if (victim === undefined) break;
      this.tasks.delete(victim);
    }

    if (this.tasks.size >= this.capacity) {
      throw new ReplError('CAPACITY_EXCEEDED', `task store capacity ${this.capacity} reached`);
    }
  }

  /** Wake every pending `wait`; they re-check their own set. */
  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
