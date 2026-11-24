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
import type { EvalTaskEvent, EvalTaskMeta, FinishedTaskStatus, StructuredToolError, TaskStatus } from '../types.ts';

/**
 * Process-wide retention floor for the task table. It is deliberately larger
 * than a single execution session's in-flight quota: the table is shared by
 * every owner, and a finished task stays here for `ttlMs`. The gateway raises
 * the floor to `maxExecSessions * maxInFlightEvalsPerExecSession`.
 */
export const DEFAULT_TASK_CAPACITY = 64;

/** Per-owner retention floor; the gateway raises it to `maxExecSessionsPerBinding * maxInFlightEvalsPerExecSession`. */
export const DEFAULT_TASK_OWNER_CAPACITY = 32;

/** Time source. Tests inject a manual clock and advance it past the TTL. */
export interface TaskClock {
  now(): number;
}

export interface TaskStoreOptions {
  /** Time source; all timestamps and TTL checks go through it. */
  clock: TaskClock;
  /** How long a task stays addressable after creation. Defaults to `LIMITS.taskTtlMs`. */
  ttlMs?: number;
  /** Maximum retained tasks across every owner. Defaults to {@link DEFAULT_TASK_CAPACITY}. */
  capacity?: number;
  /** Maximum retained tasks for one owner. Defaults to {@link DEFAULT_TASK_OWNER_CAPACITY}. */
  ownerCapacity?: number;
}

/** Hot-updatable retention limits (`PATCH /settings` capacity changes). */
export interface TaskStoreLimits {
  capacity?: number;
  ownerCapacity?: number;
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
export interface TaskSnapshot extends EvalTaskMeta {
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

interface TaskRecord extends EvalTaskMeta {
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

/** Copies only the defined execution-identity fields onto a snapshot or event. */
function metaOf(record: EvalTaskMeta): EvalTaskMeta {
  return {
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.scriptId === undefined ? {} : { scriptId: record.scriptId }),
    ...(record.scriptVersion === undefined ? {} : { scriptVersion: record.scriptVersion }),
    ...(record.scriptMode === undefined ? {} : { scriptMode: record.scriptMode }),
    ...(record.argsPreview === undefined ? {} : { argsPreview: record.argsPreview }),
    ...(record.entryMode === undefined ? {} : { entryMode: record.entryMode }),
  };
}

function assertCapacity(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function isFinishedStatus(status: TaskStatus): status is FinishedTaskStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export class TaskStore {
  private readonly clock: TaskClock;
  private readonly ttlMs: number;
  private capacity: number;
  private ownerCapacity: number;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly listeners = new Set<() => void>();

  constructor(options: TaskStoreOptions) {
    if (options === undefined || options.clock === undefined) {
      throw new TypeError('TaskStore requires a clock');
    }
    const ttlMs = options.ttlMs ?? LIMITS.taskTtlMs;
    const capacity = options.capacity ?? DEFAULT_TASK_CAPACITY;
    const ownerCapacity = options.ownerCapacity ?? DEFAULT_TASK_OWNER_CAPACITY;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be a positive number');
    assertCapacity('capacity', capacity);
    assertCapacity('ownerCapacity', ownerCapacity);
    this.clock = options.clock;
    this.ttlMs = ttlMs;
    this.capacity = capacity;
    this.ownerCapacity = ownerCapacity;
  }

  /** Number of retained records, including terminal and expired ones awaiting eviction. */
  get size(): number {
    return this.tasks.size;
  }

  /** Retained records belonging to one owner (any status). */
  countForOwner(owner: string): number {
    assertOwner(owner);
    let count = 0;
    for (const record of this.tasks.values()) {
      if (record.owner === owner) count += 1;
    }
    return count;
  }

  /** Current retention limits. */
  get limits(): { capacity: number; ownerCapacity: number } {
    return { capacity: this.capacity, ownerCapacity: this.ownerCapacity };
  }

  /** Retention window applied to records created from now on. */
  get ttl(): number {
    return this.ttlMs;
  }

  /** Applies hot-updated retention limits; existing records are not evicted eagerly. */
  updateLimits(limits: TaskStoreLimits): void {
    if (limits.capacity !== undefined) {
      assertCapacity('capacity', limits.capacity);
      this.capacity = limits.capacity;
    }
    if (limits.ownerCapacity !== undefined) {
      assertCapacity('ownerCapacity', limits.ownerCapacity);
      this.ownerCapacity = limits.ownerCapacity;
    }
  }

  /**
   * Allocate an `evalTaskId` for an async eval. Reaches `CAPACITY_EXCEEDED` when
   * the owner's slice or the whole table is full of live records and no
   * expired/consumed record can be evicted.
   */
  create(evalId: number, owner: string, meta: EvalTaskMeta = {}): string {
    assertOwner(owner);
    if (!Number.isInteger(evalId) || evalId < 0) {
      throw new TypeError('evalId must be a non-negative integer');
    }
    this.makeRoom(owner);

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
      ...meta,
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
   * Patches the eval id of a task that was allocated before its eval registered.
   * `create` accepts `0` as the placeholder; the caller sets the real id once the
   * executor reports it. A no-op for unknown or already-patched records.
   */
  setEvalId(taskId: string, evalId: number): boolean {
    if (!Number.isInteger(evalId) || evalId < 0) return false;
    const record = this.tasks.get(taskId);
    if (record === undefined) return false;
    record.evalId = evalId;
    return true;
  }

  /** True while the record is retained (any status, including expired-but-unswept). */
  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /** Ids of the owner's unconsumed, unexpired tasks at call time, in creation order. */
  unconsumedIds(owner: string): string[] {
    assertOwner(owner);
    const now = this.clock.now();
    return [...this.tasks.values()]
      .filter((record) => record.owner === owner && !record.consumed && now < record.expiresAt)
      .map((record) => record.taskId);
  }

  /** Drops one record regardless of status. Returns false for an unknown id. */
  remove(taskId: string): boolean {
    const removed = this.tasks.delete(taskId);
    if (removed) this.changed();
    return removed;
  }

  /** Drops every record of one owner; used by the `DELETE /mcp` cascade. */
  removeOwner(owner: string): number {
    assertOwner(owner);
    let removed = 0;
    for (const [taskId, record] of this.tasks) {
      if (record.owner !== owner) continue;
      this.tasks.delete(taskId);
      removed += 1;
    }
    if (removed > 0) this.changed();
    return removed;
  }

  /** Drops every record; used on process shutdown. */
  clear(): void {
    if (this.tasks.size === 0) return;
    this.tasks.clear();
    this.changed();
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
      ...metaOf(record),
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
      ...metaOf(record),
    };
    if (record.result !== undefined) snapshot.result = record.result;
    if (record.stdout !== undefined) snapshot.stdout = record.stdout;
    if (record.error !== undefined) snapshot.error = record.error;
    return snapshot;
  }

  private isExpired(record: TaskRecord): boolean {
    return this.clock.now() >= record.expiresAt;
  }

  /** Live (unexpired) records of one owner at `now`. */
  private liveCountForOwner(owner: string, now: number): number {
    let count = 0;
    for (const record of this.tasks.values()) {
      if (record.owner === owner && now < record.expiresAt) count += 1;
    }
    return count;
  }

  /**
   * Drop expired records first, then consumed ones, so `create` stays bounded.
   * The owner's own slice is checked separately: another owner's tasks can
   * never block it before the process-wide capacity is reached.
   */
  private makeRoom(owner: string): void {
    const now = this.clock.now();
    if (this.tasks.size < this.capacity && this.liveCountForOwner(owner, now) < this.ownerCapacity) {
      return;
    }

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

    while (this.liveCountForOwner(owner, now) >= this.ownerCapacity) {
      let victim: string | undefined;
      for (const [taskId, record] of this.tasks) {
        if (record.owner === owner && record.consumed) {
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
    if (this.liveCountForOwner(owner, now) >= this.ownerCapacity) {
      throw new ReplError(
        'CAPACITY_EXCEEDED',
        `task store owner capacity ${this.ownerCapacity} reached for ${owner}`,
      );
    }
  }

  /** Wake every pending `wait`; they re-check their own set. */
  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
