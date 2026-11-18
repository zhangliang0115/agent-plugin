import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProcessLedger, newId, type PoolEntry, type ToolCallRequest } from '@zhangliang0115/repl-server-core';

import { createAdminOverviewHandler } from './admin/overview.ts';
import { createAdminClientsHandler } from './admin/clients.ts';
import { createAdminDiscoverHandler } from './admin/discover.ts';
import { createAdminServersHandler, createOperationLauncher, type AdminOperation, type OperationLauncher } from './admin/servers.ts';
import { createAdminSettingsHandler } from './admin/settings.ts';
import { createAdminToolsHandler } from './admin/tools.ts';
import { createAdminConfigRoutes, operationStarterFromLauncher } from './admin/config-routes.ts';
import { createAdminReportsHandler } from './admin/reports.ts';
import { createAdminAlertsHandler } from './admin/alerts.ts';
import { createAdminAiHandler } from './admin/ai.ts';
import { parseCreateServer } from './admin/servers.ts';
import { createEventHub } from './admin/events.ts';
import { createAdminSession } from './admin/session.ts';
import { createAuditRuntime } from './audit/runtime.ts';
import { createAlertConfigStore } from './alerts/config-store.ts';
import { createAlertDispatcher } from './alerts/dispatcher.ts';
import { createAiService } from './ai/index.ts';
import { createDbReportStore } from './reports/store.ts';
import { createReportService } from './reports/service.ts';
import { createDiscoveryService } from './discovery/service.ts';
import { createAdminDiscoveryHandler } from './discovery/handler.ts';
import { createFileSecretStore } from './secrets/store.ts';
import { handleAdminHttp } from './admin/http-adapter.ts';
import { createSearchPreview, createCatalogService } from './catalog/index.ts';
import { createApp, type AppOptions, type McpContext } from './app.ts';
import { resolveIdentityConfig } from './assembly-identity.ts';
import {
  DbClientBindingStore,
  DbServerStore,
  DbSettingsStore,
  DbToolStore,
} from './assembly-stores.ts';
import { openStateDb, migrate } from './db/migrate.ts';
import { findBindingByToken } from './db/clients.ts';
import { upsertTool } from './db/tools.ts';
import { ExecGateway } from './exec/gateway.ts';
import { createPoolRuntime } from './pool/runtime.ts';
import { mcpClientFactory, mcpTransportFactory } from './pool/adapters/client.ts';
import { createServeRuntime } from './serve/runtime.ts';
import { createServeCallTool } from './serve/adapter.ts';
import { loadLocalTokens, stateDbPath } from './local-tokens.ts';
import { createMethodTable } from './mcp/methods.ts';
import { JSON_RPC_INVALID_PARAMS, JsonRpcError } from './mcp/errors.ts';
import type { AuditEvent, Catalog } from './ports.ts';
import { TransportSessionRegistry } from './sessions/transport.ts';
import { McpTaskStore, cancelMcpTask, getMcpTask, ownerOf, updateMcpTask } from './tasks/mcp-tasks.ts';
import { callTool, type ToolCallResponse } from './tools/call.ts';
import { listTools } from './tools/registry.ts';

export interface AssemblyOptions {
  root?: string;
  port?: number;
  host?: string;
  strictAuth?: boolean;
  /** Boot id shared with the startup sweep; keeps serve ledgers consistent. */
  bootId?: string;
  /** Test seam: replaces the script-visible tool call. */
  callTool?: (call: ToolCallRequest) => Promise<unknown>;
  log?: (line: string) => void;
}

export interface Assembly {
  server: Server;
  db: ReturnType<typeof openStateDb>;
  catalog: Catalog;
  /** One-time admin bootstrap token; printed once on startup. */
  adminBootstrapToken: string | null;
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

/** Wires SQLite, catalog, gateway, MCP methods, admin routes and the HTTP app. */
export async function assemble(options: AssemblyOptions = {}): Promise<Assembly> {
  const log = options.log ?? ((line: string) => console.error(line));
  const root = options.root ?? process.env['AGENTS_HOME'];

  const dataDir = dirname(stateDbPath(root === undefined ? undefined : `${root}/repl-server`));
  const tokens = await loadLocalTokens(dataDir);
  const db = openStateDb(stateDbPath(dataDir));
  migrate(db);

  const eventsHub = createEventHub();
  const auditHub = createEventHub();
  const catalog = createCatalogService({
    db,
    onCatalogChanged: (event) => {
      eventsHub.publish('catalog_changed', event);
    },
  });
  const audit = createAuditRuntime({
    dir: join(dataDir, 'audit'),
    log,
    onEvent: (event) => {
      auditHub.publish('audit', event);
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
  const poolRuntime = createPoolRuntime({
    servers: serverStore,
    secrets,
    transportFactory: mcpTransportFactory,
    clientFactory: mcpClientFactory,
    ledger: poolLedger,
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
      catalog.refreshServer(serverId);
      void aiService?.onToolsIndexed(serverId);
    },
    onStderr: (serverId, chunk) => log(`[pool ${serverId}] stderr ${chunk.length} bytes`),
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
    onAiRun: (event) => {
      audit.recordTask({ ...event, ts: event.ts ?? new Date().toISOString() });
    },
  });
  const ai = aiService;

  // Admin mutations feed the AI annotation pipeline; the AI service keeps its
  // own direct store for its create path, so hooks are added only here.
  const adminServerStore = {
    list: () => serverStore.list(),
    get: (id: string) => serverStore.get(id),
    revision: () => serverStore.revision(),
    create: async (config: Parameters<typeof serverStore.create>[0]) => {
      const result = await serverStore.create(config);
      ai.onServerCreated(result.server.id);
      return result;
    },
    update: async (
      id: string,
      patch: Parameters<typeof serverStore.update>[1],
      expectedRevision: number,
    ) => {
      const result = await serverStore.update(id, patch, expectedRevision);
      ai.onServerMutated(id);
      return result;
    },
    remove: async (id: string, expectedRevision: number) => {
      const result = await serverStore.remove(id, expectedRevision);
      ai.onServerMutated(id);
      return result;
    },
  };

  const adminHandlers = [
    createAdminServersHandler({
      servers: adminServerStore,
      pool: poolControl,
      operations,
      discovery: { demote: (id: string) => discoveryService?.demote(id) ?? 0 },
    }),
    createAdminToolsHandler({
      servers: adminServerStore,
      tools: toolStore,
      retrieval: createSearchPreview({ db }),
    }),
    createAdminClientsHandler({ bindings: bindingStore, onBindingChanged: async () => 0 }),
    createAdminSettingsHandler({ settings: settingsStore }),
    createAdminDiscoverHandler({ servers: adminServerStore }),
    createAdminConfigRoutes({
      secrets,
      servers: adminServerStore,
      operations: operationStarterFromLauncher(operations),
    }),
    createAdminReportsHandler({ reports }),
    createAdminAlertsHandler({ alerts: alertConfig, dispatcher: alertDispatcher }),
    createAdminDiscoveryHandler({ service: discoveryService }),
    createAdminAiHandler({ ai }),
    ...audit.handlers(),
  ];

  const serveRuntime = createServeRuntime({
    dataDir,
    ...(options.bootId === undefined ? {} : { bootId: options.bootId }),
    ...(process.env['REPL_CLAUDE_BIN'] === undefined ? {} : { bin: process.env['REPL_CLAUDE_BIN'] }),
    log,
  });

  const gateway = new ExecGateway({
    catalog,
    callTool:
      options.callTool ??
      (async (call: ToolCallRequest, workspace?: string, binding?: string | null) => {
        if (call.server !== undefined) {
          return await poolRuntime.callTool(call, { bindingId: binding ?? null });
        }
        const key = workspace === undefined || workspace === '' || workspace === '.' ? process.cwd() : workspace;
        const client = await serveRuntime.acquire(key);
        return await createServeCallTool(client)(call);
      }),
    onAudit: (event) => {
      const record = { ...event, ts: new Date().toISOString() };
      if (event.event.startsWith('tool_')) audit.recordToolCall(record);
      else if (event.event.startsWith('eval_')) audit.recordEval(record);
      else audit.recordTask(record);
    },
    onSessionClosed: async (workspace) => {
      const key = workspace === '' || workspace === '.' ? process.cwd() : workspace;
      await serveRuntime.release(key);
    },
  });
  const tasks = new McpTaskStore();
  const sessions = new TransportSessionRegistry();

  const dispatcher = createMethodTable<McpContext>({
    toolsList: () => ({ tools: listTools() }),
    toolsCall: async (params, context): Promise<ToolCallResponse> => {
      const name = params['name'];
      if (typeof name !== 'string' || name === '') {
        throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, 'tool name must be a non-empty string');
      }
      return await callTool(name, params['arguments'], context);
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
    overview: () => {
      const pool = poolRuntime.snapshot();
      const gatewayStats = gateway.stats();
      return {
        capacity: {
          maxExecSessions: 8,
          maxWorkspacesPerMcpSession: 4,
          maxInFlightEvalsPerExecSession: 8,
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
      };
    },
  });

  const appOptions: AppOptions = {
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
    log,
    frames: {
      recordIn: (input) => audit.recordFrameIn(input as unknown as Parameters<typeof audit.recordFrameIn>[0]),
      recordOut: (input) => audit.recordFrameOut(input as unknown as Parameters<typeof audit.recordFrameOut>[0]),
    },
    admin: async (req, res, url) =>
      await handleAdminHttp(req, res, url, {
        adminToken: tokens.adminToken,
        session: adminSession,
        sse: { events: eventsHub, audit: auditHub },
        handlers: [...adminHandlers, overviewHandler],
        log,
      }),
  };

  const server = createApp(appOptions);

  // Registers every configured server; only `eager` ones connect now (design 03 §4).
  await poolRuntime.preload().catch((error: unknown) => {
    log(`repl-server: pool preload failed: ${(error as Error).message}`);
  });
  publishPoolState();
  alertDispatcher.start();

  return {
    server,
    db,
    catalog,
    adminBootstrapToken: adminSession.bootstrapToken,
    async close() {
      clearInterval(poolStateTimer);
      await gateway.disposeAll();
      await poolRuntime.dispose();
      await serveRuntime.disposeAll();
      eventsHub.close();
      auditHub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await alertDispatcher.close();
      await audit.close();
      db.close();
    },
  };
}
