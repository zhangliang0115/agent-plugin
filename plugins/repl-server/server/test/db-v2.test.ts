import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { migrate, openStateDb } from '../src/db/migrate.ts';
import { getMeta, getRevision } from '../src/db/meta.ts';
import { createSchemaV1, createSchemaV2, createSchemaV4, DbValidationError, SCHEMA_VERSION } from '../src/db/schema.ts';
import { createServer, getServer, updateServer } from '../src/db/servers.ts';
import { applyToolPatch, getTool, patchTool, upsertTool, writeToolRow } from '../src/db/tools.ts';

const LEGACY_TIME = '2026-01-01T00:00:00.000Z';

interface Fixture {
  dir: string;
  file: string;
  db: DatabaseSync;
}

function openFixture(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'repl-server-db-v2-'));
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

function emptyFile(t: TestContext): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'repl-server-db-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'state.db') };
}

/** Builds a real v1 database: v1 DDL, seed meta keys, one server and one tool. */
function seedV1Database(file: string): void {
  const db = new DatabaseSync(file);
  createSchemaV1(db);
  db.prepare(`
    INSERT INTO servers (id, label, transport, command, created_at, updated_at)
    VALUES ('legacy', 'Legacy', 'stdio', 'node', ?, ?)
  `).run(LEGACY_TIME, LEGACY_TIME);
  db.prepare(`
    INSERT INTO tools (server_id, name, description, schema_json, schema_hash, first_seen_at, last_seen_at)
    VALUES ('legacy', 'old_tool', 'legacy tool', '{"type":"object"}', 'legacy-hash', ?, ?)
  `).run(LEGACY_TIME, LEGACY_TIME);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('revision', '5')").run();
  db.exec('PRAGMA user_version = 1');
  db.close();
}

/** Builds a real v4 database whose seed rows still carry the pre-v5 category keys. */
function seedV4Database(file: string): void {
  const db = new DatabaseSync(file);
  createSchemaV1(db);
  createSchemaV2(db);
  createSchemaV4(db);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('revision', '3')").run();
  const insertServer = db.prepare(`
    INSERT INTO servers (id, label, transport, category, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertServer.run('__official__', 'Claude Code 官方工具', 'builtin', 'official', LEGACY_TIME, LEGACY_TIME);
  insertServer.run('__builtin__', '内置聚合工具', 'builtin', 'builtin', LEGACY_TIME, LEGACY_TIME);
  insertServer.run('custom', 'Custom server', 'stdio', 'official', LEGACY_TIME, LEGACY_TIME);
  const insertTool = db.prepare(`
    INSERT INTO tools (server_id, name, schema_json, schema_hash, category, first_seen_at, last_seen_at)
    VALUES (?, ?, '{"type":"object"}', ?, ?, ?, ?)
  `);
  insertTool.run('__official__', 'Read', 'hash-1', 'official', LEGACY_TIME, LEGACY_TIME);
  insertTool.run('__builtin__', 'run_script', 'hash-2', 'builtin', LEGACY_TIME, LEGACY_TIME);
  insertTool.run('custom', 'query', 'hash-3', 'official', LEGACY_TIME, LEGACY_TIME);
  db.exec('PRAGMA user_version = 4');
  db.close();
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.['user_version'] ?? 0);
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get();
  return Number(row?.['n'] ?? 0);
}

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row['name']));
}

function indexNames(db: DatabaseSync, names: string[]): string[] {
  const placeholders = names.map(() => '?').join(', ');
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders}) ORDER BY name`)
    .all(...names)
    .map((row) => String(row['name']));
}

const REPORT_INDEX_NAMES = [
  'reports_created_idx',
  'reports_status_idx',
  'reports_owner_idx',
  'reports_dedupe_idx',
  'reports_alert_idx',
];

test('a fresh database runs v1 through v9 and exposes every feature set', (t) => {
  const { db } = openFixture(t);

  assert.equal(SCHEMA_VERSION, 9);
  assert.equal(readUserVersion(db), 9);
  assert.equal(getMeta(db, 'schema_version'), '9');
  assert.equal(count(db, "SELECT count(*) AS n FROM meta WHERE key = 'schema_version'"), 1);
  assert.equal(count(db, 'SELECT count(*) AS n FROM servers'), 2, 'v1 seeds survive');

  assert.ok(columns(db, 'servers').includes('discovery_json'));
  assert.ok(columns(db, 'tools').includes('discovered_via'));
  assert.ok(columns(db, 'reports').includes('client_name'));
  assert.ok(columns(db, 'reports').includes('client_version'));
  assert.ok(columns(db, 'reports').includes('resolution'));
  assert.ok(columns(db, 'reports').includes('resolved_at'));
  assert.ok(columns(db, 'client_bindings').includes('token_plain'));
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'reports'"),
    1,
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tool_usage'"),
    1,
  );
  assert.deepEqual(indexNames(db, REPORT_INDEX_NAMES), [...REPORT_INDEX_NAMES].sort());
  assert.deepEqual(indexNames(db, ['tools_discovery_idx']), ['tools_discovery_idx']);
});

test('v8 creates the script archive, library and candidate tables', (t) => {
  const { db } = openFixture(t);
  for (const table of ['script_runs', 'scripts', 'script_versions', 'script_candidates', 'scripts_fts']) {
    assert.equal(
      count(db, `SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'view') AND name = '${table}'`),
      1,
      `${table} must exist`,
    );
  }
  assert.ok(columns(db, 'scripts').includes('mode'));
  assert.ok(columns(db, 'script_runs').includes('args_preview'));
  assert.deepEqual(
    indexNames(db, [
      'script_runs_expires_idx',
      'script_runs_created_idx',
      'script_runs_code_idx',
      'script_runs_script_idx',
      'scripts_status_idx',
      'script_versions_status_idx',
      'script_versions_source_idx',
      'script_candidates_status_idx',
      'script_candidates_code_idx',
    ]),
    [
      'script_candidates_code_idx',
      'script_candidates_status_idx',
      'script_runs_code_idx',
      'script_runs_created_idx',
      'script_runs_expires_idx',
      'script_runs_script_idx',
      'script_versions_source_idx',
      'script_versions_status_idx',
      'scripts_status_idx',
    ],
  );

  const insert = db.prepare(`
    INSERT INTO scripts (script_id, name, description, mode, created_at, updated_at, status)
    VALUES (?, ?, 'd', 'exact', ?, ?, 'draft')
  `);
  insert.run('s_one', 'unique-name', LEGACY_TIME, LEGACY_TIME);
  assert.throws(
    () => insert.run('s_two', 'unique-name', LEGACY_TIME, LEGACY_TIME),
    /UNIQUE constraint failed: scripts\.name/,
  );
});

test('an existing v1 database upgrades in place and keeps its rows', (t) => {
  const { dir } = emptyFile(t);
  const legacy = join(dir, 'state-v1.db');
  seedV1Database(legacy);

  const db = openStateDb(legacy);
  t.after(() => {
    try {
      db.close();
    } catch {
      // closed by the test
    }
  });

  assert.equal(readUserVersion(db), 9);
  assert.equal(getMeta(db, 'schema_version'), '9');
  assert.equal(getMeta(db, 'revision'), '5', 'the migrations must not reseed the catalog revision');

  const server = getServer(db, 'legacy');
  assert.ok(server);
  assert.equal(server.label, 'Legacy');
  assert.equal(server.discoveryJson, null);

  const tool = getTool(db, 'legacy', 'old_tool');
  assert.ok(tool);
  assert.equal(tool.description, 'legacy tool');
  assert.equal(tool.discoveredVia, 'static', 'v1 rows default to static discovery');

  db.prepare(`
    INSERT INTO reports (
      id, created_at, updated_at, source, owner_key, severity, title, detail, fingerprint
    ) VALUES ('rep_1', ?, ?, 'mcp', 'mcp-1', 'high', 'Broken tool', 'details', 'fingerprint-1')
  `).run(LEGACY_TIME, LEGACY_TIME);
  const report = db.prepare('SELECT status, alert_state FROM reports WHERE id = ?').get('rep_1');
  assert.equal(report?.['status'], 'open');
  assert.equal(report?.['alert_state'], 'pending');
});

test('repeated migrate is idempotent on an already migrated database', (t) => {
  const { file } = emptyFile(t);
  const first = openStateDb(file);
  first
    .prepare(`
      INSERT INTO reports (
        id, created_at, updated_at, source, owner_key, severity, title, detail, fingerprint
      ) VALUES ('rep_1', ?, ?, 'admin', 'admin', 'low', 't', 'd', 'f')
    `)
    .run(LEGACY_TIME, LEGACY_TIME);
  first.close();

  const second = openStateDb(file);
  t.after(() => {
    try {
      second.close();
    } catch {
      // closed by the test
    }
  });

  assert.equal(migrate(second), 9);
  assert.equal(readUserVersion(second), 9);
  assert.equal(count(second, 'SELECT count(*) AS n FROM reports'), 1);
  assert.equal(count(second, 'SELECT count(*) AS n FROM servers'), 2, 'no duplicate seed rows');
  assert.equal(count(second, 'SELECT count(*) AS n FROM meta'), 2);
});

test('a v3 database backfills client_name/client_version from the legacy client label', (t) => {
  const { dir } = emptyFile(t);
  const legacy = join(dir, 'state-v3.db');
  const v3 = new DatabaseSync(legacy);
  createSchemaV1(v3);
  createSchemaV2(v3);
  v3.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run();
  v3.prepare("INSERT INTO meta (key, value) VALUES ('revision', '7')").run();
  v3.exec('PRAGMA user_version = 3');
  const insert = v3.prepare(`
    INSERT INTO reports (
      id, created_at, updated_at, source, client, mcp, owner_key,
      severity, title, detail, fingerprint
    ) VALUES (?, ?, ?, 'mcp', ?, 'mcp_1', 'cb_1', 'low', 't', 'd', ?)
  `);
  insert.run('rep_full', LEGACY_TIME, LEGACY_TIME, 'claude-code/2.1.327', 'f1');
  insert.run('rep_name_only', LEGACY_TIME, LEGACY_TIME, 'probe', 'f2');
  insert.run('rep_empty', LEGACY_TIME, LEGACY_TIME, '', 'f3');
  insert.run('rep_admin', LEGACY_TIME, LEGACY_TIME, 'admin', 'f4');
  v3.close();

  const db = openStateDb(legacy);
  t.after(() => {
    try {
      db.close();
    } catch {
      // closed by the test
    }
  });

  assert.equal(readUserVersion(db), 9);
  assert.equal(getMeta(db, 'schema_version'), '9');
  assert.equal(getMeta(db, 'revision'), '7', 'the migration must not reseed the catalog revision');

  const read = (id: string): { name: string; version: string } => {
    const row = db
      .prepare('SELECT client_name, client_version FROM reports WHERE id = ?')
      .get(id);
    return { name: String(row?.['client_name']), version: String(row?.['client_version']) };
  };
  assert.deepEqual(read('rep_full'), { name: 'claude-code', version: '2.1.327' });
  assert.deepEqual(read('rep_name_only'), { name: 'probe', version: '' });
  assert.deepEqual(read('rep_empty'), { name: '', version: '' });
  assert.deepEqual(read('rep_admin'), { name: 'admin', version: '' });
});

test('v5 rewrites seed categories and leaves user servers untouched', (t) => {
  const { dir } = emptyFile(t);
  const legacy = join(dir, 'state-v4.db');
  seedV4Database(legacy);

  const db = openStateDb(legacy);
  t.after(() => {
    try {
      db.close();
    } catch {
      // closed by the test
    }
  });

  assert.equal(readUserVersion(db), 9);
  assert.equal(getMeta(db, 'schema_version'), '9');
  assert.equal(getMeta(db, 'revision'), '3', 'the migration must not reseed the catalog revision');
  assert.ok(columns(db, 'client_bindings').includes('token_plain'));

  const servers = db
    .prepare('SELECT id, category FROM servers ORDER BY id')
    .all()
    .map((row) => ({ id: String(row['id']), category: String(row['category']) }));
  assert.deepEqual(servers, [
    { id: '__builtin__', category: 'other' },
    { id: '__official__', category: 'devtools' },
    { id: 'custom', category: 'official' },
  ]);

  const tools = db
    .prepare('SELECT server_id, name, category FROM tools ORDER BY server_id, name')
    .all()
    .map((row) => ({
      serverId: String(row['server_id']),
      name: String(row['name']),
      category: String(row['category']),
    }));
  assert.deepEqual(tools, [
    { serverId: '__builtin__', name: 'run_script', category: 'other' },
    { serverId: '__official__', name: 'Read', category: 'devtools' },
    { serverId: 'custom', name: 'query', category: 'official' },
  ]);
});

test('a database newer than the supported schema is rejected', (t) => {
  const { file } = emptyFile(t);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 10');
  db.close();

  assert.throws(() => openStateDb(file), /newer than supported 9/);
});

test('a v8 database gains tool_usage and keeps its tool rows', (t) => {
  const { dir } = emptyFile(t);
  const file = join(dir, 'state-v8.db');
  const v8 = openStateDb(file);
  v8.prepare(`
    INSERT INTO servers (id, label, transport, command, created_at, updated_at)
    VALUES ('legacy', 'Legacy', 'stdio', 'node', ?, ?)
  `).run(LEGACY_TIME, LEGACY_TIME);
  v8.prepare(`
    INSERT INTO tools (server_id, name, description, schema_json, schema_hash, first_seen_at, last_seen_at)
    VALUES ('legacy', 'old_tool', 'legacy tool', '{"type":"object"}', 'legacy-hash', ?, ?)
  `).run(LEGACY_TIME, LEGACY_TIME);
  // Roll the database back to v8: the newest table is gone, the marker follows.
  v8.exec('DROP TABLE tool_usage');
  v8.prepare("UPDATE meta SET value = '8' WHERE key = 'schema_version'").run();
  v8.exec('PRAGMA user_version = 8');
  v8.close();

  const db = openStateDb(file);
  t.after(() => {
    try {
      db.close();
    } catch {
      // closed by the test
    }
  });

  assert.equal(readUserVersion(db), 9);
  assert.equal(getMeta(db, 'schema_version'), '9');
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tool_usage'"),
    1,
  );
  const kept = getTool(db, 'legacy', 'old_tool');
  assert.ok(kept);
  assert.equal(kept.description, 'legacy tool');
  assert.equal(kept.callCount, 0);
  assert.equal(kept.successCount, 0);
  assert.equal(kept.lastCalledAt, null);
});

test('server discoveryJson round-trips as opaque JSON text', (t) => {
  const { db } = openFixture(t);
  const discovery = JSON.stringify({ mode: 'search', searchTool: 'search_tools', query: 'database' });

  const created = createServer(db, {
    id: 'hexhub',
    label: 'Hexhub',
    transport: 'http',
    url: 'https://example.test/mcp',
    discoveryJson: discovery,
  });
  assert.equal(created.server.discoveryJson, discovery);

  const updated = updateServer(db, 'hexhub', {
    discoveryJson: JSON.stringify({ mode: 'search', searchTool: 'find' }),
  });
  assert.equal(updated?.server.discoveryJson, '{"mode":"search","searchTool":"find"}');

  const cleared = updateServer(db, 'hexhub', { discoveryJson: null });
  assert.equal(cleared?.server.discoveryJson, null);

  assert.throws(
    () =>
      createServer(db, {
        id: 'bad',
        label: 'Bad',
        transport: 'http',
        url: 'https://example.test/mcp',
        discoveryJson: '{not json',
      }),
    DbValidationError,
  );
});

test('upsertTool records and preserves the discovery source', (t) => {
  const { db } = openFixture(t);
  createServer(db, { id: 'hexhub', label: 'Hexhub', transport: 'stdio', command: 'node' });

  const declared = upsertTool(db, 'hexhub', {
    name: 'search_tools',
    description: 'Search upstream tools',
    inputSchema: { type: 'object' },
  });
  assert.equal(declared.tool.discoveredVia, 'static', 'new rows default to static');

  const scanned = upsertTool(db, 'hexhub', {
    name: 'lazy_tool',
    description: 'Discovered later',
    inputSchema: { type: 'object' },
    discoveredVia: 'search',
  });
  assert.equal(scanned.tool.discoveredVia, 'search');

  const rediscovered = upsertTool(db, 'hexhub', {
    name: 'search_tools',
    inputSchema: { type: 'object' },
    discoveredVia: 'search',
  });
  assert.equal(rediscovered.tool.discoveredVia, 'static', 'static rows are not overwritten by default');

  const overwritten = upsertTool(db, 'hexhub', {
    name: 'search_tools',
    inputSchema: { type: 'object' },
    discoveredVia: 'search',
    overwriteStatic: true,
  });
  assert.equal(overwritten.tool.discoveredVia, 'search');

  const refreshed = upsertTool(db, 'hexhub', {
    name: 'lazy_tool',
    inputSchema: { type: 'object' },
  });
  assert.equal(refreshed.tool.discoveredVia, 'search', 'a plain upsert never downgrades to static');

  // 08 annotation writes reuse the exported helpers without touching the source.
  const current = getTool(db, 'hexhub', 'lazy_tool');
  assert.ok(current);
  writeToolRow(db, applyToolPatch(current, { description: 'AI description', tags: ['ai'] }));
  const reread = getTool(db, 'hexhub', 'lazy_tool');
  assert.equal(reread?.descriptionOverride, 'AI description');
  assert.deepEqual(reread?.tags, ['ai']);
  assert.equal(reread?.discoveredVia, 'search');

  assert.throws(
    () => writeToolRow(db, { ...current, name: 'missing' }),
    /does not exist/,
  );
});

test('updateServer demotes search rows only when discovery leaves search mode', (t) => {
  const { db } = openFixture(t);
  const searchJson = JSON.stringify({ mode: 'search', searchTool: 'search_tools' });
  createServer(db, {
    id: 'hexhub',
    label: 'Hexhub',
    transport: 'stdio',
    command: 'node',
    discoveryJson: searchJson,
  });
  upsertTool(db, 'hexhub', { name: 'search_tools', inputSchema: { type: 'object' } });
  upsertTool(db, 'hexhub', {
    name: 'lazy_tool',
    inputSchema: { type: 'object' },
    discoveredVia: 'search',
  });
  upsertTool(db, 'hexhub', {
    name: 'kept_tool',
    inputSchema: { type: 'object' },
    discoveredVia: 'search',
  });
  patchTool(db, 'hexhub', 'kept_tool', { staleOverride: true });
  upsertTool(db, 'hexhub', { name: 'static_tool', inputSchema: { type: 'object' } });

  // Remaining in search mode (or editing unrelated fields) never demotes.
  updateServer(db, 'hexhub', {
    discoveryJson: JSON.stringify({ mode: 'search', searchTool: 'search_tools', query: 'x' }),
  });
  updateServer(db, 'hexhub', { label: 'Hexhub 2' });
  assert.equal(getTool(db, 'hexhub', 'lazy_tool')?.stale, false);
  assert.equal(getTool(db, 'hexhub', 'kept_tool')?.stale, false);

  const revisionBefore = getRevision(db);
  const updated = updateServer(db, 'hexhub', { discoveryJson: JSON.stringify({ mode: 'static' }) });
  assert.equal(updated?.revision, revisionBefore + 1, 'one revision for the config write');

  assert.equal(getTool(db, 'hexhub', 'lazy_tool')?.stale, true);
  assert.equal(getTool(db, 'hexhub', 'kept_tool')?.stale, true, 'staleOverride does not exempt demotion');
  assert.equal(getTool(db, 'hexhub', 'static_tool')?.stale, false);
  assert.equal(getTool(db, 'hexhub', 'search_tools')?.stale, false);
  assert.equal(updated?.server.discoveryJson, JSON.stringify({ mode: 'static' }));

  // Repeating the write is idempotent and leaves the rows stale.
  const again = updateServer(db, 'hexhub', { discoveryJson: null });
  assert.equal(again?.server.discoveryJson, null);
  assert.equal(getTool(db, 'hexhub', 'lazy_tool')?.stale, true);
  assert.equal(getTool(db, 'hexhub', 'kept_tool')?.stale, true);
});

test('a failing demotion rolls the discovery switch back (one transaction)', (t) => {
  const { db } = openFixture(t);
  const searchJson = JSON.stringify({ mode: 'search', searchTool: 'search_tools' });
  createServer(db, {
    id: 'hexhub',
    label: 'Hexhub',
    transport: 'stdio',
    command: 'node',
    discoveryJson: searchJson,
  });
  upsertTool(db, 'hexhub', { name: 'search_tools', inputSchema: { type: 'object' } });
  upsertTool(db, 'hexhub', {
    name: 'lazy_tool',
    inputSchema: { type: 'object' },
    discoveredVia: 'search',
  });

  db.exec(`
    CREATE TRIGGER block_demotion BEFORE UPDATE OF stale ON tools
    WHEN new.stale = 1 BEGIN SELECT RAISE(ABORT, 'demotion blocked'); END
  `);
  try {
    assert.throws(
      () => updateServer(db, 'hexhub', { discoveryJson: null }),
      /demotion blocked/,
    );
    assert.equal(
      getServer(db, 'hexhub')?.discoveryJson,
      searchJson,
      'the server row was rolled back with the failed demotion',
    );
    assert.equal(getTool(db, 'hexhub', 'lazy_tool')?.stale, false);
  } finally {
    db.exec('DROP TRIGGER block_demotion');
  }
});
