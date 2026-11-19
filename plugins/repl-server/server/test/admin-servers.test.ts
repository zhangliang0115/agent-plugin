/** Admin endpoints for servers, tools, settings and discovery, exercised directly through
 * the factories with an in-memory SQLite store. No HTTP server is started. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAdminDiscoverHandler, sameCommandLine } from '../src/admin/discover.ts';
import {
  createAdminServersHandler,
  createOperationLauncher,
  AdminApiError,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
  type AdminSecrets,
  type CommandArg,
  type SecretValue,
  type ServerConfig,
  type ServerConfigPatch,
  type ServerPoolControl,
  type ServerRecord,
  type ServerRuntimeState,
  type ServerStore,
} from '../src/admin/servers.ts';
import {
  createAdminSettingsHandler,
  DEFAULT_CAPACITY,
  type CapacitySettings,
  type RuntimeSettings,
  type SettingsStore,
  type StoredSettings,
} from '../src/admin/settings.ts';
import {
  createAdminToolsHandler,
  type SearchPreviewInput,
  type ToolPatch,
  type ToolRecord,
  type ToolStore,
  type ToolUpdate,
} from '../src/admin/tools.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta (key, value) VALUES ('revision', '1');
CREATE TABLE servers (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, transport TEXT NOT NULL,
  command TEXT, args_json TEXT NOT NULL, env_json TEXT NOT NULL, cwd TEXT, url TEXT,
  headers_json TEXT NOT NULL, enabled INTEGER NOT NULL, connect_mode TEXT NOT NULL,
  summary TEXT, summary_source TEXT, category TEXT, tags_json TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL, max_concurrency INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE tools (
  server_id TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT, description TEXT,
  description_override TEXT, enabled INTEGER NOT NULL, concurrency TEXT NOT NULL,
  type TEXT, tags_json TEXT NOT NULL, category TEXT, schema_json TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0, stale_override INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (server_id, name)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function readRevision(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'revision'").get();
  assert.ok(row !== undefined);
  return Number(row['value']);
}

function writeRevision(db: DatabaseSync, value: number): void {
  db.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(value));
}

function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function rowText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  return Number(row[key]);
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function rowToServer(row: Record<string, unknown>): ServerRecord {
  return {
    id: String(row['id']),
    label: String(row['label']),
    transport: String(row['transport']) as ServerRecord['transport'],
    command: rowText(row, 'command'),
    args: parseJson<CommandArg[]>(row['args_json']),
    env: parseJson<Record<string, SecretValue>>(row['env_json']),
    cwd: rowText(row, 'cwd'),
    url: rowText(row, 'url'),
    headers: parseJson<Record<string, SecretValue>>(row['headers_json']),
    enabled: rowInteger(row, 'enabled') === 1,
    connectMode: String(row['connect_mode']) as ServerRecord['connectMode'],
    summary: rowText(row, 'summary'),
    summarySource: rowText(row, 'summary_source'),
    category: rowText(row, 'category'),
    tags: parseJson<string[]>(row['tags_json']),
    timeoutMs: rowInteger(row, 'timeout_ms'),
    maxConcurrency: rowInteger(row, 'max_concurrency'),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    revision: rowInteger(row, 'revision'),
  };
}

class SqliteServerStore implements ServerStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async list(): Promise<ServerRecord[]> {
    return this.db
      .prepare('SELECT * FROM servers ORDER BY rowid')
      .all()
      .map((row) => rowToServer(row));
  }

  async get(id: string): Promise<ServerRecord | null> {
    const row = this.db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    return row === undefined ? null : rowToServer(row);
  }

  async revision(): Promise<number> {
    return readRevision(this.db);
  }

  async create(config: ServerConfig): Promise<{ server: ServerRecord; revision: number }> {
    return transaction(this.db, () => {
      const revision = readRevision(this.db) + 1;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO servers (id, label, transport, command, args_json, env_json, cwd, url,
             headers_json, enabled, connect_mode, summary, summary_source, category, tags_json,
             timeout_ms, max_concurrency, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          config.id,
          config.label,
          config.transport,
          config.command,
          JSON.stringify(config.args),
          JSON.stringify(config.env),
          config.cwd,
          config.url,
          JSON.stringify(config.headers),
          config.enabled ? 1 : 0,
          config.connectMode,
          config.summary,
          config.summarySource,
          config.category,
          JSON.stringify(config.tags),
          config.timeoutMs,
          config.maxConcurrency,
          now,
          now,
          revision,
        );
      writeRevision(this.db, revision);
      return {
        server: { ...config, createdAt: now, updatedAt: now, revision },
        revision,
      };
    });
  }

  async update(
    id: string,
    patch: ServerConfigPatch,
    expectedRevision: number,
  ): Promise<{ server: ServerRecord; revision: number }> {
    return transaction(this.db, () => {
      const currentRevision = readRevision(this.db);
      if (currentRevision !== expectedRevision) {
        throw new AdminApiError(409, 'REVISION_CONFLICT', 'revision conflict', {
          expected: expectedRevision,
          current: currentRevision,
        });
      }
      const row = this.db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
      if (row === undefined) throw new AdminApiError(404, 'SERVER_NOT_FOUND', 'missing');

      const current = rowToServer(row);
      const merged: ServerRecord = { ...current, ...patch };
      const revision = currentRevision + 1;
      const updatedAt = new Date().toISOString();

      this.db
        .prepare(
          `UPDATE servers SET label = ?, command = ?, args_json = ?, env_json = ?, cwd = ?,
             url = ?, headers_json = ?, enabled = ?, connect_mode = ?, summary = ?,
             summary_source = ?, category = ?, tags_json = ?, timeout_ms = ?,
             max_concurrency = ?, updated_at = ?, revision = ? WHERE id = ?`,
        )
        .run(
          merged.label,
          merged.command,
          JSON.stringify(merged.args),
          JSON.stringify(merged.env),
          merged.cwd,
          merged.url,
          JSON.stringify(merged.headers),
          merged.enabled ? 1 : 0,
          merged.connectMode,
          merged.summary,
          merged.summarySource,
          merged.category,
          JSON.stringify(merged.tags),
          merged.timeoutMs,
          merged.maxConcurrency,
          updatedAt,
          revision,
          id,
        );
      writeRevision(this.db, revision);
      return { server: { ...merged, updatedAt, revision }, revision };
    });
  }

  async remove(id: string, expectedRevision: number): Promise<{ revision: number }> {
    return transaction(this.db, () => {
      const currentRevision = readRevision(this.db);
      if (currentRevision !== expectedRevision) {
        throw new AdminApiError(409, 'REVISION_CONFLICT', 'revision conflict', {
          expected: expectedRevision,
          current: currentRevision,
        });
      }
      const result = this.db.prepare('DELETE FROM servers WHERE id = ?').run(id);
      if (result.changes === 0) throw new AdminApiError(404, 'SERVER_NOT_FOUND', 'missing');
      const revision = currentRevision + 1;
      writeRevision(this.db, revision);
      return { revision };
    });
  }
}

function rowToTool(row: Record<string, unknown>): ToolRecord {
  return {
    serverId: String(row['server_id']),
    name: String(row['name']),
    displayName: rowText(row, 'display_name'),
    description: rowText(row, 'description'),
    descriptionOverride: rowText(row, 'description_override'),
    enabled: rowInteger(row, 'enabled') === 1,
    concurrency: String(row['concurrency']) as ToolRecord['concurrency'],
    type: rowText(row, 'type'),
    tags: parseJson<string[]>(row['tags_json']),
    category: rowText(row, 'category'),
    schema: parseJson<unknown>(row['schema_json']),
    discoveredVia: rowText(row, 'discovered_via') === 'search' ? 'search' : 'static',
    stale: rowInteger(row, 'stale') === 1,
    staleOverride: rowInteger(row, 'stale_override') === 1,
    firstSeenAt: String(row['first_seen_at']),
    lastSeenAt: String(row['last_seen_at']),
  };
}

function applyToolPatch(current: ToolRecord, patch: ToolPatch): ToolRecord {
  return {
    ...current,
    descriptionOverride:
      patch.description !== undefined ? patch.description : current.descriptionOverride,
    enabled: patch.enabled ?? current.enabled,
    concurrency: patch.concurrency ?? current.concurrency,
    tags: patch.tags ?? current.tags,
    type: patch.type !== undefined ? patch.type : current.type,
    category: patch.category !== undefined ? patch.category : current.category,
    staleOverride: patch.staleOverride ?? current.staleOverride,
  };
}

function writeTool(db: DatabaseSync, tool: ToolRecord): void {
  db.prepare(
    `UPDATE tools SET display_name = ?, description = ?, description_override = ?,
       enabled = ?, concurrency = ?, type = ?, tags_json = ?, category = ?, schema_json = ?,
       stale = ?, stale_override = ?, first_seen_at = ?, last_seen_at = ?
     WHERE server_id = ? AND name = ?`,
  ).run(
    tool.displayName,
    tool.description,
    tool.descriptionOverride,
    tool.enabled ? 1 : 0,
    tool.concurrency,
    tool.type,
    JSON.stringify(tool.tags),
    tool.category,
    JSON.stringify(tool.schema),
    tool.stale ? 1 : 0,
    tool.staleOverride ? 1 : 0,
    tool.firstSeenAt ?? new Date().toISOString(),
    tool.lastSeenAt ?? new Date().toISOString(),
    tool.serverId,
    tool.name,
  );
}

class SqliteToolStore implements ToolStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async listByServer(serverId: string): Promise<ToolRecord[]> {
    return this.db
      .prepare('SELECT * FROM tools WHERE server_id = ? ORDER BY name')
      .all(serverId)
      .map((row) => rowToTool(row));
  }

  async get(serverId: string, name: string): Promise<ToolRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM tools WHERE server_id = ? AND name = ?')
      .get(serverId, name);
    return row === undefined ? null : rowToTool(row);
  }

  async revision(): Promise<number> {
    return readRevision(this.db);
  }

  async update(
    serverId: string,
    name: string,
    patch: ToolPatch,
    expectedRevision: number,
  ): Promise<{ tool: ToolRecord; revision: number }> {
    return transaction(this.db, () => {
      const currentRevision = readRevision(this.db);
      if (currentRevision !== expectedRevision) {
        throw new AdminApiError(409, 'REVISION_CONFLICT', 'revision conflict');
      }
      const row = this.db
        .prepare('SELECT * FROM tools WHERE server_id = ? AND name = ?')
        .get(serverId, name);
      if (row === undefined) throw new AdminApiError(404, 'TOOL_NOT_FOUND', 'missing');

      const next = applyToolPatch(rowToTool(row), patch);
      writeTool(this.db, next);
      const revision = currentRevision + 1;
      writeRevision(this.db, revision);
      return { tool: next, revision };
    });
  }

  async batch(
    updates: ToolUpdate[],
    expectedRevision: number,
  ): Promise<{ tools: ToolRecord[]; revision: number }> {
    return transaction(this.db, () => {
      const currentRevision = readRevision(this.db);
      if (currentRevision !== expectedRevision) {
        throw new AdminApiError(409, 'REVISION_CONFLICT', 'revision conflict');
      }

      const updated: ToolRecord[] = [];
      for (const update of updates) {
        const row = this.db
          .prepare('SELECT * FROM tools WHERE server_id = ? AND name = ?')
          .get(update.serverId, update.name);
        if (row === undefined) throw new AdminApiError(404, 'TOOL_NOT_FOUND', 'missing');
        const next = applyToolPatch(rowToTool(row), update.patch);
        writeTool(this.db, next);
        updated.push(next);
      }

      const revision = currentRevision + 1;
      writeRevision(this.db, revision);
      return { tools: updated, revision };
    });
  }
}

class SqliteSettingsStore implements SettingsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async read(): Promise<{ settings: StoredSettings; revision: number }> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const settings: StoredSettings = {};
    for (const row of rows) settings[String(row['key'])] = JSON.parse(String(row['value']));
    return { settings, revision: readRevision(this.db) };
  }

  async replace(
    settings: StoredSettings,
    expectedRevision: number,
  ): Promise<{ settings: StoredSettings; revision: number }> {
    return transaction(this.db, () => {
      const currentRevision = readRevision(this.db);
      if (currentRevision !== expectedRevision) {
        throw new AdminApiError(409, 'REVISION_CONFLICT', 'revision conflict');
      }
      this.db.prepare('DELETE FROM settings').run();
      const insert = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(settings)) insert.run(key, JSON.stringify(value));
      const revision = currentRevision + 1;
      writeRevision(this.db, revision);
      return { settings: { ...settings }, revision };
    });
  }
}

class FakePool implements ServerPoolControl {
  readonly calls: string[] = [];
  readonly states = new Map<string, ServerRuntimeState>();
  testResult: { tools: unknown[] } = { tools: [{ name: 'query' }] };
  testError: Error | null = null;
  testPending = false;
  onTest: (() => void) | null = null;
  retireResult: { drained: boolean; inFlight?: number } = { drained: true };

  async state(id: string): Promise<ServerRuntimeState | null> {
    this.calls.push(`state:${id}`);
    return this.states.get(id) ?? null;
  }

  async connect(id: string): Promise<void> {
    this.calls.push(`connect:${id}`);
  }

  async disconnect(id: string): Promise<void> {
    this.calls.push(`disconnect:${id}`);
    this.states.set(id, { state: 'disabled' });
  }

  async restart(id: string): Promise<void> {
    this.calls.push(`restart:${id}`);
  }

  async refreshTools(id: string): Promise<void> {
    this.calls.push(`refresh:${id}`);
  }

  async test(id: string, options: { timeoutMs: number }): Promise<{ tools: unknown[] }> {
    this.calls.push(`test:${id}:${options.timeoutMs}`);
    this.onTest?.();
    if (this.testError !== null) throw this.testError;
    if (this.testPending) return new Promise<never>(() => {});
    return this.testResult;
  }

  async retire(
    id: string,
    options: { force: boolean },
  ): Promise<{ drained: boolean; inFlight?: number }> {
    this.calls.push(`retire:${id}:${options.force}`);
    return this.retireResult;
  }
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function testEnv(): {
  db: DatabaseSync;
  serverStore: SqliteServerStore;
  toolStore: SqliteToolStore;
  settingsStore: SqliteSettingsStore;
  pool: FakePool;
} {
  const db = createDb();
  return {
    db,
    serverStore: new SqliteServerStore(db),
    toolStore: new SqliteToolStore(db),
    settingsStore: new SqliteSettingsStore(db),
    pool: new FakePool(),
  };
}

async function addServer(
  store: ServerStore,
  overrides: Partial<ServerConfig> & { id: string },
): Promise<ServerRecord> {
  const config: ServerConfig = {
    label: overrides.id,
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: {},
    cwd: null,
    url: null,
    headers: {},
    enabled: true,
    connectMode: 'lazy',
    summary: null,
    summarySource: null,
    category: null,
    tags: [],
    timeoutMs: 60_000,
    maxConcurrency: 8,
    ...overrides,
  };
  const { server } = await store.create(config);
  return server;
}

function seedTool(db: DatabaseSync, tool: Partial<ToolRecord> & { serverId: string; name: string }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tools (server_id, name, display_name, description, description_override,
       enabled, concurrency, type, tags_json, category, schema_json, stale, stale_override,
       first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tool.serverId,
    tool.name,
    tool.displayName ?? null,
    tool.description ?? null,
    tool.descriptionOverride ?? null,
    tool.enabled === false ? 0 : 1,
    tool.concurrency ?? 'parallel',
    tool.type ?? null,
    JSON.stringify(tool.tags ?? []),
    tool.category ?? null,
    JSON.stringify(tool.schema ?? { type: 'object', properties: {} }),
    tool.stale === true ? 1 : 0,
    tool.staleOverride === true ? 1 : 0,
    now,
    now,
  );
}

function makeRequest(
  method: string,
  path: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
    ifMatch?: number;
    query?: Record<string, string>;
  } = {},
): AdminRequest {
  const headers: Record<string, string> = { ...options.headers };
  if (options.ifMatch !== undefined) headers['if-match'] = String(options.ifMatch);
  const request: AdminRequest = { method, path, headers };
  if (options.body !== undefined) request.body = options.body;
  if (options.query !== undefined) request.query = options.query;
  return request;
}

async function call(handler: AdminHandler, request: AdminRequest): Promise<AdminResponse> {
  const response = await handler(request);
  assert.ok(response !== null, `expected ${request.method} ${request.path} to be handled`);
  return response;
}

function bodyOf(response: AdminResponse): Record<string, unknown> {
  assert.equal(typeof response.body, 'object');
  assert.ok(response.body !== null);
  return response.body as Record<string, unknown>;
}

function errorCode(response: AdminResponse): string {
  const error = bodyOf(response)['error'];
  assert.ok(typeof error === 'object' && error !== null);
  return String((error as Record<string, unknown>)['code']);
}

function createServerHandler(env: ReturnType<typeof testEnv>, secrets?: AdminSecrets): AdminHandler {
  return createAdminServersHandler({
    servers: env.serverStore,
    pool: env.pool,
    ...(secrets === undefined ? {} : { secrets }),
    testTimeoutMs: 50,
  });
}

// ---------------------------------------------------------------------------
// Servers CRUD
// ---------------------------------------------------------------------------

test('GET /servers lists records with runtime state; unknown routes yield null', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);

  const empty = await call(handler, makeRequest('GET', '/admin/api/servers'));
  assert.equal(empty.status, 200);
  assert.deepEqual(bodyOf(empty), { servers: [], revision: 1 });

  const viaApiPrefix = await call(handler, makeRequest('GET', '/api/servers'));
  assert.equal(viaApiPrefix.status, 200);

  assert.equal(await handler(makeRequest('GET', '/admin/api/other')), null);
  assert.equal(await handler(makeRequest('PUT', '/servers')), null);

  await addServer(env.serverStore, { id: 'pg' });
  env.pool.states.set('pg', { state: 'ready', pid: 42 });

  const listed = await call(handler, makeRequest('GET', '/servers'));
  assert.equal(listed.status, 200);
  const servers = bodyOf(listed)['servers'];
  assert.ok(Array.isArray(servers));
  assert.equal(servers.length, 1);
  const server = servers[0] as Record<string, unknown>;
  assert.equal(server['id'], 'pg');
  assert.equal(server['state'], 'ready');
});

test('POST /servers resolves envKeys/headerKeys to $secret references', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);

  const response = await call(
    handler,
    makeRequest('POST', '/servers', {
      body: {
        id: 'pg',
        command: 'npx',
        args: ['-y', '@mcp/pg'],
        envKeys: ['DATABASE_URL'],
        headerKeys: ['Authorization'],
        tags: ['db', 'db', 'sql'],
        summary: 'database',
      },
    }),
  );

  assert.equal(response.status, 201);
  const body = bodyOf(response);
  assert.equal(body['revision'], 2);
  const server = body['server'] as Record<string, unknown>;
  assert.equal(server['id'], 'pg');
  assert.equal(server['state'], 'idle');
  assert.deepEqual(server['envKeys'], ['DATABASE_URL']);
  assert.deepEqual(server['headerKeys'], ['Authorization']);
  assert.equal('env' in server, false);
  assert.equal('headers' in server, false);
  assert.deepEqual(server['tags'], ['db', 'sql']);
  assert.equal(JSON.stringify(body).includes('"value"'), false);

  const duplicate = await call(
    handler,
    makeRequest('POST', '/servers', { body: { id: 'pg', command: 'npx' } }),
  );
  assert.equal(duplicate.status, 409);
  assert.equal(errorCode(duplicate), 'SERVER_EXISTS');
});

test('POST /servers defaults connectMode to eager; stored lazy rows stay lazy', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);

  // The discovery page registers servers without a connectMode field.
  const created = await call(
    handler,
    makeRequest('POST', '/servers', { body: { id: 'fresh', command: 'npx' } }),
  );
  assert.equal(created.status, 201);
  const createdServer = bodyOf(created)['server'] as Record<string, unknown>;
  assert.equal(createdServer['connectMode'], 'eager');
  const stored = env.db.prepare('SELECT connect_mode FROM servers WHERE id = ?').get('fresh');
  assert.equal(String(stored?.['connect_mode']), 'eager');

  // A row written before this default stays lazy; no migration rewrites it.
  await addServer(env.serverStore, { id: 'legacy', connectMode: 'lazy' });
  const listed = await call(handler, makeRequest('GET', '/servers'));
  assert.equal(listed.status, 200);
  const legacy = (bodyOf(listed)['servers'] as Array<Record<string, unknown>>).find(
    (entry) => entry['id'] === 'legacy',
  );
  assert.equal(legacy?.['connectMode'], 'lazy');

  const patched = await call(
    handler,
    makeRequest('PATCH', '/servers/legacy', {
      body: { label: 'Renamed' },
      ifMatch: await env.serverStore.revision(),
    }),
  );
  assert.equal(patched.status, 200);
  assert.equal((bodyOf(patched)['server'] as Record<string, unknown>)['connectMode'], 'lazy');
});

test('POST /servers validates transport configuration and unknown fields', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);

  const reserved = await call(
    handler,
    makeRequest('POST', '/servers', { body: { id: '__official__', command: 'x' } }),
  );
  assert.equal(reserved.status, 422);
  assert.equal(errorCode(reserved), 'BUILTIN_RESERVED');

  const missingCommand = await call(
    handler,
    makeRequest('POST', '/servers', { body: { id: 'broken' } }),
  );
  assert.equal(missingCommand.status, 422);
  assert.equal(errorCode(missingCommand), 'INVALID_CONFIG');

  const unknown = await call(
    handler,
    makeRequest('POST', '/servers', { body: { id: 'x', command: 'npx', wat: true } }),
  );
  assert.equal(unknown.status, 400);
  assert.equal(errorCode(unknown), 'UNKNOWN_FIELD');

  const invalidJson = await call(
    handler,
    makeRequest('POST', '/servers', { body: '{"id":' }),
  );
  assert.equal(invalidJson.status, 400);
  assert.equal(errorCode(invalidJson), 'INVALID_JSON');

  const credentials = await call(
    handler,
    makeRequest('POST', '/servers', {
      body: { id: 'remote', transport: 'http', url: 'https://user:pass@example.com/mcp' },
    }),
  );
  assert.equal(credentials.status, 422);
  assert.equal(errorCode(credentials), 'URL_HAS_CREDENTIALS');

  const argsOnHttp = await call(
    handler,
    makeRequest('POST', '/servers', {
      body: { id: 'remote', transport: 'http', url: 'https://example.com/mcp', args: ['x'] },
    }),
  );
  assert.equal(argsOnHttp.status, 422);
  assert.equal(errorCode(argsOnHttp), 'INVALID_CONFIG');

  const httpOk = await call(
    handler,
    makeRequest('POST', '/servers', {
      body: { id: 'remote', transport: 'http', url: 'https://example.com/mcp' },
    }),
  );
  assert.equal(httpOk.status, 201);
});

test('PATCH /servers/:id requires If-Match and a non-empty, coherent patch', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);
  await addServer(env.serverStore, { id: 'pg', command: 'npx', env: { DB: 'literal' } });
  const revision = await env.serverStore.revision();

  const noMatch = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', { body: { label: 'PG' } }),
  );
  assert.equal(noMatch.status, 400);
  assert.equal(errorCode(noMatch), 'IF_MATCH_REQUIRED');

  const badMatch = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', {
      body: { label: 'PG' },
      headers: { 'if-match': 'abc' },
    }),
  );
  assert.equal(badMatch.status, 400);
  assert.equal(errorCode(badMatch), 'INVALID_IF_MATCH');

  const stale = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', { body: { label: 'PG' }, ifMatch: revision + 10 }),
  );
  assert.equal(stale.status, 409);
  assert.equal(errorCode(stale), 'REVISION_CONFLICT');

  const empty = await call(handler, makeRequest('PATCH', '/servers/pg', { body: {}, ifMatch: revision }));
  assert.equal(empty.status, 422);
  assert.equal(errorCode(empty), 'EMPTY_PATCH');

  const transport = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', { body: { transport: 'http' }, ifMatch: revision }),
  );
  assert.equal(transport.status, 422);
  assert.equal(errorCode(transport), 'TRANSPORT_IMMUTABLE');

  const ok = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', {
      body: { label: 'PostgreSQL', enabled: false, tags: ['sql'], envKeys: ['DATABASE_URL'] },
      ifMatch: revision,
    }),
  );
  assert.equal(ok.status, 200);
  const body = bodyOf(ok);
  assert.equal(body['revision'], revision + 1);
  const server = body['server'] as Record<string, unknown>;
  assert.equal(server['label'], 'PostgreSQL');
  assert.equal(server['enabled'], false);
  assert.equal(server['state'], 'disabled');
  assert.deepEqual(server['envKeys'], ['DATABASE_URL', 'DB']);

  const missing = await call(
    handler,
    makeRequest('PATCH', '/servers/nope', { body: { label: 'x' }, ifMatch: revision + 1 }),
  );
  assert.equal(missing.status, 404);
  assert.equal(errorCode(missing), 'SERVER_NOT_FOUND');
});

test('PATCH enabled=false disconnects the server and reports it disabled', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);
  await addServer(env.serverStore, { id: 'pg' });
  env.pool.states.set('pg', { state: 'ready', pid: 42 });
  const revision = await env.serverStore.revision();

  const response = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', { body: { enabled: false }, ifMatch: revision }),
  );

  assert.equal(response.status, 200);
  const server = bodyOf(response)['server'] as Record<string, unknown>;
  assert.equal(server['enabled'], false);
  assert.equal(server['state'], 'disabled');
  assert.ok(env.pool.calls.includes('disconnect:pg'));
});

test('PATCH enabled=false on a builtin server never disconnects', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);
  await addServer(env.serverStore, { id: '__builtin__', transport: 'builtin', command: null });
  const revision = await env.serverStore.revision();

  const response = await call(
    handler,
    makeRequest('PATCH', '/servers/__builtin__', { body: { enabled: false }, ifMatch: revision }),
  );

  assert.equal(response.status, 200);
  const server = bodyOf(response)['server'] as Record<string, unknown>;
  assert.equal(server['enabled'], false);
  assert.equal(env.pool.calls.some((entry) => entry.startsWith('disconnect:')), false);
});

test('PATCH summary moves summary_source and clearing it removes the source', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);
  await addServer(env.serverStore, { id: 'pg', summary: 'ai draft', summarySource: 'ai' });

  const revision = await env.serverStore.revision();
  const edited = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', {
      body: { summary: '人工摘要' },
      ifMatch: revision,
    }),
  );
  assert.equal(edited.status, 200);
  const editedServer = bodyOf(edited)['server'] as Record<string, unknown>;
  assert.equal(editedServer['summary'], '人工摘要');
  assert.equal(editedServer['summarySource'], 'manual');
  assert.equal((await env.serverStore.get('pg'))?.summarySource, 'manual');

  const cleared = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', {
      body: { summary: null },
      ifMatch: await env.serverStore.revision(),
    }),
  );
  assert.equal(cleared.status, 200);
  const clearedServer = bodyOf(cleared)['server'] as Record<string, unknown>;
  assert.equal(clearedServer['summary'], null);
  assert.equal(clearedServer['summarySource'], null);
});

test('PATCH with an unchanged summary keeps its source', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);
  await addServer(env.serverStore, { id: 'pg', summary: 'ai draft', summarySource: 'ai' });

  const revision = await env.serverStore.revision();
  const edited = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', {
      // The manage UI sends every field on save; the summary is unchanged here.
      body: { label: 'PostgreSQL', summary: 'ai draft' },
      ifMatch: revision,
    }),
  );
  assert.equal(edited.status, 200);
  const editedServer = bodyOf(edited)['server'] as Record<string, unknown>;
  assert.equal(editedServer['summary'], 'ai draft');
  assert.equal(editedServer['summarySource'], 'ai');
  assert.equal((await env.serverStore.get('pg'))?.summarySource, 'ai');

  const changed = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', {
      body: { summary: 'ai draft v2' },
      ifMatch: await env.serverStore.revision(),
    }),
  );
  assert.equal(changed.status, 200);
  assert.equal((await env.serverStore.get('pg'))?.summarySource, 'manual');
});

test('POST /servers stores blank summaries as null without a source', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);

  const blank = await call(
    handler,
    makeRequest('POST', '/servers', {
      body: { id: 'blank', command: 'npx', summary: '   ' },
    }),
  );
  assert.equal(blank.status, 201);
  const blankServer = bodyOf(blank)['server'] as Record<string, unknown>;
  assert.equal(blankServer['summary'], null);
  assert.equal(blankServer['summarySource'], null);

  const empty = await call(
    handler,
    makeRequest('POST', '/servers', {
      body: { id: 'empty', command: 'npx', summary: '' },
    }),
  );
  assert.equal(empty.status, 201);
  assert.equal((bodyOf(empty)['server'] as Record<string, unknown>)['summary'], null);

  const nonBlank = await call(
    handler,
    makeRequest('POST', '/servers', {
      body: { id: 'real', command: 'npx', summary: '真实摘要' },
    }),
  );
  assert.equal(nonBlank.status, 201);
  const realServer = bodyOf(nonBlank)['server'] as Record<string, unknown>;
  assert.equal(realServer['summary'], '真实摘要');
  assert.equal(realServer['summarySource'], 'manual');
});

test('PATCH normalizes blank summaries to null and clears the source', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);
  await addServer(env.serverStore, { id: 'pg', summary: 'ai draft', summarySource: 'ai' });

  const blank = await call(
    handler,
    makeRequest('PATCH', '/servers/pg', {
      body: { summary: '   ' },
      ifMatch: await env.serverStore.revision(),
    }),
  );
  assert.equal(blank.status, 200);
  const blankServer = bodyOf(blank)['server'] as Record<string, unknown>;
  assert.equal(blankServer['summary'], null);
  assert.equal(blankServer['summarySource'], null);
  assert.equal((await env.serverStore.get('pg'))?.summary, null);
  assert.equal((await env.serverStore.get('pg'))?.summarySource, null);

  await addServer(env.serverStore, { id: 'plain', summary: 'human', summarySource: 'manual' });
  const empty = await call(
    handler,
    makeRequest('PATCH', '/servers/plain', {
      body: { summary: '' },
      ifMatch: await env.serverStore.revision(),
    }),
  );
  assert.equal(empty.status, 200);
  assert.equal((await env.serverStore.get('plain'))?.summary, null);
  assert.equal((await env.serverStore.get('plain'))?.summarySource, null);
});

test('refresh and restart notify onToolsRefreshed after the pool settles', async () => {
  const env = testEnv();
  await addServer(env.serverStore, { id: 'pg' });
  const operations = createOperationLauncher();
  const refreshed: string[] = [];
  const handler = createAdminServersHandler({
    servers: env.serverStore,
    pool: env.pool,
    operations,
    onToolsRefreshed: (id) => {
      refreshed.push(id);
    },
  });

  async function waitForOperation(operationId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const operation = operations.get?.(operationId);
      if (operation?.state !== 'running') return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`operation ${operationId} never settled`);
  }

  const refresh = await call(handler, makeRequest('POST', '/servers/pg/tools/refresh'));
  assert.equal(refresh.status, 202);
  await waitForOperation(String(bodyOf(refresh)['operationId']));
  assert.deepEqual(refreshed, ['pg']);

  const restart = await call(handler, makeRequest('POST', '/servers/pg/restart'));
  assert.equal(restart.status, 202);
  await waitForOperation(String(bodyOf(restart)['operationId']));
  assert.deepEqual(refreshed, ['pg', 'pg']);

  const connect = await call(handler, makeRequest('POST', '/servers/pg/connect'));
  await waitForOperation(String(bodyOf(connect)['operationId']));
  assert.deepEqual(refreshed, ['pg', 'pg'], 'plain connect must not re-trigger AI');
});

test('seeded builtin servers can only change display metadata', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);
  await addServer(env.serverStore, { id: '__official__', transport: 'builtin', command: null });

  const revision = await env.serverStore.revision();
  const label = await call(
    handler,
    makeRequest('PATCH', '/servers/__official__', { body: { label: 'Official' }, ifMatch: revision }),
  );
  assert.equal(label.status, 200);

  const command = await call(
    handler,
    makeRequest('PATCH', '/servers/__official__', {
      body: { command: 'rm' },
      ifMatch: revision + 1,
    }),
  );
  assert.equal(command.status, 422);
  assert.equal(errorCode(command), 'BUILTIN_RESERVED');

  const deletion = await call(
    handler,
    makeRequest('DELETE', '/servers/__official__', { ifMatch: revision + 1 }),
  );
  assert.equal(deletion.status, 422);
  assert.equal(errorCode(deletion), 'BUILTIN_RESERVED');
});

test('DELETE /servers/:id drains by default, refuses busy servers and honours force', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);
  await addServer(env.serverStore, { id: 'pg' });
  const revision = await env.serverStore.revision();

  env.pool.retireResult = { drained: false, inFlight: 2 };
  const busy = await call(
    handler,
    makeRequest('DELETE', '/servers/pg', { ifMatch: revision }),
  );
  assert.equal(busy.status, 409);
  assert.equal(errorCode(busy), 'SERVER_BUSY');
  assert.ok(await env.serverStore.get('pg') !== null);

  const forced = await call(
    handler,
    makeRequest('DELETE', '/servers/pg?force=true', { ifMatch: revision }),
  );
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.ok(env.pool.calls.includes('retire:pg:true'));
  assert.equal(await env.serverStore.get('pg'), null);

  await addServer(env.serverStore, { id: 'fs' });
  const nextRevision = await env.serverStore.revision();
  env.pool.retireResult = { drained: true };
  const drained = await call(
    handler,
    makeRequest('DELETE', '/admin/api/servers/fs', { ifMatch: nextRevision }),
  );
  assert.equal(drained.status, 200);
  assert.ok(env.pool.calls.includes('retire:fs:false'));

  const badForce = await call(
    handler,
    makeRequest('DELETE', '/servers/nope?force=maybe', { ifMatch: nextRevision + 1 }),
  );
  assert.equal(badForce.status, 400);
  assert.equal(errorCode(badForce), 'INVALID_QUERY');
});

// ---------------------------------------------------------------------------
// Connection control and test endpoint
// ---------------------------------------------------------------------------

test('connect/disconnect/restart/refresh return 202 operations', async () => {
  const env = testEnv();
  const handler = createServerHandler(env);
  await addServer(env.serverStore, { id: 'pg' });
  await addServer(env.serverStore, { id: 'off', enabled: false });
  await addServer(env.serverStore, { id: '__builtin__', transport: 'builtin', command: null });

  for (const action of ['connect', 'disconnect', 'restart']) {
    const response = await call(handler, makeRequest('POST', `/servers/pg/${action}`));
    assert.equal(response.status, 202);
    const body = bodyOf(response);
    assert.equal(body['kind'], action);
    assert.equal(body['target'], 'pg');
    assert.equal(body['state'], 'running');
    assert.match(String(body['operationId']), /^op_[0-9a-f]{32}$/);
  }
  assert.ok(env.pool.calls.includes('connect:pg'));
  assert.ok(env.pool.calls.includes('disconnect:pg'));
  assert.ok(env.pool.calls.includes('restart:pg'));

  const disabled = await call(handler, makeRequest('POST', '/servers/off/connect'));
  assert.equal(disabled.status, 409);
  assert.equal(errorCode(disabled), 'SERVER_DISABLED');

  const builtin = await call(handler, makeRequest('POST', '/servers/__builtin__/connect'));
  assert.equal(builtin.status, 422);
  assert.equal(errorCode(builtin), 'NOT_CONNECTABLE');

  const refresh = await call(handler, makeRequest('POST', '/servers/pg/tools/refresh'));
  assert.equal(refresh.status, 202);
  assert.equal(bodyOf(refresh)['kind'], 'tools_refresh');
  assert.ok(env.pool.calls.includes('refresh:pg'));

  const missing = await call(handler, makeRequest('POST', '/servers/nope/restart'));
  assert.equal(missing.status, 404);
});

test('POST /servers/:id/test maps missing secrets, success and runtime failures', async () => {
  const env = testEnv();
  await addServer(env.serverStore, {
    id: 'github',
    command: 'npx',
    env: { GITHUB_TOKEN: { $secret: 'GITHUB_TOKEN' } },
  });
  await addServer(env.serverStore, { id: 'plain', command: 'npx' });

  const missingSecrets: AdminSecrets = {
    missing: (names) => names.filter((name) => name !== 'OTHER_TOKEN'),
  };
  const handler = createServerHandler(env, missingSecrets);

  const missing = await call(handler, makeRequest('POST', '/servers/github/test'));
  assert.equal(missing.status, 422);
  assert.equal(errorCode(missing), 'MISSING_SECRETS');
  const missingBody = bodyOf(missing);
  assert.deepEqual(missingBody['missingSecrets'], ['GITHUB_TOKEN']);
  const details = (missingBody['error'] as Record<string, unknown>)['details'];
  assert.deepEqual(details, { missingSecrets: ['GITHUB_TOKEN'] });
  assert.equal(env.pool.calls.some((entry) => entry.startsWith('test:')), false);

  const allPresent = createServerHandler(env, { missing: () => [] });
  let now = 1000;
  env.pool.onTest = () => {
    now = 1025;
  };
  const clockHandler = createAdminServersHandler({
    servers: env.serverStore,
    pool: env.pool,
    secrets: { missing: () => [] },
    clock: { now: () => now },
    testTimeoutMs: 50,
  });
  const ok = await call(clockHandler, makeRequest('POST', '/servers/plain/test'));
  assert.equal(ok.status, 200);
  assert.deepEqual(bodyOf(ok), {
    ok: true,
    tools: [{ name: 'query' }],
    count: 1,
    elapsedMs: 25,
  });

  env.pool.testError = new Error('connection refused');
  const failed = await call(allPresent, makeRequest('POST', '/servers/plain/test'));
  assert.equal(failed.status, 503);
  assert.equal(errorCode(failed), 'SERVER_UNAVAILABLE');

  env.pool.testError = null;
  env.pool.testPending = true;
  const timedOut = await call(allPresent, makeRequest('POST', '/servers/plain/test'));
  assert.equal(timedOut.status, 503);
  assert.equal(errorCode(timedOut), 'RUNTIME_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

test('GET /servers/:id/tools returns raw plus effective values', async () => {
  const env = testEnv();
  await addServer(env.serverStore, { id: 'pg', tags: ['db', 'sql'], category: 'database' });
  seedTool(env.db, {
    serverId: 'pg',
    name: 'query',
    description: 'upstream description',
    descriptionOverride: 'admin description',
    tags: ['read'],
    type: 'query',
  });

  const handler = createAdminToolsHandler({
    servers: env.serverStore,
    tools: env.toolStore,
    retrieval: { search: () => ({ results: [] }) },
  });

  const response = await call(handler, makeRequest('GET', '/servers/pg/tools'));
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body['revision'], await env.serverStore.revision());
  const tools = body['tools'] as Record<string, unknown>[];
  assert.equal(tools.length, 1);
  const tool = tools[0]!;
  assert.equal(tool['description'], 'upstream description');
  assert.equal(tool['descriptionOverride'], 'admin description');
  const effective = tool['effective'] as Record<string, unknown>;
  assert.equal(effective['description'], 'admin description');
  assert.deepEqual(effective['tags'], ['db', 'sql', 'read']);
  assert.equal(effective['category'], 'database');
  assert.equal(effective['exposed'], true);

  const missing = await call(handler, makeRequest('GET', '/servers/nope/tools'));
  assert.equal(missing.status, 404);
});

test('PATCH /tools/:serverId/:name writes the description override with If-Match', async () => {
  const env = testEnv();
  await addServer(env.serverStore, { id: 'pg' });
  seedTool(env.db, {
    serverId: 'pg',
    name: 'query',
    description: 'upstream',
    enabled: true,
  });

  const handler = createAdminToolsHandler({
    servers: env.serverStore,
    tools: env.toolStore,
    retrieval: { search: () => ({ results: [] }) },
  });

  const revision = await env.serverStore.revision();

  const noMatch = await call(
    handler,
    makeRequest('PATCH', '/tools/pg/query', { body: { description: 'x' } }),
  );
  assert.equal(noMatch.status, 400);
  assert.equal(errorCode(noMatch), 'IF_MATCH_REQUIRED');

  const stale = await call(
    handler,
    makeRequest('PATCH', '/tools/pg/query', {
      body: { description: 'x' },
      ifMatch: revision + 10,
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(errorCode(stale), 'REVISION_CONFLICT');

  const invalid = await call(
    handler,
    makeRequest('PATCH', '/tools/pg/query', {
      body: { concurrency: 'sometimes' },
      ifMatch: revision,
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal(errorCode(invalid), 'INVALID_FIELD');

  const ok = await call(
    handler,
    makeRequest('PATCH', '/tools/pg/query', {
      body: {
        description: 'Read-only SQL.',
        enabled: false,
        concurrency: 'serial',
        tags: ['read'],
        type: 'query',
        category: 'database',
        staleOverride: true,
      },
      ifMatch: revision,
    }),
  );
  assert.equal(ok.status, 200);
  const body = bodyOf(ok);
  assert.equal(body['revision'], revision + 1);
  const tool = body['tool'] as Record<string, unknown>;
  assert.equal(tool['description'], 'upstream');
  assert.equal(tool['descriptionOverride'], 'Read-only SQL.');
  assert.equal(tool['concurrency'], 'serial');
  assert.deepEqual(tool['tags'], ['read']);

  const unknownTool = await call(
    handler,
    makeRequest('PATCH', '/tools/pg/nope', {
      body: { enabled: true },
      ifMatch: revision + 1,
    }),
  );
  assert.equal(unknownTool.status, 404);
  assert.equal(errorCode(unknownTool), 'TOOL_NOT_FOUND');
});

test('POST /tools/batch is one transaction and one revision', async () => {
  const env = testEnv();
  await addServer(env.serverStore, { id: 'pg' });
  seedTool(env.db, { serverId: 'pg', name: 'query' });
  seedTool(env.db, { serverId: 'pg', name: 'insert' });

  const handler = createAdminToolsHandler({
    servers: env.serverStore,
    tools: env.toolStore,
    retrieval: { search: () => ({ results: [] }) },
  });
  const revision = await env.serverStore.revision();

  const response = await call(
    handler,
    makeRequest('POST', '/tools/batch', {
      body: {
        updates: [
          { serverId: 'pg', name: 'query', patch: { enabled: false } },
          { serverId: 'pg', name: 'insert', patch: { tags: ['write'] } },
        ],
      },
      ifMatch: revision,
    }),
  );
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body['revision'], revision + 1);
  assert.equal((body['tools'] as unknown[]).length, 2);

  const query = await env.toolStore.get('pg', 'query');
  assert.equal(query?.enabled, false);
  const insert = await env.toolStore.get('pg', 'insert');
  assert.deepEqual(insert?.tags, ['write']);

  const duplicate = await call(
    handler,
    makeRequest('POST', '/tools/batch', {
      body: {
        updates: [
          { serverId: 'pg', name: 'query', patch: { enabled: true } },
          { serverId: 'pg', name: 'query', patch: { enabled: false } },
        ],
      },
      ifMatch: revision + 1,
    }),
  );
  assert.equal(duplicate.status, 422);
  assert.equal(errorCode(duplicate), 'DUPLICATE_UPDATE');

  const unknown = await call(
    handler,
    makeRequest('POST', '/tools/batch', {
      body: { updates: [{ serverId: 'pg', name: 'nope', patch: { enabled: true } }] },
      ifMatch: revision + 1,
    }),
  );
  assert.equal(unknown.status, 404);
  assert.equal(await env.toolStore.revision(), revision + 1);
});

test('GET /search forwards filters and binding to the retriever', async () => {
  const env = testEnv();
  await addServer(env.serverStore, { id: 'pg' });
  const calls: SearchPreviewInput[] = [];
  const handler = createAdminToolsHandler({
    servers: env.serverStore,
    tools: env.toolStore,
    retrieval: {
      search: (input) => {
        calls.push(input);
        return { results: [{ name: 'pg.query' }], notice: 'visibility filtered' };
      },
    },
  });

  const response = await call(
    handler,
    makeRequest('GET', '/search', {
      query: { q: 'sql query', server: 'pg', category: 'database', tag: 'db', type: 'query', max: '5', binding: 'cb_1' },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      query: 'sql query',
      server: 'pg',
      category: 'database',
      tag: 'db',
      type: 'query',
      max: 5,
      bindingId: 'cb_1',
    },
  ]);
  const body = bodyOf(response);
  assert.equal(body['count'], 1);
  assert.equal(body['binding'], 'cb_1');
  assert.equal(body['notice'], 'visibility filtered');

  const bad = await call(handler, makeRequest('GET', '/search', { query: { max: '500' } }));
  assert.equal(bad.status, 400);
  assert.equal(errorCode(bad), 'INVALID_QUERY');
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('GET/PATCH /settings validates capacity and bumps the revision', async () => {
  const env = testEnv();
  // A setting the admin API does not know must survive a PATCH.
  env.db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run('logLevel', JSON.stringify('debug'));
  const handler = createAdminSettingsHandler({ settings: env.settingsStore });

  const initial = await call(handler, makeRequest('GET', '/admin/api/settings'));
  assert.equal(initial.status, 200);
  const initialBody = bodyOf(initial);
  assert.equal(initialBody['revision'], 1);
  assert.deepEqual((initialBody['settings'] as RuntimeSettings).capacity, DEFAULT_CAPACITY);
  assert.equal((initialBody['settings'] as RuntimeSettings).strictAuth, false);
  assert.equal((initialBody['settings'] as Record<string, unknown>)['logLevel'], 'debug');

  const noMatch = await call(
    handler,
    makeRequest('PATCH', '/settings', { body: { strictAuth: true } }),
  );
  assert.equal(noMatch.status, 400);

  const stale = await call(
    handler,
    makeRequest('PATCH', '/settings', { body: { strictAuth: true }, ifMatch: 7 }),
  );
  assert.equal(stale.status, 409);

  const unknown = await call(
    handler,
    makeRequest('PATCH', '/settings', { body: { logLevel: 'debug' }, ifMatch: 1 }),
  );
  assert.equal(unknown.status, 422);
  assert.equal(errorCode(unknown), 'UNKNOWN_SETTING');

  const unknownCapacity = await call(
    handler,
    makeRequest('PATCH', '/settings', {
      body: { capacity: { maxExexSessions: 4 } },
      ifMatch: 1,
    }),
  );
  assert.equal(unknownCapacity.status, 422);
  assert.equal(errorCode(unknownCapacity), 'UNKNOWN_SETTING');

  const badValue = await call(
    handler,
    makeRequest('PATCH', '/settings', {
      body: { capacity: { maxExecSessions: 0 } },
      ifMatch: 1,
    }),
  );
  assert.equal(badValue.status, 422);
  assert.equal(errorCode(badValue), 'INVALID_CAPACITY');

  const relation = await call(
    handler,
    makeRequest('PATCH', '/settings', {
      body: { capacity: { maxServeProcesses: 2 } },
      ifMatch: 1,
    }),
  );
  assert.equal(relation.status, 422);
  assert.equal(errorCode(relation), 'INVALID_CAPACITY');

  const ok = await call(
    handler,
    makeRequest('PATCH', '/settings', {
      body: { capacity: { maxExecSessions: 4, maxServeProcesses: 4 }, strictAuth: true },
      ifMatch: 1,
    }),
  );
  assert.equal(ok.status, 200);
  const body = bodyOf(ok);
  assert.equal(body['revision'], 2);
  const settings = body['settings'] as RuntimeSettings;
  assert.equal(settings.capacity.maxExecSessions, 4);
  assert.equal(settings.capacity.maxServeProcesses, 4);
  assert.equal(settings.capacity.maxWorkers, DEFAULT_CAPACITY.maxWorkers);
  assert.equal(settings.strictAuth, true);

  const persisted = await call(handler, makeRequest('GET', '/settings'));
  assert.deepEqual((bodyOf(persisted)['settings'] as RuntimeSettings), settings);

  const wrongType = await call(
    handler,
    makeRequest('PATCH', '/settings', { body: { strictAuth: 'yes' }, ifMatch: 2 }),
  );
  assert.equal(wrongType.status, 400);
  assert.equal(errorCode(wrongType), 'INVALID_FIELD');
});

test('PATCH /settings applies committed capacity through onSettingsChanged', async () => {
  const env = testEnv();
  const applied: CapacitySettings[] = [];
  const handler = createAdminSettingsHandler({
    settings: env.settingsStore,
    onSettingsChanged: (capacity) => {
      applied.push(capacity);
    },
  });

  const updated = await call(
    handler,
    makeRequest('PATCH', '/settings', {
      body: { capacity: { maxExecSessions: 4, maxServeProcesses: 4 } },
      ifMatch: 1,
    }),
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(applied, [
    { ...DEFAULT_CAPACITY, maxExecSessions: 4, maxServeProcesses: 4 },
  ]);

  // The relation check still rejects before anything is persisted or applied.
  const relation = await call(
    handler,
    makeRequest('PATCH', '/settings', {
      body: { capacity: { maxServeProcesses: 2 } },
      ifMatch: 2,
    }),
  );
  assert.equal(relation.status, 422);
  assert.equal(errorCode(relation), 'INVALID_CAPACITY');
  assert.equal(applied.length, 1);
});

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

test('POST /discover returns the fixed list, marks existing commands and never leaks values', async () => {
  const home = await mkdtemp(join(tmpdir(), 'repl-discover-'));
  const workspace = join(home, 'workspace');
  try {
    await mkdir(join(home, '.cursor'), { recursive: true });
    await mkdir(join(home, '.kiro', 'settings'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          claude_http: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer secret-header' },
          },
        },
      }),
    );
    await writeFile(
      join(home, '.kiro', 'settings', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          kiro_fs: { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: 'secret-env' } },
        },
      }),
    );
    await writeFile(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', env: { TOKEN: 'super-secret-value' } },
        },
      }),
    );
    await writeFile(join(home, '.pgpass'), 'host:5432:db:user:password\n');

    const lookup = {
      list: () => [
        {
          id: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
        {
          id: 'fs',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/project'],
        },
        {
          id: 'other',
          transport: 'stdio',
          command: 'docker',
          args: [],
        },
        {
          id: 'remote',
          transport: 'http',
          command: null,
          args: [],
          url: 'https://example.test/mcp',
        },
      ],
    };
    const exec = new Map([
      ['gh', true],
      ['psql', false],
      ['npx', true],
    ]);

    const handler = createAdminDiscoverHandler({
      servers: lookup,
      homeDir: home,
      workspace,
      env: { PATH: '/usr/bin' },
      secrets: { has: (name) => name === 'GITHUB_TOKEN' },
      commandProbe: (command) => exec.get(command) ?? false,
    });

    assert.equal(await handler(makeRequest('GET', '/discover')), null);

    const response = await call(handler, makeRequest('POST', '/admin/api/discover'));
    assert.equal(response.status, 200);
    const body = bodyOf(response);
    const suggestions = body['suggestions'] as Record<string, unknown>[];
    assert.deepEqual(
      suggestions.map((item) => item['id']),
      ['claude_http', 'kiro_fs', 'fs-2', 'filesystem', 'github', 'postgres', 'sqlite', 'fetch'],
    );

    const byId = new Map(suggestions.map((item) => [String(item['id']), item]));
    const remote = byId.get('claude_http')!;
    assert.equal(remote['url'], 'https://example.test/mcp');
    assert.deepEqual(remote['headerKeys'], ['Authorization']);
    assert.equal(remote['alreadyExists'], true);

    const kiro = byId.get('kiro_fs')!;
    assert.match(String(kiro['reason']), /\.kiro/);
    assert.deepEqual(kiro['args'], ['-y', 'pkg']);
    assert.deepEqual(kiro['envKeys'], ['API_KEY']);

    // The id `fs` is already used by a different registered command, so the slug avoids it.
    const cursor = byId.get('fs-2')!;
    assert.match(String(cursor['reason']), /\.cursor/);
    assert.deepEqual(cursor['envKeys'], ['TOKEN']);
    assert.equal(cursor['alreadyExists'], false);

    assert.equal(byId.get('github')!['alreadyExists'], true);
    assert.deepEqual(byId.get('github')!['envKeys'], ['GITHUB_TOKEN']);
    assert.equal(byId.get('github')!['confidence'], 'high');

    assert.equal(byId.get('filesystem')!['alreadyExists'], true);
    assert.equal(byId.get('filesystem')!['confidence'], 'high');
    assert.deepEqual(byId.get('filesystem')!['args'], [
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '<workspace>',
    ]);

    assert.equal(byId.get('postgres')!['alreadyExists'], false);
    assert.equal(byId.get('postgres')!['confidence'], 'medium');
    assert.equal(byId.get('sqlite')!['confidence'], 'medium');

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('super-secret-value'), false);
    assert.equal(serialized.includes('secret-env'), false);
    assert.equal(serialized.includes('secret-header'), false);
    assert.equal(serialized.includes('password'), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('sameCommandLine normalizes whitespace and matches placeholders only positionally', () => {
  assert.equal(
    sameCommandLine(
      { command: ' npx ', args: ['-y', '  @scope/pkg  '] },
      { command: 'npx', args: ['-y', '@scope/pkg'] },
    ),
    true,
  );
  assert.equal(
    sameCommandLine(
      { command: 'npx', args: ['-y', '@x/filesystem', '<workspace>'] },
      { command: 'npx', args: ['-y', '@x/filesystem', '/repo'] },
    ),
    true,
  );
  assert.equal(
    sameCommandLine(
      { command: 'npx', args: ['-y', '@x/filesystem', '<workspace>'] },
      { command: 'npx', args: ['-y', '@x/filesystem'] },
    ),
    false,
  );
  assert.equal(
    sameCommandLine(
      { command: 'npx', args: ['-y', '@x/a'] },
      { command: 'node', args: ['-y', '@x/a'] },
    ),
    false,
  );
});
