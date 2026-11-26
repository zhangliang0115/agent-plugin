/**
 * Third-party MCP connection pool.
 *
 * One connection per server id, shared by the whole process (design 03 §3):
 * lazy connect with in-flight dedupe, `detached: true` stdio children recorded
 * in `pool.json` through the injected {@link ProcessLedger}, a consuming stderr
 * pipe, connect timeout with transport teardown, exponential backoff, a
 * 5-failure circuit breaker and **no automatic replay** of business calls.
 *
 * External MCP clients are injected: this module never imports an SDK and never
 * spawns a process itself. The transport factory receives the exact stdio
 * options the pool requires (`detached: true`, `stderr: 'pipe'`), and a
 * transport's `close()` must terminate the child process group.
 *
 * @module
 */

import { McpToolError } from '@zhangliang0115/repl-server-core/src/errors.ts';

import { systemClock, type AuditSink, type Clock, type ProcessLedger } from '../ports.ts';
import { isPingUnsupported } from './health.ts';

/** `idle` = configured and never connected; `disabled` = switched off by the admin. */
export type ServerState =
  | 'disabled'
  | 'idle'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'reconnecting'
  | 'failed';

export type PoolTransportKind = 'stdio' | 'http';

/** Configuration snapshot for one third-party server (a row from `servers`). */
export interface PoolServerSpec {
  id: string;
  /** Bumped by the admin on every config change; a new value forces a reconnect. */
  cfgVersion: number;
  transport: PoolTransportKind;
  /** Defaults to true. */
  enabled?: boolean;
  command?: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Options the pool hands to a stdio transport adapter. */
export interface StdioTransportOptions {
  command: string;
  args: readonly string[];
  /** Whitelist-built environment; never `process.env` itself (design 03 §3.1). */
  env: Record<string, string>;
  cwd?: string;
  /** Always true: a SIGKILLed parent must not orphan the child's process group. */
  detached: true;
  /** Always `pipe`: a stderr pipe with no consumer eventually blocks the child. */
  stderr: 'pipe';
}

/** Options the pool hands to an HTTP transport adapter. */
export interface HttpTransportOptions {
  url: string;
  headers: Record<string, string>;
}

/**
 * A started transport. `close()` must resolve only after the underlying
 * connection (and child process group for stdio) is gone; the pool uses that
 * guarantee before clearing `pool.json`.
 */
export interface PoolTransport {
  readonly kind: PoolTransportKind;
  readonly pid?: number;
  readonly pgid?: number;
  /** Raw `ps -o lstart=` value, for PID-reuse checks in the ledger. */
  readonly lstart?: string;
  onStderr(handler: (chunk: string) => void): void;
  onClose(handler: (error?: unknown) => void): void;
  close(): Promise<void> | void;
}

/** What the pool needs from a hand-written MCP client adapter. */
export interface PoolToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface PoolClient {
  /** `initialize` on the transport; the pool bounds the wait. */
  connect(transport: PoolTransport, options: { signal: AbortSignal }): Promise<void>;
  /** Must hit the server, not a cache: it is the second half of the success criterion. */
  listTools(options: { signal: AbortSignal }): Promise<readonly PoolToolInfo[]>;
  callTool(name: string, args: unknown, options: { signal: AbortSignal }): Promise<unknown>;
  ping(options: { signal: AbortSignal }): Promise<void>;
  close(): Promise<void> | void;
}

/** Injected transport implementation (`StdioMcpClient` / `HttpMcpClient` adapters). */
export interface PoolTransportFactory {
  stdio(options: StdioTransportOptions): PoolTransport | Promise<PoolTransport>;
  http(options: HttpTransportOptions): PoolTransport | Promise<PoolTransport>;
}

/** Injected client implementation; one instance per connection attempt. */
export interface PoolClientFactory {
  create(spec: PoolServerSpec, transport: PoolTransport): PoolClient | Promise<PoolClient>;
}

export interface PoolEntrySnapshot {
  id: string;
  cfgVersion: number;
  transport: PoolTransportKind;
  state: ServerState;
  pid: number | null;
  pgid: number | null;
  lstart: string | null;
  generation: number;
  consecutiveFailures: number;
  /** Epoch ms before which a retry is not allowed; 0 when not waiting. */
  nextRetryAt: number;
  pingUnsupported: boolean;
  stderrDropped: number;
  inflight: number;
  tools: readonly PoolToolInfo[];
  lastError: { code: string; message: string } | null;
}

export interface PoolCallPrepare {
  /** Upstream search tool name. */
  tool: string;
  /** Arguments for the search tool (already `$query`-substituted). */
  args: unknown;
  /** Prepare-cache key on the current connection; typically the called tool. */
  cacheKey: string;
  /** Warm-up budget; only `min(15000, remaining call budget)` is ever used. */
  timeoutMs?: number;
  /**
   * Optional: parse the search result into the set of tool names it registered.
   * Returning `undefined` means "could not parse" and keeps only the cacheKey.
   */
  onPrepared?: (result: unknown) => readonly string[] | undefined;
}

export interface PoolCallOptions {
  /** Recorded per in-flight call; gates enforce the binding quota, not the pool. */
  bindingId?: string | null;
  signal?: AbortSignal;
  /** When present, warm the connection with this search before the business call. */
  prepare?: PoolCallPrepare;
}

/** Options for {@link ConnectionPool.callToolDirect}; no gates and no prepare. */
export interface PoolDirectCallOptions {
  bindingId?: string | null;
  signal?: AbortSignal;
}

export interface PoolOptions {
  transportFactory: PoolTransportFactory;
  clientFactory: PoolClientFactory;
  ledger?: ProcessLedger;
  audit?: AuditSink;
  /** Receives stderr chunks when set; otherwise they go to `audit`, then `stderrDropped`. */
  onStderr?: (serverId: string, chunk: string) => void;
  clock?: Clock;
  random?: () => number;
  /** Defaults to 10s (design 03 §3.1). */
  connectTimeoutMs?: number;
  /** Defaults to 60s (design 01 §6.3). */
  callTimeoutMs?: number;
  /** Defaults to 5s; short enough to finish before the next 12–18s ping tick. */
  pingTimeoutMs?: number;
  /** Exponential backoff; defaults to 500ms → 30s. */
  backoffMs?: readonly number[];
  /** Consecutive transport failures that open the circuit. Defaults to 5. */
  circuitThreshold?: number;
  /** How long the circuit stays open before a single probe. Defaults to 60s. */
  circuitCooldownMs?: number;
  /** Background reconnect after a transport failure. Defaults to true. */
  autoReconnect?: boolean;
  /** Env keys copied from `baseEnv` into a stdio child. Defaults to PATH/HOME/LANG. */
  envWhitelist?: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
  /** Stderr text is truncated to this many characters before dispatch. Defaults to 8k. */
  stderrChunkChars?: number;
  servers?: readonly PoolServerSpec[];
}

export const POOL_DEFAULTS = {
  connectTimeoutMs: 10_000,
  callTimeoutMs: 60_000,
  pingTimeoutMs: 5_000,
  backoffMs: [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const,
  circuitThreshold: 5,
  circuitCooldownMs: 60_000,
  envWhitelist: ['PATH', 'HOME', 'LANG'] as const,
  stderrChunkChars: 8_192,
  /** Upper bound for one call-time discovery warm-up (design 07 §4.6). */
  prepareTimeoutMs: 15_000,
} as const;

const BACKOFF_JITTER_RATIO = 0.2;

/** Transport-level error codes that count toward `degraded` and the circuit. */
const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'MCP_SERVER_UNAVAILABLE',
  'MCP_SESSION_EXPIRED_RETRY',
  'MCP_PROTOCOL_ERROR',
  'MCP_CALL_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_STREAM_DESTROYED',
]);

/** True for failures that mean "the connection itself is unhealthy". */
export function isTransportFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const record = error as { code?: unknown; transport?: unknown };
  if (typeof record.transport === 'boolean') return record.transport;
  return typeof record.code === 'string' && TRANSPORT_ERROR_CODES.has(record.code);
}

interface InflightCall {
  controller: AbortController;
  startedAt: number;
  bindingId: string | null;
  fail: (error: unknown) => void;
}

interface PoolEntry {
  spec: PoolServerSpec;
  state: ServerState;
  generation: number;
  transport: PoolTransport | null;
  client: PoolClient | null;
  connectPromise: Promise<void> | null;
  consecutiveFailures: number;
  nextRetryAt: number;
  pingUnsupported: boolean;
  stderrDropped: number;
  tools: readonly PoolToolInfo[];
  readonly inflight: Map<number, InflightCall>;
  retryTimer: ReturnType<typeof setTimeout> | null;
  lastError: { code: string; message: string } | null;
  /** cacheKeys prepared on the current connection generation. */
  prepared: Set<string>;
  /** In-flight prepare promises, one per cacheKey. */
  preparePending: Map<string, Promise<void>>;
  /** Bumped by explicit invalidation so late writes cannot land. */
  prepareEpoch: number;
}

/**
 * One process-wide pool. A failed connection is never retried by replaying the
 * business call: the call rejects with `retryable` metadata and the reconnect
 * happens in the background (or on the next `ensureConnected`).
 */
export class ConnectionPool {
  private readonly options: Required<Omit<PoolOptions, 'ledger' | 'audit' | 'onStderr' | 'servers' | 'baseEnv'>> &
    Pick<PoolOptions, 'ledger' | 'audit' | 'onStderr' | 'baseEnv'>;
  private readonly serverMap = new Map<string, PoolEntry>();
  private closed = false;
  private nextCallId = 0;

  constructor(options: PoolOptions) {
    const connectTimeoutMs = options.connectTimeoutMs ?? POOL_DEFAULTS.connectTimeoutMs;
    const callTimeoutMs = options.callTimeoutMs ?? POOL_DEFAULTS.callTimeoutMs;
    const pingTimeoutMs = options.pingTimeoutMs ?? POOL_DEFAULTS.pingTimeoutMs;
    const circuitThreshold = options.circuitThreshold ?? POOL_DEFAULTS.circuitThreshold;
    const circuitCooldownMs = options.circuitCooldownMs ?? POOL_DEFAULTS.circuitCooldownMs;
    const backoffMs = options.backoffMs ?? POOL_DEFAULTS.backoffMs;
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
      throw new RangeError('connectTimeoutMs must be a positive number');
    }
    if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) {
      throw new RangeError('callTimeoutMs must be a positive number');
    }
    if (!Number.isFinite(pingTimeoutMs) || pingTimeoutMs <= 0) {
      throw new RangeError('pingTimeoutMs must be a positive number');
    }
    if (!Number.isInteger(circuitThreshold) || circuitThreshold < 1) {
      throw new RangeError('circuitThreshold must be a positive integer');
    }
    if (!Number.isFinite(circuitCooldownMs) || circuitCooldownMs < 0) {
      throw new RangeError('circuitCooldownMs must be a non-negative number');
    }
    if (backoffMs.length === 0 || backoffMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new RangeError('backoffMs must contain non-negative numbers');
    }

    this.options = {
      transportFactory: options.transportFactory,
      clientFactory: options.clientFactory,
      ledger: options.ledger,
      audit: options.audit,
      onStderr: options.onStderr,
      clock: options.clock ?? systemClock,
      random: options.random ?? Math.random,
      connectTimeoutMs,
      callTimeoutMs,
      pingTimeoutMs,
      backoffMs,
      circuitThreshold,
      circuitCooldownMs,
      autoReconnect: options.autoReconnect ?? true,
      envWhitelist: options.envWhitelist ?? POOL_DEFAULTS.envWhitelist,
      baseEnv: options.baseEnv,
      stderrChunkChars: options.stderrChunkChars ?? POOL_DEFAULTS.stderrChunkChars,
    };

    for (const spec of options.servers ?? []) this.addEntry(spec);
  }

  /**
   * Adds or replaces a server. A different `cfgVersion` tears the old
   * connection down first so the ledger never holds two process records for one
   * server id. Same-version registration only refreshes the stored spec.
   */
  async register(spec: PoolServerSpec): Promise<void> {
    if (this.closed) throw new Error('the pool is closed');
    validateSpec(spec);
    const existing = this.serverMap.get(spec.id);
    if (existing !== undefined) {
      if (existing.spec.cfgVersion === spec.cfgVersion) {
        existing.spec = spec;
        return;
      }
      this.serverMap.delete(spec.id);
      await this.detach(existing, spec.enabled === false ? 'disabled' : 'idle');
    }
    this.addEntry(spec);
  }

  /** Removes a server and closes its connection. Unknown ids are a no-op. */
  async unregister(serverId: string): Promise<void> {
    const entry = this.serverMap.get(serverId);
    if (entry === undefined) return;
    this.serverMap.delete(serverId);
    await this.detach(entry, 'idle');
  }

  /** Current state of one server, or `null` when it is not registered. */
  entry(serverId: string): PoolEntrySnapshot | null {
    const entry = this.serverMap.get(serverId);
    return entry === undefined ? null : snapshotOf(entry);
  }

  /** All servers sorted by id, for health checks and the admin view. */
  entries(): readonly PoolEntrySnapshot[] {
    return [...this.serverMap.values()]
      .sort((left, right) => left.spec.id.localeCompare(right.spec.id))
      .map(snapshotOf);
  }

  /**
   * Connects lazily. Concurrent callers share one attempt, and a call made
   * during the backoff/circuit window fails fast with `retryAfterMs` instead of
   * spawning another child.
   */
  async ensureConnected(serverId: string): Promise<void> {
    const entry = this.requireEntry(serverId);
    if (entry.state === 'disabled' || entry.spec.enabled === false) {
      entry.state = 'disabled';
      throw new McpToolError(`MCP server ${serverId} is disabled`, {
        code: 'MCP_SERVER_DISABLED',
        server: serverId,
      });
    }
    if (entry.state === 'ready' || entry.state === 'degraded') return;
    if (entry.connectPromise !== null) return entry.connectPromise;

    const now = this.options.clock.now();
    if ((entry.state === 'reconnecting' || entry.state === 'failed') && now < entry.nextRetryAt) {
      throw new McpToolError(
        `MCP server ${serverId} is ${entry.state}; next retry in ${entry.nextRetryAt - now}ms`,
        {
          code: 'MCP_SERVER_UNAVAILABLE',
          server: serverId,
          retryable: true,
          retryAfterMs: entry.nextRetryAt - now,
          detail: entry.lastError ?? undefined,
        },
      );
    }
    // A connect that already ran but was superseded leaves `starting` behind;
    // treat it as due and start a fresh attempt.
    await this.startConnect(entry);
  }

  /**
   * Calls a tool through the pooled connection. The pool never replays: one
   * attempt, one result or one error. Gates (binding quota, serial/exclusive)
   * wrap this method; they are not applied here.
   *
   * When `options.prepare` is present and the cacheKey is not prepared on the
   * current connection, the search tool runs first on the same client. Prepare
   * and the business call share one deadline.
   */
  async callTool(
    serverId: string,
    tool: string,
    args: unknown,
    options: PoolCallOptions = {},
  ): Promise<unknown> {
    return await this.callOnConnection(serverId, tool, args, options, options.prepare);
  }

  /**
   * One call on the pooled connection without gates and without preparation.
   * Used by a caller that already holds the server's serial gate (discovery
   * scans must not re-enter {@link PoolGates}).
   */
  async callToolDirect(
    serverId: string,
    tool: string,
    args: unknown,
    options: PoolDirectCallOptions = {},
  ): Promise<unknown> {
    return await this.callOnConnection(serverId, tool, args, options, undefined);
  }

  /**
   * Drops every warm-up entry for one server. In-flight prepares are also
   * invalidated, so a late result cannot repopulate the cache.
   */
  invalidatePrepared(serverId: string): void {
    const entry = this.serverMap.get(serverId);
    if (entry === undefined) return;
    this.clearPrepared(entry);
  }

  private async callOnConnection(
    serverId: string,
    tool: string,
    args: unknown,
    options: PoolDirectCallOptions,
    prepare: PoolCallPrepare | undefined,
  ): Promise<unknown> {
    await this.ensureConnected(serverId);
    const entry = this.requireEntry(serverId);
    const client = entry.client;
    if (client === null || (entry.state !== 'ready' && entry.state !== 'degraded')) {
      throw unavailableError(entry, `server is ${entry.state}`);
    }

    const signal = options.signal;
    if (signal?.aborted === true) {
      throw new McpToolError(`call ${serverId}.${tool} was cancelled before it started`, {
        code: 'MCP_CALL_CANCELLED',
        server: serverId,
        tool,
      });
    }

    const callId = ++this.nextCallId;
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const death = new Promise<never>((_resolve, reject) => {
      entry.inflight.set(callId, {
        controller,
        startedAt: this.options.clock.now(),
        bindingId: options.bindingId ?? null,
        fail: reject,
      });
    });

    const deadline = this.options.clock.now() + this.options.callTimeoutMs;
    const task = this.invoke(entry, tool, args, prepare, controller.signal, deadline, (reason) =>
      controller.abort(reason),
    );
    try {
      const result = await withTimeout(
        Promise.race([task, death]),
        this.options.callTimeoutMs,
        () => controller.abort(new Error('call timeout')),
        () => callTimeoutError(entry, tool),
      );
      this.markHealthy(entry);
      return result;
    } catch (error) {
      // Warm-up failures already classified the transport inside
      // `prepareForCall`; re-classifying the wrapper would mark a genuinely
      // degraded link healthy again.
      if (errorCode(error) !== 'MCP_DISCOVERY_PREPARE_FAILED') {
        this.classifyFailure(entry, error);
      }
      throw error;
    } finally {
      entry.inflight.delete(callId);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Runs the optional warm-up, then the business call, on one connection. */
  private async invoke(
    entry: PoolEntry,
    tool: string,
    args: unknown,
    prepare: PoolCallPrepare | undefined,
    signal: AbortSignal,
    deadline: number,
    abortCall: (reason: unknown) => void,
  ): Promise<unknown> {
    if (prepare !== undefined) {
      if (entry.prepared.has(prepare.cacheKey)) {
        this.auditPrepare(entry, tool, prepare.cacheKey, true, 0, true, undefined);
      } else {
        await this.prepareForCall(entry, prepare, signal, deadline, abortCall);
      }
    }

    const client = entry.client;
    if (client === null) throw unavailableError(entry, `server is ${entry.state}`);
    try {
      return await client.callTool(tool, args, { signal });
    } catch (error) {
      if (prepare !== undefined && isUnknownToolError(error)) {
        // The upstream tool set moved on; the next call prepares again.
        entry.prepared.delete(prepare.cacheKey);
      }
      throw error;
    }
  }

  /**
   * One warm-up, deduplicated per cacheKey. A successful result replaces the
   * prepared set with the parsed registered names (replace semantics are safe
   * for both overwrite-style and additive upstreams), always after checking
   * the connection generation and the invalidation epoch.
   */
  private async prepareForCall(
    entry: PoolEntry,
    prepare: PoolCallPrepare,
    signal: AbortSignal,
    deadline: number,
    abortCall: (reason: unknown) => void,
  ): Promise<void> {
    const pending = entry.preparePending.get(prepare.cacheKey);
    if (pending !== undefined) {
      await pending;
      return;
    }

    const generation = entry.generation;
    const epoch = entry.prepareEpoch;
    const startedAt = this.options.clock.now();
    const remaining = deadline - startedAt;
    const maxBudget = Math.min(POOL_DEFAULTS.prepareTimeoutMs, remaining);
    if (maxBudget <= 0) {
      throw prepareError(entry, prepare, 'deadline_exceeded', undefined, false);
    }
    const budget = Math.max(
      1,
      Math.min(prepare.timeoutMs ?? POOL_DEFAULTS.prepareTimeoutMs, maxBudget),
    );

    const task = (async (): Promise<void> => {
      const client = entry.client;
      if (client === null) {
        throw prepareError(entry, prepare, 'not_connected', undefined, true);
      }

      let result: unknown;
      try {
        result = await withTimeout(
          Promise.resolve(client.callTool(prepare.tool, prepare.args, { signal })),
          budget,
          () => abortCall(new Error('discovery prepare timeout')),
          () => prepareError(entry, prepare, 'timeout', undefined, true),
        );
      } catch (error) {
        if (errorCode(error) === 'MCP_DISCOVERY_PREPARE_FAILED') {
          this.auditPrepare(entry, prepare.tool, prepare.cacheKey, false, this.elapsed(startedAt), false, errorCode(error));
          throw error;
        }
        this.classifyFailure(entry, error);
        const wrapped = prepareError(entry, prepare, 'search_failed', error, isRetryable(error));
        this.auditPrepare(entry, prepare.tool, prepare.cacheKey, false, this.elapsed(startedAt), false, wrapped.code);
        throw wrapped;
      }

      if (entry.generation !== generation) {
        const error = prepareError(entry, prepare, 'generation_changed', undefined, true);
        this.auditPrepare(entry, prepare.tool, prepare.cacheKey, false, this.elapsed(startedAt), false, error.code);
        throw error;
      }
      if (entry.prepareEpoch !== epoch) {
        const error = prepareError(entry, prepare, 'invalidated', undefined, true);
        this.auditPrepare(entry, prepare.tool, prepare.cacheKey, false, this.elapsed(startedAt), false, error.code);
        throw error;
      }

      if (prepare.onPrepared !== undefined) {
        let names: readonly string[] | undefined;
        try {
          names = prepare.onPrepared(result);
        } catch {
          names = undefined;
        }
        if (names !== undefined) entry.prepared = new Set(names);
      }
      entry.prepared.add(prepare.cacheKey);
      this.auditPrepare(entry, prepare.tool, prepare.cacheKey, false, this.elapsed(startedAt), true, undefined);
    })();

    entry.preparePending.set(prepare.cacheKey, task);
    try {
      await task;
    } finally {
      if (entry.preparePending.get(prepare.cacheKey) === task) {
        entry.preparePending.delete(prepare.cacheKey);
      }
    }
  }

  /** Degrades or reconnects for transport failures; tool errors leave the link alone. */
  private classifyFailure(entry: PoolEntry, error: unknown): void {
    if (errorCode(error) === 'MCP_SESSION_EXPIRED_RETRY') {
      // HTTP session expiry is a reconnect event, not a business failure.
      // The call still rejects unchanged: MCP tools are not idempotent, so
      // the pool never replays it (design 03 §3.3).
      this.abandonTransport(entry, 'HTTP session expired');
    } else if (isTransportFailure(error)) {
      // A tool-level JSON-RPC error proves the transport is alive; only
      // transport failures degrade the entry. `markTransportFailure` is a
      // no-op when a concurrent close already moved the entry out of
      // ready/degraded, so the failure is counted once.
      this.markTransportFailure(entry.spec.id, error);
    } else if (entry.state === 'ready' || entry.state === 'degraded') {
      this.markHealthy(entry);
    }
  }

  private clearPrepared(entry: PoolEntry): void {
    entry.prepared.clear();
    entry.preparePending.clear();
    entry.prepareEpoch += 1;
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, this.options.clock.now() - startedAt);
  }

  private auditPrepare(
    entry: PoolEntry,
    tool: string,
    cacheKey: string,
    cacheHit: boolean,
    ms: number,
    ok: boolean,
    errorCodeValue: string | undefined,
  ): void {
    const audit = this.options.audit;
    if (audit === undefined) return;
    try {
      audit.write({
        event: 'discovery_prepare',
        ts: new Date(this.options.clock.now()).toISOString(),
        server: entry.spec.id,
        tool,
        cacheKey,
        cacheHit,
        ms,
        ok,
        ...(errorCodeValue === undefined ? {} : { errorCode: errorCodeValue }),
      });
    } catch {
      // Audit must never fail a call.
    }
  }

  /**
   * One health ping. A server that answers "method not found" is reported as
   * `MCP_PING_UNSUPPORTED` so the monitor can stop pinging it.
   */
  async ping(serverId: string): Promise<void> {
    const entry = this.requireEntry(serverId);
    if (entry.state !== 'ready' && entry.state !== 'degraded') {
      throw unavailableError(entry, `server is ${entry.state}`);
    }
    const client = entry.client;
    if (client === null) throw unavailableError(entry, 'client is not connected');

    const controller = new AbortController();
    try {
      await withTimeout(
        Promise.resolve(client.ping({ signal: controller.signal })),
        this.options.pingTimeoutMs,
        () => controller.abort(new Error('ping timeout')),
        () => unavailableError(entry, 'ping timed out'),
      );
    } catch (error) {
      if (isPingUnsupported(error)) {
        throw new McpToolError(`MCP server ${serverId} does not support ping`, {
          code: 'MCP_PING_UNSUPPORTED',
          server: serverId,
          detail: error,
        });
      }
      throw unavailableError(entry, `ping failed: ${errorMessage(error)}`, error);
    }
  }

  /** The monitor learned the server rejects `ping`; stop scheduling it. */
  markPingUnsupported(serverId: string): void {
    const entry = this.serverMap.get(serverId);
    if (entry !== undefined) entry.pingUnsupported = true;
  }

  /**
   * Records one transport-level failure from the health monitor. Below the
   * threshold the entry becomes `degraded` (still callable); at the threshold
   * the circuit opens (`failed`, transport closed, one probe after the cooldown).
   */
  markTransportFailure(serverId: string, error?: unknown): void {
    const entry = this.serverMap.get(serverId);
    if (entry === undefined || this.closed) return;
    if (entry.state !== 'ready' && entry.state !== 'degraded') return;

    entry.consecutiveFailures += 1;
    entry.lastError = {
      code: 'MCP_SERVER_UNAVAILABLE',
      message: errorMessage(error),
    };
    if (entry.consecutiveFailures >= this.options.circuitThreshold) {
      this.openCircuit(entry);
      return;
    }
    entry.state = 'degraded';
  }

  /** Closes the connection now and returns to `idle` (admin disconnect). */
  async disconnect(serverId: string): Promise<void> {
    const entry = this.requireEntry(serverId);
    await this.detach(entry, entry.spec.enabled === false ? 'disabled' : 'idle');
  }

  /** Closes every connection and stops all retry timers. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const all = [...this.serverMap.values()];
    this.serverMap.clear();
    await Promise.all(all.map((entry) => this.detach(entry, 'idle')));
  }

  private addEntry(spec: PoolServerSpec): void {
    validateSpec(spec);
    const entry: PoolEntry = {
      spec,
      state: spec.enabled === false ? 'disabled' : 'idle',
      generation: 0,
      transport: null,
      client: null,
      connectPromise: null,
      consecutiveFailures: 0,
      nextRetryAt: 0,
      pingUnsupported: false,
      stderrDropped: 0,
      tools: [],
      inflight: new Map(),
      retryTimer: null,
      lastError: null,
      prepared: new Set<string>(),
      preparePending: new Map<string, Promise<void>>(),
      prepareEpoch: 0,
    };
    this.serverMap.set(spec.id, entry);
  }

  private requireEntry(serverId: string): PoolEntry {
    const entry = this.serverMap.get(serverId);
    if (entry === undefined) {
      throw new McpToolError(`unknown MCP server ${serverId}`, {
        code: 'MCP_SERVER_NOT_FOUND',
        server: serverId,
      });
    }
    return entry;
  }

  /** Shares one connect attempt between every caller (the lazy-connect dedupe). */
  private startConnect(entry: PoolEntry): Promise<void> {
    if (entry.connectPromise !== null) return entry.connectPromise;
    const attempt = this.connect(entry);
    entry.connectPromise = attempt;
    void attempt
      .catch(() => {
        // The failure is recorded and reported through the promise itself.
      })
      .finally(() => {
        if (entry.connectPromise === attempt) entry.connectPromise = null;
      });
    return attempt;
  }

  private async connect(entry: PoolEntry): Promise<void> {
    if (this.closed) throw unavailableError(entry, 'the pool is closed');
    if (entry.spec.enabled === false) {
      entry.state = 'disabled';
      throw new McpToolError(`MCP server ${entry.spec.id} is disabled`, {
        code: 'MCP_SERVER_DISABLED',
        server: entry.spec.id,
      });
    }

    entry.state = 'starting';
    entry.generation += 1;
    const generation = entry.generation;
    entry.lastError = null;
    await this.closeCurrent(entry);

    const spec = entry.spec;
    try {
      let transport: PoolTransport;
      if (spec.transport === 'stdio') {
        // Intent first: a crash between these two lines still leaves a record
        // the startup sweep can find (design 02 §3.3).
        await this.writeLedgerIntent(entry);
        transport = await this.openStdio(entry);
      } else {
        transport = await this.openHttp(entry);
      }
      if (this.isStale(entry, generation)) {
        await closeQuietly(transport);
        throw unavailableError(entry, 'connection attempt was superseded');
      }

      entry.transport = transport;
      this.watchTransport(entry, generation, transport);

      const client = await this.options.clientFactory.create(spec, transport);
      if (this.isStale(entry, generation)) {
        await closeQuietly(client);
        await closeQuietly(transport);
        throw unavailableError(entry, 'connection attempt was superseded');
      }
      entry.client = client;

      const controller = new AbortController();
      await withTimeout(
        Promise.resolve(client.connect(transport, { signal: controller.signal })),
        this.options.connectTimeoutMs,
        () => controller.abort(new Error('connect timeout')),
        () => unavailableError(entry, 'connect timed out'),
      );
      // Success means initialize *and* tools/list (design 03 §3.3).
      const tools = await withTimeout(
        Promise.resolve(client.listTools({ signal: controller.signal })),
        this.options.connectTimeoutMs,
        () => controller.abort(new Error('tools/list timeout')),
        () => unavailableError(entry, 'tools/list timed out'),
      );
      if (this.isStale(entry, generation)) {
        throw unavailableError(entry, 'connection attempt was superseded');
      }

      entry.tools = tools;
      entry.state = 'ready';
      entry.consecutiveFailures = 0;
      entry.nextRetryAt = 0;
      entry.lastError = null;
      this.clearRetry(entry);
      // pool.json records stdio child processes only; HTTP has no PID to recover.
      if (spec.transport === 'stdio') await this.writeLedgerReady(entry, transport);
    } catch (error) {
      await this.failConnect(entry, generation, error);
      throw toUnavailableError(entry, error);
    }
  }

  private async openStdio(entry: PoolEntry): Promise<PoolTransport> {
    const spec = entry.spec;
    if (spec.command === undefined || spec.command === '') {
      throw new TypeError(`stdio server ${spec.id} has no command`);
    }
    const options: StdioTransportOptions = {
      command: spec.command,
      args: [...(spec.args ?? [])],
      env: this.buildEnv(spec),
      detached: true,
      stderr: 'pipe',
    };
    if (spec.cwd !== undefined) options.cwd = spec.cwd;
    return await this.options.transportFactory.stdio(options);
  }

  private async openHttp(entry: PoolEntry): Promise<PoolTransport> {
    const spec = entry.spec;
    if (spec.url === undefined || spec.url === '') {
      throw new TypeError(`http server ${spec.id} has no url`);
    }
    return await this.options.transportFactory.http({
      url: spec.url,
      headers: { ...(spec.headers ?? {}) },
    });
  }

  /** Whitelisted environment: never hand the caller's tokens/proxies to a third party. */
  private buildEnv(spec: PoolServerSpec): Record<string, string> {
    const base = this.options.baseEnv ?? process.env;
    const env: Record<string, string> = {};
    for (const key of this.options.envWhitelist) {
      const value = base[key];
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = value;
    return env;
  }

  private watchTransport(entry: PoolEntry, generation: number, transport: PoolTransport): void {
    transport.onClose((error) => {
      this.handleTransportClosed(entry, generation, error);
    });
    transport.onStderr((chunk) => {
      this.consumeStderr(entry, chunk);
    });
  }

  private consumeStderr(entry: PoolEntry, chunk: string): void {
    const limit = this.options.stderrChunkChars;
    const text = chunk.length > limit ? chunk.slice(0, limit) : chunk;
    if (this.options.onStderr !== undefined) {
      try {
        this.options.onStderr(entry.spec.id, text);
        return;
      } catch {
        // A broken consumer must not break the pipe drain; fall through.
      }
    }
    if (this.options.audit !== undefined) {
      try {
        this.options.audit.write({
          event: 'pool_stderr',
          ts: new Date(this.options.clock.now()).toISOString(),
          serverId: entry.spec.id,
          text,
        });
        return;
      } catch {
        // Same as above: keep draining.
      }
    }
    entry.stderrDropped += 1;
  }

  /**
   * Child exit / transport close. This is the immediate signal (design 03
   * §3.2): every in-flight call fails now and the entry starts reconnecting;
   * the periodic ping is only the fallback.
   */
  private handleTransportClosed(entry: PoolEntry, generation: number, error?: unknown): void {
    if (this.closed || entry.generation !== generation) return;
    entry.generation += 1;

    const failure = unavailableError(
      entry,
      error === undefined ? 'transport closed' : `transport closed: ${errorMessage(error)}`,
      error,
    );
    entry.lastError = { code: failure.code, message: failure.message };
    this.failInflight(entry, failure);

    const client = entry.client;
    entry.client = null;
    entry.transport = null;
    this.clearPrepared(entry);
    void closeQuietly(client);
    void this.removeLedger(entry);
    this.recordFailure(entry);
  }

  private async failConnect(entry: PoolEntry, generation: number, error: unknown): Promise<void> {
    if (entry.generation !== generation) {
      // A transport close already handled (and counted) this attempt.
      await this.closeCurrent(entry);
      return;
    }
    entry.generation += 1;
    await this.closeCurrent(entry);
    entry.lastError = {
      code: 'MCP_SERVER_UNAVAILABLE',
      message: errorMessage(error),
    };
    await this.removeLedger(entry);
    if (!this.closed) this.recordFailure(entry);
  }

  /** Counts one connection-level failure and arms the backoff or the circuit. */
  private recordFailure(entry: PoolEntry): void {
    entry.consecutiveFailures += 1;
    const now = this.options.clock.now();
    if (entry.consecutiveFailures >= this.options.circuitThreshold) {
      entry.state = 'failed';
      entry.nextRetryAt = now + this.options.circuitCooldownMs;
    } else {
      entry.state = 'reconnecting';
      entry.nextRetryAt = now + this.backoffDelay(entry.consecutiveFailures);
    }
    this.scheduleRetry(entry);
  }

  /** 500ms → 30s with ±20% jitter; extra failures reuse the cap. */
  private backoffDelay(failureCount: number): number {
    const schedule = this.options.backoffMs;
    const index = Math.min(Math.max(failureCount - 1, 0), schedule.length - 1);
    const base = schedule[index] ?? schedule[schedule.length - 1] ?? 500;
    const factor = 1 - BACKOFF_JITTER_RATIO + this.options.random() * 2 * BACKOFF_JITTER_RATIO;
    return Math.max(0, Math.round(base * factor));
  }

  private scheduleRetry(entry: PoolEntry): void {
    if (!this.options.autoReconnect || this.closed) return;
    this.clearRetry(entry);
    const delay = Math.max(0, entry.nextRetryAt - this.options.clock.now());
    const timer = setTimeout(() => {
      if (entry.retryTimer === timer) entry.retryTimer = null;
      if (this.closed) return;
      if (entry.state !== 'reconnecting' && entry.state !== 'failed') return;
      void this.startConnect(entry).catch(() => {
        // Failure is recorded by `connect` and rearms the timer.
      });
    }, delay);
    unrefTimer(timer);
    entry.retryTimer = timer;
  }

  private clearRetry(entry: PoolEntry): void {
    if (entry.retryTimer === null) return;
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }

  /** Opens the circuit: fail in-flight calls, close the connection, wait the cooldown. */
  private openCircuit(entry: PoolEntry): void {
    entry.state = 'failed';
    entry.nextRetryAt = this.options.clock.now() + this.options.circuitCooldownMs;
    const failure = unavailableError(entry, 'circuit breaker is open');
    entry.lastError = { code: failure.code, message: failure.message };
    entry.generation += 1;
    this.failInflight(entry, failure);
    void this.closeCurrent(entry).then(() => this.removeLedger(entry));
    this.scheduleRetry(entry);
  }

  /**
   * Drops a connection whose protocol session is gone (HTTP 404) and arms the
   * normal backoff/circuit path. In-flight calls fail fast; none are replayed.
   */
  private abandonTransport(entry: PoolEntry, reason: string): void {
    if (entry.state !== 'ready' && entry.state !== 'degraded') return;
    entry.generation += 1;
    const failure = unavailableError(entry, reason);
    entry.lastError = { code: failure.code, message: failure.message };
    this.failInflight(entry, failure);
    void this.closeCurrent(entry).then(() => this.removeLedger(entry));
    this.recordFailure(entry);
  }

  private failInflight(entry: PoolEntry, error: McpToolError): void {
    for (const call of entry.inflight.values()) {
      call.controller.abort(error);
      call.fail(error);
    }
    entry.inflight.clear();
  }

  /** A successful response proves the connection is healthy again. */
  private markHealthy(entry: PoolEntry): void {
    entry.consecutiveFailures = 0;
    entry.nextRetryAt = 0;
    entry.lastError = null;
    if (entry.state === 'degraded') entry.state = 'ready';
  }

  private isStale(entry: PoolEntry, generation: number): boolean {
    return this.closed || entry.generation !== generation;
  }

  private async closeCurrent(entry: PoolEntry): Promise<void> {
    const client = entry.client;
    const transport = entry.transport;
    entry.client = null;
    entry.transport = null;
    this.clearPrepared(entry);
    await closeQuietly(client);
    await closeQuietly(transport);
  }

  private async detach(entry: PoolEntry, nextState: ServerState): Promise<void> {
    this.clearRetry(entry);
    entry.generation += 1;
    const failure = unavailableError(entry, 'server was disconnected');
    this.failInflight(entry, failure);
    await this.closeCurrent(entry);
    await this.removeLedger(entry);
    entry.consecutiveFailures = 0;
    entry.nextRetryAt = 0;
    entry.lastError = null;
    entry.tools = [];
    entry.state = nextState;
  }

  private async writeLedgerIntent(entry: PoolEntry): Promise<void> {
    const ledger = this.options.ledger;
    if (ledger === undefined) return;
    await ledger.recordPool({
      serverId: entry.spec.id,
      cfgVersion: entry.spec.cfgVersion,
      pid: null,
      pgid: null,
      lstart: null,
      state: 'spawning',
      startedAt: new Date(this.options.clock.now()).toISOString(),
    });
  }

  private async writeLedgerReady(entry: PoolEntry, transport: PoolTransport): Promise<void> {
    const ledger = this.options.ledger;
    if (ledger === undefined) return;
    // The ledger only accepts a complete {pid, pgid, lstart} triple (core
    // ProcessLedger validates this); a partially described process is worse
    // than no pid at all because recovery could kill an unrelated PID.
    const complete =
      transport.pid !== undefined && transport.pgid !== undefined && transport.lstart !== undefined;
    await ledger.recordPool({
      serverId: entry.spec.id,
      cfgVersion: entry.spec.cfgVersion,
      pid: complete ? transport.pid : null,
      pgid: complete ? transport.pgid : null,
      lstart: complete ? transport.lstart : null,
      state: 'running',
      startedAt: new Date(this.options.clock.now()).toISOString(),
    });
  }

  private async removeLedger(entry: PoolEntry): Promise<void> {
    const ledger = this.options.ledger;
    if (ledger === undefined || entry.spec.transport !== 'stdio') return;
    try {
      await ledger.removePool(entry.spec.id);
    } catch {
      // Cleanup is best effort; the startup sweep also reads the ledger.
    }
  }
}

function snapshotOf(entry: PoolEntry): PoolEntrySnapshot {
  const transport = entry.transport;
  return {
    id: entry.spec.id,
    cfgVersion: entry.spec.cfgVersion,
    transport: entry.spec.transport,
    state: entry.state,
    pid: transport?.pid ?? null,
    pgid: transport?.pgid ?? null,
    lstart: transport?.lstart ?? null,
    generation: entry.generation,
    consecutiveFailures: entry.consecutiveFailures,
    nextRetryAt: entry.nextRetryAt,
    pingUnsupported: entry.pingUnsupported,
    stderrDropped: entry.stderrDropped,
    inflight: entry.inflight.size,
    tools: entry.tools,
    lastError: entry.lastError === null ? null : { ...entry.lastError },
  };
}

function validateSpec(spec: PoolServerSpec): void {
  if (typeof spec.id !== 'string' || spec.id === '') {
    throw new TypeError('server id must be a non-empty string');
  }
  if (!Number.isInteger(spec.cfgVersion) || spec.cfgVersion < 1) {
    throw new RangeError(`server ${spec.id} cfgVersion must be a positive integer`);
  }
  if (spec.transport === 'stdio') {
    if (spec.command === undefined || spec.command === '') {
      throw new TypeError(`stdio server ${spec.id} requires a command`);
    }
    return;
  }
  if (spec.transport === 'http') {
    if (spec.url === undefined || spec.url === '') {
      throw new TypeError(`http server ${spec.id} requires a url`);
    }
    return;
  }
  throw new TypeError(`server ${spec.id} has an unknown transport`);
}

function unavailableError(entry: PoolEntry, message: string, detail?: unknown): McpToolError {
  const error = new McpToolError(`MCP server ${entry.spec.id} unavailable: ${message}`, {
    code: 'MCP_SERVER_UNAVAILABLE',
    server: entry.spec.id,
    retryable: true,
    detail,
  });
  return error;
}

function callTimeoutError(entry: PoolEntry, tool: string): McpToolError {
  return new McpToolError(`call ${entry.spec.id}.${tool} timed out`, {
    code: 'MCP_CALL_TIMEOUT',
    server: entry.spec.id,
    tool,
    retryable: true,
  });
}

/** Tool-level "gone" errors that mean the prepare cache is out of date. */
function isUnknownToolError(error: unknown): boolean {
  if (errorCode(error) === 'MCP_TOOL_NOT_FOUND') return true;
  if (error === null || typeof error !== 'object') return false;
  const detail = (error as { detail?: unknown }).detail;
  return (
    typeof detail === 'object' &&
    detail !== null &&
    (detail as { code?: unknown }).code === 'TOOL_NOT_FOUND'
  );
}

function isRetryable(error: unknown): boolean {
  if (error !== null && typeof error === 'object') {
    const retryable = (error as { retryable?: unknown }).retryable;
    if (typeof retryable === 'boolean') return retryable;
    if (isTransportFailure(error)) return true;
  }
  return false;
}

function describeCause(error: unknown): unknown {
  if (error === null || typeof error !== 'object') return error === undefined ? undefined : String(error);
  const record = error as { code?: unknown; message?: unknown };
  const detail: Record<string, unknown> = {};
  if (typeof record.code === 'string') detail['code'] = record.code;
  if (typeof record.message === 'string') detail['message'] = record.message;
  return Object.keys(detail).length === 0 ? String(error) : detail;
}

/**
 * A failed warm-up never becomes a business error: the call is not sent, and
 * the script sees an explicit preparation failure (design 07 §4.5).
 */
function prepareError(
  entry: PoolEntry,
  prepare: PoolCallPrepare,
  reason: string,
  cause: unknown,
  retryable: boolean,
): McpToolError {
  return new McpToolError(
    `preparing ${entry.spec.id}.${prepare.cacheKey} failed: ${reason}`,
    {
      code: 'MCP_DISCOVERY_PREPARE_FAILED',
      server: entry.spec.id,
      tool: prepare.cacheKey,
      retryable,
      detail: {
        searchTool: prepare.tool,
        reason,
        ...(cause === undefined ? {} : { cause: describeCause(cause) }),
      },
    },
  );
}

/** Keep the more specific error when the connect path already built one. */
function toUnavailableError(entry: PoolEntry, error: unknown): McpToolError {
  if (error instanceof McpToolError && error.code === 'MCP_SERVER_UNAVAILABLE') return error;
  return unavailableError(entry, errorMessage(error), error);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return error === undefined ? 'unknown error' : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function closeQuietly(target: { close: () => Promise<void> | void } | null): Promise<void> {
  if (target === null) return;
  try {
    await target.close();
  } catch {
    // Closing is best effort; the process/ledger cleanup path still runs.
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as unknown as { unref?: () => void };
  candidate.unref?.();
}

/**
 * Races a task against a timer. On timeout the abort callback runs first, so
 * adapters holding a socket/child can tear their request down, then the
 * caller-supplied error is thrown.
 */
function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  error: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        // The timeout must still reject even if the abort hook throws.
      }
      reject(error());
    }, timeoutMs);
    unrefTimer(timer);
    task.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}
