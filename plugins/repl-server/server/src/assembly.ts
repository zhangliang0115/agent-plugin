import type { Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditWriter, ProcessLedger, newId, type PoolEntry, type ToolCallRequest } from '@zhangliang0115/repl-server-core';

import { createLog, type LogFn } from './log.ts';
import { createAdminOverviewHandler, type BindingActivity } from './admin/overview.ts';
import { createResourceMonitor } from './admin/resources.ts';
import { createAdminClientsHandler, type McpSessionRecord, type SessionRegistry } from './admin/clients.ts';
import { createAdminDiscoverHandler } from './admin/discover.ts';
import { createAdminServersHandler, createOperationLauncher, type AdminOperation, type OperationLauncher } from './admin/servers.ts';
import { createAdminSettingsHandler, type SettingsStore } from './admin/settings.ts';
import { createAdminTagsHandler } from './admin/tags.ts';
import { createAdminCategoriesHandler } from './admin/categories.ts';
import { createAdminToolsHandler } from './admin/tools.ts';
import { createAdminConfigRoutes, operationStarterFromLauncher } from './admin/config-routes.ts';
import { createAdminReportsHandler } from './admin/reports.ts';
import { createAdminAlertsHandler } from './admin/alerts.ts';
import { createAdminAiHandler } from './admin/ai.ts';
import { createAdminScriptsHandler } from './admin/scripts.ts';
import { createAdminScriptCandidatesHandler } from './admin/script-candidates.ts';
import { parseCreateServer } from './admin/servers.ts';
import { createEventHub } from './admin/events.ts';
import { createAdminSession } from './admin/session.ts';
import { createAuditRuntime } from './audit/runtime.ts';
import {
  LOG_MAX_TOTAL_BYTES,
  LOG_RETENTION_DAYS,
  createRetention,
  type Retention,
} from './audit/retention.ts';
import { createSessionPruner } from './serve/session-prune.ts';
import { METRICS_PREFIX, createLayout } from './layout.ts';
import { createAlertConfigStore } from './alerts/config-store.ts';
import { createAlertDispatcher } from './alerts/dispatcher.ts';
import { createAiService, createAiRunner } from './ai/index.ts';
import { type HostAllowlist } from './auth/tokens.ts';
import { splitClientLabel } from './client-info.ts';
import { createDbReportStore } from './reports/store.ts';
import { createReportService } from './reports/service.ts';
import {
  REPORT_RETENTION_DAYS,
  REPORT_RETENTION_INTERVAL_MS,
  REPORT_RETENTION_MAX_ROWS,
} from './reports/constants.ts';
import { createDiscoveryService } from './discovery/service.ts';
import { createAdminDiscoveryHandler } from './discovery/handler.ts';
import { createFileSecretStore } from './secrets/store.ts';
import { handleAdminHttp } from './admin/http-adapter.ts';
import { createSearchPreview, createCatalogService, type CatalogService } from './catalog/index.ts';
import { createApp, type AppOptions, type McpContext } from './app.ts';
import { resolveIdentityConfig } from './assembly-identity.ts';
import {
  DbClientBindingStore,
  DbServerStore,
  DbSettingsStore,
  DbToolStore,
} from './assembly-stores.ts';
import { openStateDb, migrate } from './db/migrate.ts';
import { findBindingByToken, getClientBinding } from './db/clients.ts';
import { OFFICIAL_SERVER_ID, listServers } from './db/servers.ts';
import { countToolsByServer, markAbsentToolsStale, upsertTool } from './db/tools.ts';
import { seedBuiltinTools } from './tools/builtin-seed.ts';
import { ExecGateway, STUCK_EVAL_WARN_MS, stuckEvalsOf, type IdleSweepResult } from './exec/gateway.ts';
import { resolveCapacityLimitsFromSettings, type CapacityLimits } from './exec/capacity.ts';
import { PoolGates } from './pool/gates.ts';
import { createPoolRuntime } from './pool/runtime.ts';
import { mcpClientFactory, mcpTransportFactory } from './pool/adapters/client.ts';
import { createServeRuntime } from './serve/runtime.ts';
import { createOfficialToolsSync } from './serve/official-sync.ts';
import { createServeCallTool } from './serve/adapter.ts';
import { ScriptService } from './scripts/service.ts';
import { ScriptCandidatesService } from './scripts/candidates.ts';
import { createAiCandidateSuggester } from './scripts/candidate-suggester.ts';
import { loadLocalTokens, stateDbPath } from './local-tokens.ts';
import { createMethodTable } from './mcp/methods.ts';
import { INSTRUCTIONS } from './mcp/discover.ts';
import {
  buildRunScriptDescription,
  collectVisibleMcpServers,
  type McpServerOverview,
} from './mcp/overview.ts';
import { JSON_RPC_INVALID_PARAMS, JsonRpcError } from './mcp/errors.ts';
import type { AuditEvent, RequestIdentity, ToolCallObservation } from './ports.ts';
import { systemClock } from './ports.ts';
import { TransportSessionRegistry } from './sessions/transport.ts';
import { McpTaskStore, cancelMcpTask, getMcpTask, ownerOf, updateMcpTask } from './tasks/mcp-tasks.ts';
import { callTool, type ToolCallResponse } from './tools/call.ts';
import {
  buildSearchToolsDefinition,
  listTools,
  RUN_SCRIPT_DESCRIPTION,
  type ToolDefinition,
} from './tools/registry.ts';
import { isToolVisible, type ToolVisibility } from './tools/search.ts';

export interface AssemblyOptions {
  root?: string;
  port?: number;
  host?: string;
  /** Host allowlist for `/health`, `/mcp` and `/admin`; defaults to loopback-only. */
  allowedHosts?: HostAllowlist;
  /**
   * Static admin auto-login convenience. Defaults to true; only loopback peers
   * (local browser or a local reverse proxy) receive it.
   */
  adminAutoLogin?: boolean;
  strictAuth?: boolean;
  /** Boot id shared with the startup sweep; keeps serve ledgers consistent. */
  bootId?: string;
  /** Test seam: replaces the script-visible tool call. */
  callTool?: (call: ToolCallRequest) => Promise<unknown>;
  /** Test seam: transport-session idle TTL; defaults to 60 minutes. */
  transportIdleMs?: number;
  /** Test seam: background lifecycle sweep interval; defaults to 60 seconds. */
  sweepIntervalMs?: number;
  log?: LogFn;
}

export interface Assembly {
  server: Server;
  db: ReturnType<typeof openStateDb>;
  catalog: CatalogService;
  /** Live execution gateway; the admin overview and tests read its limits. */
  gateway: ExecGateway;
  /**
   * Effective capacity limits as enforced right now by the gateway, the pool
   * gates and the serve runtime. `maxExecSessions` is already capped by
   * `maxWorkers`; the raw values stay visible through `GET /settings`.
   */
  capacity(): CapacityLimits;
  /** One-time admin bootstrap token; printed once on startup. */
  adminBootstrapToken: string | null;
  /** Runs one lifecycle sweep now (transport, worker, serve, task retention). */
  sweep(): Promise<IdleSweepResult | null>;
  /** On-disk retention budget for `log/`; `runOnce()` sweeps immediately. */
  retention: Retention;
  close(): Promise<void>;
}

/** Built admin UI; `web/scripts/build.mjs` copies it here. */
const WEB_DIST = fileURLToPath(new URL('../dist/web', import.meta.url));

function readTaskId(params: Record<string, unknown>): string {
  const taskId = params['taskId'];
  if (typeof taskId !== 'string' || taskId === '') {
    throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, 'taskId must be a non-empty string');
  }
  return taskId;
}

/** How long shutdown waits for the HTTP server before logging and moving on. */
const SERVER_CLOSE_TIMEOUT_MS = 5_000;

/** Background idle-lifecycle sweep (design 03 §2.3). */
const SWEEP_INTERVAL_MS = 60_000;

/** How often the oldest in-flight eval is checked against {@link STUCK_EVAL_WARN_MS}. */
const EVAL_WATCHDOG_INTERVAL_MS = 60_000;

/** `script_runs` retention sweep: boot plus at most once a day (design 10 §5.1). */
const SCRIPT_RUN_PRUNE_INTERVAL_MS = 86_400_000;

/**
 * Stops accepting connections and waits for the listener to close. Idle
 * keep-alive sockets are dropped first; a lingering request cannot hold
 * shutdown forever, so the wait is bounded.
 */
function closeServer(
  server: Server,
  log: LogFn,
  timeoutMs = SERVER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  server.closeIdleConnections();
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log(`server.close did not finish within ${timeoutMs}ms; continuing shutdown`, {
        level: 'warn',
        scope: 'server',
        timeoutMs,
      });
      resolve();
    }, timeoutMs);
    timer.unref?.();
    server.close(() => finish());
  });
}

/** Seeds the protocol tool rows the admin page shows under `__builtin__`. */
function applyBuiltinSeed(db: ReturnType<typeof openStateDb>, log: LogFn): void {
  try {
    const seeded = seedBuiltinTools(db);
    if (seeded.inserted > 0 || seeded.filled > 0) {
      log(`__builtin__ tools seeded (inserted ${seeded.inserted}, filled ${seeded.filled})`, {
        scope: 'server',
        inserted: seeded.inserted,
        filled: seeded.filled,
      });
    }
  } catch (error) {
    // The protocol surface does not depend on these rows; keep booting.
    log(`__builtin__ tool seed failed: ${(error as Error).message}`, {
      level: 'error',
      scope: 'server',
    });
  }
}

/** Wires SQLite, catalog, gateway, MCP methods, admin routes and the HTTP app. */
export async function assemble(options: AssemblyOptions = {}): Promise<Assembly> {
  const log = options.log ?? createLog((line) => console.error(line));
  const root = options.root ?? process.env['AGENTS_HOME'];
  const clock = systemClock;

  const layout = createLayout(root);
  const dataDir = layout.run;
  const tokens = await loadLocalTokens(dataDir);
  const db = openStateDb(stateDbPath(dataDir));
  migrate(db);
  applyBuiltinSeed(db, log);

  const scripts = new ScriptService({ db, now: () => clock.now() });
  try {
    const pruned = scripts.pruneExpiredRuns();
    if (pruned > 0) {
      log(`pruned ${pruned} expired script run(s)`, { level: 'info', scope: 'scripts', pruned });
    }
  } catch (error) {
    log(`script run retention failed: ${(error as Error).message}`, {
      level: 'error',
      scope: 'scripts',
    });
  }

  const eventsHub = createEventHub();
  const auditHub = createEventHub();
  const catalog = createCatalogService({
    db,
    onCatalogChanged: (event) => {
      eventsHub.publish('catalog_changed', event);
    },
  });
  // One budget for the whole `log/` domain: the writers' own prune only fires
  // when a daily file rolls over, which a long-lived process can defer for
  // hours, and it never sees `payload/`.
  // Late-bound: the handler needs `audit`, which needs `retention.stats`.
  let onHighWater: ((info: { totalBytes: number; limitBytes: number; ratio: number }) => void) | undefined;
  const retention = createRetention({
    logDir: layout.log,
    log,
    now: () => clock.now(),
    onHighWater: (info) => {
      onHighWater?.(info);
    },
  });
  const audit = createAuditRuntime({
    dir: layout.log,
    log,
    // Full frames keep redacted request/response payloads for the request view;
    // bodies above 4 KiB move into `payload/`.
    frameMode: 'full',
    retention: () => retention.stats(),
    onEvent: (event) => {
      auditHub.publish('audit', event);
    },
  });
  onHighWater = (info) => {
    audit.recordTask({
      ts: new Date(clock.now()).toISOString(),
      event: 'payload_high_water',
      bytes: info.totalBytes,
      limitBytes: info.limitBytes,
      ratio: Number(info.ratio.toFixed(3)),
    });
  };
  // Same late-bound trick: the pruner needs to report through `audit`, but
  // `audit` is created above with a callback into the retention module.
  let onSessionsPruned: ((info: { removedDirs: number; keptDirs: number }) => void) | undefined;
  const sessionPruner = createSessionPruner({
    sessionsDir: layout.sessions,
    log,
    now: () => clock.now(),
    onPrune: (info) => {
      onSessionsPruned?.(info);
    },
  });
  onSessionsPruned = (info) => {
    if (info.removedDirs === 0) return;
    audit.recordTask({
      ts: new Date(clock.now()).toISOString(),
      event: 'session_dirs_pruned',
      removed: info.removedDirs,
      kept: info.keptDirs,
    });
  };

  // Samples are kept beyond the 30-minute in-memory series for later analysis.
  const resourceWriter = new AuditWriter({
    dir: layout.log,
    filePrefix: METRICS_PREFIX,
    redact: false,
    retentionDays: LOG_RETENTION_DAYS,
    maxTotalBytes: LOG_MAX_TOTAL_BYTES,
  });
  const resourceMonitor = createResourceMonitor({
    log,
    onSample: (sample) => {
      resourceWriter.write('resource_sample', { ...sample });
      if (!resourceWriter.healthy) {
        throw resourceWriter.error ?? new Error('resource writer is unhealthy');
      }
    },
  });
  const adminSession = createAdminSession({ adminToken: tokens.adminToken });
  const baseLauncher = createOperationLauncher();
  const operations: OperationLauncher = {
    launch(kind, target, run) {
      let ref: AdminOperation;
      const wrapped = async (): Promise<unknown> => {
        await Promise.resolve();
        try {
          const result = await run();
          eventsHub.publish('operation', {
            operationId: ref.operationId,
            kind,
            target,
            state: 'ok',
          });
          return result;
        } catch (error) {
          eventsHub.publish('operation', {
            operationId: ref.operationId,
            kind,
            target,
            state: 'error',
            error: { message: error instanceof Error ? error.message : String(error) },
          });
          throw error;
        }
      };
      ref = baseLauncher.launch(kind, target, wrapped);
      eventsHub.publish('operation', {
        operationId: ref.operationId,
        kind,
        target,
        state: ref.state,
        startedAt: ref.startedAt,
      });
      return ref;
    },
    get: (operationId) => baseLauncher.get?.(operationId) ?? null,
  };
  const serverStore = new DbServerStore(db);
  const toolStore = new DbToolStore(db);
  const bindingStore = new DbClientBindingStore(db);
  const settingsStore = new DbSettingsStore(db);
  // One merged snapshot at startup: defaults ← stored settings ← env. Every
  // component below is built from it, so a stored value is live before the
  // first request and env overrides (tests) apply to all of them.
  const bootSettings = await settingsStore.read();
  const bootCapacity = resolveCapacityLimitsFromSettings(bootSettings.settings);
  const secrets = createFileSecretStore(dataDir);
  const ledgerBootId = options.bootId ?? newId('boot');
  const processLedger = new ProcessLedger({ root: dataDir });
  const poolLedger = {
    async recordPool(entry: Record<string, unknown>): Promise<void> {
      const file = processLedger.readPool();
      const entries = file.entries.filter((item) => item.serverId !== entry['serverId']);
      entries.push({ ...(entry as unknown as PoolEntry), bootId: ledgerBootId });
      processLedger.writePool({ bootId: ledgerBootId, entries });
    },
    async removePool(serverId: string): Promise<void> {
      const file = processLedger.readPool();
      processLedger.writePool({
        bootId: ledgerBootId,
        entries: file.entries.filter((item) => item.serverId !== serverId),
      });
    },
  };
  let discoveryService: ReturnType<typeof createDiscoveryService> | null = null;
  let aiService: ReturnType<typeof createAiService> | null = null;
  const poolGates = new PoolGates({
    callsPerBinding: bootCapacity.maxInFlightCallsPerBindingPerServer,
    queuedPerBinding: bootCapacity.maxQueuedCallsPerBindingPerServer,
  });
  const poolRuntime = createPoolRuntime({
    servers: serverStore,
    secrets,
    transportFactory: mcpTransportFactory,
    clientFactory: mcpClientFactory,
    gates: poolGates,
    ledger: poolLedger,
    clock,
    audit: {
      write: (event: AuditEvent) => {
        audit.recordTask({ ...event, ts: event.ts ?? new Date().toISOString() });
      },
    },
    policies: {
      get: async (serverId, toolName) => {
        const tool = await toolStore.get(serverId, toolName);
        return tool === null
          ? null
          : {
              concurrency: tool.concurrency,
              enabled: tool.enabled,
              discoveredVia: tool.discoveredVia,
              stale: tool.stale,
              staleOverride: tool.staleOverride,
            };
      },
    },
    prepareProvider: (serverId, toolName) => discoveryService?.prepareProvider(serverId, toolName) ?? null,
    onTools: async (serverId, tools) => {
      for (const tool of tools) {
        upsertTool(db, serverId, {
          name: tool.name,
          description: tool.description ?? null,
          inputSchema: tool.inputSchema ?? {},
        });
      }
      // A successful `tools/list` is authoritative for this server: rows it no
      // longer returns are stale (design 03 §5.1). `upsertTool` already cleared
      // the flag on every tool that did come back.
      const stale = markAbsentToolsStale(
        db,
        serverId,
        tools.map((tool) => tool.name),
      );
      if (stale > 0) {
        log(`marked ${stale} tool(s) stale on ${serverId}: absent from tools/list`, {
          level: 'info',
          scope: 'pool',
          server: serverId,
          stale,
        });
      }
      catalog.refreshServer(serverId);
      void aiService?.onToolsIndexed(serverId);
    },
    onStderr: (serverId, chunk) =>
      log(`stderr ${chunk.length} bytes`, {
        level: 'warn',
        scope: 'pool',
        server: serverId,
        bytes: chunk.length,
      }),
    log,
  });
  const poolControl = poolRuntime.control;
  let lastPoolSignature = '';
  const publishPoolState = (): void => {
    const snapshot = poolRuntime.snapshot();
    const entries = snapshot.entries.map((entry) => ({
      id: entry.id,
      state: entry.state,
      pid: entry.pid,
      generation: entry.generation,
      tools: entry.tools.length,
      lastError: entry.lastError,
    }));
    const signature = JSON.stringify(entries);
    if (signature === lastPoolSignature) return;
    lastPoolSignature = signature;
    eventsHub.publish('server_state', {
      pool: {
        total: snapshot.total,
        ready: snapshot.ready,
        reconnecting: snapshot.reconnecting,
        failed: snapshot.failed,
      },
      entries,
    });
  };
  const poolStateTimer = setInterval(publishPoolState, 2_000);
  poolStateTimer.unref();

  const auditSink = {
    write: (event: AuditEvent) => {
      audit.recordTask({ ...event, ts: event.ts ?? new Date().toISOString() });
    },
  };
  const reportStore = createDbReportStore(db);
  const alertConfig = createAlertConfigStore({ db, secrets });
  const alertDispatcher = createAlertDispatcher({
    store: reportStore,
    config: alertConfig,
    audit: auditSink,
    log,
  });
  const reports = createReportService({ store: reportStore, alerts: alertDispatcher, audit: auditSink, log });

  discoveryService = createDiscoveryService({
    db,
    servers: serverStore,
    tools: toolStore,
    catalog,
    pool: poolRuntime,
    audit: auditSink,
  });

  const aiRunner = createAiRunner({
    dataDir,
    clock,
    log,
    bootId: ledgerBootId,
  });
  aiService = createAiService({
    db,
    servers: serverStore,
    tools: toolStore,
    catalog,
    settings: settingsStore,
    dataDir,
    parseCreateServer,
    log,
    runner: aiRunner,
    bootId: ledgerBootId,
    onAiRun: (event) => {
      audit.recordTask({ ...event, ts: event.ts ?? new Date().toISOString() });
    },
  });
  const ai = aiService;

  // P3 suggestions share the AI runner and settings; a failed or disabled AI
  // only adds a scan warning and leaves the deterministic candidate intact.
  const scriptCandidates = new ScriptCandidatesService({
    db,
    scripts,
    suggester: createAiCandidateSuggester({ db, runner: aiRunner }),
    now: () => clock.now(),
    log,
  });

  // Admin mutations feed the AI annotation pipeline; the AI service keeps its
  // own direct store for its create path, so hooks are added only here.
  const adminServerStore = {
    list: () => serverStore.list(),
    get: (id: string) => serverStore.get(id),
    revision: () => serverStore.revision(),
    create: async (config: Parameters<typeof serverStore.create>[0]) => {
      const result = await serverStore.create(config);
      // A config import replaces rows through remove+create; the snapshot must
      // stop advertising tools of the previous incarnation.
      catalog.refreshServer(result.server.id);
      ai.onServerCreated(result.server.id);
      return result;
    },
    update: async (
      id: string,
      patch: Parameters<typeof serverStore.update>[1],
      expectedRevision: number,
    ) => {
      const result = await serverStore.update(id, patch, expectedRevision);
      // The store demotes discovered rows when the mode returns to static; the
      // snapshot must be rebuilt so the next eval stops seeing them.
      catalog.refreshServer(id);
      ai.onServerMutated(id);
      return result;
    },
    remove: async (id: string, expectedRevision: number) => {
      const result = await serverStore.remove(id, expectedRevision);
      // Drop the removed server's tool rows from the live snapshot immediately.
      catalog.refreshServer(id);
      ai.onServerMutated(id);
      return result;
    },
  };

  const serveRuntime = createServeRuntime({
    dataDir,
    maxProcesses: bootCapacity.maxServeProcesses,
    ...(options.bootId === undefined ? {} : { bootId: options.bootId }),
    ...(process.env['REPL_CLAUDE_BIN'] === undefined ? {} : { bin: process.env['REPL_CLAUDE_BIN'] }),
    now: () => clock.now(),
    log,
  });
  // Lazily fills `__official__` from `claude mcp serve`; releases the dedicated
  // serve pair right after listing (see official-sync.ts).
  const officialSync = createOfficialToolsSync({
    db,
    runtime: serveRuntime,
    workspace: join(dataDir, 'official-workspace'),
    ...(process.env['REPL_CLAUDE_BIN'] === undefined ? {} : { bin: process.env['REPL_CLAUDE_BIN'] }),
    onSynced: () => {
      catalog.refreshServer(OFFICIAL_SERVER_ID);
    },
    log,
  });
  const tasks = new McpTaskStore({ clock });
  const sessions = new TransportSessionRegistry({
    clock,
    ...(options.transportIdleMs === undefined ? {} : { idleMs: options.transportIdleMs }),
  });

  /** Publishes the design 03 §4.5 `eval` frames from the gateway's audit events. */
  const publishEvalEvent = (event: Record<string, unknown> & { event: string }): void => {
    if (event.event !== 'eval_start' && event.event !== 'eval_end') return;
    const frame: Record<string, unknown> = {
      phase: event.event === 'eval_start' ? 'start' : 'end',
      execSessionId: event['exec'],
      binding: event['binding'] ?? null,
      client: event['client'] ?? '',
      clientName: event['clientName'] ?? '',
      clientVersion: event['clientVersion'] ?? '',
      workspace: event['workspace'],
    };
    if (typeof event['evalId'] === 'number') frame['evalId'] = event['evalId'];
    if (event.event === 'eval_start') {
      frame['mode'] = event['mode'];
    } else {
      frame['ok'] = event['ok'];
      frame['outcome'] = event['outcome'];
      frame['ms'] = event['ms'];
    }
    eventsHub.publish('eval', frame);
  };

  const gateway = new ExecGateway({
    catalog,
    log,
    clock,
    limits: bootCapacity,
    serve: {
      healthy: (execSessionId) => serveRuntime.isHealthy({ execSessionId }),
      restart: async (execSessionId) => {
        await serveRuntime.restart({ execSessionId });
      },
    },
    callTool:
      options.callTool ??
      (async (
        call: ToolCallRequest,
        workspace?: string,
        binding?: string | null,
        signal?: AbortSignal,
        deadline?: number,
        execSessionId?: string,
        observation?: ToolCallObservation,
      ) => {
        if (call.server !== undefined) {
          return await poolRuntime.callTool(call, {
            bindingId: binding ?? null,
            ...(signal === undefined ? {} : { signal }),
            ...(deadline === undefined ? {} : { deadline }),
            ...(observation === undefined ? {} : { observation }),
          });
        }
        const key = workspace === undefined || workspace === '' || workspace === '.' ? process.cwd() : workspace;
        const client = await serveRuntime.acquire(
          key,
          execSessionId === undefined ? undefined : { execSessionId },
        );
        return await createServeCallTool(client)(call, {
          ...(signal === undefined ? {} : { signal }),
          ...(deadline === undefined ? {} : { deadline }),
        });
      }),
    onAudit: (event) => {
      const record = { ...event, ts: new Date().toISOString() };
      if (event.event.startsWith('tool_')) {
        audit.recordToolCall(record);
      } else if (event.event.startsWith('eval_')) {
        audit.recordEval(record);
        publishEvalEvent(event);
      } else {
        audit.recordTask(record);
      }
    },
    onSessionClosed: async (_workspace, session) => {
      if (session === undefined) return;
      // Only this execution session's serve handle is released; a sibling
      // session in the same workspace keeps its own process (design 03 §2.2).
      await serveRuntime.release(session.workspace, { execSessionId: session.id });
    },
    onScriptRun: (record) => {
      const archived = scripts.archiveRun(record);
      if (archived.activationSkipped !== undefined) {
        log(
          `script activation skipped for ${record.scriptId ?? '?'} v${record.scriptVersion ?? '?'}: current state ${archived.activationSkipped}`,
          { level: 'warn', scope: 'scripts', runId: record.runId },
        );
      }
      if (record.ok && record.entryMode === 'script' && record.purpose !== 'test' && record.scriptId) {
        scripts.noteUsage(record.scriptId);
      }
    },
  });

  /** Latest resolved identity per transport session, for the admin client view. */
  const sessionActivity = new Map<
    string,
    { binding: string | null; client: string; clientName: string; clientVersion: string }
  >();
  const sessionRegistry: SessionRegistry = {
    async list(): Promise<McpSessionRecord[]> {
      const live = sessions.list();
      const liveIds = new Set(live.map((session) => session.id));
      for (const id of [...sessionActivity.keys()]) {
        if (!liveIds.has(id)) sessionActivity.delete(id);
      }

      const records = new Map<string, McpSessionRecord>();
      for (const session of live) {
        const seen = sessionActivity.get(session.id);
        records.set(session.id, {
          mcpSessionId: session.id,
          bindingId: seen?.binding ?? null,
          client: seen?.client ?? '',
          clientName: seen?.clientName ?? '',
          clientVersion: seen?.clientVersion ?? '',
          connectedAt: new Date(session.createdAt).toISOString(),
          lastRequestAt: new Date(session.lastRequestAt).toISOString(),
        });
      }
      // Sessions with no request yet (or whose identity came from a binding)
      // are enriched from the execution sessions they own.
      for (const exec of gateway.sessions.list()) {
        let record = records.get(exec.mcpSessionId);
        if (record === undefined) {
          const parts = splitClientLabel(exec.clientLabel);
          record = {
            mcpSessionId: exec.mcpSessionId,
            bindingId: exec.binding,
            client: exec.clientLabel,
            clientName: parts.name,
            clientVersion: parts.version,
            lastRequestAt: new Date(exec.lastRequestAt).toISOString(),
          };
          records.set(exec.mcpSessionId, record);
        }
        if (record.bindingId === null) record.bindingId = exec.binding;
        if (record.client === '') record.client = exec.clientLabel;
        if (record.clientName === '' && exec.clientLabel !== '') {
          const parts = splitClientLabel(exec.clientLabel);
          record.clientName = parts.name;
          record.clientVersion = parts.version;
        }
        const ids = record.execSessionIds ?? [];
        ids.push(exec.id);
        record.execSessionIds = ids;
      }
      return [...records.values()];
    },
  };

  /**
   * Applies a committed capacity snapshot to every runtime component. The
   * store wrapper covers every writer; the settings handler also calls this
   * after a PATCH. Values were validated before the write, so a failure here
   * can only come from a malformed test env override.
   */
  const applyCapacitySettings = (settings: unknown): void => {
    try {
      const limits = resolveCapacityLimitsFromSettings(settings);
      gateway.updateLimits(limits);
      poolRuntime.gates.updateLimits({
        callsPerBinding: limits.maxInFlightCallsPerBindingPerServer,
        queuedPerBinding: limits.maxQueuedCallsPerBindingPerServer,
      });
      serveRuntime.updateLimits({ maxProcesses: limits.maxServeProcesses });
    } catch (error) {
      // The write already committed; a bad stored value must not fail the PATCH.
      log(`capacity settings were not applied: ${(error as Error).message}`, {
        level: 'warn',
        scope: 'server',
      });
    }
  };
  const settingsWithHooks: SettingsStore = {
    read: () => settingsStore.read(),
    replace: async (settings, expectedRevision) => {
      const result = await settingsStore.replace(settings, expectedRevision);
      applyCapacitySettings(result.settings);
      return result;
    },
  };

  const adminHandlers = [
    createAdminServersHandler({
      servers: adminServerStore,
      pool: poolControl,
      operations,
      toolCounts: () => countToolsByServer(db),
      toolTags: async (serverId) =>
        (await toolStore.listByServer(serverId)).map((tool) => ({
          name: tool.name,
          enabled: tool.enabled,
          tags: tool.tags,
        })),
      official: officialSync,
      onToolsRefreshed: (id) => {
        ai.onServerMutated(id);
        void ai.onToolsIndexed(id);
      },
    }),
    createAdminToolsHandler({
      servers: adminServerStore,
      tools: toolStore,
      retrieval: createSearchPreview({ db }),
      official: officialSync,
    }),
    createAdminClientsHandler({
      bindings: bindingStore,
      sessions: sessionRegistry,
      onBindingChanged: async (bindingId) => {
        const affected = gateway.sessions
          .list()
          .filter((record) => record.binding === bindingId).length;
        await gateway.destroyOwner(bindingId);
        return affected;
      },
    }),
    createAdminSettingsHandler({
      settings: settingsWithHooks,
      onSettingsChanged: (capacity) => applyCapacitySettings(capacity),
    }),
    createAdminTagsHandler({ settings: settingsWithHooks }),
    createAdminCategoriesHandler({ settings: settingsWithHooks }),
    createAdminDiscoverHandler({
      servers: adminServerStore,
      secrets: {
        has: async (name) => (await secrets.get(name)) !== undefined,
        set: (name, value) => secrets.set(name, value),
        delete: (name) => secrets.delete(name),
      },
    }),
    createAdminConfigRoutes({
      secrets,
      servers: adminServerStore,
      operations: operationStarterFromLauncher(operations),
    }),
    createAdminReportsHandler({ reports }),
    createAdminAlertsHandler({ alerts: alertConfig, dispatcher: alertDispatcher }),
    createAdminDiscoveryHandler({ service: discoveryService }),
    createAdminAiHandler({ ai }),
    createAdminScriptsHandler({ scripts, gateway }),
    createAdminScriptCandidatesHandler({ candidates: scriptCandidates }),
    ...audit.handlers(),
  ];

  /**
   * One request's tool surface (design 01 §7.2, 03 §6.2): one binding read and
   * one catalog snapshot, shared by `tools/list`, `tools/call` and the discover
   * instructions. A binding that vanished mid-request fails closed.
   */
  interface ToolSurface {
    servers: McpServerOverview[];
    visibility: Required<Pick<ToolVisibility, 'allowedServers' | 'allowedTags'>>;
    categories: string[];
    tags: string[];
    runScriptDescription: string;
    searchToolsDefinition: ToolDefinition;
  }

  const toolSurfaceFor = (identity: RequestIdentity): ToolSurface => {
    const binding = identity.binding === null ? null : getClientBinding(db, identity.binding);
    const missingBinding = identity.binding !== null && binding === null;
    const allowedServers = missingBinding ? [] : (binding?.allowedServers ?? null);
    const allowedTags = missingBinding ? [] : (binding?.allowedTags ?? null);
    const visibility = { allowedServers, allowedTags };

    const snapshot = catalog.snapshot();
    const servers = collectVisibleMcpServers({
      servers: listServers(db),
      tools: snapshot.tools,
      allowedServers,
      allowedTags,
    });
    const visibleTools = snapshot.tools.filter(
      (tool) => tool.enabled && isToolVisible(tool, visibility),
    );
    const categories = [
      ...new Set(
        visibleTools
          .map((tool) => tool.category)
          .filter((category): category is string => category !== undefined),
      ),
    ].sort();
    const tags = [
      ...new Set(visibleTools.flatMap((tool) => tool.tags ?? [])),
    ].sort();

    // Empty when official sync never ran or the tools are disabled by policy,
    // which keeps the description's built-in block out of unsupported hosts.
    const builtinNames = visibleTools
      .filter((tool) => tool.kind === 'builtin')
      .map((tool) => tool.name);
    return {
      servers,
      visibility,
      categories,
      tags,
      runScriptDescription: buildRunScriptDescription(RUN_SCRIPT_DESCRIPTION, servers, builtinNames),
      searchToolsDefinition: buildSearchToolsDefinition(
        categories,
        tags,
        [
          ...servers.map((server) => server.id),
          ...(builtinNames.length > 0 ? ['__official__'] : []),
        ],
      ),
    };
  };

  const dispatcher = createMethodTable<McpContext>({
    instructions: () => INSTRUCTIONS,
    toolsList: (_params, context) => {
      const surface = toolSurfaceFor(context.identity);
      return {
        resultType: 'complete',
        // 2026-07-28 list results must carry cache hints; visibility is per binding.
        ttlMs: 0,
        cacheScope: 'private',
        tools: listTools({
          runScriptDescription: surface.runScriptDescription,
          searchToolsDescription: surface.searchToolsDefinition.description,
          searchToolsSchema: surface.searchToolsDefinition.inputSchema,
        }),
      };
    },
    toolsCall: async (params, context): Promise<ToolCallResponse> => {
      const name = params['name'];
      if (typeof name !== 'string' || name === '') {
        throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, 'tool name must be a non-empty string');
      }
      const surface = toolSurfaceFor(context.identity);
      return await callTool(name, params['arguments'], {
        ...context,
        visibility: surface.visibility,
        searchToolsDefinition: surface.searchToolsDefinition,
      });
    },
    tasksGet: async (params, context) => {
      const owner = ownerOf(context.identity);
      return await getMcpTask(context.tasks, context.gateway, owner, readTaskId(params));
    },
    tasksCancel: async (params, context) => {
      const owner = ownerOf(context.identity);
      return await cancelMcpTask(context.tasks, context.gateway, owner, readTaskId(params));
    },
    tasksUpdate: async (params, context) => {
      const owner = ownerOf(context.identity);
      return await updateMcpTask(context.tasks, owner, readTaskId(params));
    },
  });

  const overviewHandler = createAdminOverviewHandler({
    staticDir: WEB_DIST,
    evals: () => gateway.inFlightEvals(),
    cancelEval: (exec, evalId) => gateway.cancelEval(exec, evalId),
    overview: () => {
      const pool = poolRuntime.snapshot();
      const gatewayStats = gateway.stats();
      const limits = gateway.sessions.limits;
      const byBinding = new Map<string, BindingActivity>();
      const activityFor = (binding: string | null): BindingActivity => {
        const key = binding ?? '';
        let entry = byBinding.get(key);
        if (entry === undefined) {
          entry = { binding, execSessions: 0, inFlightEvals: 0, inFlightCalls: 0, queuedCalls: 0 };
          byBinding.set(key, entry);
        }
        return entry;
      };
      for (const stat of gateway.bindingStats()) {
        const entry = activityFor(stat.binding);
        entry.execSessions += stat.execSessions;
        entry.inFlightEvals += stat.inFlightEvals;
      }
      for (const stat of poolRuntime.gates.bindingStats()) {
        const entry = activityFor(stat.binding);
        entry.inFlightCalls += stat.running;
        entry.queuedCalls += stat.queued;
      }
      const bindings = [...byBinding.values()]
        .map((entry) => ({
          ...entry,
          label: entry.binding === null ? null : (getClientBinding(db, entry.binding)?.label ?? null),
        }))
        .sort((a, b) => (a.binding ?? '').localeCompare(b.binding ?? ''));
      return {
        capacity: {
          maxExecSessions: limits.maxExecSessions,
          maxExecSessionsPerBinding: limits.maxExecSessionsPerBinding,
          maxInFlightEvalsPerExecSession: limits.maxInFlightEvalsPerExecSession,
          maxInFlightEvalsPerBinding: limits.maxInFlightEvalsPerBinding,
          // Cold keys report what the live components enforce, not the raw row.
          maxServeProcesses: serveRuntime.maxProcesses,
          maxWorkers: limits.maxWorkers,
          maxInFlightCallsPerBindingPerServer: poolRuntime.gates.callsPerBinding,
          maxQueuedCallsPerBindingPerServer: poolRuntime.gates.queuedPerBinding,
        },
        pool: { total: pool.total, ready: pool.ready, reconnecting: pool.reconnecting, failed: pool.failed },
        sessions: {
          transport: sessions.size,
          exec: gatewayStats.sessions,
          inFlightEvals: gatewayStats.inFlightEvals,
        },
        servers: {
          total: db.prepare('SELECT count(*) AS n FROM servers').get()?.['n'] as number,
          enabled: db.prepare('SELECT count(*) AS n FROM servers WHERE enabled = 1').get()?.['n'] as number,
        },
        bindings,
        resources: resourceMonitor.snapshot(),
      };
    },
  });

  // Programmatic callers get the same default as the CLI. The adapter only
  // auto-logs in loopback peers; direct remote clients still need a token.
  const adminAutoLogin = options.adminAutoLogin ?? true;

  const appOptions: AppOptions = {
    allowedHosts: options.allowedHosts,
    identity: resolveIdentityConfig({
      mode: options.strictAuth === true ? 'strict' : 'loose',
      globalToken: tokens.mcpToken,
      bindings: { findByToken: (token) => findBindingByToken(db, token) },
    }),
    sessions,
    gateway,
    catalog,
    tasks,
    dispatcher,
    reports,
    scripts,
    audit: (event) => {
      audit.recordTask({ ...event, ts: new Date().toISOString() });
    },
    log,
    onSessionActivity: (transportId, identity) => {
      sessionActivity.set(transportId, {
        binding: identity.binding,
        client: identity.client,
        clientName: identity.clientName ?? '',
        clientVersion: identity.clientVersion ?? '',
      });
    },
    frames: {
      recordIn: (input) => audit.recordFrameIn(input as unknown as Parameters<typeof audit.recordFrameIn>[0]),
      recordOut: (input) => audit.recordFrameOut(input as unknown as Parameters<typeof audit.recordFrameOut>[0]),
    },
    admin: async (req, res, url) =>
      await handleAdminHttp(req, res, url, {
        adminToken: tokens.adminToken,
        allowedHosts: options.allowedHosts,
        adminAutoLogin,
        session: adminSession,
        sse: { events: eventsHub, audit: auditHub },
        handlers: [...adminHandlers, overviewHandler],
        log,
      }),
  };

  const server = createApp(appOptions);

  // Registers every configured server; only `eager` ones connect now (design 03 §4).
  await poolRuntime.preload().catch((error: unknown) => {
    log(`pool preload failed: ${(error as Error).message}`, { level: 'error', scope: 'pool' });
  });
  publishPoolState();
  alertDispatcher.start();
  resourceMonitor.start();

  let closing = false;
  let closePromise: Promise<void> | null = null;
  let activeSweep: Promise<IdleSweepResult | null> | null = null;
  let lastReportPruneAt = 0;
  let lastScriptRunPruneAt = 0;
  const sweepNow = (): Promise<IdleSweepResult | null> => {
    if (closing || activeSweep !== null) return Promise.resolve(null);
    const run = (async (): Promise<IdleSweepResult | null> => {
      try {
        // Transport expiry first: its close cascade drops exec sessions and tasks
        // of the expired `Mcp-Session-Id` before the worker/serve sweep runs.
        try {
          await sessions.sweep();
        } catch (error) {
          log(`transport sweep failed: ${(error as Error).message}`, {
            level: 'error',
            scope: 'server',
          });
        }
        // Reports retention rides the same sweep but runs at most hourly: the
        // table only grows on `report_problem`, so a 60 s cadence is wasted IO.
        const now = Date.now();
        if (now - lastReportPruneAt >= REPORT_RETENTION_INTERVAL_MS) {
          lastReportPruneAt = now;
          try {
            const deleted = reportStore.prune({
              before: new Date(now - REPORT_RETENTION_DAYS * 86_400_000).toISOString(),
              maxRows: REPORT_RETENTION_MAX_ROWS,
            });
            if (deleted > 0) {
              log(`pruned ${deleted} closed report(s)`, {
                level: 'info',
                scope: 'reports',
                deleted,
              });
            }
          } catch (error) {
            log(`report retention failed: ${(error as Error).message}`, {
              level: 'error',
              scope: 'reports',
            });
          }
        }
        // Script archives expire after 30 days; a daily pass is enough and keeps
        // this out of the audit retention budget (design 10 §5.1).
        if (now - lastScriptRunPruneAt >= SCRIPT_RUN_PRUNE_INTERVAL_MS) {
          lastScriptRunPruneAt = now;
          try {
            const deleted = scripts.pruneExpiredRuns();
            if (deleted > 0) {
              log(`pruned ${deleted} expired script run(s)`, {
                level: 'info',
                scope: 'scripts',
                deleted,
              });
            }
          } catch (error) {
            log(`script run retention failed: ${(error as Error).message}`, {
              level: 'error',
              scope: 'scripts',
            });
          }
        }
        return await gateway.sweepIdle();
      } catch (error) {
        log(`idle sweep failed: ${(error as Error).message}`, { level: 'error', scope: 'exec' });
        return null;
      }
    })();
    activeSweep = run;
    void run.then(
      () => {
        if (activeSweep === run) activeSweep = null;
      },
      () => {
        if (activeSweep === run) activeSweep = null;
      },
    );
    return run;
  };
  const sweepTimer = setInterval(() => {
    void sweepNow();
  }, options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // One sweep at boot (a crash can leave yesterday's payload tree behind) and
  // then every six hours; failures are logged by the service itself.
  retention.start();
  void retention.runOnce();
  // `run/` is not a log domain, but stale `sessions/<id>` dirs are bounded
  // state: one sweep at boot, then every six hours on the same cadence.
  sessionPruner.start();
  void sessionPruner.runOnce();

  // Each eval warns once when it first crosses the threshold; the key is
  // dropped once that eval settles.
  const warnedEvals = new Set<string>();
  const evalWatchdogTimer = setInterval(() => {
    if (closing) return;
    // The default 200-row page would hide young evals behind old stuck ones.
    const inFlight = gateway.inFlightEvals(Number.MAX_SAFE_INTEGER);
    if (inFlight.total === 0) {
      warnedEvals.clear();
      return;
    }
    const live = new Set(inFlight.items.map((item) => `${item.exec}:${item.evalId}`));
    for (const key of warnedEvals) {
      if (!live.has(key)) warnedEvals.delete(key);
    }
    for (const item of stuckEvalsOf(inFlight.items)) {
      const key = `${item.exec}:${item.evalId}`;
      if (warnedEvals.has(key)) continue;
      warnedEvals.add(key);
      log(`eval ${item.evalId} has been in flight for ${item.ageMs}ms`, {
        level: 'warn',
        scope: 'eval',
        exec: item.exec,
        evalId: item.evalId,
        binding: item.binding,
        workspace: item.workspace,
        ageMs: item.ageMs,
      });
    }
  }, EVAL_WATCHDOG_INTERVAL_MS);
  evalWatchdogTimer.unref();

  return {
    server,
    db,
    catalog,
    gateway,
    capacity: () => ({
      ...gateway.sessions.limits,
      maxServeProcesses: serveRuntime.maxProcesses,
      maxInFlightCallsPerBindingPerServer: poolRuntime.gates.callsPerBinding,
      maxQueuedCallsPerBindingPerServer: poolRuntime.gates.queuedPerBinding,
    }),
    adminBootstrapToken: adminSession.bootstrapToken,
    sweep: sweepNow,
    retention,
    close() {
      if (closePromise !== null) return closePromise;
      closing = true;
      clearInterval(sweepTimer);
      clearInterval(evalWatchdogTimer);
      clearInterval(poolStateTimer);
      resourceMonitor.stop();
      retention.stop();
      sessionPruner.stop();
      closePromise = (async () => {
        // A sweep that started before `closing` owns the gateway until it ends.
        if (activeSweep !== null) await activeSweep.catch(() => undefined);
        await gateway.disposeAll();
        await poolRuntime.dispose();
        await serveRuntime.disposeAll();
        eventsHub.close();
        auditHub.close();
        await closeServer(server, log);
        await alertDispatcher.close();
        const closableAi = ai as { close?: () => void | Promise<void> };
        try {
          await closableAi.close?.();
        } catch (error) {
          log(`ai service close failed: ${(error as Error).message}`, {
            level: 'error',
            scope: 'ai',
          });
        }
        await audit.close();
        await resourceWriter.close();
        db.close();
      })();
      return closePromise;
    },
  };
}
