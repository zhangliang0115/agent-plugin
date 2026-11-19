import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { migrate, openStateDb } from '../src/db/migrate.ts';
import { getMeta, getRevision } from '../src/db/meta.ts';
import { createSchemaV1, DbValidationError, SCHEMA_VERSION } from '../src/db/schema.ts';
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

test('a fresh database runs v1 then v2 and exposes both v2 feature sets', (t) => {
  const { db } = openFixture(t);

  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(readUserVersion(db), 2);
  assert.equal(getMeta(db, 'schema_version'), '2');
  assert.equal(count(db, "SELECT count(*) AS n FROM meta WHERE key = 'schema_version'"), 1);
  assert.equal(count(db, 'SELECT count(*) AS n FROM servers'), 2, 'v1 seeds survive');

  assert.ok(columns(db, 'servers').includes('discovery_json'));
  assert.ok(columns(db, 'tools').includes('discovered_via'));
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'reports'"),
    1,
  );
  assert.deepEqual(indexNames(db, REPORT_INDEX_NAMES), [...REPORT_INDEX_NAMES].sort());
  assert.deepEqual(indexNames(db, ['tools_discovery_idx']), ['tools_discovery_idx']);
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

  assert.equal(readUserVersion(db), 2);
  assert.equal(getMeta(db, 'schema_version'), '2');
  assert.equal(getMeta(db, 'revision'), '5', 'v2 must not reseed the catalog revision');

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

  assert.equal(migrate(second), 2);
  assert.equal(readUserVersion(second), 2);
  assert.equal(count(second, 'SELECT count(*) AS n FROM reports'), 1);
  assert.equal(count(second, 'SELECT count(*) AS n FROM servers'), 2, 'no duplicate seed rows');
  assert.equal(count(second, 'SELECT count(*) AS n FROM meta'), 2);
});

test('a database newer than the supported schema is rejected', (t) => {
  const { file } = emptyFile(t);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 3');
  db.close();

  assert.throws(() => openStateDb(file), /newer than supported 2/);
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
