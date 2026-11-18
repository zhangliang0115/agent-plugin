/** Transport sessions: one `Mcp-Session-Id` record per MCP stream, with idle expiry and close cascade. @module */
import { newId } from '@zhangliang0115/repl-server-core/src/ids.ts';

import { systemClock, type Clock } from '../ports.ts';

/** Idle TTL from protocol.md §8: a transport session dies 60 minutes after its last request. */
export const TRANSPORT_IDLE_MS = 60 * 60_000;

/** The first request of a session fixes it to the modern (`server/discover`) or legacy (`initialize`) flow. */
export type TransportMode = 'modern' | 'legacy';

export type TransportCloseReason = 'delete' | 'idle';

/** What callers see of a session. `lastRequestAt` is live; the registry mutates it on `touch`. */
export interface TransportSession {
  readonly id: string;
  readonly mode: TransportMode;
  readonly createdAt: number;
  lastRequestAt: number;
}

export interface TransportSessionHooks {
  /**
   * Runs once when the session is destroyed. `DELETE /mcp` uses the `delete` reason to cancel
   * in-flight evals, stop worker/serve and drop the task store. Rejections propagate to `delete`
   * and to `sweep` (as an `AggregateError` after every expired session was attempted).
   */
  onClose?: (reason: TransportCloseReason) => void | Promise<void>;
}

export interface TransportSessionRegistryOptions {
  clock?: Clock;
  /** Defaults to {@link TRANSPORT_IDLE_MS}; tests shrink it. */
  idleMs?: number;
}

interface TransportSessionRecord extends TransportSession {
  hooks: TransportSessionHooks;
  closed: boolean;
}

/**
 * Registry of transport sessions. It owns generation, last-request tracking, idle expiry and the
 * delete cascade; the HTTP layer only calls it. Expiry is lazy (`get`/`touch`) plus an explicit
 * `sweep()` so no timer is left behind in tests.
 */
export class TransportSessionRegistry {
  private readonly records = new Map<string, TransportSessionRecord>();
  private readonly clock: Clock;
  private readonly idleMs: number;

  constructor(options: TransportSessionRegistryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idleMs = options.idleMs ?? TRANSPORT_IDLE_MS;
  }

  /** Creates a session whose mode is fixed for its whole life; the id is `mcp_<32 hex>`. */
  create(mode: TransportMode, hooks: TransportSessionHooks = {}): TransportSession {
    const now = this.clock.now();
    const record: TransportSessionRecord = {
      id: newId('mcpSession'),
      mode,
      createdAt: now,
      lastRequestAt: now,
      hooks,
      closed: false,
    };
    this.records.set(record.id, record);
    return record;
  }

  /** Looks a session up without refreshing it. An idle session is destroyed and reported as null. */
  async get(id: string): Promise<TransportSession | null> {
    const record = this.records.get(id);
    if (record === undefined || record.closed) return null;
    if (this.isIdle(record, this.clock.now())) {
      await this.destroy(record, 'idle');
      return null;
    }
    return record;
  }

  /** Registers a request against the session; an idle session is destroyed instead of refreshed. */
  async touch(id: string, at: number = this.clock.now()): Promise<TransportSession | null> {
    const record = this.records.get(id);
    if (record === undefined || record.closed) return null;
    if (this.isIdle(record, at)) {
      await this.destroy(record, 'idle');
      return null;
    }
    record.lastRequestAt = at;
    return record;
  }

  /** `DELETE /mcp`: destroys now, runs the cascade once. False when the id is unknown or already closed. */
  async delete(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (record === undefined) return false;
    return this.destroy(record, 'delete');
  }

  /** Destroys every session idle at `at`; returns the destroyed ids. */
  async sweep(at: number = this.clock.now()): Promise<string[]> {
    const expired: TransportSessionRecord[] = [];
    for (const record of this.records.values()) {
      if (this.isIdle(record, at)) expired.push(record);
    }
    const destroyed: string[] = [];
    const errors: unknown[] = [];
    for (const record of expired) {
      try {
        if (await this.destroy(record, 'idle')) destroyed.push(record.id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'transport session close cascade failed');
    return destroyed;
  }

  get size(): number {
    return this.records.size;
  }

  /** Live sessions in creation order. */
  list(): TransportSession[] {
    return [...this.records.values()];
  }

  private isIdle(record: TransportSessionRecord, at: number): boolean {
    return at - record.lastRequestAt >= this.idleMs;
  }

  private async destroy(record: TransportSessionRecord, reason: TransportCloseReason): Promise<boolean> {
    if (record.closed) return false;
    // Flip the flag before awaiting so a concurrent delete/get cannot run the cascade twice.
    record.closed = true;
    this.records.delete(record.id);
    await record.hooks.onClose?.(reason);
    return true;
  }
}
