import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { openStateDb } from '../src/db/migrate.ts';
import { DbSettingsStore } from '../src/assembly-stores.ts';
import { getRevision, getSetting, listSettings, patchSettings, setSetting } from '../src/db/meta.ts';
import {
  SEED_SERVER_IDS,
  createServer,
  deleteServer,
  getServer,
  updateServer,
} from '../src/db/servers.ts';
import { DbNotFoundError, DbValidationError } from '../src/db/schema.ts';
import {
  countToolsByServer,
  deleteTool,
  getTool,
  hashToolSchema,
  listTools,
  patchTool,
  upsertTool,
} from '../src/db/tools.ts';
import type { BindingQuota } from '../src/db/clients.ts';
import {
  WorkspaceError,
  createClientBinding,
  deleteClientBinding,
  findBindingByToken,
  getClientBinding,
  getClientToken,
  hashToken,
  listClientBindings,
  resolveWorkspacePath,
  rotateClientToken,
  touchBinding,
  updateClientBinding,
} from '../src/db/clients.ts';

interface Fixture {
  dir: string;
  file: string;
  db: DatabaseSync;
}

function fixture(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'repl-server-db-'));
  const file = join(dir, 'state.db');
  const db = openStateDb(file);
  t.after(() => {
    try {
      db.close();
    } catch {
      // the test closed it already
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, db };
}

function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params);
  return Number(row?.['n'] ?? 0);
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.['user_version'] ?? 0);
}

test('migration creates the current schema once and seeds the fixed servers', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-server-db-'));
  const file = join(dir, 'state.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = openStateDb(file);
  try {
    assert.equal(readUserVersion(first), 6);
    assert.equal(count(first, 'SELECT count(*) AS n FROM servers'), 2);
    const seeds = first
      .prepare('SELECT id, transport, category FROM servers ORDER BY id')
      .all()
      .map((row) => ({
        id: String(row['id']),
        transport: String(row['transport']),
        category: String(row['category']),
      }));
    assert.deepEqual(seeds, [
      { id: '__builtin__', transport: 'builtin', category: 'other' },
      { id: '__official__', transport: 'builtin', category: 'devtools' },
    ]);
    assert.equal(
      count(first, "SELECT count(*) AS n FROM meta WHERE key = 'revision' AND value = '0'"),
      1,
    );
    const triggers = first
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all()
      .map((row) => String(row['name']));
    assert.deepEqual(triggers, ['tools_ad', 'tools_ai', 'tools_au']);
    assert.ok(first.prepare("SELECT name FROM sqlite_master WHERE name = 'tools_fts'").get());
    assert.equal(first.prepare('PRAGMA journal_mode').get()?.['journal_mode'], 'wal');
    assert.equal(first.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'], 1);
  } finally {
    first.close();
  }

  assert.equal(statSync(file).mode & 0o777, 0o600);

  const second = openStateDb(file);
  try {
    assert.equal(readUserVersion(second), 6);
    assert.equal(count(second, 'SELECT count(*) AS n FROM servers'), 2);
    assert.equal(
      count(second, "SELECT count(*) AS n FROM meta WHERE key = 'schema_version'"),
      1,
    );
    assert.equal(getRevision(second), 0);
  } finally {
    second.close();
  }
});

test('V3 backfills untouched seed rows and preserves edited ones', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-server-db-'));
  const file = join(dir, 'state.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const v3 = openStateDb(file);
  // Roll the seed rows back to their V1 shape and mark the database as V2.
  v3.prepare(
    "UPDATE servers SET label = 'Official Claude Code tools', summary = NULL, category = NULL, tags_json = '[]' WHERE id = '__official__'",
  ).run();
  v3.prepare(
    "UPDATE servers SET label = 'Built-in composite tools', summary = NULL, category = NULL, tags_json = '[]' WHERE id = '__builtin__'",
  ).run();
  v3.prepare("UPDATE servers SET label = '自定义内置' WHERE id = '__builtin__'").run();
  v3.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  v3.exec('PRAGMA user_version = 2');
  v3.close();

  const upgraded = openStateDb(file);
  try {
    assert.equal(readUserVersion(upgraded), 6);
    const official = upgraded
      .prepare("SELECT label, category, tags_json FROM servers WHERE id = '__official__'")
      .get();
    assert.equal(official?.['label'], 'Claude Code 官方工具');
    assert.equal(official?.['category'], 'devtools');
    assert.equal(official?.['tags_json'], '["official"]');
    const builtin = upgraded
      .prepare("SELECT label, category FROM servers WHERE id = '__builtin__'")
      .get();
    assert.equal(builtin?.['label'], '自定义内置', 'an edited label is not overwritten');
    assert.equal(builtin?.['category'], null);
  } finally {
    upgraded.close();
  }
});

test('V3 backfills the new seed categories', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-server-db-'));
  const file = join(dir, 'state.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const v2 = openStateDb(file);
  v2.prepare(
    "UPDATE servers SET label = 'Official Claude Code tools', summary = NULL, category = NULL, tags_json = '[]' WHERE id = '__official__'",
  ).run();
  v2.prepare(
    "UPDATE servers SET label = 'Built-in composite tools', summary = NULL, category = NULL, tags_json = '[]' WHERE id = '__builtin__'",
  ).run();
  v2.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  v2.exec('PRAGMA user_version = 2');
  v2.close();

  const upgraded = openStateDb(file);
  try {
    const rows = upgraded
      .prepare("SELECT id, category FROM servers WHERE id IN ('__official__', '__builtin__') ORDER BY id")
      .all();
    assert.deepEqual(
      rows.map((row) => ({ id: String(row['id']), category: String(row['category']) })),
      [
        { id: '__builtin__', category: 'other' },
        { id: '__official__', category: 'devtools' },
      ],
    );
  } finally {
    upgraded.close();
  }
});

test('server writes bump meta.revision and servers.revision independently', (t) => {
  const { db } = fixture(t);

  const created = createServer(db, {
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio',
    command: 'npx',
  });
  assert.equal(created.revision, 1);
  assert.equal(created.server.revision, 1);
  assert.equal(getRevision(db), 1);

  const updated = updateServer(db, 'pg', { label: 'PG', summary: 'database — query' });
  assert.ok(updated);
  assert.equal(updated.revision, 2);
  assert.equal(updated.server.revision, 2);
  assert.equal(updated.server.summary, 'database — query');

  const other = createServer(db, {
    id: 'github',
    label: 'GitHub',
    transport: 'http',
    url: 'https://api.example.com/mcp',
  });
  assert.equal(other.revision, 3);
  assert.equal(other.server.revision, 1, 'servers.revision is per row');

  const toolWrite = upsertTool(db, 'pg', {
    name: 'query',
    description: 'Run SQL',
    inputSchema: { type: 'object' },
  });
  assert.equal(toolWrite.revision, 4);
  assert.equal(getServer(db, 'pg')?.revision, 2, 'tool writes must not bump servers.revision');

  const patched = patchTool(db, 'pg', 'query', { enabled: false, concurrency: 'serial' });
  assert.ok(patched);
  assert.equal(patched.revision, 5);
  assert.equal(patched.tool.enabled, false);
  assert.equal(patched.tool.concurrency, 'serial');

  const removed = deleteServer(db, 'github');
  assert.deepEqual(removed, { deleted: true, revision: 6 });
  assert.equal(getRevision(db), 6);
});

test('countToolsByServer aggregates total and enabled rows per server', (t) => {
  const { db } = fixture(t);
  createServer(db, { id: 'pg', label: 'PG', transport: 'stdio', command: 'npx' });
  createServer(db, { id: 'gh', label: 'GH', transport: 'stdio', command: 'npx' });
  upsertTool(db, 'pg', { name: 'query', inputSchema: { type: 'object' } });
  upsertTool(db, 'pg', { name: 'insert', inputSchema: { type: 'object' } });
  patchTool(db, 'pg', 'insert', { enabled: false });

  const counts = countToolsByServer(db);
  assert.deepEqual(counts.get('pg'), { total: 2, enabled: 1 });
  assert.equal(counts.has('gh'), false, 'servers without tool rows are absent');
});

test('failed writes roll back the revision and seed servers are immutable', (t) => {
  const { db } = fixture(t);

  createServer(db, { id: 'a', label: 'A', transport: 'stdio', command: 'node' });
  assert.throws(
    () => createServer(db, { id: 'a', label: 'duplicate', transport: 'stdio', command: 'node' }),
    DbValidationError,
  );
  assert.equal(getRevision(db), 1, 'the failed insert must roll the revision back');
  assert.equal(count(db, "SELECT count(*) AS n FROM servers WHERE id = 'a'"), 1);

  assert.throws(() => deleteServer(db, SEED_SERVER_IDS[0]), DbValidationError);
  assert.equal(getServer(db, SEED_SERVER_IDS[0])?.transport, 'builtin');

  assert.throws(
    () => upsertTool(db, 'missing', { name: 'x', inputSchema: { type: 'object' } }),
    DbNotFoundError,
  );
  assert.equal(getRevision(db), 1);

  assert.throws(
    () => createServer(db, { id: 'no-command', label: 'X', transport: 'stdio' }),
    DbValidationError,
  );
  assert.throws(
    () => createServer(db, { id: 'no-url', label: 'X', transport: 'http' }),
    DbValidationError,
  );
  assert.throws(
    () => createServer(db, { id: 'bad', label: 'X', transport: 'smtp' as 'stdio' }),
    DbValidationError,
  );
  assert.equal(updateServer(db, 'nope', { label: 'X' }), null);
});

test('deleting a server cascades its tools and FTS rows', (t) => {
  const { db } = fixture(t);

  createServer(db, {
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio',
    command: 'node',
    summary: 'database',
  });
  upsertTool(db, 'pg', {
    name: 'query',
    description: 'run sql',
    inputSchema: { type: 'object' },
  });
  assert.equal(count(db, 'SELECT count(*) AS n FROM tools'), 1);
  assert.equal(count(db, "SELECT count(*) AS n FROM tools_fts WHERE tools_fts MATCH 'sql'"), 1);

  const removed = deleteServer(db, 'pg');
  assert.equal(removed.deleted, true);
  assert.equal(count(db, 'SELECT count(*) AS n FROM tools'), 0);
  assert.equal(count(db, "SELECT count(*) AS n FROM tools_fts WHERE tools_fts MATCH 'sql'"), 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM servers'), 2, 'seed rows survive');
});

test('tool writes maintain derived index columns and FTS', (t) => {
  const { db } = fixture(t);

  createServer(db, {
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio',
    command: 'node',
    summary: 'database — query',
    tags: ['db', 'sql'],
  });

  const first = upsertTool(db, 'pg', {
    name: 'query',
    description: 'Run readonly SQL',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    tags: ['read'],
  });
  assert.equal(first.tool.indexDescription, 'Run readonly SQL');
  assert.equal(first.tool.indexSummary, 'database — query');
  assert.deepEqual(first.tool.indexTags, ['db', 'sql', 'read']);
  assert.equal(
    first.tool.schemaHash,
    hashToolSchema({ type: 'object', properties: { q: { type: 'string' } } }),
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM tools_fts WHERE tools_fts MATCH 'readonly'"), 1);

  const refreshed = upsertTool(db, 'pg', {
    name: 'query',
    description: 'Run analytics SQL',
    inputSchema: { type: 'object' },
    tags: ['ignored'],
  });
  assert.equal(refreshed.tool.firstSeenAt, first.tool.firstSeenAt);
  assert.equal(refreshed.tool.description, 'Run analytics SQL');
  assert.deepEqual(refreshed.tool.tags, ['read'], 'upstream refresh keeps admin tags');
  assert.equal(count(db, "SELECT count(*) AS n FROM tools_fts WHERE tools_fts MATCH 'analytics'"), 1);
  assert.equal(count(db, "SELECT count(*) AS n FROM tools_fts WHERE tools_fts MATCH 'readonly'"), 0);

  updateServer(db, 'pg', { summary: 'analytics warehouse', tags: ['db', 'warehouse'] });
  const afterServerUpdate = getTool(db, 'pg', 'query');
  assert.equal(afterServerUpdate?.indexSummary, 'analytics warehouse');
  assert.deepEqual(afterServerUpdate?.indexTags, ['db', 'warehouse', 'read']);
  assert.equal(count(db, "SELECT count(*) AS n FROM tools_fts WHERE tools_fts MATCH 'warehouse'"), 1);

  const patched = patchTool(db, 'pg', 'query', {
    description: 'Explain plans',
    tags: ['plan'],
    type: 'read',
  });
  assert.ok(patched);
  assert.equal(patched.tool.descriptionOverride, 'Explain plans');
  assert.equal(patched.tool.indexDescription, 'Explain plans');
  assert.deepEqual(patched.tool.indexTags, ['db', 'warehouse', 'plan']);
  assert.equal(count(db, "SELECT count(*) AS n FROM tools_fts WHERE tools_fts MATCH 'explain'"), 1);

  assert.equal(listTools(db, 'pg').length, 1);
  assert.equal(deleteTool(db, 'pg', 'query').deleted, true);
  assert.equal(count(db, 'SELECT count(*) AS n FROM tools'), 0);
  assert.equal(count(db, "SELECT count(*) AS n FROM tools_fts WHERE tools_fts MATCH 'explain'"), 0);
});

test('client bindings hash tokens, resolve workspaces and round-trip quotas', (t) => {
  const { db, dir } = fixture(t);
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const link = join(dir, 'workspace-link');
  symlinkSync(workspace, link, 'dir');
  const canonical = realpathSync(workspace);
  assert.equal(resolveWorkspacePath(link), canonical);

  const created = createClientBinding(db, {
    label: 'Cursor',
    token: 'plain-token',
    defaultWorkspace: link,
    allowedServers: ['pg'],
    allowedTags: ['db', 'read'],
    quota: { maxExecSessionsPerBinding: 2 },
  });
  assert.equal(created.token, 'plain-token');
  assert.equal(created.binding.tokenHash, hashToken('plain-token'));
  assert.notEqual(created.binding.tokenHash, 'plain-token');
  assert.equal(getClientToken(db, created.binding.id), 'plain-token');
  assert.equal('tokenPlain' in created.binding, false, 'public records never carry the plaintext');
  assert.equal(JSON.stringify(listClientBindings(db)).includes('plain-token'), false);
  assert.equal(created.binding.defaultWorkspace, canonical);
  assert.deepEqual(created.binding.allowedServers, ['pg']);
  assert.deepEqual(created.binding.allowedTags, ['db', 'read']);
  assert.deepEqual(created.binding.quota, {
    maxExecSessionsPerBinding: 2,
  });

  assert.equal(findBindingByToken(db, 'plain-token')?.id, created.binding.id);
  assert.equal(findBindingByToken(db, 'unknown-token'), null);
  assert.equal(getClientBinding(db, created.binding.id)?.label, 'Cursor');
  assert.equal(listClientBindings(db).length, 1);

  const rotated = rotateClientToken(db, created.binding.id, 'rotated-token');
  assert.equal(rotated?.id, created.binding.id);
  assert.equal(findBindingByToken(db, 'plain-token'), null, 'the old token stops matching');
  assert.equal(findBindingByToken(db, 'rotated-token')?.id, created.binding.id);
  assert.equal(getClientToken(db, created.binding.id), 'rotated-token');

  assert.equal(touchBinding(db, created.binding.id, '2026-11-18T00:00:00.000Z'), true);
  assert.equal(getClientBinding(db, created.binding.id)?.lastSeenAt, '2026-11-18T00:00:00.000Z');

  const updated = updateClientBinding(db, created.binding.id, {
    label: 'Cursor 2',
    defaultWorkspace: null,
    allowedServers: null,
    quota: { maxQueuedCallsPerBindingPerServer: 32 },
  });
  assert.equal(updated?.label, 'Cursor 2');
  assert.equal(updated?.defaultWorkspace, null);
  assert.equal(updated?.allowedServers, null);
  assert.deepEqual(updated?.allowedTags, ['db', 'read'], 'omitted fields stay unchanged');
  assert.deepEqual(updated?.quota, { maxQueuedCallsPerBindingPerServer: 32 });

  createClientBinding(db, { label: 'Other', token: 'other-token' });
  assert.throws(
    () => rotateClientToken(db, created.binding.id, 'other-token'),
    (error: unknown) => error instanceof DbValidationError && error.code === 'CONFLICT',
  );
  assert.equal(getClientToken(db, created.binding.id), 'rotated-token', 'a failed rotation leaves the token intact');

  db.prepare('UPDATE client_bindings SET token_plain = NULL WHERE id = ?').run(created.binding.id);
  assert.equal(getClientToken(db, created.binding.id), null, 'pre-v6 bindings cannot recover the token');
  assert.equal(findBindingByToken(db, 'rotated-token')?.id, created.binding.id);

  const generated = createClientBinding(db, { label: 'Generated' });
  assert.ok(generated.token.length >= 32);
  assert.equal(findBindingByToken(db, generated.token)?.id, generated.binding.id);
  assert.equal(getClientToken(db, generated.binding.id), generated.token);

  assert.equal(deleteClientBinding(db, generated.binding.id).deleted, true);
  assert.equal(findBindingByToken(db, generated.token), null);
  assert.equal(getClientToken(db, generated.binding.id), null);
  assert.equal(rotateClientToken(db, 'cb_missing', 'missing-token'), null);
  assert.equal(deleteClientBinding(db, generated.binding.id).deleted, false);
});

test('client binding validation rejects bad workspaces and quotas', (t) => {
  const { db, dir } = fixture(t);
  const file = join(dir, 'not-a-dir');
  writeFileSync(file, 'x');

  assert.throws(
    () => createClientBinding(db, { label: 'x', defaultWorkspace: join(dir, 'missing') }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'WS_INVALID',
  );
  assert.throws(
    () => createClientBinding(db, { label: 'x', defaultWorkspace: file }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'WS_INVALID',
  );
  assert.throws(
    () => createClientBinding(db, { label: 'x', quota: { maxExecSessionsPerBinding: -1 } }),
    DbValidationError,
  );
  assert.throws(
    () => createClientBinding(db, { label: 'x', quota: [] as unknown as BindingQuota }),
    DbValidationError,
  );
  assert.equal(listClientBindings(db).length, 0);
});

test('legacy per-MCP-session workspace quota is dropped on read and write', (t) => {
  const { db } = fixture(t);
  const created = createClientBinding(db, {
    label: 'Legacy',
    token: 'legacy-token',
    quota: { maxExecSessionsPerBinding: 2, maxWorkspacesPerMcpSession: 3 },
  });
  assert.deepEqual(created.binding.quota, { maxExecSessionsPerBinding: 2 });

  db.prepare('UPDATE client_bindings SET quota_json = ? WHERE id = ?').run(
    JSON.stringify({ maxExecSessionsPerBinding: 2, maxWorkspacesPerMcpSession: 3 }),
    created.binding.id,
  );
  assert.deepEqual(getClientBinding(db, created.binding.id)?.quota, {
    maxExecSessionsPerBinding: 2,
  });
});

test('settings round-trip JSON values and bump the catalog revision', (t) => {
  const { db } = fixture(t);

  const first = patchSettings(db, {
    strict_auth: true,
    capacity: { maxExecSessions: 8, maxServeProcesses: 8 },
  });
  assert.equal(first.revision, 1);
  assert.equal(getSetting<boolean>(db, 'strict_auth'), true);
  assert.deepEqual(getSetting(db, 'capacity'), { maxExecSessions: 8, maxServeProcesses: 8 });

  const second = setSetting(db, 'strict_auth', false);
  assert.equal(second.revision, 2);
  assert.equal(getSetting(db, 'strict_auth'), false);
  assert.deepEqual(Object.keys(listSettings(db)), ['capacity', 'strict_auth']);
});

test('DbSettingsStore reads back the top-level keys written by replace', async (t) => {
  const { db } = fixture(t);
  const store = new DbSettingsStore(db);

  const empty = await store.read();
  assert.deepEqual(empty.settings, {});
  assert.equal(empty.revision, 0);

  const written = await store.replace(
    { capacity: { maxExecSessions: 6, maxServeProcesses: 6 }, strictAuth: true },
    0,
  );
  assert.equal(written.revision, 1);

  const readBack = await store.read();
  assert.deepEqual(readBack.settings, {
    capacity: { maxExecSessions: 6, maxServeProcesses: 6 },
    strictAuth: true,
  });
  assert.equal(readBack.revision, 1);
});
