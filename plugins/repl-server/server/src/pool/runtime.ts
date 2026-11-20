import type { LogFn } from '../log.ts';
/**
 * Third-party MCP pool runtime.
 *
 * Wires the process-wide {@link ConnectionPool} to the server configuration and
 * secret stores, and exposes the two entry points the rest of the server uses:
 *
 * - `control` is the runtime half of the admin `/servers/:id/*` routes
 *   ({@link ServerPoolControl});
 * - `callTool` routes a script's `<server>.<tool>` call through the
 *   {@link PoolGates} (per-server read/write lock, per-binding quota and the
 *   global exclusive admission gate) before it reaches the pooled connection.
 *
 * Connections stay lazy and are registered from the store on demand, so a
 * configuration edit is observed on the next state read or call without an
 * explicit invalidation. Secret values are only handed to the transport
 * factory; errors and logs carry secret names, never values.
 *
 * @module
 */

import { McpToolError } from '@zhangliang0115/repl-server-core/src/errors.ts';
import {
  normalizeMcpResult,
  type ServeToolResult,
} from '@zhangliang0115/repl-server-core/src/bridge/normalize-result.ts';
import type { ToolCallRequest } from '@zhangliang0115/repl-server-core/src/types.ts';

import type { ServerPoolControl, ServerRuntimeState } from '../admin/servers.ts';
import type { ToolDiscoveryConfig } from '../discovery/types.ts';
import type { AuditSink, Clock, ProcessLedger } from '../ports.ts';
import { systemClock } from '../ports.ts';
import { resolveServerSecrets } from '../secrets/resolve.ts';
import type { SecretField, SecretFieldValue } from '../secrets/resolve.ts';
import type { SecretStore } from '../secrets/store.ts';
import { PoolGates } from './gates.ts';
import type { ConcurrencyPolicy } from './gates.ts';
import { HealthMonitor } from './health.ts';
import type { HealthTimerApi } from './health.ts';
import {
  ConnectionPool,
  type PoolCallPrepare,
  type PoolClientFactory,
  type PoolEntrySnapshot,
  type PoolServerSpec,
  type PoolToolInfo,
  type PoolTransportFactory,
} from './pool.ts';

/**
 * Frozen by docs/protocol.md §8: an upstream `CreateTaskResult` is reported to
 * the model as this tool-layer code. Do not alias it to a shorter name without
 * changing the protocol table.
 */
export const UPSTREAM_TASK_UNSUPPORTED = 'UPSTREAM_TASK_UNSUPPORTED';

/** The slice of an admin `ServerRecord` this module needs. */
export interface PoolRuntimeServerRecord {
  id: string;
  transport: 'stdio' | 'http' | 'builtin';
  command: string | null;
  args: readonly unknown[];
  env: Record<string, unknown>;
  cwd: string | null;
  url: string | null;
  headers: Record<string, unknown>;
  enabled: boolean;
  /** Per-server config version; copied to `PoolServerSpec.cfgVersion`. */
  revision: number;
  connectMode?: 'lazy' | 'eager';
  /** Lazy-tool discovery config; `null`/absent means a static catalog. */
  toolDiscovery?: ToolDiscoveryConfig | null;
}

/** Configuration source implemented by the admin `ServerStore`. */
export interface PoolRuntimeServerSource {
  get(id: string): Promise<PoolRuntimeServerRecord | null>;
  /** Optional; used by {@link PoolRuntime.preload}. */
  list?(): Promise<readonly PoolRuntimeServerRecord[]>;
}

/** Secret source implemented by `SecretStore`; the runtime only reads. */
export type PoolRuntimeSecretSource = Pick<SecretStore, 'get'>;

/** Effective per-tool settings resolved from the tool registry. */
export interface PoolToolPolicy {
  concurrency?: ConcurrencyPolicy;
  enabled?: boolean;
  /** Catalog origin; only `search` rows are warmed before a call. */
  discoveredVia?: 'static' | 'search';
  /** Rows marked stale by a scan are not callable, even with `staleOverride`. */
  stale?: boolean;
  staleOverride?: boolean;
}

/** Tool policy source implemented by the admin `ToolStore`. */
export interface PoolToolPolicySource {
  get(
    serverId: string,
    toolName: string,
  ): Promise<PoolToolPolicy | null | undefined> | PoolToolPolicy | null | undefined;
}

/** One call-time warm-up descriptor produced by the discovery layer. */
export interface PoolRuntimePrepareInfo {
  prepare: PoolCallPrepare;
  searchTool: string;
  query: string;
  args: unknown;
}

/**
 * Injected by assembly and backed by the discovery service. Returning `null`
 * means "no warm-up needed" (static tool, prepareOnCall=false, stale row, …).
 */
export type PoolPrepareProvider = (
  serverId: string,
  toolName: string,
) => PoolRuntimePrepareInfo | null | Promise<PoolRuntimePrepareInfo | null>;

export interface PoolDiscoverOptions {
  tool: string;
  args: unknown;
  signal?: AbortSignal;
  /** Caller-side budget, kept for logging; the pool applies its own call timeout. */
  timeoutMs?: number;
}

/** Optional background ping loop settings; omitted means enabled at 15s. */
export interface PoolRuntimeHealthOptions {
  enabled?: boolean;
  intervalMs?: number;
  jitterRatio?: number;
  random?: () => number;
  timers?: HealthTimerApi;
}

export interface PoolRuntimeOptions {
  /** Server configuration (admin `ServerStore` is structurally compatible). */
  servers: PoolRuntimeServerSource;
  /** Secret store used to resolve `$secret` references. */
  secrets: PoolRuntimeSecretSource;
  /** Injected stdio/HTTP transport adapter. */
  transportFactory: PoolTransportFactory;
  /** Injected MCP client adapter; one instance per connection attempt. */
  clientFactory: PoolClientFactory;
  /** Share one gate facade across every pooled server; defaults to a new one. */
  gates?: PoolGates;
  /** Tool concurrency/enabled lookup; defaults to `parallel` and enabled. */
  policies?: PoolToolPolicySource;
  /** Called once per server after a connect lists a new tool set. */
  onTools?: (serverId: string, tools: readonly PoolToolInfo[]) => Promise<void> | void;
  /** Receives stderr chunks from pooled stdio children. */
  onStderr?: (serverId: string, chunk: string) => void;
  ledger?: ProcessLedger;
  audit?: AuditSink;
  log?: LogFn;
  clock?: Clock;
  random?: () => number;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  pingTimeoutMs?: number;
  backoffMs?: readonly number[];
  circuitThreshold?: number;
  circuitCooldownMs?: number;
  autoReconnect?: boolean;
  envWhitelist?: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
  stderrChunkChars?: number;
  /** Background health loop; `false` turns it off entirely. */
  health?: false | PoolRuntimeHealthOptions;
  /** How long `retire` waits for in-flight calls before reporting busy. Defaults to 0. */
  retireDrainTimeoutMs?: number;
  /** Max wait for the global exclusive gate; defaults to 30s. */
  exclusiveTimeoutMs?: number;
  /**
   * Builds a warm-up request for a discovered tool. Assembly wires this to the
   * discovery service; without it no call ever prepares.
   */
  prepareProvider?: PoolPrepareProvider;
}

export interface PoolRuntimeSnapshot {
  total: number;
  ready: number;
  reconnecting: number;
  failed: number;
  idle: number;
  starting: number;
  degraded: number;
  disabled: number;
  entries: readonly PoolEntrySnapshot[];
  /** Admitted calls currently executing across every server. */
  inFlight: number;
  admissionClosed: boolean;
  retiring: readonly string[];
}

export interface PoolToolCallOptions {
  /** Binding id for the per-binding quota; `null` groups unbound clients. */
  bindingId?: string | null;
  signal?: AbortSignal;
  /**
   * Absolute epoch-ms budget for this call (the gateway's L1 deadline). The
   * runtime aborts the call, including one still queueing for a gate.
   */
  deadline?: number;
}

export interface PoolRuntime {
  control: ServerPoolControl;
  callTool(call: ToolCallRequest, options?: PoolToolCallOptions): Promise<unknown>;
  /**
   * Runs the upstream search tool on the shared pooled connection under the
   * server's serial gate. Used by discovery previews; returns the raw result
   * and never publishes tools or bumps the catalog.
   */
  discoverTools(serverId: string, options: PoolDiscoverOptions): Promise<unknown>;
  /** Drops the connection-level warm-up cache (after a scan changed the tool set). */
  invalidatePrepared(serverId: string): void;
  snapshot(): PoolRuntimeSnapshot;
  dispose(): Promise<void>;
  /** Registers every configured server and connects the eager ones. */
  preload(): Promise<void>;
  /** Exposed for the health monitor and admin counters. */
  readonly pool: ConnectionPool;
  readonly gates: PoolGates;
  readonly health: HealthMonitor | null;
}

interface CachedSpec {
  cfgVersion: number;
  enabled: boolean;
  spec: PoolServerSpec;
}

interface ResolvedToolPolicy {
  concurrency: ConcurrencyPolicy;
  discoveredVia?: 'static' | 'search';
  stale: boolean;
  staleOverride: boolean;
}

interface ToolRoute {
  server: string;
  tool: string;
}

interface UpstreamTaskInfo {
  resultType?: string;
  taskId?: string;
  status?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `<server>.<tool>` routing. `call.server` is authoritative; without it the
 * first dot splits the name, because MCP has no field that marks the boundary.
 */
function resolveToolRoute(call: ToolCallRequest): ToolRoute {
  let name = call.tool.startsWith('tools.') ? call.tool.slice('tools.'.length) : call.tool;

  if (call.server !== undefined && call.server !== '') {
    const server = call.server;
    // Accept both the raw tool name and the protocol-layer qualified name.
    if (name.startsWith(`mcp.${server}.`)) {
      name = name.slice(`mcp.${server}.`.length);
    } else if (name.startsWith(`${server}.`)) {
      name = name.slice(server.length + 1);
    }
    return { server, tool: name };
  }

  if (name.startsWith('mcp.')) name = name.slice('mcp.'.length);
  const dot = name.indexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    throw new McpToolError(
      `third-party tool name must be <server>.<tool>, got ${JSON.stringify(call.tool)}`,
      { code: 'MCP_TOOL_NOT_FOUND', tool: call.tool },
    );
  }
  return { server: name.slice(0, dot), tool: name.slice(dot + 1) };
}

/** True for an upstream task result: `resultType: "task"` or a non-empty `taskId`. */
function upstreamTaskOf(result: unknown): UpstreamTaskInfo | undefined {
  const record = recordOf(result);
  if (record === undefined) return undefined;

  const resultType = typeof record['resultType'] === 'string' ? record['resultType'] : undefined;
  const taskId =
    typeof record['taskId'] === 'string' && record['taskId'] !== '' ? record['taskId'] : undefined;
  if (resultType !== 'task' && taskId === undefined) return undefined;

  const info: UpstreamTaskInfo = {};
  if (resultType !== undefined) info.resultType = resultType;
  if (taskId !== undefined) info.taskId = taskId;
  if (typeof record['status'] === 'string') info.status = record['status'];
  return info;
}

function upstreamTaskError(
  serverId: string,
  toolName: string,
  task: UpstreamTaskInfo,
): McpToolError {
  const idText = task.taskId === undefined ? '' : ` (${task.taskId})`;
  return new McpToolError(
    `MCP server ${serverId} returned an upstream task${idText}; ` +
      'repl-server does not forward upstream tasks',
    {
      code: UPSTREAM_TASK_UNSUPPORTED,
      server: serverId,
      tool: toolName,
      detail: task,
    },
  );
}

function disabledError(serverId: string): McpToolError {
  return new McpToolError(`MCP server ${serverId} is disabled`, {
    code: 'MCP_SERVER_DISABLED',
    server: serverId,
  });
}

function callCancelledError(serverId: string, toolName: string): McpToolError {
  return new McpToolError(`call ${serverId}.${toolName} was cancelled`, {
    code: 'MCP_CALL_CANCELLED',
    server: serverId,
    tool: toolName,
  });
}

function callTimeoutError(serverId: string, toolName: string, budgetMs: number): McpToolError {
  return new McpToolError(`call ${serverId}.${toolName} exceeded its ${budgetMs}ms budget`, {
    code: 'MCP_CALL_TIMEOUT',
    server: serverId,
    tool: toolName,
    retryable: true,
  });
}

/**
 * Rejects as soon as the call-level signal fires, even while the inner promise
 * is still queueing for a gate. The queued continuation checks the same signal
 * and exits without reaching the upstream, so the cancellation leaves no
 * pending work behind.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  serverId: string,
  toolName: string,
): Promise<T> {
  const reason = (): unknown => signal.reason ?? callCancelledError(serverId, toolName);
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(reason());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      void promise.catch(() => undefined);
      reject(reason());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function retiringError(serverId: string): McpToolError {
  return new McpToolError(`MCP server ${serverId} is being retired`, {
    code: 'MCP_SERVER_UNAVAILABLE',
    server: serverId,
  });
}

/**
 * A discovered tool that the latest scan did not return. `staleOverride` only
 * preserves search visibility; callability is revoked for every stale row.
 */
function staleToolError(serverId: string, tool: string): McpToolError {
  return new McpToolError(
    `MCP tool ${serverId}.${tool} is stale: the latest discovery scan did not return it`,
    {
      code: 'MCP_DISCOVERY_TOOL_STALE',
      server: serverId,
      tool,
      retryable: false,
    },
  );
}

class PoolRuntimeImpl implements PoolRuntime {
  readonly pool: ConnectionPool;
  readonly gates: PoolGates;
  readonly health: HealthMonitor | null;
  readonly control: ServerPoolControl;

  private readonly options: PoolRuntimeOptions;
  private readonly clock: Clock;
  private readonly specCache = new Map<string, CachedSpec>();
  private readonly registrations = new Map<string, Promise<PoolRuntimeServerRecord>>();
  private readonly active = new Map<string, number>();
  private readonly idleWaiters = new Map<string, Set<(drained: boolean) => void>>();
  private readonly retiring = new Set<string>();
  private readonly publishedTools = new Map<string, string>();
  private disposed = false;

  constructor(options: PoolRuntimeOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.pool = new ConnectionPool({
      transportFactory: options.transportFactory,
      clientFactory: options.clientFactory,
      ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
      ...(options.audit !== undefined ? { audit: options.audit } : {}),
      ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
      clock: this.clock,
      ...(options.random !== undefined ? { random: options.random } : {}),
      ...(options.connectTimeoutMs !== undefined
        ? { connectTimeoutMs: options.connectTimeoutMs }
        : {}),
      ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
      ...(options.pingTimeoutMs !== undefined ? { pingTimeoutMs: options.pingTimeoutMs } : {}),
      ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
      ...(options.circuitThreshold !== undefined
        ? { circuitThreshold: options.circuitThreshold }
        : {}),
      ...(options.circuitCooldownMs !== undefined
        ? { circuitCooldownMs: options.circuitCooldownMs }
        : {}),
      ...(options.autoReconnect !== undefined ? { autoReconnect: options.autoReconnect } : {}),
      ...(options.envWhitelist !== undefined ? { envWhitelist: options.envWhitelist } : {}),
      ...(options.baseEnv !== undefined ? { baseEnv: options.baseEnv } : {}),
      ...(options.stderrChunkChars !== undefined
        ? { stderrChunkChars: options.stderrChunkChars }
        : {}),
    });
    this.gates =
      options.gates ??
      new PoolGates(
        options.exclusiveTimeoutMs === undefined
          ? {}
          : { exclusiveTimeoutMs: options.exclusiveTimeoutMs },
      );
    this.health = this.createHealthMonitor(options);
    this.control = this.createControl();
  }

  async callTool(call: ToolCallRequest, options: PoolToolCallOptions = {}): Promise<unknown> {
    this.assertUsable();
    const route = resolveToolRoute(call);

    // One controller per call. The caller's signal (eval cancel / gateway L1
    // abort) and this call's absolute deadline both feed it; a call still
    // queueing for a gate observes the abort and leaves without reaching the
    // upstream, so no stale pending work survives the cancellation.
    const controller = new AbortController();
    const callerSignal = options.signal;
    const forwardAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted === true) forwardAbort();
    else callerSignal?.addEventListener('abort', forwardAbort, { once: true });

    const budget =
      options.deadline === undefined ? undefined : Math.max(0, options.deadline - this.clock.now());
    const timer =
      budget === undefined
        ? undefined
        : setTimeout(
            () => controller.abort(callTimeoutError(route.server, route.tool, budget)),
            budget,
          );
    timer?.unref?.();

    try {
      return await this.callWithSignal(route, call, options, controller.signal);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async callWithSignal(
    route: ToolRoute,
    call: ToolCallRequest,
    options: PoolToolCallOptions,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.throwIfAborted(signal, route.server, route.tool);
    if (this.retiring.has(route.server)) throw retiringError(route.server);

    const record = await this.ensureRegistered(route.server);
    this.throwIfAborted(signal, route.server, route.tool);
    if (!record.enabled) throw disabledError(route.server);

    const policy = await this.resolvePolicy(route.server, route.tool);
    this.throwIfAborted(signal, route.server, route.tool);
    // A scan said the tool is gone. `staleOverride` keeps it searchable, not
    // callable (design 03 §5.1 / 07 §4.7); the script proxy can bypass search,
    // so the check belongs here as well.
    if (policy.discoveredVia === 'search' && policy.stale) {
      throw staleToolError(route.server, route.tool);
    }

    let prepare: PoolCallPrepare | undefined;
    if (this.needsPrepare(record, policy)) {
      const info = await this.options.prepareProvider?.(route.server, route.tool);
      if (info !== null && info !== undefined) prepare = info.prepare;
    }
    // Upstream lazy registration may overwrite the connection's current tool
    // set, so prepared calls must not interleave with each other.
    const effectivePolicy: ConcurrencyPolicy =
      prepare !== undefined && policy.concurrency === 'parallel' ? 'serial' : policy.concurrency;

    const bindingId = options.bindingId ?? null;

    return await raceAbort(
      this.track(route.server, () =>
        this.gates.run(route.server, bindingId, effectivePolicy, async () => {
          this.throwIfAborted(signal, route.server, route.tool);
          this.assertUsable();
          if (this.retiring.has(route.server)) throw retiringError(route.server);

          // Lazy connect with in-flight dedupe lives in the pool; calling it here
          // also gives `onTools` a chance to publish the freshly listed tools.
          await this.pool.ensureConnected(route.server);
          await this.publishTools(route.server);
          this.throwIfAborted(signal, route.server, route.tool);

          const result = await this.pool.callTool(route.server, route.tool, call.args, {
            bindingId,
            signal,
            ...(prepare === undefined ? {} : { prepare }),
          });

          // The first version does not proxy upstream tasks. Dropping the task id
          // would leave the script with an unusable result, so reject explicitly.
          const upstreamTask = upstreamTaskOf(result);
          if (upstreamTask !== undefined) {
            throw upstreamTaskError(route.server, route.tool, upstreamTask);
          }
          // Hand scripts the same `{ text, images, documents }` shape as the
          // serve path. Without this, image/PDF base64 blocks are serialized
          // into the XML text instead of the gateway's media collector.
          if (result === undefined || result === null) return result;
          return normalizeMcpResult(result as ServeToolResult);
        }),
      ),
      signal,
      route.server,
      route.tool,
    );
  }

  /** Drops a queued call once its caller or its deadline has aborted it. */
  private throwIfAborted(signal: AbortSignal, serverId: string, tool: string): void {
    if (!signal.aborted) return;
    throw signal.reason ?? callCancelledError(serverId, tool);
  }

  async discoverTools(serverId: string, options: PoolDiscoverOptions): Promise<unknown> {
    this.assertUsable();
    const record = await this.ensureRegistered(serverId);
    if (!record.enabled) throw disabledError(serverId);
    this.assertConnectable(record);

    // Serial on purpose: the search may rewrite the connection's current tool
    // set, so it must not interleave with business calls. The gate is not
    // re-entered from inside the callback (that would deadlock on the write lock).
    return await this.gates.run(serverId, null, 'serial', async () => {
      this.assertUsable();
      if (this.retiring.has(serverId)) throw retiringError(serverId);
      this.assertScanActive(serverId, options);
      await this.pool.ensureConnected(serverId);
      // A queued gate callback can start after the caller's deadline fired.
      this.assertScanActive(serverId, options);
      return await this.pool.callToolDirect(serverId, options.tool, options.args, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    });
  }

  invalidatePrepared(serverId: string): void {
    this.pool.invalidatePrepared(serverId);
  }

  private assertScanActive(serverId: string, options: PoolDiscoverOptions): void {
    if (options.signal?.aborted === true) {
      throw new McpToolError(`discovery scan on ${serverId} was cancelled`, {
        code: 'MCP_CALL_CANCELLED',
        server: serverId,
        tool: options.tool,
      });
    }
  }

  /** Lazy tools are warmed only when the server config and catalog row agree. */
  private needsPrepare(
    record: PoolRuntimeServerRecord,
    policy: ResolvedToolPolicy,
  ): boolean {
    if (this.options.prepareProvider === undefined) return false;
    if (policy.discoveredVia !== 'search' || policy.stale) return false;
    const config = record.toolDiscovery;
    return (
      config !== null &&
      config !== undefined &&
      config.mode === 'search' &&
      config.prepareOnCall !== false
    );
  }

  snapshot(): PoolRuntimeSnapshot {
    const entries = this.pool.entries();
    let ready = 0;
    let reconnecting = 0;
    let failed = 0;
    let idle = 0;
    let starting = 0;
    let degraded = 0;
    let disabled = 0;

    for (const entry of entries) {
      switch (entry.state) {
        case 'ready':
          ready += 1;
          break;
        case 'reconnecting':
          reconnecting += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'idle':
          idle += 1;
          break;
        case 'starting':
          starting += 1;
          break;
        case 'degraded':
          degraded += 1;
          break;
        case 'disabled':
          disabled += 1;
          break;
      }
    }

    return {
      total: entries.length,
      ready,
      reconnecting,
      failed,
      idle,
      starting,
      degraded,
      disabled,
      entries,
      inFlight: this.gates.inFlight,
      admissionClosed: this.gates.admissionClosed,
      retiring: [...this.retiring].sort(),
    };
  }

  async preload(): Promise<void> {
    this.assertUsable();
    const source = this.options.servers;
    const list = source.list;
    if (list === undefined) return;

    const records = await list.call(source);
    for (const record of records) {
      if (record.transport === 'builtin') continue;
      try {
        await this.ensureRegistered(record.id);
        if (record.enabled && record.connectMode === 'eager') {
          await this.pool.ensureConnected(record.id);
          await this.publishTools(record.id);
        }
      } catch (error) {
        // A single broken server must not stop the rest from loading.
        this.options.log?.(`pool preload skipped: ${messageOf(error)}`, { level: 'warn', scope: 'pool', server: record.id });
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.health?.stop();
    await this.pool.close();
    this.specCache.clear();
    this.publishedTools.clear();
    this.retiring.clear();
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new McpToolError('the third-party pool runtime has been disposed', {
        code: 'MCP_SERVER_UNAVAILABLE',
      });
    }
  }

  private createHealthMonitor(options: PoolRuntimeOptions): HealthMonitor | null {
    if (options.health === false || options.health?.enabled === false) return null;
    const settings: PoolRuntimeHealthOptions = options.health ?? {};
    const monitor = new HealthMonitor({
      pool: this.pool,
      ...(settings.intervalMs !== undefined ? { intervalMs: settings.intervalMs } : {}),
      ...(settings.jitterRatio !== undefined ? { jitterRatio: settings.jitterRatio } : {}),
      ...(settings.random !== undefined ? { random: settings.random } : {}),
      ...(settings.timers !== undefined ? { timers: settings.timers } : {}),
      ...(options.log !== undefined
        ? {
            onFailure: (serverId: string, error: unknown) => {
              options.log?.(`pool health check failed: ${messageOf(error)}`, { level: 'warn', scope: 'pool', server: serverId });
            },
          }
        : {}),
    });
    monitor.start();
    return monitor;
  }

  private createControl(): ServerPoolControl {
    return {
      state: async (id) => this.state(id),
      connect: async (id) => {
        // Re-resolve secrets: the store can change without a server revision bump.
        this.specCache.delete(id);
        await this.ensureRegistered(id);
        await this.pool.ensureConnected(id);
        await this.publishTools(id);
      },
      disconnect: async (id) => {
        const record = await this.readRecord(id);
        this.assertConnectable(record);
        // Disconnect must work even when the config no longer resolves (for
        // example a missing secret); there is simply nothing to close then.
        if (this.pool.entry(id) !== null) await this.pool.disconnect(id);
        this.publishedTools.delete(id);
      },
      restart: async (id) => {
        this.specCache.delete(id);
        // A restart must republish even when the tool names did not change:
        // descriptions/schemas may have moved, and AI previews must see the
        // fresh rows.
        this.publishedTools.delete(id);
        await this.ensureRegistered(id);
        await this.pool.disconnect(id);
        await this.pool.ensureConnected(id);
        await this.publishTools(id);
      },
      refreshTools: async (id) => {
        this.specCache.delete(id);
        this.publishedTools.delete(id);
        await this.ensureRegistered(id);
        // `PoolClient.listTools` is only reachable through a connection, so a
        // refresh is a controlled reconnect that re-runs initialize + tools/list.
        await this.pool.disconnect(id);
        await this.pool.ensureConnected(id);
        await this.publishTools(id);
      },
      test: async (id, testOptions) => this.test(id, testOptions.timeoutMs),
      retire: async (id, retireOptions) => this.retire(id, retireOptions.force),
    };
  }

  private async state(id: string): Promise<ServerRuntimeState | null> {
    const record = await this.options.servers.get(id);
    if (record === null) {
      this.specCache.delete(id);
      await this.pool.unregister(id).catch(() => undefined);
      return null;
    }
    if (record.transport === 'builtin') return null;

    const fallback = record.enabled ? 'idle' : 'disabled';
    try {
      await this.ensureRegistered(id);
    } catch (error) {
      // A misconfigured server must still render in the admin list.
      return { state: fallback, lastError: messageOf(error) };
    }

    const entry = this.pool.entry(id);
    if (entry === null) return { state: fallback };
    const view: ServerRuntimeState = { state: entry.state };
    if (entry.lastError !== null) {
      view.lastError = `${entry.lastError.code}: ${entry.lastError.message}`;
    }
    if (entry.pid !== null) view.pid = entry.pid;
    return view;
  }

  private async test(id: string, timeoutMs: number): Promise<{ tools: unknown[] }> {
    this.assertUsable();
    const record = await this.readRecord(id);
    this.assertConnectable(record);
    this.specCache.delete(id);
    const spec = await this.specFor(record);

    // A throwaway pool shares the production transport/env/teardown logic but
    // has no ledger and no presence in this runtime, so nothing is persisted.
    const temporary = new ConnectionPool({
      transportFactory: this.options.transportFactory,
      clientFactory: this.options.clientFactory,
      autoReconnect: false,
      connectTimeoutMs: timeoutMs,
      callTimeoutMs: timeoutMs,
      pingTimeoutMs: timeoutMs,
      servers: [spec],
    });

    // The pool bounds each phase; this bounds the whole temporary connection so
    // a wedged initialize cannot outlive the admin request budget.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new McpToolError(`test for server ${id} timed out after ${timeoutMs}ms`, {
            code: 'MCP_CALL_TIMEOUT',
            server: id,
          }),
        );
      }, timeoutMs);
      const candidate = timer as unknown as { unref?: () => void };
      candidate.unref?.();
    });

    try {
      await Promise.race([temporary.ensureConnected(id), deadline]);
      const entry = temporary.entry(id);
      return { tools: entry === null ? [] : [...entry.tools] };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await temporary.close();
    }
  }

  private async retire(
    id: string,
    force: boolean,
  ): Promise<{ drained: boolean; inFlight?: number }> {
    const record = await this.readRecord(id);
    this.assertConnectable(record);

    this.retiring.add(id);
    try {
      if (!force) {
        const active = this.activeCount(id);
        if (active > 0) {
          const drained = await this.waitForIdle(id, this.options.retireDrainTimeoutMs ?? 0);
          if (!drained) return { drained: false, inFlight: this.activeCount(id) };
        }
      }
      // Unregister detaches the entry, aborts in-flight calls and removes the
      // process-ledger record; force only changes what happens before this.
      await this.pool.unregister(id);
      this.publishedTools.delete(id);
      this.specCache.delete(id);
      return { drained: true, inFlight: 0 };
    } finally {
      this.retiring.delete(id);
    }
  }

  private async readRecord(id: string): Promise<PoolRuntimeServerRecord> {
    const record = await this.options.servers.get(id);
    if (record === null) {
      throw new McpToolError(`MCP server ${id} is not configured`, {
        code: 'MCP_SERVER_NOT_FOUND',
        server: id,
      });
    }
    return record;
  }

  private assertConnectable(record: PoolRuntimeServerRecord): void {
    if (record.transport === 'builtin') {
      throw new McpToolError(`MCP server ${record.id} is built in and has no connection`, {
        code: 'MCP_SERVER_UNAVAILABLE',
        server: record.id,
      });
    }
  }

  /** Registers (or refreshes) one server from the store; concurrent callers share the work. */
  private async ensureRegistered(serverId: string): Promise<PoolRuntimeServerRecord> {
    this.assertUsable();
    const previous = this.registrations.get(serverId);
    const run = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => this.reconcile(serverId));
    this.registrations.set(serverId, run);
    try {
      return await run;
    } finally {
      if (this.registrations.get(serverId) === run) this.registrations.delete(serverId);
    }
  }

  private async reconcile(serverId: string): Promise<PoolRuntimeServerRecord> {
    const record = await this.options.servers.get(serverId);
    if (record === null) {
      this.specCache.delete(serverId);
      await this.pool.unregister(serverId);
      throw new McpToolError(`MCP server ${serverId} is not configured`, {
        code: 'MCP_SERVER_NOT_FOUND',
        server: serverId,
      });
    }
    this.assertConnectable(record);

    const spec = await this.specFor(record);
    // Same cfgVersion only refreshes the stored spec; a new one detaches the
    // old connection inside the pool before the fresh entry is added.
    await this.pool.register(spec);
    return record;
  }

  private async specFor(record: PoolRuntimeServerRecord): Promise<PoolServerSpec> {
    const cfgVersion =
      Number.isInteger(record.revision) && record.revision >= 1 ? record.revision : 1;
    const cached = this.specCache.get(record.id);
    if (
      cached !== undefined &&
      cached.cfgVersion === cfgVersion &&
      cached.enabled === record.enabled
    ) {
      return cached.spec;
    }

    const spec = await this.resolveSpec(record, cfgVersion);
    this.specCache.set(record.id, { cfgVersion, enabled: record.enabled, spec });
    return spec;
  }

  private async resolveSpec(
    record: PoolRuntimeServerRecord,
    cfgVersion: number,
  ): Promise<PoolServerSpec> {
    let resolved: Awaited<ReturnType<typeof resolveServerSecrets>>;
    try {
      resolved = await resolveServerSecrets(this.options.secrets as SecretStore, {
        id: record.id,
        url: record.url,
        env: record.env as SecretField,
        headers: record.headers as SecretField,
        args: record.args as readonly SecretFieldValue[],
      });
    } catch (error) {
      // `ServerUrlError` messages deliberately omit the URL, so this is safe.
      throw new McpToolError(
        `MCP server ${record.id} has invalid connection settings: ${messageOf(error)}`,
        {
          code: 'MCP_SERVER_UNAVAILABLE',
          server: record.id,
          detail: { code: errorCodeOf(error) },
        },
      );
    }

    if (resolved.missingSecrets.length > 0) {
      throw new McpToolError(
        `MCP server ${record.id} is missing secrets: ${resolved.missingSecrets.join(', ')}`,
        {
          code: 'MCP_SERVER_UNAVAILABLE',
          server: record.id,
          detail: { missingSecrets: resolved.missingSecrets },
        },
      );
    }

    const spec: PoolServerSpec = {
      id: record.id,
      cfgVersion,
      transport: record.transport === 'stdio' ? 'stdio' : 'http',
      enabled: record.enabled,
      args: resolved.args,
    };

    if (record.transport === 'stdio') {
      if (record.command === null || record.command.trim() === '') {
        throw new McpToolError(`stdio server ${record.id} has no command`, {
          code: 'MCP_SERVER_UNAVAILABLE',
          server: record.id,
        });
      }
      spec.command = record.command;
      if (record.cwd !== null) spec.cwd = record.cwd;
    } else {
      if (resolved.url === undefined) {
        throw new McpToolError(`http server ${record.id} has no url`, {
          code: 'MCP_SERVER_UNAVAILABLE',
          server: record.id,
        });
      }
      spec.url = resolved.url;
    }

    if (Object.keys(resolved.env).length > 0) spec.env = resolved.env;
    if (Object.keys(resolved.headers).length > 0) spec.headers = resolved.headers;
    return spec;
  }

  private async resolvePolicy(
    serverId: string,
    toolName: string,
  ): Promise<ResolvedToolPolicy> {
    const source = this.options.policies;
    const policy = source === undefined ? null : await source.get(serverId, toolName);
    if (policy !== null && policy !== undefined && policy.enabled === false) {
      throw new McpToolError(`MCP tool ${serverId}.${toolName} is disabled`, {
        code: 'MCP_TOOL_DISABLED',
        server: serverId,
        tool: toolName,
      });
    }

    const concurrency: unknown = policy?.concurrency ?? 'parallel';
    if (concurrency !== 'parallel' && concurrency !== 'serial' && concurrency !== 'exclusive') {
      throw new McpToolError(
        `unknown concurrency policy for ${serverId}.${toolName}: ${String(concurrency)}`,
        { code: 'MCP_TOOL_ERROR', server: serverId, tool: toolName },
      );
    }
    const discoveredVia =
      policy?.discoveredVia === 'static' || policy?.discoveredVia === 'search'
        ? policy.discoveredVia
        : undefined;
    return {
      concurrency,
      ...(discoveredVia === undefined ? {} : { discoveredVia }),
      stale: policy?.stale === true,
      staleOverride: policy?.staleOverride === true,
    };
  }

  private async publishTools(serverId: string): Promise<void> {
    const onTools = this.options.onTools;
    if (onTools === undefined) return;

    const entry = this.pool.entry(serverId);
    if (entry === null) return;
    if (entry.state !== 'ready' && entry.state !== 'degraded') return;

    const signature = `${entry.cfgVersion}:${entry.tools.map((tool) => tool.name).join('\u0000')}`;
    if (this.publishedTools.get(serverId) === signature) return;
    await onTools(serverId, entry.tools);
    this.publishedTools.set(serverId, signature);
  }

  private async track<T>(serverId: string, run: () => Promise<T>): Promise<T> {
    this.markActive(serverId);
    try {
      return await run();
    } finally {
      this.markIdle(serverId);
    }
  }

  private activeCount(serverId: string): number {
    return this.active.get(serverId) ?? 0;
  }

  private markActive(serverId: string): void {
    this.active.set(serverId, this.activeCount(serverId) + 1);
  }

  private markIdle(serverId: string): void {
    const next = this.activeCount(serverId) - 1;
    if (next > 0) {
      this.active.set(serverId, next);
      return;
    }
    this.active.delete(serverId);
    const waiters = this.idleWaiters.get(serverId);
    if (waiters === undefined) return;
    this.idleWaiters.delete(serverId);
    for (const waiter of [...waiters]) waiter(true);
  }

  private waitForIdle(serverId: string, timeoutMs: number): Promise<boolean> {
    if (this.activeCount(serverId) === 0) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (drained: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.idleWaiters.get(serverId)?.delete(finish);
        resolve(drained);
      };

      timer = setTimeout(() => finish(false), timeoutMs);
      const candidate = timer as unknown as { unref?: () => void };
      candidate.unref?.();

      let waiters = this.idleWaiters.get(serverId);
      if (waiters === undefined) {
        waiters = new Set();
        this.idleWaiters.set(serverId, waiters);
      }
      waiters.add(finish);
    });
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Creates the process-wide third-party MCP runtime. */
export function createPoolRuntime(options: PoolRuntimeOptions): PoolRuntime {
  return new PoolRuntimeImpl(options);
}
