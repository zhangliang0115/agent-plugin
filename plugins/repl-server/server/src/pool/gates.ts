/**
 * Concurrency gates for pooled third-party MCP calls.
 *
 * The primitives are frozen in core (task C09):
 * - one `RwLock` per server: `parallel` takes the read lock, `serial` the write
 *   lock, so a serial call drains in-flight parallel calls and blocks new ones;
 * - one `Semaphore` per binding x server: 4 calls in flight, 32 queued, then
 *   `MCP_QUEUE_FULL`;
 * - one process-wide `ExclusiveGate`: admission closes first, in-flight calls
 *   drain, and the exclusive call runs alone (`EXCLUSIVE_TIMEOUT` after 30s).
 *
 * This module is the pool-facing facade: the tool router talks to `PoolGates`
 * and does not need to know where the primitives live. One instance must be
 * shared by every pooled server, otherwise `exclusive` stops being global.
 *
 * @module
 */

import { ServerGates } from '@zhangliang0115/repl-server-core/src/gates.ts';
import type {
  ConcurrencyPolicy,
  ExclusiveGate,
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
 * Pool-facing gate facade.
 *
 * `run` takes the same triple the tool registry has: server id, binding id and
 * the tool's declared concurrency policy. `bindingId === null` groups unbound
 * clients together, matching the protocol's `owner = bindingId ?? mcpSessionId`
 * fallback.
 */
export class PoolGates {
  readonly serverGates: ServerGates;

  constructor(options: PoolGatesOptions = {}) {
    this.serverGates = new ServerGates(options);
  }

  /** In-flight limit for one binding x server pair (default 4). */
  get callsPerBinding(): number {
    return this.serverGates.callsPerBinding;
  }

  /** Queue limit for one binding x server pair (default 32). */
  get queuedPerBinding(): number {
    return this.serverGates.queuedPerBinding;
  }

  /** The process-wide exclusive gate, exposed for health/admin counters. */
  get exclusiveGate(): ExclusiveGate {
    return this.serverGates.exclusiveGate;
  }

  /** Calls admitted (non-exclusive) and currently executing across all servers. */
  get inFlight(): number {
    return this.serverGates.exclusiveGate.inFlightCount;
  }

  /** True while an exclusive call holds the gate and new calls are queueing. */
  get admissionClosed(): boolean {
    return this.serverGates.exclusiveGate.admissionClosed;
  }

  /**
   * Runs one tool call under the gates. `exclusive` ignores the per-server lock
   * and the binding quota and waits for every admitted call to finish.
   */
  run<T>(
    serverId: string,
    bindingId: string | null,
    policy: ConcurrencyPolicy,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    return this.serverGates.withTool(serverId, policy, bindingId, fn);
  }
}
