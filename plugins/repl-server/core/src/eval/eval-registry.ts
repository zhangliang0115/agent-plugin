/**
 * Keyed registry of execution sessions.
 *
 * The registry purposefully owns no policy: capacity limits and LRU eviction
 * belong to the server layer (plan `srv-07` / `srv-08`). Here a
 * key is opaque — the assembly uses `${mcpSessionId}\u0000${workspace}` — and the
 * only lifecycle operation is "drop it and dispose its worker".
 *
 * `delete`/`disposeAll` await `ExecSession.dispose()`, which settles every
 * in-flight eval as `worker_dead` before terminating the worker, so removing a
 * key can never leave a promise hanging.
 * @module
 */
import type { ExecSession } from './exec-session.ts';

export interface EvalRegistryEntry {
  key: string;
  session: ExecSession;
}

export interface EvalRegistryOptions {
  /** Builds a session for a key that is not registered yet. */
  create: (key: string) => ExecSession;
}

export class EvalRegistry {
  private readonly create: (key: string) => ExecSession;
  private readonly sessions = new Map<string, ExecSession>();

  constructor(options: EvalRegistryOptions) {
    this.create = options.create;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(key: string): ExecSession | undefined {
    return this.sessions.get(key);
  }

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  /** Returns the live session for `key`, creating and storing it on first use. */
  getOrCreate(key: string): ExecSession {
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;
    const session = this.create(key);
    this.sessions.set(key, session);
    return session;
  }

  keys(): string[] {
    return [...this.sessions.keys()];
  }

  list(): EvalRegistryEntry[] {
    return [...this.sessions.entries()].map(([key, session]) => ({ key, session }));
  }

  /** Sum of in-flight evals across every registered session. */
  activeEvalCount(): number {
    let total = 0;
    for (const session of this.sessions.values()) total += session.inFlightEvals;
    return total;
  }

  /**
   * Unlinks the key first, then disposes the session. Returns false for an
   * unknown key; a repeated delete is a no-op.
   */
  async delete(key: string): Promise<boolean> {
    const session = this.sessions.get(key);
    if (session === undefined) return false;
    this.sessions.delete(key);
    await session.dispose();
    return true;
  }

  /** Shutdown path: unlinks everything, then disposes each session sequentially. */
  async disposeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      await session.dispose();
    }
  }
}
