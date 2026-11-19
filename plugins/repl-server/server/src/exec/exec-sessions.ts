/** Execution-session registry: lazy creation, quotas and handle lifecycle.
 *
 * One execution session is keyed by `(Mcp-Session-Id, binding, workspace
 * realpath)` and owns exactly one worker and one serve handle. The registry
 * never spawns or terminates anything itself: the executor installs the handles
 * and receives an `onRemove` callback when a record leaves the registry, so
 * worker/serve teardown stays in the executor.
 * @module
 */

import { newId } from '@zhangliang0115/repl-server-core/src/ids.ts';

import { systemClock, type Clock } from '../ports.ts';
import {
  CapacityExceededError,
  resolveCapacityLimits,
  type CapacityLimits,
} from './capacity.ts';

/** Why an execution session left the registry. */
export type SessionRemovalReason =
  | 'capacity_evict'
  | 'idle_recycle'
  | 'delete'
  | 'binding_deleted'
  | 'shutdown'
  | 'crash';

/** One execution session. `worker` and `serve` are opaque handles owned by the executor. */
export interface ExecSession<W = unknown, S = unknown> {
  /** `es_...`, unique per process. */
  id: string;
  mcpSessionId: string;
  /** `client_bindings.id`; null for unbound clients. */
  binding: string | null;
  /** Self-reported client label, display only. */
  clientLabel: string;
  /** realpath of the workspace. The executor resolves it before calling. */
  workspace: string;
  createdAt: number;
  /** Eval start time (or creation time). Idle and LRU all use this field. */
  lastEvalAt: number;
  /** Last request that touched the session. */
  lastRequestAt: number;
  /** Number of evals currently in flight. */
  inFlightEvals: number;
  /** 0 before the first worker is attached; +1 on every attach, i.e. every rebuild. */
  workerEpoch: number;
  worker: W | null;
  serve: S | null;
}

/** Identifies an execution session. `workspace` must already be a realpath. */
export interface SessionRequest {
  mcpSessionId: string;
  workspace: string;
  binding?: string | null;
  clientLabel?: string;
}

export interface ExecSessionRegistryOptions<W = unknown, S = unknown> {
  clock?: Clock;
  limits?: Partial<CapacityLimits>;
  idFactory?: (request: SessionRequest) => string;
  /**
   * Fired once per removed session, after the record is unlinked. Capacity
   * eviction passes `"capacity_evict"`; the caller uses the callback to write
   * the audit event and to terminate the attached worker/serve handles.
   */
  onRemove?: (session: ExecSession<W, S>, reason: SessionRemovalReason) => void;
}

const BINDING_OWNER = 'b\u0000';
const SESSION_OWNER = 'm\u0000';

function ownerKeyFor(binding: string | null, mcpSessionId: string): string {
  return binding === null ? `${SESSION_OWNER}${mcpSessionId}` : `${BINDING_OWNER}${binding}`;
}

function describeOwner(binding: string | null, mcpSessionId: string): string {
  return binding === null ? `mcp:${mcpSessionId}` : `binding:${binding}`;
}

/**
 * Execution-session key. `binding` participates so two identities that happen
 * to share one `Mcp-Session-Id` (for example a bound and an unbound request on
 * the same transport) never share a JS context (design 03 §2.1–2.2).
 */
function sessionKey(mcpSessionId: string, binding: string | null, workspace: string): string {
  return `${mcpSessionId}\u0000${binding ?? ''}\u0000${workspace}`;
}

function assertRequest(request: SessionRequest): void {
  if (typeof request.mcpSessionId !== 'string' || request.mcpSessionId === '') {
    throw new TypeError('mcpSessionId must be a non-empty string');
  }
  if (typeof request.workspace !== 'string' || request.workspace === '') {
    throw new TypeError('workspace must be a non-empty string');
  }
}

function addTo(index: Map<string, Set<string>>, key: string, sessionId: string): void {
  const set = index.get(key);
  if (set === undefined) index.set(key, new Set([sessionId]));
  else set.add(sessionId);
}

function deleteFrom(index: Map<string, Set<string>>, key: string, sessionId: string): void {
  const set = index.get(key);
  if (set === undefined) return;
  set.delete(sessionId);
  if (set.size === 0) index.delete(key);
}

/**
 * Registry for execution sessions.
 *
 * Identity (design 03 §2.1): the key is `(Mcp-Session-Id, binding, workspace
 * realpath)`, so an unbound and a bound request on the same transport never
 * share a JS context.
 *
 * Quotas (design 03 §2.6):
 * - 8 sessions per process, 4 per binding (unbound clients are bucketed per
 *   MCP session), 4 workspaces per MCP session;
 * - 8 in-flight evals per execution session, 16 per binding.
 *
 * Creating a session while the global limit is reached first attempts to evict
 * the least recently used session that has no in-flight eval and has been idle
 * longer than `evictIdleMs`; otherwise it throws `CAPACITY_EXCEEDED`. The
 * workspace quota never evicts, it throws `WS_LIMIT` (protocol §8).
 */
export class ExecSessionRegistry<W = unknown, S = unknown> {
  private limitsValue: CapacityLimits;

  private readonly clock: Clock;
  private readonly idFactory: (request: SessionRequest) => string;
  private readonly onRemove:
    | ((session: ExecSession<W, S>, reason: SessionRemovalReason) => void)
    | undefined;
  private readonly sessions = new Map<string, ExecSession<W, S>>();
  private readonly byKey = new Map<string, string>();
  private readonly byMcpSession = new Map<string, Set<string>>();
  private readonly byOwner = new Map<string, Set<string>>();

  constructor(options: ExecSessionRegistryOptions<W, S> = {}) {
    this.clock = options.clock ?? systemClock;
    this.limitsValue = resolveCapacityLimits(options.limits);
    this.idFactory = options.idFactory ?? (() => newId('execSession'));
    this.onRemove = options.onRemove;
  }

  /** Current quotas; replaced wholesale by {@link updateLimits}. */
  get limits(): CapacityLimits {
    return this.limitsValue;
  }

  /**
   * Hot-applies `PATCH /settings` capacity changes. Existing sessions are not
   * evicted eagerly; the next `acquire`/`beginEval` enforces the new values.
   */
  updateLimits(overrides: Partial<CapacityLimits>): CapacityLimits {
    this.limitsValue = resolveCapacityLimits({ ...this.limitsValue, ...overrides });
    return this.limitsValue;
  }

  /** Number of live execution sessions. */
  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): ExecSession<W, S> | undefined {
    return this.sessions.get(sessionId);
  }

  find(
    mcpSessionId: string,
    workspace: string,
    binding: string | null = null,
  ): ExecSession<W, S> | undefined {
    const id = this.byKey.get(sessionKey(mcpSessionId, binding, workspace));
    return id === undefined ? undefined : this.sessions.get(id);
  }

  /** Snapshot in insertion order. */
  list(): ExecSession<W, S>[] {
    return [...this.sessions.values()];
  }

  listForMcpSession(mcpSessionId: string): ExecSession<W, S>[] {
    return this.collect(this.byMcpSession.get(mcpSessionId));
  }

  countForMcpSession(mcpSessionId: string): number {
    return this.byMcpSession.get(mcpSessionId)?.size ?? 0;
  }

  countForBinding(binding: string): number {
    return this.byOwner.get(`${BINDING_OWNER}${binding}`)?.size ?? 0;
  }

  /**
   * Returns the session for `(mcpSessionId, workspace)`, creating it lazily.
   * Creating enforces the workspace, binding and global quotas. At the global
   * limit an idle LRU session is evicted when eligible; otherwise this throws
   * `CapacityExceededError` (`WS_LIMIT` only for the workspace quota).
   */
  acquire(request: SessionRequest): ExecSession<W, S> {
    assertRequest(request);
    const binding = request.binding ?? null;
    const existing = this.find(request.mcpSessionId, request.workspace, binding);
    if (existing !== undefined) return existing;

    const workspaceCount = this.workspaceCountForMcpSession(request.mcpSessionId);
    if (workspaceCount >= this.limits.maxWorkspacesPerMcpSession) {
      throw new CapacityExceededError({
        code: 'WS_LIMIT',
        resource: 'workspaces_per_mcp_session',
        current: workspaceCount,
        limit: this.limits.maxWorkspacesPerMcpSession,
        scope: request.mcpSessionId,
      });
    }

    const ownerKey = ownerKeyFor(binding, request.mcpSessionId);
    const ownerCount = this.byOwner.get(ownerKey)?.size ?? 0;
    if (ownerCount >= this.limits.maxExecSessionsPerBinding) {
      throw new CapacityExceededError({
        resource: 'exec_sessions_per_binding',
        current: ownerCount,
        limit: this.limits.maxExecSessionsPerBinding,
        scope: describeOwner(binding, request.mcpSessionId),
      });
    }

    while (this.sessions.size >= this.limits.maxExecSessions) {
      if (!this.evictLru()) {
        throw new CapacityExceededError({
          resource: 'exec_sessions',
          current: this.sessions.size,
          limit: this.limits.maxExecSessions,
          scope: 'global',
        });
      }
    }

    const now = this.clock.now();
    const id = this.idFactory(request);
    if (this.sessions.has(id)) throw new Error(`duplicate exec session id ${id}`);

    const session: ExecSession<W, S> = {
      id,
      mcpSessionId: request.mcpSessionId,
      binding,
      clientLabel: request.clientLabel ?? '',
      workspace: request.workspace,
      createdAt: now,
      lastEvalAt: now,
      lastRequestAt: now,
      inFlightEvals: 0,
      workerEpoch: 0,
      worker: null,
      serve: null,
    };

    this.sessions.set(id, session);
    this.byKey.set(sessionKey(session.mcpSessionId, session.binding, session.workspace), id);
    addTo(this.byMcpSession, session.mcpSessionId, id);
    addTo(this.byOwner, ownerKey, id);
    return session;
  }

  /**
   * Reserves one in-flight eval slot for `(mcpSessionId, workspace)`, creating
   * the session lazily and marking it active (`lastEvalAt = now`).
   * Exceeding the per-session or per-binding in-flight quota throws
   * `CAPACITY_EXCEEDED`; callers must not queue.
   */
  beginEval(request: SessionRequest): ExecSession<W, S> {
    assertRequest(request);
    const binding = request.binding ?? null;
    const ownerKey = ownerKeyFor(binding, request.mcpSessionId);

    // Checked before `acquire` so a rejected eval never leaves a fresh session behind.
    const ownerInFlight = this.inFlightForOwner(ownerKey);
    if (ownerInFlight >= this.limits.maxInFlightEvalsPerBinding) {
      throw new CapacityExceededError({
        resource: 'in_flight_evals_per_binding',
        current: ownerInFlight,
        limit: this.limits.maxInFlightEvalsPerBinding,
        scope: describeOwner(binding, request.mcpSessionId),
      });
    }

    const session = this.acquire(request);
    if (session.inFlightEvals >= this.limits.maxInFlightEvalsPerExecSession) {
      throw new CapacityExceededError({
        resource: 'in_flight_evals_per_exec_session',
        current: session.inFlightEvals,
        limit: this.limits.maxInFlightEvalsPerExecSession,
        scope: session.id,
      });
    }

    session.inFlightEvals += 1;
    const now = this.clock.now();
    session.lastEvalAt = now;
    session.lastRequestAt = now;
    return session;
  }

  /** Releases one in-flight slot. Returns the remaining count (0 for a stale session). */
  endEval(session: ExecSession<W, S>): number {
    if (this.sessions.get(session.id) !== session) return 0;
    if (session.inFlightEvals > 0) session.inFlightEvals -= 1;
    session.lastRequestAt = this.clock.now();
    return session.inFlightEvals;
  }

  /**
   * Drops one record and fires `onRemove`. Returns the removed record, or
   * undefined when the id is unknown (double removal is a no-op).
   */
  remove(sessionId: string, reason: SessionRemovalReason): ExecSession<W, S> | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;

    this.sessions.delete(sessionId);
    this.byKey.delete(sessionKey(session.mcpSessionId, session.binding, session.workspace));
    deleteFrom(this.byMcpSession, session.mcpSessionId, sessionId);
    deleteFrom(this.byOwner, ownerKeyFor(session.binding, session.mcpSessionId), sessionId);
    this.onRemove?.(session, reason);
    return session;
  }

  destroySession(sessionId: string, reason: SessionRemovalReason = 'delete'): boolean {
    return this.remove(sessionId, reason) !== undefined;
  }

  /** `DELETE /mcp`: removes every execution session under one transport session. */
  destroyByMcpSession(mcpSessionId: string, reason: SessionRemovalReason = 'delete'): number {
    return this.removeMany(this.listForMcpSession(mcpSessionId), reason);
  }

  /** Binding deletion/rotation: removes every execution session of one binding. */
  destroyByBinding(binding: string, reason: SessionRemovalReason = 'binding_deleted'): number {
    const ids = this.byOwner.get(`${BINDING_OWNER}${binding}`);
    return this.removeMany(this.collect(ids), reason);
  }

  destroyAll(reason: SessionRemovalReason = 'shutdown'): number {
    return this.removeMany([...this.sessions.values()], reason);
  }

  /**
   * Attaches the initial worker or a rebuilt one. Every call bumps
   * `workerEpoch`, so messages from a previous generation can be dropped.
   * Returns the new epoch.
   */
  attachWorker(session: ExecSession<W, S>, worker: W): number {
    const live = this.requireLive(session);
    live.workerEpoch += 1;
    live.worker = worker;
    return live.workerEpoch;
  }

  /** Clears the worker handle without touching the epoch. */
  detachWorker(session: ExecSession<W, S>): W | null {
    const live = this.requireLive(session);
    const worker = live.worker;
    live.worker = null;
    return worker;
  }

  attachServe(session: ExecSession<W, S>, serve: S): void {
    this.requireLive(session).serve = serve;
  }

  detachServe(session: ExecSession<W, S>): S | null {
    const live = this.requireLive(session);
    const serve = live.serve;
    live.serve = null;
    return serve;
  }

  private collect(ids: Set<string> | undefined): ExecSession<W, S>[] {
    if (ids === undefined) return [];
    const result: ExecSession<W, S>[] = [];
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session !== undefined) result.push(session);
    }
    return result;
  }

  /** Distinct workspaces bound to one MCP session; the quota counts directories, not identities. */
  private workspaceCountForMcpSession(mcpSessionId: string): number {
    const ids = this.byMcpSession.get(mcpSessionId);
    if (ids === undefined) return 0;
    const workspaces = new Set<string>();
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session !== undefined) workspaces.add(session.workspace);
    }
    return workspaces.size;
  }

  private inFlightForOwner(ownerKey: string): number {
    const ids = this.byOwner.get(ownerKey);
    if (ids === undefined) return 0;
    let total = 0;
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session !== undefined) total += session.inFlightEvals;
    }
    return total;
  }

  /**
   * Evicts the least recently used idle session that has been idle longer than
   * `evictIdleMs`. Sessions with in-flight evals never qualify. Returns false
   * when no candidate exists.
   */
  private evictLru(): boolean {
    const now = this.clock.now();
    let candidate: ExecSession<W, S> | undefined;
    for (const session of this.sessions.values()) {
      if (session.inFlightEvals > 0) continue;
      if (now - session.lastEvalAt <= this.limits.evictIdleMs) continue;
      if (
        candidate === undefined ||
        session.lastEvalAt < candidate.lastEvalAt ||
        (session.lastEvalAt === candidate.lastEvalAt && session.createdAt < candidate.createdAt)
      ) {
        candidate = session;
      }
    }
    if (candidate === undefined) return false;
    this.remove(candidate.id, 'capacity_evict');
    return true;
  }

  private removeMany(targets: ExecSession<W, S>[], reason: SessionRemovalReason): number {
    let removed = 0;
    for (const session of targets) {
      if (this.remove(session.id, reason) !== undefined) removed += 1;
    }
    return removed;
  }

  private requireLive(session: ExecSession<W, S>): ExecSession<W, S> {
    const live = this.sessions.get(session.id);
    if (live === undefined) throw new Error(`exec session ${session.id} is not registered`);
    return live;
  }
}
