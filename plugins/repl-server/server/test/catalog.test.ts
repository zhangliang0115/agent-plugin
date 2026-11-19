import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { CatalogSnapshot, CatalogTool } from '../src/ports.ts';
import {
  buildCatalogSnapshot,
  createCatalogService,
  createSearchPreview,
  refreshFts,
  searchTools,
} from '../src/catalog/index.ts';
import type { SearchOutcome } from '../src/catalog/index.ts';
import { createSchemaV1 } from '../src/db/schema.ts';

const NOW = '2026-11-18T00:00:00.000Z';

interface ServerSeed {
  id: string;
  label?: string;
  transport?: 'stdio' | 'http' | 'builtin';
  summary?: string | null;
  category?: string | null;
  tags?: string[];
  enabled?: 0 | 1;
}

interface ToolSeed {
  displayName?: string | null;
  description?: string | null;
  descriptionOverride?: string | null;
  enabled?: 0 | 1;
  concurrency?: 'parallel' | 'serial' | 'exclusive';
  type?: string | null;
  tags?: string[];
  schema?: unknown;
  category?: string | null;
  stale?: 0 | 1;
  staleOverride?: 0 | 1;
}

function openMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  createSchemaV1(db);
  return db;
}

function insertServer(db: DatabaseSync, seed: ServerSeed): void {
  db.prepare(
    `INSERT INTO servers (
       id, label, transport, summary, category, tags_json, enabled,
       timeout_ms, max_concurrency, created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 60000, 8, ?, ?, 1)`,
  ).run(
    seed.id,
    seed.label ?? seed.id,
    seed.transport ?? 'stdio',
    seed.summary ?? null,
    seed.category ?? null,
    JSON.stringify(seed.tags ?? []),
    seed.enabled ?? 1,
    NOW,
    NOW,
  );
}

function insertTool(
  db: DatabaseSync,
  serverId: string,
  name: string,
  seed: ToolSeed = {},
): void {
  db.prepare(
    `INSERT INTO tools (
       server_id, name, display_name, description, description_override,
       enabled, concurrency, type, tags_json,
       index_description, index_summary, index_tags_json,
       schema_json, schema_hash, category, stale, stale_override,
       first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '[]', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    serverId,
    name,
    seed.displayName ?? null,
    seed.description ?? null,
    seed.descriptionOverride ?? null,
    seed.enabled ?? 1,
    seed.concurrency ?? 'parallel',
    seed.type ?? null,
    JSON.stringify(seed.tags ?? []),
    JSON.stringify(seed.schema ?? { type: 'object', properties: {} }),
    `hash-${serverId}-${name}`,
    seed.category ?? null,
    seed.stale ?? 0,
    seed.staleOverride ?? 0,
    NOW,
    NOW,
  );
}

function insertBinding(
  db: DatabaseSync,
  id: string,
  allowedServers: string[] | null,
  allowedTags: string[] | null,
): void {
  db.prepare(
    `INSERT INTO client_bindings (
       id, label, token_hash, allowed_servers_json, allowed_tags_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    `hash-${id}`,
    allowedServers === null ? null : JSON.stringify(allowedServers),
    allowedTags === null ? null : JSON.stringify(allowedTags),
    NOW,
  );
}

function toolRow(db: DatabaseSync, serverId: string, name: string): Record<string, unknown> {
  const row = db
    .prepare('SELECT * FROM tools WHERE server_id = ? AND name = ?')
    .get(serverId, name);
  assert.ok(row, `missing tool row ${serverId}.${name}`);
  return row as Record<string, unknown>;
}

function findTool(snapshot: CatalogSnapshot, name: string): CatalogTool {
  const tool = snapshot.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing catalog tool ${name}`);
  return tool;
}

function resultNames(outcome: SearchOutcome): string[] {
  return outcome.results.map((hit) => hit.name);
}

test('refreshFts derives description override, server summary and the tag union', () => {
  const db = openMemoryDb();
  insertServer(db, {
    id: 'pg',
    summary: 'Postgres database',
    tags: ['db', 'sql'],
  });
  insertTool(db, 'pg', 'query', {
    description: 'Run a SQL query',
    tags: ['read', 'db'],
  });

  assert.equal(refreshFts(db, 'pg'), 1);

  const refreshed = toolRow(db, 'pg', 'query');
  assert.equal(refreshed.index_description, 'Run a SQL query');
  assert.equal(refreshed.index_summary, 'Postgres database');
  assert.deepEqual(
    [...JSON.parse(String(refreshed.index_tags_json))].sort(),
    ['db', 'read', 'sql'],
  );

  // The trigger must have mirrored the new effective values into tools_fts.
  const ftsRow = db
    .prepare(
      `SELECT f.index_description, f.index_summary, f.index_tags_json
       FROM tools_fts f
       JOIN tools t ON t.rowid = f.rowid
       WHERE t.server_id = 'pg' AND t.name = 'query'`,
    )
    .get();
  assert.ok(ftsRow);
  assert.equal(ftsRow.index_description, 'Run a SQL query');
  assert.equal(ftsRow.index_summary, 'Postgres database');
  assert.deepEqual(
    [...JSON.parse(String(ftsRow.index_tags_json))].sort(),
    ['db', 'read', 'sql'],
  );

  db.prepare(
    `UPDATE tools SET description_override = ?
     WHERE server_id = 'pg' AND name = 'query'`,
  ).run('Run a read-only SQL query.');
  refreshFts(db, 'pg');

  const overridden = toolRow(db, 'pg', 'query');
  assert.equal(overridden.index_description, 'Run a read-only SQL query.');
  assert.equal(overridden.description, 'Run a SQL query');
});

test('refreshFts only UPDATEs the target server rows', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'pg', summary: 'PG summary', tags: ['db'] });
  insertServer(db, { id: 'fs', summary: 'FS summary', tags: ['files'] });
  insertTool(db, 'pg', 'query', { tags: ['read'] });
  insertTool(db, 'fs', 'read_file', { tags: ['read'] });

  assert.equal(refreshFts(db, 'pg'), 1);

  assert.equal(toolRow(db, 'pg', 'query').index_summary, 'PG summary');
  assert.equal(toolRow(db, 'fs', 'read_file').index_summary, '');

  // Running it again still touches exactly one row, not the whole table.
  assert.equal(refreshFts(db, 'pg'), 1);

  refreshFts(db, 'fs');
  assert.equal(toolRow(db, 'fs', 'read_file').index_summary, 'FS summary');
});

test('search inherits server tags and honours server/category/type/tag filters', () => {
  const db = openMemoryDb();
  insertServer(db, {
    id: 'pg',
    summary: 'Postgres database',
    category: 'database',
    tags: ['db', 'sql'],
  });
  insertServer(db, { id: 'fs', summary: 'Filesystem', category: 'files', tags: ['files'] });
  insertTool(db, 'pg', 'query', {
    description: 'Run a SQL query',
    type: 'query',
    tags: ['read'],
  });
  insertTool(db, 'fs', 'read_file', { description: 'Read a file', tags: ['read'] });
  refreshFts(db, 'pg');
  refreshFts(db, 'fs');

  // tag:db matches pg.query through the inherited server tag, not the tool tag.
  assert.deepEqual(resultNames(searchTools(db, { query: 'query tag:db' })), ['pg.query']);
  assert.deepEqual(resultNames(searchTools(db, { query: 'query server:fs' })), []);
  assert.deepEqual(
    resultNames(searchTools(db, { query: 'read server:fs' })),
    ['fs.read_file'],
  );
  assert.deepEqual(
    resultNames(searchTools(db, { query: 'read category:database' })),
    ['pg.query'],
  );
  assert.deepEqual(
    resultNames(searchTools(db, { query: 'query type:query' })),
    ['pg.query'],
  );
  assert.deepEqual(
    resultNames(searchTools(db, { query: 'read', type: 'query' })),
    ['pg.query'],
  );
  assert.deepEqual(
    resultNames(searchTools(db, { query: '', tags: ['db'] })).length,
    0,
  );
});

test('empty query returns a server and category overview', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'pg', summary: 'Postgres', category: 'database', tags: ['db'] });
  insertServer(db, { id: 'fs', summary: 'Files', category: 'files', tags: ['files'] });
  insertServer(db, {
    id: '__official__',
    label: 'official',
    transport: 'builtin',
    tags: ['official'],
  });
  insertTool(db, 'pg', 'query', { description: 'Run SQL' });
  insertTool(db, 'pg', 'insert_row', { description: 'Insert' });
  insertTool(db, 'fs', 'read_file', { description: 'Read a file' });
  insertTool(db, '__official__', 'Read', { description: 'Read a file' });
  refreshFts(db, 'pg');
  refreshFts(db, 'fs');
  refreshFts(db, '__official__');

  const outcome = searchTools(db, { query: '' });
  assert.equal(outcome.mode, 'overview');
  assert.deepEqual(outcome.results, []);
  assert.ok(outcome.overview);
  assert.deepEqual(
    outcome.overview.servers.map((server) => [server.server, server.toolCount]),
    [['__official__', 1], ['fs', 1], ['pg', 2]],
  );
  assert.deepEqual(
    outcome.overview.servers.map((server) => server.kind),
    ['builtin', 'mcp', 'mcp'],
  );
  assert.deepEqual(outcome.overview.categories, [
    { category: 'database', toolCount: 2 },
    { category: 'files', toolCount: 1 },
  ]);
  assert.deepEqual(outcome.hints, []);

  const narrowed = searchTools(db, {
    query: '',
    visibility: { allowedServers: ['pg'] },
  });
  assert.ok(narrowed.overview);
  assert.deepEqual(
    narrowed.overview.servers.map((server) => server.server),
    ['pg'],
  );
  assert.ok(narrowed.hints.some((hint) => hint.includes('outside your visibility scope')));
  assert.ok(!narrowed.hints.some((hint) => hint.includes('No matching tools')));
});

test('BM25 weights rank name, display name and description in that order', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 's' });
  insertTool(db, 's', 'deploy', { description: 'misc' });
  insertTool(db, 's', 'other', {
    displayName: 'deploy helper',
    description: 'misc',
  });
  insertTool(db, 's', 'third', { description: 'deploy the application now' });
  refreshFts(db, 's');

  const names = resultNames(searchTools(db, { query: 'deploy' }));
  assert.deepEqual(names, ['s.deploy', 's.other', 's.third']);
});

test('synonyms translate Chinese queries before FTS', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'comm' });
  insertTool(db, 'comm', 'send_email', { description: 'Send an email message' });
  insertServer(db, { id: 'pg', summary: 'SQL database' });
  insertTool(db, 'pg', 'query', { description: 'Run a query' });
  refreshFts(db, 'comm');
  refreshFts(db, 'pg');

  assert.deepEqual(resultNames(searchTools(db, { query: '发邮件' })), ['comm.send_email']);
  assert.ok(resultNames(searchTools(db, { query: '数据库' })).includes('pg.query'));
});

test('a query with no FTS match falls back to a substring scan', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'comm' });
  insertTool(db, 'comm', 'send_email', { description: 'Send an email message' });
  refreshFts(db, 'comm');

  const outcome = searchTools(db, { query: 'ail' });
  assert.deepEqual(resultNames(outcome), ['comm.send_email']);
  assert.ok(outcome.results[0]?.score !== undefined);
});

test('visibility is applied before truncation and reported as a hint', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'pg', tags: ['db'] });
  insertServer(db, { id: 'fs', tags: ['files'] });
  insertTool(db, 'pg', 'query', { description: 'Run a read-only SQL query', tags: ['read'] });
  insertTool(db, 'fs', 'read_file', { description: 'Read a file', tags: ['read'] });
  refreshFts(db, 'pg');
  refreshFts(db, 'fs');

  // allowed_tags is any-of, and inherited server tags participate.
  assert.deepEqual(
    resultNames(searchTools(db, { query: 'read', visibility: { allowedTags: ['db'] } })),
    ['pg.query'],
  );
  assert.deepEqual(
    resultNames(searchTools(db, {
      query: 'read',
      visibility: { allowedTags: ['files', 'admin'] },
    })),
    ['fs.read_file'],
  );
  assert.deepEqual(
    resultNames(searchTools(db, {
      query: 'read',
      visibility: { allowedServers: ['pg'], allowedTags: ['files'] },
    })),
    [],
  );

  const hidden = searchTools(db, {
    query: 'read',
    visibility: { allowedTags: ['admin'] },
  });
  assert.deepEqual(hidden.results, []);
  assert.equal(hidden.hiddenByVisibility, 2);
  assert.ok(hidden.hints.some((hint) => hint.includes('outside your visibility scope')));

  const emptyAllowList = searchTools(db, {
    query: 'read',
    visibility: { allowedTags: [] },
  });
  assert.deepEqual(emptyAllowList.results, []);
  assert.equal(emptyAllowList.hiddenByVisibility, 2);

  const unavailable = searchTools(db, { query: 'read', unavailableServers: ['pg'] });
  assert.deepEqual(resultNames(unavailable), ['fs.read_file']);
  assert.ok(unavailable.hints.some((hint) => hint.includes('server pg is unavailable')));
});

test('stale tools are excluded and counted in a hint', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'pg' });
  insertTool(db, 'pg', 'old_query', { description: 'Legacy SQL query', stale: 1 });
  insertTool(db, 'pg', 'query', { description: 'Run a SQL query' });
  refreshFts(db, 'pg');

  const outcome = searchTools(db, { query: 'query' });
  assert.deepEqual(resultNames(outcome), ['pg.query']);
  assert.equal(outcome.hiddenStale, 1);
  assert.ok(outcome.hints.some((hint) => hint.includes('stale')));
});

test('snapshot tools omit category and summary when the server has none', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'bare' });
  insertTool(db, 'bare', 'ping', { description: 'Ping' });
  refreshFts(db, 'bare');

  const tool = findTool(buildCatalogSnapshot(db), 'bare.ping');
  assert.equal(tool.category, undefined);
  assert.equal(tool.summary, undefined);
});

test('catalog snapshots are immutable, revisioned and notify catalog_changed', () => {
  const db = openMemoryDb();
  insertServer(db, {
    id: '__official__',
    transport: 'builtin',
    category: 'devtools',
    summary: 'Official tools',
    tags: ['official'],
  });
  insertTool(db, '__official__', 'Read', {
    description: 'Read a file',
    tags: ['read'],
  });
  insertServer(db, { id: 'pg', summary: 'Postgres', category: 'database', tags: ['db'] });
  insertTool(db, 'pg', 'query', {
    description: 'Run a SQL query',
    concurrency: 'serial',
    tags: ['read'],
  });
  refreshFts(db, '__official__');
  refreshFts(db, 'pg');

  const events: { revision: number; servers: string[] }[] = [];
  const catalog = createCatalogService({
    db,
    onCatalogChanged: (event) => events.push(event),
  });

  const first = catalog.snapshot();
  assert.equal(first.revision, 0);
  assert.ok(Object.isFrozen(first.tools));

  const read = findTool(first, 'Read');
  assert.equal(read.kind, 'builtin');
  assert.equal(read.server, undefined);
  assert.equal(read.category, 'devtools', 'builtins inherit the server category');
  assert.equal(read.summary, 'Official tools', 'builtins inherit the server summary');
  const query = findTool(first, 'pg.query');
  assert.equal(query.kind, 'mcp');
  assert.equal(query.server, 'pg');
  assert.equal(query.category, 'database');
  assert.equal(query.summary, 'Postgres');
  assert.equal(query.concurrency, 'serial');
  assert.ok(Object.isFrozen(query));
  assert.ok(Object.isFrozen(query.tags));

  db.prepare(
    `UPDATE tools SET description_override = ?
     WHERE server_id = 'pg' AND name = 'query'`,
  ).run('Run a read-only SQL query.');
  refreshFts(db, 'pg');

  const second = catalog.commit(['pg']);
  assert.equal(second.revision, 1);
  assert.ok(Object.isFrozen(second.tools));
  assert.equal(findTool(second, 'pg.query').description, 'Run a read-only SQL query.');

  // The old snapshot keeps the values it was built with.
  assert.equal(findTool(first, 'pg.query').description, 'Run a SQL query');
  assert.equal(first.revision, 0);

  assert.deepEqual(events, [{ revision: 1, servers: ['pg'] }]);

  const third = catalog.rebuild(['pg']);
  assert.equal(third.revision, 1);
  assert.deepEqual(events, [
    { revision: 1, servers: ['pg'] },
    { revision: 1, servers: ['pg'] },
  ]);

  const unsubscribe = catalog.onCatalogChanged(() => {
    throw new Error('listener failures must not break commits');
  });
  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const fourth = catalog.commit([]);
    assert.equal(fourth.revision, 2);
  } finally {
    console.error = originalError;
  }
  unsubscribe();
  assert.equal(logged.length, 1);
  assert.equal(events.length, 3);

  const refreshedSnapshot = catalog.refreshFts('pg');
  assert.equal(refreshedSnapshot.revision, 2);
  assert.equal(events.length, 4);
});

test('admin search preview reuses the retriever and binding visibility', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'pg', tags: ['db'] });
  insertServer(db, { id: 'fs', tags: ['files'] });
  insertTool(db, 'pg', 'query', { description: 'Run a read-only SQL query', tags: ['read'] });
  insertTool(db, 'fs', 'read_file', { description: 'Read a file', tags: ['read'] });
  refreshFts(db, 'pg');
  refreshFts(db, 'fs');
  insertBinding(db, 'cb_pg', ['pg'], null);
  insertBinding(db, 'cb_tags', null, ['files']);

  const preview = createSearchPreview({ db });

  const adminView = preview.search({ query: 'read', max: 10 });
  assert.deepEqual(
    adminView.results.map((hit) => hit.name).sort(),
    ['fs.read_file', 'pg.query'],
  );

  const serverBound = preview.search({ query: 'read', max: 10, bindingId: 'cb_pg' });
  assert.deepEqual(serverBound.results.map((hit) => hit.name), ['pg.query']);
  assert.ok(serverBound.notice?.includes('outside your visibility scope'));

  const tagBound = preview.search({ query: 'read', max: 10, bindingId: 'cb_tags' });
  assert.deepEqual(tagBound.results.map((hit) => hit.name), ['fs.read_file']);

  const missingBinding = preview.search({
    query: 'read',
    max: 10,
    bindingId: 'cb_missing',
  });
  assert.deepEqual(missingBinding.results, []);
  assert.ok(missingBinding.notice?.includes('does not exist'));

  const overview = preview.search({ query: '', max: 10 });
  assert.deepEqual(
    overview.results.map((hit) => hit.name),
    ['fs', 'pg'],
  );
  assert.match(String(overview.results[0]?.description), /tool; call tools\.mcp\.fs/);

  const filteredByServer = preview.search({ query: 'read', max: 10, server: 'fs' });
  assert.deepEqual(filteredByServer.results.map((hit) => hit.name), ['fs.read_file']);
});

test('the catalog works on a file-backed temp SQLite database', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-server-catalog-'));
  const db = new DatabaseSync(join(dir, 'state.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec('PRAGMA journal_mode = WAL');
  createSchemaV1(db);

  insertServer(db, { id: 'pg', summary: 'Postgres', tags: ['db'] });
  insertTool(db, 'pg', 'query', { description: 'Run SQL', tags: ['read'] });
  assert.equal(refreshFts(db, 'pg'), 1);

  const catalog = createCatalogService({ db });
  assert.deepEqual(catalog.snapshot().tools.map((tool) => tool.name), ['pg.query']);
  assert.deepEqual(resultNames(searchTools(db, { query: 'sql' })), ['pg.query']);
});
