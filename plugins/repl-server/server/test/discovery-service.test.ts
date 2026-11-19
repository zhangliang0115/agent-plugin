import assert from 'node:assert/strict';
import test from 'node:test';

import { McpToolError } from '@zhangliang0115/repl-server-core/src/errors.ts';

import { AdminApiError } from '../src/admin/servers.ts';
import {
  buildCatalogSnapshot,
  refreshFts,
  searchTools as catalogSearch,
} from '../src/catalog/index.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { getRevision } from '../src/db/meta.ts';
import { createServer, getServer, updateServer } from '../src/db/servers.ts';
import { getTool, listTools, patchTool, upsertTool } from '../src/db/tools.ts';
import { decodeStoredDiscovery } from '../src/discovery/config.ts';
import {
  createDiscoveryService,
  DISCOVERY_PREVIEW_TTL_MS,
  type DiscoveryPoolPort,
  type DiscoveryServerRecord,
  type DiscoveryServerSource,
  type DiscoveryService,
} from '../src/discovery/service.ts';
import { DISCOVERY_SEARCH_LIMIT } from '../src/discovery/store.ts';
import type { AuditSink } from '../src/ports.ts';
import { describeTools } from '../src/tools/describe.ts';
import { searchTools as snapshotSearch } from '../src/tools/search.ts';

interface Harness {
  db: ReturnType<typeof openStateDb>;
  pool: FakePool;
  catalog: { refreshes: string[]; refreshServer(id: string): void };
  service: DiscoveryService;
  now: () => number;
  advance(ms: number): void;
}

class FakePool implements DiscoveryPoolPort {
  readonly calls: Array<{
    serverId: string;
    tool: string;
    args: unknown;
    signal: AbortSignal;
  }> = [];
  readonly invalidated: string[] = [];
  result: unknown = { content: [{ type: 'text', text: JSON.stringify({ tools: [] }) }] };
  error: Error | null = null;
  blocker: Promise<void> | null = null;

  async discoverTools(
    serverId: string,
    options: { tool: string; args: unknown; signal: AbortSignal; timeoutMs: number },
  ): Promise<unknown> {
    this.calls.push({ serverId, tool: options.tool, args: options.args, signal: options.signal });
    if (this.blocker !== null) await this.blocker;
    if (options.signal.aborted) {
      throw new McpToolError('cancelled', { code: 'MCP_CALL_CANCELLED', server: serverId });
    }
    if (this.error !== null) throw this.error;
    return this.result;
  }

  invalidatePrepared(serverId: string): void {
    this.invalidated.push(serverId);
  }
}

function serverSource(db: ReturnType<typeof openStateDb>): DiscoveryServerSource {
  return {
    get(id: string): DiscoveryServerRecord | null {
      const row = getServer(db, id);
      if (row === null) return null;
      return {
        id: row.id,
        transport: row.transport,
        enabled: row.enabled,
        toolDiscovery: decodeStoredDiscovery(row.discoveryJson),
      };
    },
    revision: () => getRevision(db),
  };
}

function harness(options: { audit?: AuditSink } = {}): Harness {
  const db = openStateDb(':memory:');
  const pool = new FakePool();
  const catalog = {
    refreshes: [] as string[],
    refreshServer(id: string): void {
      this.refreshes.push(id);
    },
  };
  let current = 1_700_000_000_000;
  const service = createDiscoveryService({
    db,
    servers: serverSource(db),
    catalog,
    pool,
    clock: { now: () => current },
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
  return {
    db,
    pool,
    catalog,
    service,
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function addServer(
  db: ReturnType<typeof openStateDb>,
  id = 'lazy',
  options: { enabled?: boolean; transport?: 'stdio' | 'http' } = {},
): void {
  createServer(db, {
    id,
    label: id,
    transport: options.transport ?? 'http',
    url: (options.transport ?? 'http') === 'http' ? 'https://example.test/mcp' : null,
    command: (options.transport ?? 'http') === 'stdio' ? 'node' : null,
    enabled: options.enabled ?? true,
    discoveryJson: JSON.stringify({ mode: 'search', searchTool: 'search_tools' }),
  });
}

function addStaticTools(db: ReturnType<typeof openStateDb>, serverId = 'lazy'): void {
  upsertTool(db, serverId, {
    name: 'search_tools',
    description: 'Search upstream tools',
    inputSchema: { type: 'object' },
  });
}

function addTool(
  db: ReturnType<typeof openStateDb>,
  name: string,
  options: { via?: 'static' | 'search'; serverId?: string; schema?: unknown } = {},
): void {
  upsertTool(db, options.serverId ?? 'lazy', {
    name,
    description: `${name} description`,
    inputSchema: options.schema ?? { type: 'object', properties: {} },
    ...(options.via === undefined ? {} : { discoveredVia: options.via }),
  });
}

function searchResult(tools: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify({ tools, ...extra }) }],
    isError: false,
  };
}

function discoveredTool(name: string, schema: unknown = { type: 'object', properties: {} }): Record<string, unknown> {
  return { name, description: `${name} discovered`, inputSchema: schema };
}

async function expectRejection(promise: Promise<unknown>, check: (error: AdminApiError) => void): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AdminApiError, `expected AdminApiError, got ${String(error)}`);
    check(error);
    return true;
  });
}

test('preview returns tools/conflicts without writing the database', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  addTool(env.db, 'already_search', { via: 'search' });
  const beforeTools = listTools(env.db, 'lazy');
  const beforeRevision = getRevision(env.db);
  env.pool.result = searchResult([
    discoveredTool('list_tables'),
    discoveredTool('already_search'),
    discoveredTool('search_tools'),
  ]);

  const response = await env.service.preview('lazy', {
    searchTool: 'search_tools',
    query: 'database',
  });

  assert.equal(response.serverId, 'lazy');
  assert.equal(response.searchTool, 'search_tools');
  assert.equal(response.query, 'database');
  assert.deepEqual(response.effectiveConfig, {
    mode: 'search',
    searchTool: 'search_tools',
    query: 'database',
    args: {},
    maxTools: 50,
    prepareOnCall: true,
  });
  assert.equal(response.parsed, true);
  assert.equal(response.shape, 'call_result_tools');
  assert.equal(response.partial, false);
  assert.equal(response.omitted, 0);
  assert.equal(response.nextCursor, null);
  assert.equal(response.willStaleCount, 0);
  assert.deepEqual(env.pool.calls[0]?.args, { query: 'database' });
  assert.deepEqual(env.pool.invalidated, ['lazy']);

  const byName = new Map(response.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('list_tables')?.action, 'create');
  assert.equal(byName.get('list_tables')?.conflict, 'none');
  assert.equal(byName.get('already_search')?.action, 'update');
  assert.equal(byName.get('already_search')?.conflict, 'search');
  assert.equal(byName.get('search_tools')?.action, 'skip_static');
  assert.equal(byName.get('search_tools')?.conflict, 'static');

  assert.deepEqual(listTools(env.db, 'lazy'), beforeTools);
  assert.equal(getRevision(env.db), beforeRevision);
  assert.equal(getServer(env.db, 'lazy')?.discoveryJson, JSON.stringify({ mode: 'search', searchTool: 'search_tools' }));
});

test('preview validates the merged config with the shared rules', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);

  await expectRejection(
    env.service.preview('lazy', {
      searchTool: 'search_tools',
      args: { token: { $secret: 'TOKEN' } },
    }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'DISCOVERY_SECRET_NOT_ALLOWED');
    },
  );
  assert.equal(env.pool.calls.length, 0);

  await expectRejection(
    env.service.preview('lazy', { searchTool: 'missing_tool' }),
    (error) => {
      assert.equal(error.code, 'DISCOVERY_SEARCH_TOOL_NOT_FOUND');
      assert.deepEqual((error.details as { availableTools: string[] }).availableTools, ['search_tools']);
    },
  );

  await expectRejection(
    env.service.preview('lazy', { maxTools: 0 }),
    (error) => {
      assert.equal(error.code, 'DISCOVERY_CONFIG_INVALID');
    },
  );
});

test('A-07: builtin and disabled servers cannot be scanned', async () => {
  const env = harness();
  addServer(env.db, 'off', { enabled: false });
  addStaticTools(env.db, 'off');

  await expectRejection(env.service.preview('__official__', { searchTool: 'x' }), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'NOT_CONNECTABLE');
  });
  await expectRejection(env.service.preview('off', { searchTool: 'search_tools' }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'SERVER_DISABLED');
  });
  await expectRejection(env.service.preview('missing', { searchTool: 'search_tools' }), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.code, 'SERVER_NOT_FOUND');
  });
});

test('a server without tool rows reports DISCOVERY_NO_TOOLS', async () => {
  const env = harness();
  addServer(env.db);
  await expectRejection(env.service.preview('lazy', { searchTool: 'search_tools' }), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'DISCOVERY_NO_TOOLS');
  });
});

test('concurrent previews for one server get DISCOVERY_BUSY', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  env.pool.result = searchResult([discoveredTool('a')]);
  let release!: () => void;
  env.pool.blocker = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = env.service.preview('lazy', { searchTool: 'search_tools', timeoutMs: 2_000 });
  await Promise.resolve();
  await expectRejection(
    env.service.preview('lazy', { searchTool: 'search_tools', timeoutMs: 2_000 }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'DISCOVERY_BUSY');
    },
  );
  release();
  await first;
});

test('a scanner timeout maps to DISCOVERY_TIMEOUT and invalidates prepare state', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  env.pool.blocker = new Promise<void>(() => {});

  await expectRejection(
    env.service.preview('lazy', { searchTool: 'search_tools', timeoutMs: 10 }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'DISCOVERY_TIMEOUT');
    },
  );
  assert.deepEqual(env.pool.invalidated, ['lazy']);
});

test('search tool errors map to the frozen 503 codes', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);

  env.pool.error = new McpToolError('search tool failed', { code: 'MCP_TOOL_ERROR', detail: { reason: 'x' } });
  await expectRejection(env.service.preview('lazy', { searchTool: 'search_tools' }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'DISCOVERY_SEARCH_TOOL_ERROR');
  });

  env.pool.error = new McpToolError('timeout', { code: 'MCP_CALL_TIMEOUT' });
  await expectRejection(env.service.preview('lazy', { searchTool: 'search_tools' }), (error) => {
    assert.equal(error.code, 'DISCOVERY_TIMEOUT');
  });
});

test('apply writes rows, discovery_json and one revision, then refreshes the catalog', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  env.pool.result = searchResult([discoveredTool('list_tables'), discoveredTool('describe_table')]);

  const preview = await env.service.preview('lazy', {
    searchTool: 'search_tools',
    query: 'database',
  });
  const revisionBefore = getRevision(env.db);
  const result = await env.service.apply('lazy', {
    discoveryId: preview.discoveryId,
    expectedRevision: revisionBefore,
  });

  assert.deepEqual(result, {
    serverId: 'lazy',
    applied: 2,
    created: 2,
    updated: 0,
    skippedStatic: 0,
    skippedOther: 0,
    stale: 0,
    revision: revisionBefore + 1,
  });
  assert.equal(getRevision(env.db), revisionBefore + 1);
  assert.deepEqual(
    listTools(env.db, 'lazy').filter((tool) => tool.discoveredVia === 'search').map((tool) => tool.name),
    ['describe_table', 'list_tables'],
  );
  const server = getServer(env.db, 'lazy');
  assert.deepEqual(decodeStoredDiscovery(server?.discoveryJson ?? null), {
    mode: 'search',
    searchTool: 'search_tools',
    query: 'database',
    args: {},
    maxTools: 50,
    prepareOnCall: true,
  });
  assert.equal(server?.revision, 2, 'server revision bumps once when the config changes');
  assert.deepEqual(env.catalog.refreshes, ['lazy']);

  await expectRejection(
    env.service.apply('lazy', {
      discoveryId: preview.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 410);
      assert.equal(error.code, 'DISCOVERY_PREVIEW_EXPIRED');
      assert.equal((error.details as { reason: string }).reason, 'applied');
    },
  );
});

test('a stale If-Match rejects the apply and keeps the preview retryable', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  env.pool.result = searchResult([discoveredTool('a')]);
  const preview = await env.service.preview('lazy', { searchTool: 'search_tools' });

  await expectRejection(
    env.service.apply('lazy', {
      discoveryId: preview.discoveryId,
      expectedRevision: 999,
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'REVISION_CONFLICT');
    },
  );

  const result = await env.service.apply('lazy', {
    discoveryId: preview.discoveryId,
    expectedRevision: getRevision(env.db),
  });
  assert.equal(result.created, 1);
});

test('re-scan marks absent search rows stale; accept does not define the stale set', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  addTool(env.db, 'a', { via: 'search' });
  addTool(env.db, 'b', { via: 'search' });
  addTool(env.db, 'c', { via: 'search' });
  addTool(env.db, 'old_tool', { via: 'search' });
  env.pool.result = searchResult([discoveredTool('a'), discoveredTool('b'), discoveredTool('c')]);

  const preview = await env.service.preview('lazy', { searchTool: 'search_tools' });
  assert.deepEqual(preview.willStale, ['old_tool']);
  assert.equal(preview.willStaleCount, 1);

  const result = await env.service.apply('lazy', {
    discoveryId: preview.discoveryId,
    expectedRevision: getRevision(env.db),
    accept: ['a'],
    staleOthers: true,
  });
  assert.equal(result.updated, 1);
  assert.equal(result.stale, 1);

  const rows = new Map(listTools(env.db, 'lazy').map((row) => [row.name, row]));
  assert.equal(rows.get('a')?.stale, false);
  assert.equal(rows.get('b')?.stale, false, 'b returned but was not accepted → not stale');
  assert.equal(rows.get('c')?.stale, false);
  assert.equal(rows.get('old_tool')?.stale, true);
});

test('partial previews require confirmPartialStale before stale marking', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  addTool(env.db, 'old_tool', { via: 'search' });
  env.pool.result = searchResult([discoveredTool('a')], { nextCursor: 'page-2' });

  const preview = await env.service.preview('lazy', { searchTool: 'search_tools' });
  assert.equal(preview.partial, true);
  assert.equal(preview.nextCursor, 'page-2');

  await expectRejection(
    env.service.apply('lazy', {
      discoveryId: preview.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'DISCOVERY_PARTIAL_STALE_UNCONFIRMED');
      assert.deepEqual(error.details, { nextCursor: 'page-2', omitted: 0 });
    },
  );
  assert.equal(getTool(env.db, 'lazy', 'old_tool')?.stale, false, 'rejected apply wrote nothing');

  const noStale = await env.service.apply('lazy', {
    discoveryId: preview.discoveryId,
    expectedRevision: getRevision(env.db),
    staleOthers: false,
  });
  assert.equal(noStale.created, 1);
  assert.equal(noStale.stale, 0);
  assert.equal(getTool(env.db, 'lazy', 'old_tool')?.stale, false);

  const second = await env.service.preview('lazy', { searchTool: 'search_tools' });
  const confirmed = await env.service.apply('lazy', {
    discoveryId: second.discoveryId,
    expectedRevision: getRevision(env.db),
    confirmPartialStale: true,
  });
  assert.equal(confirmed.stale, 1);
  assert.equal(getTool(env.db, 'lazy', 'old_tool')?.stale, true);
});

test('an unparseable preview needs allowEmpty and never marks tools stale', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  addTool(env.db, 'old_tool', { via: 'search' });
  env.pool.result = { content: [{ type: 'text', text: 'not json' }], isError: false };

  const preview = await env.service.preview('lazy', { searchTool: 'search_tools' });
  assert.equal(preview.parsed, false);
  assert.equal(preview.raw, 'not json');

  await expectRejection(
    env.service.apply('lazy', {
      discoveryId: preview.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'DISCOVERY_EMPTY_PREVIEW');
      assert.deepEqual(error.details, { discoveryId: preview.discoveryId, parsed: false });
    },
  );

  const result = await env.service.apply('lazy', {
    discoveryId: preview.discoveryId,
    expectedRevision: getRevision(env.db),
    allowEmpty: true,
  });
  assert.equal(result.applied, 0);
  assert.equal(result.stale, 0);
  assert.equal(getTool(env.db, 'lazy', 'old_tool')?.stale, false);
});

test('accept names must exist in the preview; unknown ids are 404 and expired ones 410', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  addServer(env.db, 'other');
  addStaticTools(env.db, 'other');
  env.pool.result = searchResult([discoveredTool('a')]);

  const preview = await env.service.preview('lazy', { searchTool: 'search_tools' });

  await expectRejection(
    env.service.apply('lazy', {
      discoveryId: preview.discoveryId,
      expectedRevision: getRevision(env.db),
      accept: ['nope'],
    }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'DISCOVERY_UNKNOWN_TOOL');
      assert.deepEqual(error.details, { names: ['nope'] });
    },
  );

  await expectRejection(
    env.service.apply('other', {
      discoveryId: preview.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, 'DISCOVERY_PREVIEW_NOT_FOUND');
    },
  );

  await expectRejection(
    env.service.apply('lazy', { discoveryId: 'disc_missing', expectedRevision: getRevision(env.db) }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, 'DISCOVERY_PREVIEW_NOT_FOUND');
    },
  );

  env.advance(DISCOVERY_PREVIEW_TTL_MS + 1);
  await expectRejection(
    env.service.apply('lazy', {
      discoveryId: preview.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 410);
      assert.equal((error.details as { reason: string }).reason, 'expired');
    },
  );
});

test('overwriteStatic updates a static row and preserves admin fields', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  addTool(env.db, 'echo', { schema: { type: 'object', properties: { old: {} } } });
  patchTool(env.db, 'lazy', 'echo', {
    description: 'admin description',
    enabled: false,
    tags: ['keep'],
  });
  env.pool.result = searchResult([
    discoveredTool('echo', { type: 'object', properties: { next: { type: 'string' } } }),
  ]);

  const skippedPreview = await env.service.preview('lazy', { searchTool: 'search_tools' });
  assert.equal(skippedPreview.tools[0]?.action, 'skip_static');
  const skipped = await env.service.apply('lazy', {
    discoveryId: skippedPreview.discoveryId,
    expectedRevision: getRevision(env.db),
  });
  assert.equal(skipped.created, 0);
  assert.equal(skipped.skippedStatic, 1);
  assert.equal(getTool(env.db, 'lazy', 'echo')?.inputSchema !== undefined, true);

  const preview = await env.service.preview('lazy', {
    searchTool: 'search_tools',
    overwriteStatic: true,
  });
  assert.equal(preview.tools[0]?.action, 'update');
  const result = await env.service.apply('lazy', {
    discoveryId: preview.discoveryId,
    expectedRevision: getRevision(env.db),
    overwriteStatic: true,
  });
  assert.equal(result.updated, 1);
  const echo = getTool(env.db, 'lazy', 'echo');
  assert.equal(echo?.discoveredVia, 'search');
  assert.equal(echo?.descriptionOverride, 'admin description');
  assert.equal(echo?.enabled, false);
  assert.deepEqual(echo?.tags, ['keep']);
  assert.deepEqual(echo?.inputSchema, { type: 'object', properties: { next: { type: 'string' } } });
});

test('maxTools truncates the preview but the stale baseline keeps every parsed name', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  addTool(env.db, 'old_tool', { via: 'search' });
  env.pool.result = searchResult([
    discoveredTool('t1'),
    discoveredTool('t2'),
    discoveredTool('t3'),
  ]);

  const preview = await env.service.preview('lazy', { searchTool: 'search_tools', maxTools: 1 });
  assert.deepEqual(preview.tools.map((tool) => tool.name), ['t1']);
  assert.equal(preview.omitted, 2);
  assert.equal(preview.partial, true);

  const result = await env.service.apply('lazy', {
    discoveryId: preview.discoveryId,
    expectedRevision: getRevision(env.db),
    confirmPartialStale: true,
  });
  assert.equal(result.created, 1);
  assert.equal(result.stale, 1, 'old_tool is absent from the complete parsed set');
  assert.equal(getTool(env.db, 'lazy', 't2'), null, 'truncated tools are not written');
});

test('switching back to static demotes every search row, including staleOverride', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  addTool(env.db, 'lazy_tool', { via: 'search' });
  addTool(env.db, 'kept_tool', { via: 'search' });
  patchTool(env.db, 'lazy', 'kept_tool', { staleOverride: true });
  addTool(env.db, 'static_tool');

  const demoted = await env.service.demote('lazy');
  assert.equal(demoted, 2);
  assert.equal(getTool(env.db, 'lazy', 'lazy_tool')?.stale, true);
  assert.equal(getTool(env.db, 'lazy', 'kept_tool')?.stale, true);
  assert.equal(getTool(env.db, 'lazy', 'static_tool')?.stale, false);
  assert.deepEqual(env.catalog.refreshes, ['lazy']);
});

test('prepareFor only warms search rows of a search-mode server', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  addTool(env.db, 'lazy_tool', { via: 'search' });
  addTool(env.db, 'static_tool');

  const descriptor = await env.service.prepareFor('lazy', 'lazy_tool');
  assert.equal(descriptor?.prepare.tool, 'search_tools');
  assert.deepEqual(descriptor?.prepare.args, { query: 'lazy_tool' });
  assert.equal(descriptor?.prepare.cacheKey, 'lazy_tool');
  assert.equal(typeof descriptor?.prepare.onPrepared, 'function');
  assert.equal(descriptor?.searchTool, 'search_tools');
  assert.equal(descriptor?.query, 'lazy_tool');
  assert.deepEqual(descriptor?.args, { query: 'lazy_tool' });
  const parsedNames = descriptor?.prepare.onPrepared?.({
    content: [{ type: 'text', text: JSON.stringify({ tools: [{ name: 'lazy_tool' }] }) }],
  });
  assert.deepEqual(parsedNames, ['lazy_tool']);
  assert.equal(descriptor?.prepare.onPrepared?.({ nonsense: true }), undefined);
  assert.equal(await env.service.prepareFor('lazy', 'static_tool'), null);
  assert.equal(await env.service.prepareFor('lazy', 'missing'), null);

  updateServer(env.db, 'lazy', {
    discoveryJson: JSON.stringify({
      mode: 'search',
      searchTool: 'search_tools',
      args: { q: '$query' },
      prepareOnCall: false,
    }),
  });
  assert.equal(await env.service.prepareFor('lazy', 'lazy_tool'), null);

  updateServer(env.db, 'lazy', {
    discoveryJson: JSON.stringify({ mode: 'search', searchTool: 'search_tools', args: { q: '$query' } }),
  });
  const substituted = await env.service.prepareFor('lazy', 'lazy_tool');
  assert.deepEqual(substituted?.args, { q: 'lazy_tool' });

  patchTool(env.db, 'lazy', 'lazy_tool', { staleOverride: true });
  env.db.prepare("UPDATE tools SET stale = 1 WHERE server_id = 'lazy' AND name = 'lazy_tool'").run();
  assert.equal(await env.service.prepareFor('lazy', 'lazy_tool'), null);
});

test('discovery_preview/apply audits carry counts only, never raw output or args', async () => {
  const records: Array<Record<string, unknown>> = [];
  const env = harness({
    audit: {
      write: (event) => {
        records.push({ ...event });
      },
    },
  });
  addServer(env.db);
  addStaticTools(env.db);
  addTool(env.db, 'old_tool', { via: 'search' });
  env.pool.result = searchResult([
    {
      name: 'leaky_tool',
      description: 'audit-description-leak',
      inputSchema: {
        type: 'object',
        properties: { secret: { const: 'audit-schema-leak' } },
      },
    },
    discoveredTool('plain_tool'),
  ]);

  const preview = await env.service.preview('lazy', {
    searchTool: 'search_tools',
    query: 'audit-query-needle',
  });
  const result = await env.service.apply('lazy', {
    discoveryId: preview.discoveryId,
    expectedRevision: getRevision(env.db),
  });

  assert.equal(records.length, 2);
  const previewEvent = records[0];
  const applyEvent = records[1];
  assert.ok(previewEvent !== undefined && applyEvent !== undefined);

  assert.equal(previewEvent['event'], 'discovery_preview');
  assert.equal(previewEvent['server'], 'lazy');
  assert.equal(previewEvent['searchTool'], 'search_tools');
  assert.equal(previewEvent['queryLength'], 'audit-query-needle'.length);
  assert.equal(previewEvent['shape'], 'call_result_tools');
  assert.equal(previewEvent['count'], 2);
  assert.equal(typeof previewEvent['elapsedMs'], 'number');
  assert.equal(typeof previewEvent['ts'], 'string');
  assert.equal(Object.hasOwn(previewEvent, 'raw'), false);
  assert.equal(Object.hasOwn(previewEvent, 'args'), false);

  assert.equal(applyEvent['event'], 'discovery_apply');
  assert.equal(applyEvent['server'], 'lazy');
  assert.equal(applyEvent['created'], 2);
  assert.equal(applyEvent['updated'], 0);
  assert.equal(applyEvent['skippedStatic'], 0);
  assert.equal(applyEvent['stale'], 1);
  assert.equal(applyEvent['revision'], result.revision);
  assert.equal(typeof applyEvent['ts'], 'string');
  assert.equal(Object.hasOwn(applyEvent, 'raw'), false);
  assert.equal(Object.hasOwn(applyEvent, 'args'), false);

  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes('audit-query-needle'), false);
  assert.equal(serialized.includes('audit-schema-leak'), false);
  assert.equal(serialized.includes('audit-description-leak'), false);
});

test('tombstones remember the owning server for applied and expired previews', async () => {
  const env = harness();
  addServer(env.db, 'lazy');
  addStaticTools(env.db, 'lazy');
  addServer(env.db, 'other');
  addStaticTools(env.db, 'other');
  env.pool.result = searchResult([discoveredTool('t1')]);

  const applied = await env.service.preview('lazy', { searchTool: 'search_tools' });
  await env.service.apply('lazy', {
    discoveryId: applied.discoveryId,
    expectedRevision: getRevision(env.db),
  });

  await expectRejection(
    env.service.apply('lazy', {
      discoveryId: applied.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 410);
      assert.equal((error.details as { reason: string }).reason, 'applied');
    },
  );
  await expectRejection(
    env.service.apply('other', {
      discoveryId: applied.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, 'DISCOVERY_PREVIEW_NOT_FOUND');
    },
  );

  // Expired preview still in the map: the server check wins over the 410.
  const liveExpired = await env.service.preview('lazy', { searchTool: 'search_tools' });
  env.advance(DISCOVERY_PREVIEW_TTL_MS + 1);
  await expectRejection(
    env.service.apply('other', {
      discoveryId: liveExpired.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, 'DISCOVERY_PREVIEW_NOT_FOUND');
    },
  );

  // Eviction moves the preview into a tombstone; same server gets 410, other 404.
  const evicted = await env.service.preview('lazy', { searchTool: 'search_tools' });
  env.advance(DISCOVERY_PREVIEW_TTL_MS + 1);
  await env.service.preview('other', { searchTool: 'search_tools' });
  await expectRejection(
    env.service.apply('lazy', {
      discoveryId: evicted.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 410);
      assert.equal(error.code, 'DISCOVERY_PREVIEW_EXPIRED');
      assert.equal((error.details as { reason: string }).reason, 'expired');
    },
  );
  await expectRejection(
    env.service.apply('other', {
      discoveryId: evicted.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, 'DISCOVERY_PREVIEW_NOT_FOUND');
    },
  );
});

test('E-02: a fresh service instance returns 404 for a discoveryId from before the restart', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  env.pool.result = searchResult([discoveredTool('t1')]);

  const preview = await env.service.preview('lazy', { searchTool: 'search_tools' });
  const restarted = createDiscoveryService({
    db: env.db,
    servers: serverSource(env.db),
    catalog: env.catalog,
    pool: env.pool,
    clock: { now: env.now },
  });

  await expectRejection(
    restarted.apply('lazy', {
      discoveryId: preview.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, 'DISCOVERY_PREVIEW_NOT_FOUND');
    },
  );

  const result = await env.service.apply('lazy', {
    discoveryId: preview.discoveryId,
    expectedRevision: getRevision(env.db),
  });
  assert.equal(result.created, 1, 'the original instance still owns the preview');
});

test('DISCOVERY_LIMIT rejects the would-be 501st search row with limit/current', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  for (let index = 0; index < DISCOVERY_SEARCH_LIMIT; index += 1) {
    addTool(env.db, `row_${String(index).padStart(3, '0')}`, { via: 'search' });
  }
  env.pool.result = searchResult([discoveredTool('row_500')]);

  const preview = await env.service.preview('lazy', { searchTool: 'search_tools' });
  assert.deepEqual(preview.tools.map((tool) => tool.name), ['row_500']);

  await expectRejection(
    env.service.apply('lazy', {
      discoveryId: preview.discoveryId,
      expectedRevision: getRevision(env.db),
    }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'DISCOVERY_LIMIT');
      assert.deepEqual(error.details, {
        limit: DISCOVERY_SEARCH_LIMIT,
        current: DISCOVERY_SEARCH_LIMIT,
      });
    },
  );
  assert.equal(getTool(env.db, 'lazy', 'row_500'), null, 'the rejected apply wrote nothing');
});

test('C-01..C-05: applied rows reach search_tools/describe_tools and honour stale visibility', async () => {
  const env = harness();
  addServer(env.db);
  addStaticTools(env.db);
  env.pool.result = searchResult([
    discoveredTool('list_tables', {
      type: 'object',
      properties: { schema: { type: 'string' } },
    }),
    { name: 'no_schema', description: 'no_schema discovered without a schema' },
  ]);

  const preview = await env.service.preview('lazy', { searchTool: 'search_tools' });
  await env.service.apply('lazy', {
    discoveryId: preview.discoveryId,
    expectedRevision: getRevision(env.db),
  });
  refreshFts(env.db, 'lazy');
  const snapshot = buildCatalogSnapshot(env.db);

  // C-01: discovered rows are searchable by name and description under <server>.<tool>.
  const byName = snapshotSearch(snapshot, { query: 'list_tables' });
  assert.deepEqual(byName.map((item) => item.name), ['lazy.list_tables']);
  assert.equal(byName[0]?.kind, 'mcp');
  assert.equal(byName[0]?.server, 'lazy');
  assert.deepEqual(
    snapshotSearch(snapshot, { query: 'discovered' }).map((item) => item.name).sort(),
    ['lazy.list_tables', 'lazy.no_schema'],
  );

  // C-02: describe_tools returns the full schema, and the normalized permissive
  // empty-object schema when the upstream had none.
  const described = describeTools(snapshot, ['lazy.list_tables', 'lazy.no_schema']);
  assert.deepEqual(described.tools, [
    {
      name: 'lazy.list_tables',
      inputSchema: { type: 'object', properties: { schema: { type: 'string' } } },
    },
    {
      name: 'lazy.no_schema',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    },
  ]);

  // C-03: the empty-query overview counts search rows too (search_tools + 2 discovered).
  assert.deepEqual(snapshotSearch(snapshot, { query: '' }), [
    {
      name: 'lazy',
      kind: 'mcp',
      server: 'lazy',
      description: '3 tools; call tools.mcp.lazy.<tool>(args)',
    },
  ]);
  const catalogOverview = catalogSearch(env.db, { query: '' });
  assert.deepEqual(
    catalogOverview.overview?.servers.map((server) => [server.server, server.toolCount]),
    [['lazy', 3]],
  );

  // C-05: the search tool itself stays visible and describable.
  assert.ok(snapshot.tools.some((tool) => tool.name === 'lazy.search_tools'));
  assert.ok(catalogOverview.overview?.servers.some((server) => server.server === 'lazy'));
  assert.deepEqual(
    describeTools(snapshot, ['lazy.search_tools']).tools.map((tool) => tool.name),
    ['lazy.search_tools'],
  );

  // C-04: demotion hides stale rows from search_tools and the catalog retrieval;
  // the direct-call error MCP_DISCOVERY_TOOL_STALE is covered in discovery-pool.
  await env.service.demote('lazy');
  refreshFts(env.db, 'lazy');
  const staleSnapshot = buildCatalogSnapshot(env.db);
  assert.deepEqual(
    staleSnapshot.tools.map((tool) => tool.name),
    ['lazy.search_tools'],
    'stale rows without staleOverride leave the snapshot',
  );
  const hidden = catalogSearch(env.db, { query: 'list_tables' });
  assert.deepEqual(hidden.results, []);
  assert.equal(hidden.hiddenStale, 1);
  assert.deepEqual(snapshotSearch(staleSnapshot, { query: 'list_tables' }), []);

  // C-04b: staleOverride keeps the row searchable/describable, not callable.
  patchTool(env.db, 'lazy', 'list_tables', { staleOverride: true });
  refreshFts(env.db, 'lazy');
  const keptSnapshot = buildCatalogSnapshot(env.db);
  assert.deepEqual(
    snapshotSearch(keptSnapshot, { query: 'list_tables' }).map((item) => item.name),
    ['lazy.list_tables'],
  );
  assert.deepEqual(
    catalogSearch(env.db, { query: 'list_tables' }).results.map((hit) => hit.name),
    ['lazy.list_tables'],
  );
  assert.deepEqual(
    describeTools(keptSnapshot, ['lazy.list_tables']).tools.map((tool) => tool.name),
    ['lazy.list_tables'],
  );
  assert.equal(getTool(env.db, 'lazy', 'list_tables')?.stale, true);
});
