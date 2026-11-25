import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { buildCatalogSnapshot, refreshFts } from '../src/catalog/index.ts';
import { createSchemaV1 } from '../src/db/schema.ts';
import type {
  Catalog,
  ExecutionGateway,
  RequestIdentity,
} from '../src/ports.ts';
import { McpTaskStore } from '../src/tasks/mcp-tasks.ts';
import { callTool, type ToolCallContext } from '../src/tools/call.ts';
import type { CallToolResult } from '../src/tools/registry.ts';
import {
  searchTools,
  type SearchToolsInput,
  type ToolVisibility,
} from '../src/tools/search.ts';
import { createToolTextSearch } from '../src/tools/search-fts.ts';

/**
 * Shared FTS5 search for `search_tools`. The fixture mirrors the relevance
 * suite's tool set, but lives in real SQLite so FTS columns and triggers are
 * exercised; parity assertions compare the adapter with `searchTools` over the
 * snapshot built from the same rows.
 */

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
  tags?: string[];
  schema?: unknown;
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
     ) VALUES (?, ?, ?, ?, ?, ?, 'parallel', NULL, ?, '', '', '[]', ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    serverId,
    name,
    seed.displayName ?? null,
    seed.description ?? null,
    seed.descriptionOverride ?? null,
    seed.enabled ?? 1,
    JSON.stringify(seed.tags ?? []),
    JSON.stringify(seed.schema ?? { type: 'object', properties: {} }),
    `hash-${serverId}-${name}`,
    seed.stale ?? 0,
    seed.staleOverride ?? 0,
    NOW,
    NOW,
  );
}

function seedFixture(db: DatabaseSync): void {
  insertServer(db, {
    id: '__official__',
    transport: 'builtin',
    summary: 'Official Claude Code tools',
    category: 'devtools',
  });
  insertTool(db, '__official__', 'Read', {
    description: 'Read a file from disk',
    tags: ['files', 'read'],
  });
  insertTool(db, '__official__', 'WebSearch', {
    description: 'Search the web for pages',
    tags: ['web', 'search'],
  });
  insertTool(db, '__official__', 'Bash', {
    description: 'Run a shell command',
    tags: ['shell', 'exec'],
  });

  insertServer(db, {
    id: 'pg-main',
    summary: 'Postgres warehouse',
    category: 'database',
    tags: ['db'],
  });
  insertTool(db, 'pg-main', 'query', {
    description: 'Run a read-only SQL query',
    tags: ['read'],
  });
  insertTool(db, 'pg-main', 'insert_row', {
    description: 'Insert a row into a table',
    tags: ['write'],
  });
  insertTool(db, 'pg-main', 'slow_query_log', {
    description: 'List slow SQL statements',
    tags: ['sql'],
  });
  insertTool(db, 'pg-main', 'percent_stats', {
    description: 'Report 100% coverage of tables',
    tags: ['metrics'],
  });
  insertTool(db, 'pg-main', 'sql_query_v2', {
    description: 'SELECT * FROM users and return rows',
    tags: ['sql', 'read'],
  });

  insertServer(db, {
    id: 'es-logs',
    summary: 'Elasticsearch cluster',
    category: 'search',
    tags: ['elasticsearch'],
  });
  insertTool(db, 'es-logs', '日志检索', {
    description: '在 ES 中按关键字搜索日志',
    tags: ['log'],
  });
  insertTool(db, 'es-logs', 'search_help', {
    description: '检索工具使用说明',
    tags: ['docs'],
  });

  insertServer(db, { id: 'legacy', summary: 'Legacy helpers', category: 'tools' });
  insertTool(db, 'legacy', 'old_helper (deprecated)', {
    description: "Call (deprecated) helper; owner's report is gone",
    tags: ['legacy'],
  });

  insertServer(db, {
    id: 'internal',
    summary: '内部运维平台',
    category: 'ops',
    tags: ['ops'],
  });
  insertTool(db, 'internal', 'plain_tool', {
    displayName: 'secretwidget',
    description: 'Nothing to see here',
    tags: ['ops'],
  });

  for (const server of ['__official__', 'pg-main', 'es-logs', 'legacy', 'internal']) {
    refreshFts(db, server);
  }
}

function fixture(): { db: DatabaseSync; snapshot: ReturnType<typeof buildCatalogSnapshot> } {
  const db = openMemoryDb();
  seedFixture(db);
  return { db, snapshot: buildCatalogSnapshot(db) };
}

function snapshotNames(
  snapshot: ReturnType<typeof buildCatalogSnapshot>,
  input: SearchToolsInput,
): string[] {
  return searchTools(snapshot, input).map((item) => item.name);
}

test('common queries return the same names as the snapshot path', () => {
  const { db, snapshot } = fixture();
  const search = createToolTextSearch({ db });
  for (const query of ['query', '检索', '100%', "owner's", 'select *']) {
    assert.deepEqual(
      search({ query }).map((item) => item.name),
      snapshotNames(snapshot, { query }),
      query,
    );
  }
});

test('equal scoreTool scores are ordered by bm25, not by name', () => {
  // Every pg-main tool inherits the server tag `db`, so all five score 2.
  // The adapter's required order is score desc, then bm25 asc, then name asc.
  const { db, snapshot } = fixture();
  const search = createToolTextSearch({ db });
  const fts = search({ query: 'db' }).map((item) => item.name);
  const snap = snapshotNames(snapshot, { query: 'db' });
  assert.deepEqual([...fts].sort(), [...snap].sort(), 'same recall');
  assert.equal(snap[0], 'pg-main.insert_row', 'the snapshot breaks ties by name');
  assert.notEqual(fts[0], 'pg-main.insert_row', 'bm25 decides the tie in the adapter');
});

test('FTS hits without a literal substring score are dropped like the snapshot', () => {
  // `sql_` tokenizes to `sql`, so FTS also hits the description "List slow SQL
  // statements"; `scoreTool` finds no literal `sql_` there and drops it, which
  // keeps the adapter's recall identical to the snapshot.
  const { db, snapshot } = fixture();
  const search = createToolTextSearch({ db });
  assert.deepEqual(snapshotNames(snapshot, { query: 'sql_' }), ['pg-main.sql_query_v2']);
  assert.deepEqual(search({ query: 'sql_' }).map((item) => item.name), [
    'pg-main.sql_query_v2',
  ]);
});

test('an exact canonical or bare name leads through scoreTool points, not a tier', () => {
  const { db } = fixture();
  const search = createToolTextSearch({ db });
  // scoreTool itself awards +10 for an exact canonical/bare name; there is no
  // separate ranking layer that could force an exact hit above a higher score.
  assert.equal(search({ query: 'pg-main.query' })[0]?.name, 'pg-main.query');
  assert.equal(search({ query: 'query' })[0]?.name, 'pg-main.query');
  assert.equal(search({ query: 'read' })[0]?.name, 'Read');
});

test('a higher scoreTool score beats an exact bare name, including under max=1', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'rank', summary: 'Ranking tools', category: 'tools' });
  insertTool(db, 'rank', 'read', { description: 'Plain reader' });
  insertTool(db, 'rank', 'read_write_search', {
    description: 'Read and write data',
    tags: ['read', 'write'],
  });
  refreshFts(db, 'rank');

  const search = createToolTextSearch({ db });
  const snapshot = buildCatalogSnapshot(db);
  // rank.read: exact bare name 10 + description 1 = 11.
  // rank.read_write_search: name 3+3 + tags 2+2 + description 1+1 = 12.
  // The separate exact-name tier used to force rank.read first and made a
  // max=1 result differ from the snapshot path.
  assert.deepEqual(search({ query: 'read write' }).map((item) => item.name), [
    'rank.read_write_search',
    'rank.read',
  ]);
  assert.deepEqual(search({ query: 'read write', max: 1 }).map((item) => item.name), [
    'rank.read_write_search',
  ]);
  assert.deepEqual(snapshotNames(snapshot, { query: 'read write', max: 1 }), [
    'rank.read_write_search',
  ]);
});

test('a punctuation-only tool name is reachable through the exact-name branch', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'punct', summary: 'Punctuation tools', category: 'tools' });
  insertTool(db, 'punct', '+++', { description: 'Purely symbolic tool' });
  refreshFts(db, 'punct');

  const search = createToolTextSearch({ db });
  // Neither FTS nor LIKE matches the canonical name `punct.+++` on its own:
  // FTS produces no token from `+++`, and the bare name misses the server prefix.
  assert.deepEqual(search({ query: 'punct.+++' }).map((item) => item.name), ['punct.+++']);
  assert.deepEqual(search({ query: '+++' }).map((item) => item.name), ['punct.+++']);
});

test('long queries are split into LIKE batches without dropping terms', () => {
  const { db } = fixture();
  const search = createToolTextSearch({ db });
  for (const count of [1000, 5000]) {
    const filler = Array.from({ length: count }, (_value, index) => `term${index}`);
    // One unbounded OR chain used to fail with "Expression tree is too large".
    assert.deepEqual(search({ query: filler.join(' ') }), []);
    // The matching word sits past the 32-term FTS cap and in the final LIKE
    // batch, so it can only come back if every batch and every term is queried.
    assert.deepEqual(
      search({ query: [...filler, 'query'].join(' ') }).map((item) => item.name),
      ['pg-main.query', 'pg-main.slow_query_log', 'pg-main.sql_query_v2'],
      `${count} terms`,
    );
  }
});

test('a single token over the LIKE limit is dropped without throwing', () => {
  const { db } = fixture();
  const search = createToolTextSearch({ db });
  // One 50k-character token used to reach SQLite as a LIKE pattern and raise
  // "LIKE or GLOB pattern too complex"; the adapter must still answer [].
  assert.deepEqual(search({ query: 'a'.repeat(50_000) }), []);
});

test('server summaries never drive keyword matching', () => {
  const { db, snapshot } = fixture();
  const search = createToolTextSearch({ db });
  assert.deepEqual(search({ query: 'warehouse' }), []);
  assert.deepEqual(snapshotNames(snapshot, { query: 'warehouse' }), []);
});

test('server ids never drive keyword matching in the FTS path', () => {
  const { db } = fixture();
  const search = createToolTextSearch({ db });
  assert.deepEqual(search({ query: 'pg-main' }), []);
  // The DB snapshot stores canonical `<server>.<tool>` names, so the snapshot
  // path does see the server prefix; the adapter deliberately does not index it.
  assert.deepEqual(snapshotNames(buildCatalogSnapshot(db), { query: 'pg-main' }), [
    'pg-main.insert_row',
    'pg-main.percent_stats',
    'pg-main.query',
    'pg-main.slow_query_log',
    'pg-main.sql_query_v2',
  ]);
});

test('display names never drive keyword matching', () => {
  const { db, snapshot } = fixture();
  const search = createToolTextSearch({ db });
  assert.deepEqual(search({ query: 'secretwidget' }), []);
  assert.deepEqual(snapshotNames(snapshot, { query: 'secretwidget' }), []);
});

test('Chinese mid-token matches merge in while FTS has other hits', () => {
  const { db, snapshot } = fixture();
  const search = createToolTextSearch({ db });
  // `search_help` matches FTS through the token starting with 检索; `日志检索`
  // is only reachable through the LIKE substring, and must survive the merge.
  assert.deepEqual(search({ query: '检索' }).map((item) => item.name), [
    'es-logs.日志检索',
    'es-logs.search_help',
  ]);
  assert.deepEqual(
    search({ query: '检索' }).map((item) => item.name),
    snapshotNames(snapshot, { query: '检索' }),
  );
});

test('server, category and all-of tags narrow before ordering and limit', () => {
  const { db, snapshot } = fixture();
  const search = createToolTextSearch({ db });
  const cases: SearchToolsInput[] = [
    { query: 'db', server: 'pg-main' },
    { query: 'db', server: '__official__' },
    { query: 'db', category: 'database' },
    { query: 'db', category: 'vcs' },
    { query: 'db', tags: ['db'] },
    { query: 'db', tags: ['db', 'read'] },
    { query: 'db', tags: ['db', 'write'] },
    { query: 'db', tags: ['db', 'nope'] },
    { query: 'read', server: 'legacy' },
  ];
  for (const input of cases) {
    assert.deepEqual(
      search(input).map((item) => item.name).sort(),
      snapshotNames(snapshot, input).sort(),
      JSON.stringify(input),
    );
  }
});

test('allowedServers and allowedTags keep the snapshot semantics', () => {
  const { db, snapshot } = fixture();
  const search = createToolTextSearch({ db });
  const cases: Array<[SearchToolsInput, ToolVisibility]> = [
    [{ query: 'read' }, {}],
    [{ query: 'read' }, { allowedServers: ['pg-main'] }],
    [{ query: 'read' }, { allowedServers: [] }],
    [{ query: 'read' }, { allowedServers: ['legacy'] }],
    [{ query: 'read' }, { allowedTags: ['files'] }],
    [{ query: 'read' }, { allowedTags: [] }],
    [{ query: 'search' }, { allowedTags: ['WEB'] }],
  ];
  for (const [input, visibility] of cases) {
    assert.deepEqual(
      search(input, visibility).map((item) => item.name).sort(),
      searchTools(snapshot, { ...input, ...visibility }).map((item) => item.name).sort(),
      JSON.stringify({ input, visibility }),
    );
  }
});

test('result objects match the snapshot shape exactly', () => {
  const { db, snapshot } = fixture();
  const search = createToolTextSearch({ db });
  for (const query of ['insert', 'read', '日志']) {
    assert.deepEqual(search({ query }), searchTools(snapshot, { query }), query);
  }
});

test('max defaults to 10 and the protocol caps it at 50', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'bulk', transport: 'builtin' });
  for (let index = 0; index < 55; index += 1) {
    insertTool(db, 'bulk', `bulk_${String(index).padStart(2, '0')}`, {
      description: 'limit fixture tool',
    });
  }
  refreshFts(db, 'bulk');
  const search = createToolTextSearch({ db });
  const snapshot = buildCatalogSnapshot(db);
  assert.equal(search({ query: 'bulk' }).length, 10);
  assert.equal(search({ query: 'bulk', max: 1 }).length, 1);
  assert.equal(search({ query: 'bulk', max: 50 }).length, 50);
  assert.equal(searchTools(snapshot, { query: 'bulk' }).length, 10);
  assert.equal(searchTools(snapshot, { query: 'bulk', max: 50 }).length, 50);
});

test('a negative or non-finite max falls back to the default limit', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'bulk', transport: 'builtin' });
  for (let index = 0; index < 12; index += 1) {
    insertTool(db, 'bulk', `bulk_${String(index).padStart(2, '0')}`, {
      description: 'limit fixture tool',
    });
  }
  refreshFts(db, 'bulk');
  const snapshot = buildCatalogSnapshot(db);
  for (const max of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      searchTools(snapshot, { query: 'bulk', max }).length,
      10,
      `max=${String(max)} must fall back to the default`,
    );
  }
});

test('the SQL prefilter matches the snapshot: no protocol tools, disabled or hidden-stale', () => {
  const db = openMemoryDb();
  insertServer(db, { id: 'ops', summary: 'Ops', category: 'ops' });
  insertTool(db, 'ops', 'visible', { description: 'Ship the build' });
  insertTool(db, 'ops', 'disabled', { description: 'Ship the build', enabled: 0 });
  insertTool(db, 'ops', 'hidden_stale', { description: 'Ship the build', stale: 1 });
  insertTool(db, 'ops', 'kept_stale', {
    description: 'Ship the build',
    stale: 1,
    staleOverride: 1,
  });
  insertServer(db, { id: 'off', summary: 'Off', enabled: 0 });
  insertTool(db, 'off', 'server_off', { description: 'Ship the build' });
  insertServer(db, { id: '__builtin__', transport: 'builtin' });
  insertTool(db, '__builtin__', 'protocol_tool', { description: 'Ship the build' });
  for (const server of ['ops', 'off', '__builtin__']) refreshFts(db, server);

  const search = createToolTextSearch({ db });
  assert.deepEqual(
    search({ query: 'ship' }).map((item) => item.name).sort(),
    snapshotNames(buildCatalogSnapshot(db), { query: 'ship' }).sort(),
  );
  assert.deepEqual(search({ query: 'ship' }).map((item) => item.name), [
    'ops.visible',
    'ops.kept_stale',
  ]);
});

const IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'test-client/1.0',
  mcp: 'mcp_1',
};

function stubGateway(): ExecutionGateway {
  return {
    runScript: async () => ({ content: '', isError: false }),
    dispatchScript: async () => ({ taskId: 't_1', evalId: 1, runId: 'r_1' }),
    waitTasks: async () => null,
    getTask: async () => null,
    cancelTask: async () => true,
    destroyOwner: async () => {},
    destroyTransport: async () => {},
  };
}

function callResult(result: Awaited<ReturnType<typeof callTool>>): CallToolResult {
  return result as CallToolResult;
}

function callText(result: CallToolResult): unknown {
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === 'text');
  return JSON.parse(block.text);
}

test('search_tools uses the injected port only for non-empty queries', async () => {
  const { db, snapshot } = fixture();
  const tools = createToolTextSearch({ db });
  const tasks = new McpTaskStore({
    clock: { now: () => Date.UTC(2026, 10, 18, 6, 0, 0) },
    idFactory: () => 't_1',
  });
  const catalog: Catalog = { snapshot: () => snapshot };
  const base: ToolCallContext = {
    identity: IDENTITY,
    gateway: stubGateway(),
    catalog,
    tasks,
  };
  const withPort: ToolCallContext = { ...base, toolTextSearch: tools };

  for (const query of ['query', 'read', '检索']) {
    assert.deepEqual(
      callText(callResult(await callTool('search_tools', { query }, withPort))),
      callText(callResult(await callTool('search_tools', { query }, base))),
      query,
    );
  }

  let portCalls = 0;
  const counting: ToolCallContext = {
    ...base,
    toolTextSearch: (input, visibility) => {
      portCalls += 1;
      return tools(input, visibility);
    },
  };
  const overview = callText(callResult(await callTool('search_tools', {}, counting)));
  assert.ok(Array.isArray(overview));
  assert.equal(portCalls, 0, 'the empty-query overview stays on the snapshot path');

  callText(callResult(await callTool('search_tools', { query: '   ' }, counting)));
  assert.equal(portCalls, 0, 'a whitespace-only query is still empty');

  callText(callResult(await callTool('search_tools', { query: 'read' }, counting)));
  assert.equal(portCalls, 1);
});

test('search_tools enforces the 200-character query cap', async () => {
  const { db, snapshot } = fixture();
  const tasks = new McpTaskStore({
    clock: { now: () => Date.UTC(2026, 10, 18, 6, 0, 0) },
    idFactory: () => 't_1',
  });
  const ctx: ToolCallContext = {
    identity: IDENTITY,
    gateway: stubGateway(),
    catalog: { snapshot: () => snapshot },
    tasks,
    toolTextSearch: createToolTextSearch({ db }),
  };

  const rejected = callResult(await callTool('search_tools', { query: 'a'.repeat(201) }, ctx));
  assert.equal(rejected.isError, true);
  assert.deepEqual(callText(rejected), {
    ok: false,
    error: {
      code: 'INVALID_ARGUMENT',
      message: 'search_tools.query must be at most 200 character(s)',
    },
  });

  const accepted = callResult(await callTool('search_tools', { query: 'a'.repeat(200) }, ctx));
  assert.equal(accepted.isError, false);
  assert.deepEqual(callText(accepted), []);
});
