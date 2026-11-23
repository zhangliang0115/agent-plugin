/**
 * Concurrency gates for pooled third-party MCP calls.
 *
 * The primitives are frozen in core (task C09):
 * - one `RwLock` per server: `parallel` takes the read lock, `serial` the write
 *   lock, so a serial call drains in-flight parallel calls and blocks new ones;
 * - one per binding x server quota: N calls in flight, M queued, then
 *   `MCP_QUEUE_FULL`;
 * - one process-wide `ExclusiveGate`: admission closes first, in-flight calls
 *   drain, and the exclusive call runs alone (`EXCLUSIVE_TIMEOUT` after 30s).
 *
 * This module is the pool-facing facade: the tool router talks to `PoolGates`
 * and does not need to know where the primitives live. One instance must be
 * shared by every pooled server, otherwise `exclusive` stops being global.
 *
 * The per-binding quota lives here rather than in `ServerGates` so
 * `PATCH /settings` can hot-apply `maxInFlightCallsPerBindingPerServer` and
 * `maxQueuedCallsPerBindingPerServer`: the core semaphore has a fixed limit,
 * while this facade re-reads the current values on every call. The inner
 * `ServerGates` is built with no effective quota and still owns the locks and
 * the exclusive gate, which therefore survive a limit change untouched.
 *
 * @module
 */

import { LIMITS } from '@zhangliang0115/repl-server-core/src/constants.ts';
import { ReplError } from '@zhangliang0115/repl-server-core/src/errors.ts';
import { ServerGates } from '@zhangliang0115/repl-server-core/src/gates.ts';
import type {
  ConcurrencyPolicy,
  ExclusiveGate,
  ServerGateWaitReason,
  ServerGatesOptions,
} from '@zhangliang0115/repl-server-core/src/gates.ts';

export { EXCLUSIVE_TIMEOUT_MS, ExclusiveGate, ServerGates } from '@zhangliang0115/repl-server-core/src/gates.ts';
export type {
  ConcurrencyPolicy,
  ExclusiveGateOptions,
  ServerGatesOptions,
} from '@zhangliang0115/repl-server-core/src/gates.ts';

export interface PoolGatesOptions extends ServerGatesOptions {}

/**
 * Where a pooled call spent its wait, in the order the layers see it:
 * this facade's per-binding quota first, then the server's write lock, then the
 * process-wide exclusive gate.
 */
export type PoolWaitReason = 'binding-quota' | ServerGateWaitReason;

/** Hot-appliable per-binding quota values. */
export interface PoolGateLimits {
  callsPerBinding?: number;
  queuedPerBinding?: number;
}

interface BindingQuota {
  readonly key: string;
  readonly serverId: string;
  readonly bindingId: string | null;
  running: number;
  readonly waiters: Array<() => void>;
}

/** The inner `ServerGates` quota is disabled; this facade enforces the real one. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

function assertCallsPerBinding(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError('callsPerBinding must be a positive integer');
  }
}

function assertQueuedPerBinding(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('queuedPerBinding must be a non-negative integer');
  }
}

/**
 * Pool-facing gate facade.
 *
 * `run` takes the same triple the tool registry has: server id, binding id and
 * the tool's declared concurrency policy. `bindingId === null` groups unbound
 * clients together, matching the protocol's `owner = bindingId ?? mcpSessionId`
 * fallback.
 */
export class PoolGates {
  readonly serverGates: ServerGates;

  private callsPerBindingValue: number;
  private queuedPerBindingValue: number;
  private readonly quotas = new Map<string, BindingQuota>();

  constructor(options: PoolGatesOptions = {}) {
    this.callsPerBindingValue = options.callsPerBinding ?? LIMITS.callsPerBindingPerServer;
    this.queuedPerBindingValue = options.queuedPerBinding ?? LIMITS.queuedPerBindingPerServer;
    assertCallsPerBinding(this.callsPerBindingValue);
    assertQueuedPerBinding(this.queuedPerBindingValue);

    this.serverGates = new ServerGates({
      ...options,
      callsPerBinding: UNBOUNDED,
      queuedPerBinding: UNBOUNDED,
    });
  }

  /** In-flight limit for one binding x server pair. */
  get callsPerBinding(): number {
    return this.callsPerBindingValue;
  }

  /** Queue limit for one binding x server pair. */
  get queuedPerBinding(): number {
    return this.queuedPerBindingValue;
  }

  /** The process-wide exclusive gate, exposed for health/admin counters. */
  get exclusiveGate(): ExclusiveGate {
    return this.serverGates.exclusiveGate;
  }

  /** Calls admitted (non-exclusive) and currently executing across all servers. */
  get inFlight(): number {
    return this.serverGates.exclusiveGate.inFlightCount;
  }

  /** Live per-binding x server counters; idle pairs are removed from the map. */
  bindingStats(): Array<{
    binding: string | null;
    serverId: string;
    running: number;
    queued: number;
  }> {
    return [...this.quotas.values()].map((quota) => ({
      binding: quota.bindingId,
      serverId: quota.serverId,
      running: quota.running,
      queued: quota.waiters.length,
    }));
  }

  /** True while an exclusive call holds the gate and new calls are queueing. */
  get admissionClosed(): boolean {
    return this.serverGates.exclusiveGate.admissionClosed;
  }

  /**
   * Hot-applies per-binding quota changes from `PATCH /settings`. Calls already
   * running are not interrupted; the next admission and every queue-full check
   * use the new values. Raising a limit releases queued calls immediately.
   */
  updateLimits(limits: PoolGateLimits): void {
    if (limits.callsPerBinding !== undefined) {
      assertCallsPerBinding(limits.callsPerBinding);
      this.callsPerBindingValue = limits.callsPerBinding;
    }
    if (limits.queuedPerBinding !== undefined) {
      assertQueuedPerBinding(limits.queuedPerBinding);
      this.queuedPerBindingValue = limits.queuedPerBinding;
    }
    for (const quota of this.quotas.values()) this.grantWaiters(quota);
  }

  /**
   * Runs one tool call under the gates. `exclusive` ignores the per-server lock
   * and the binding quota and waits for every admitted call to finish.
   *
   * `onWait` is observation only, used to explain a non-zero `queueMs` on the
   * audit row. It can fire more than once (quota, then write lock, then
   * admission); the caller decides whether to keep the first or the last.
   */
  run<T>(
    serverId: string,
    bindingId: string | null,
    policy: ConcurrencyPolicy,
    fn: () => Promise<T> | T,
    onWait?: (reason: PoolWaitReason) => void,
  ): Promise<T> {
    if (policy === 'exclusive') {
      return this.serverGates.withTool(serverId, policy, bindingId, fn, onWait);
    }
    return this.withBindingQuota(
      serverId,
      bindingId,
      () => this.serverGates.withTool(serverId, policy, bindingId, fn, onWait),
      onWait,
    );
  }

  private async withBindingQuota<T>(
    serverId: string,
    bindingId: string | null,
    fn: () => Promise<T>,
    onWait?: (reason: PoolWaitReason) => void,
  ): Promise<T> {
    const quota = this.quotaFor(serverId, bindingId);
    if (quota.running >= this.callsPerBindingValue) {
      if (quota.waiters.length >= this.queuedPerBindingValue) {
        throw new ReplError(
          'MCP_QUEUE_FULL',
          `binding ${bindingId ?? 'unbound'} already queues ${quota.waiters.length} calls ` +
            `for server ${serverId} (limit ${this.queuedPerBindingValue})`,
        );
      }
      onWait?.('binding-quota');
      await new Promise<void>((resolve) => quota.waiters.push(resolve));
    } else {
      quota.running += 1;
    }

    try {
      return await fn();
    } finally {
      quota.running -= 1;
      this.grantWaiters(quota);
      if (quota.running === 0 && quota.waiters.length === 0 && this.quotas.get(quota.key) === quota) {
        this.quotas.delete(quota.key);
      }
    }
  }

  /** Grants queued calls while the current in-flight limit leaves room. */
  private grantWaiters(quota: BindingQuota): void {
    while (quota.waiters.length > 0 && quota.running < this.callsPerBindingValue) {
      quota.running += 1;
      const next = quota.waiters.shift();
      next?.();
    }
  }

  private quotaFor(serverId: string, bindingId: string | null): BindingQuota {
    const key = `${serverId}\u0000${bindingId ?? ''}`;
    let quota = this.quotas.get(key);
    if (quota === undefined) {
      quota = { key, serverId, bindingId, running: 0, waiters: [] };
      this.quotas.set(key, quota);
    }
    return quota;
  }
}
