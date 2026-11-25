/**
 * Health checks for the third-party connection pool.
 *
 * The pool reports child exit / transport close immediately on its own (that is
 * the primary signal). This monitor is the fallback for transports that stay
 * silently wedged: every 15s ±20% it pings each ready/degraded server, and a
 * server that answers "method not found" is marked `pingUnsupported` and left
 * to the exit signal plus per-call timeouts (design 03 §3.2).
 *
 * @module
 */

/** 15s base interval from design 03 §3.2. */
export const PING_INTERVAL_MS = 15_000;

/** ±20% jitter so many pools do not ping in lockstep. */
export const PING_JITTER_RATIO = 0.2;

/** A persisting monitor-level failure warns at most once per minute. */
export const HEALTH_WARN_INTERVAL_MS = 60_000;

/** `onFailure` id for a failure that is not tied to one pooled server. */
const MONITOR_FAILURE_ID = '*';

/** The slice of a pool entry the monitor needs. */
export interface HealthTarget {
  id: string;
  state: string;
  pingUnsupported: boolean;
}

/** Structural port implemented by `ConnectionPool`. */
export interface HealthPool {
  entries(): readonly HealthTarget[];
  ping(serverId: string): Promise<void>;
  markPingUnsupported(serverId: string): void;
  markTransportFailure(serverId: string, error?: unknown): void;
}

/** Timer seam so tests do not wait 15 seconds per tick. */
export interface HealthTimerApi {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface HealthMonitorOptions {
  pool: HealthPool;
  /** Base interval; defaults to 15s. */
  intervalMs?: number;
  /** Fraction of the interval used for ± jitter; defaults to 0.2. */
  jitterRatio?: number;
  random?: () => number;
  timers?: HealthTimerApi;
  /**
   * Called after a transport failure was recorded, for audit/logging. Also
   * receives monitor-level failures under id `'*'`, rate-limited.
   */
  onFailure?: (serverId: string, error: unknown) => void;
}

export interface HealthStats {
  /** Successful pings since construction. */
  pings: number;
  /** Servers that answered "method not found". */
  pingUnsupported: number;
  /** Transport-level ping failures handed to the pool. */
  failures: number;
  /** Ticks that found nothing to ping. */
  idleTicks: number;
}

const defaultTimers: HealthTimerApi = {
  set(callback, ms) {
    const timer = setTimeout(callback, ms);
    const candidate = timer as unknown as { unref?: () => void };
    candidate.unref?.();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Periodic ping loop. `tick()` is public and deterministic, so tests drive the
 * checks directly; `start()`/`stop()` only add the jittered scheduling.
 */
export class HealthMonitor {
  readonly intervalMs: number;
  readonly jitterRatio: number;
  readonly stats: HealthStats = { pings: 0, pingUnsupported: 0, failures: 0, idleTicks: 0 };

  private readonly pool: HealthPool;
  private readonly random: () => number;
  private readonly timers: HealthTimerApi;
  private readonly onFailure: ((serverId: string, error: unknown) => void) | undefined;
  private running = false;
  private ticking = false;
  private timer: unknown = null;
  private lastFailureWarnAt: number | null = null;

  constructor(options: HealthMonitorOptions) {
    const intervalMs = options.intervalMs ?? PING_INTERVAL_MS;
    const jitterRatio = options.jitterRatio ?? PING_JITTER_RATIO;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError('intervalMs must be a positive number');
    }
    if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
      throw new RangeError('jitterRatio must be between 0 and 1');
    }
    this.pool = options.pool;
    this.intervalMs = intervalMs;
    this.jitterRatio = jitterRatio;
    this.random = options.random ?? Math.random;
    this.timers = options.timers ?? defaultTimers;
    this.onFailure = options.onFailure;
  }

  /** True while the scheduled loop is armed. */
  get started(): boolean {
    return this.running;
  }

  /** One jittered delay, in milliseconds, rounded to a whole millisecond. */
  nextDelayMs(): number {
    const factor = 1 - this.jitterRatio + this.random() * 2 * this.jitterRatio;
    return Math.max(1, Math.round(this.intervalMs * factor));
  }

  /** Arms the loop. Calling twice is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  /** Disarms the loop; an in-flight tick finishes but does not reschedule. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  /**
   * Pings every ready/degraded entry once. Failures never reject the tick: a
   * method-not-found marks the server `pingUnsupported`, anything else is a
   * transport failure for the pool's circuit counter.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const targets = this.pool
        .entries()
        .filter((entry) => (entry.state === 'ready' || entry.state === 'degraded') && !entry.pingUnsupported);
      if (targets.length === 0) {
        this.stats.idleTicks += 1;
        return;
      }
      await Promise.all(
        targets.map(async (entry) => {
          try {
            await this.pool.ping(entry.id);
            this.stats.pings += 1;
          } catch (error) {
            if (isPingUnsupported(error)) {
              this.pool.markPingUnsupported(entry.id);
              this.stats.pingUnsupported += 1;
              return;
            }
            this.pool.markTransportFailure(entry.id, error);
            this.stats.failures += 1;
            this.onFailure?.(entry.id, error);
          }
        }),
      );
    } finally {
      this.ticking = false;
    }
  }

  /**
   * A rejected tick (a throwing `entries()` or listener) must neither stop the
   * loop nor disappear silently: report it through `onFailure`, capped at one
   * warning per {@link HEALTH_WARN_INTERVAL_MS}.
   */
  private reportFailure(error: unknown): void {
    const at = Date.now();
    if (this.lastFailureWarnAt !== null && at - this.lastFailureWarnAt < HEALTH_WARN_INTERVAL_MS) {
      return;
    }
    this.lastFailureWarnAt = at;
    try {
      this.onFailure?.(MONITOR_FAILURE_ID, error);
    } catch {
      // Logging is best-effort; the loop must keep scheduling.
    }
  }

  private schedule(): void {
    if (!this.running) return;
    const delay = this.nextDelayMs();
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.tick().then(
        () => this.schedule(),
        (error: unknown) => {
          this.reportFailure(error);
          this.schedule();
        },
      );
    }, delay);
  }
}

/** JSON-RPC -32601 or a pre-classified ping error: stop pinging this server. */
export function isPingUnsupported(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === -32601 ||
    code === 'MCP_PING_UNSUPPORTED' ||
    code === 'METHOD_NOT_FOUND' ||
    code === 'MCP_METHOD_NOT_FOUND'
  );
}
