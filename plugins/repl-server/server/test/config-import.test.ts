/** `POST /config/import` route: dry-run, transactional upsert, validation and
 * secret hygiene, exercised through the framework-free handler with an in-memory
 * `ServerStore` and the real file-backed secret store. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  createAdminConfigRoutes,
  type AdminConfigRoutesDeps,
} from '../src/admin/config-routes.ts';
import {
  AdminApiError,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
  type CommandArg,
  type ServerConfig,
  type ServerConfigPatch,
  type ServerRecord,
  type ServerStore,
} from '../src/admin/servers.ts';
import { createFileSecretStore, type SecretStore } from '../src/secrets/store.ts';

// ---------------------------------------------------------------------------
// In-memory ServerStore (same revision semantics as the SQLite adapter)
// ---------------------------------------------------------------------------

class MemoryServerStore implements ServerStore {
  private readonly records = new Map<string, ServerRecord>();
  private currentRevision = 10;

  readonly writes: string[] = [];
  /** Write number (1-based) that throws; disabled after firing once. */
  failAtWrite: number | null = null;

  constructor(seed: readonly ServerConfig[]) {
    for (const config of seed) this.records.set(config.id, toRecord(config));
  }

  async list(): Promise<ServerRecord[]> {
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<ServerRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : structuredClone(record);
  }

  async revision(): Promise<number> {
    return this.currentRevision;
  }

  async create(config: ServerConfig): Promise<{ server: ServerRecord; revision: number }> {
    this.write(`create ${config.id}`);
    if (this.records.has(config.id)) {
      throw new AdminApiError(409, 'CONFLICT', `server ${config.id} already exists`);
    }
    const record = toRecord(config);
    this.records.set(config.id, record);
    this.currentRevision += 1;
    return { server: structuredClone(record), revision: this.currentRevision };
  }

  async update(
    id: string,
    patch: ServerConfigPatch,
    expectedRevision: number,
  ): Promise<{ server: ServerRecord; revision: number }> {
    this.assertRevision(expectedRevision);
    this.write(`update ${id}`);
    const current = this.records.get(id);
    if (current === undefined) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${id} does not exist`);
    }
    const next: ServerRecord = {
      ...current,
      ...patch,
      args: structuredClone(patch.args ?? current.args) as CommandArg[],
      env: { ...(patch.env ?? current.env) },
      headers: { ...(patch.headers ?? current.headers) },
      tags: [...(patch.tags ?? current.tags)],
      revision: current.revision + 1,
      updatedAt: '2026-11-18T00:00:00.000Z',
    };
    this.records.set(id, next);
    this.currentRevision += 1;
    return { server: structuredClone(next), revision: this.currentRevision };
  }

  async remove(id: string, expectedRevision: number): Promise<{ revision: number }> {
    this.assertRevision(expectedRevision);
    this.write(`remove ${id}`);
    if (!this.records.delete(id)) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${id} does not exist`);
    }
    this.currentRevision += 1;
    return { revision: this.currentRevision };
  }

  private assertRevision(expected: number): void {
    if (expected !== this.currentRevision) {
      throw new AdminApiError(
        409,
        'REVISION_CONFLICT',
        `revision ${expected} does not match ${this.currentRevision}`,
      );
    }
  }

  private write(action: string): void {
    this.writes.push(action);
    if (this.failAtWrite !== null && this.writes.length >= this.failAtWrite) {
      this.failAtWrite = null;
      throw new Error(`simulated storage failure on ${action}`);
    }
  }
}

function toRecord(config: ServerConfig): ServerRecord {
  return {
    id: config.id,
    label: config.label,
    transport: config.transport,
    command: config.command ?? null,
    args: structuredClone(config.args) as CommandArg[],
    env: { ...config.env },
    cwd: config.cwd ?? null,
    url: config.url ?? null,
    headers: { ...config.headers },
    enabled: config.enabled,
    connectMode: config.connectMode,
    summary: config.summary ?? null,
    summarySource: config.summarySource ?? null,
    category: config.category ?? null,
    tags: [...config.tags],
    timeoutMs: config.timeoutMs,
    maxConcurrency: config.maxConcurrency,
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    revision: 1,
  };
}

function stdioServer(id: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id,
    label: id,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', id],
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
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  handler: AdminHandler;
  store: MemoryServerStore;
  secrets: SecretStore;
}

async function setup(
  t: TestContext,
  seed: readonly ServerConfig[],
  deps: Partial<AdminConfigRoutesDeps> = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'repl-config-import-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const store = new MemoryServerStore(seed);
  const secrets = createFileSecretStore(directory);
  const handler = createAdminConfigRoutes({
    secrets,
    servers: store,
    newOperationId: () => 'op_test',
    ...deps,
  });
  return { handler, store, secrets };
}

async function post(
  handler: AdminHandler,
  body: unknown,
  query?: string,
): Promise<AdminResponse> {
  const request: AdminRequest = {
    method: 'POST',
    path: '/admin/api/config/import',
    body,
  };
  if (query !== undefined) request.query = new URLSearchParams(query);
  const response = await handler(request);
  assert.ok(response !== null, 'expected /config/import to handle the request');
  return response;
}

function errorBody(response: AdminResponse): Record<string, unknown> {
  assert.equal(response.status >= 400, true, `expected an error, got ${response.status}`);
  const body = response.body as { error?: Record<string, unknown> } | undefined;
  assert.ok(body?.error !== undefined, 'expected an error envelope');
  return body.error;
}

/** Row content without per-write metadata a compensating rollback cannot undo. */
function configState(records: readonly ServerRecord[]): Array<Record<string, unknown>> {
  return records.map((record) => {
    const copy: Record<string, unknown> = { ...record };
    delete copy['revision'];
    delete copy['updatedAt'];
    return copy;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('dry-run returns the diff and never writes', async (t) => {
  const { handler, store } = await setup(t, [
    stdioServer('pg', { label: 'PostgreSQL' }),
    stdioServer('old'),
  ]);

  const response = await post(handler, {
    servers: [
      {
        id: 'pg',
        label: 'PostgreSQL (edited)',
        transport: 'stdio',
        command: 'npx',
      },
      { id: 'fresh', label: 'Fresh', transport: 'stdio', command: 'node' },
    ],
    dryRun: true,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    valid: true,
    diff: { added: ['fresh'], changed: ['pg'], removed: ['old'] },
  });
  assert.deepEqual(store.writes, []);
  assert.equal((await store.get('pg'))?.label, 'PostgreSQL');
  assert.equal(await store.get('fresh'), null);
  assert.notEqual(await store.get('old'), null);
});

test('import upserts by server id and removes servers absent from the document', async (t) => {
  const { handler, store } = await setup(t, [
    stdioServer('pg', { label: 'PostgreSQL' }),
    stdioServer('old'),
  ]);

  const response = await post(handler, {
    version: 1,
    servers: [
      {
        id: 'pg',
        label: 'PostgreSQL (edited)',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mcp/pg', '--readonly'],
        tags: ['db'],
      },
      {
        id: 'fresh',
        label: 'Fresh',
        transport: 'http',
        url: 'https://example.com/mcp',
      },
    ],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    operationId: 'op_test',
    diff: { added: ['fresh'], changed: ['pg'], removed: ['old'] },
  });

  const pg = await store.get('pg');
  assert.ok(pg !== null);
  assert.equal(pg.label, 'PostgreSQL (edited)');
  assert.deepEqual(pg.args, ['-y', '@mcp/pg', '--readonly']);
  assert.deepEqual(pg.tags, ['db']);

  const fresh = await store.get('fresh');
  assert.ok(fresh !== null);
  assert.equal(fresh.transport, 'http');
  assert.equal(fresh.url, 'https://example.com/mcp');

  assert.equal(await store.get('old'), null);
});

test('import keeps summary_source in sync when a summary changes', async (t) => {
  const { handler, store } = await setup(t, [
    stdioServer('pg', { summary: 'AI 摘要', summarySource: 'ai' }),
    stdioServer('stable', { summary: '保持不变', summarySource: 'ai' }),
    stdioServer('moved', { summary: '同摘要换传输', summarySource: 'ai' }),
  ]);

  const response = await post(handler, {
    servers: [
      {
        id: 'pg',
        label: 'pg',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pg'],
        summary: '人工摘要',
      },
      {
        id: 'stable',
        label: 'stable',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'stable'],
        summary: '保持不变',
      },
      {
        id: 'fresh',
        label: 'fresh',
        transport: 'stdio',
        command: 'node',
        summary: '新服务器摘要',
      },
      {
        id: 'bare',
        label: 'bare',
        transport: 'stdio',
        command: 'node',
      },
      {
        id: 'moved',
        label: 'moved',
        transport: 'http',
        url: 'https://example.com/mcp',
        summary: '同摘要换传输',
      },
    ],
  });
  assert.equal(response.status, 200);

  assert.equal((await store.get('pg'))?.summarySource, 'manual');
  assert.equal((await store.get('stable'))?.summarySource, 'ai');
  assert.equal((await store.get('fresh'))?.summarySource, 'manual');
  assert.equal((await store.get('bare'))?.summarySource, null);
  assert.equal((await store.get('moved'))?.summarySource, 'ai');
});

test('import stores blank summaries as null without a source', async (t) => {
  const { handler, store } = await setup(t, [
    stdioServer('pg', { summary: 'AI 摘要', summarySource: 'ai' }),
  ]);

  const response = await post(handler, {
    servers: [
      {
        id: 'pg',
        label: 'pg',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pg'],
        summary: '',
      },
      {
        id: 'fresh',
        label: 'fresh',
        transport: 'stdio',
        command: 'node',
        summary: '   ',
      },
    ],
  });
  assert.equal(response.status, 200);
  assert.equal((await store.get('pg'))?.summary, null);
  assert.equal((await store.get('pg'))?.summarySource, null);
  assert.equal((await store.get('fresh'))?.summary, null);
  assert.equal((await store.get('fresh'))?.summarySource, null);
});

test('a transport change replaces the row instead of silently keeping the old one', async (t) => {
  const { handler, store } = await setup(t, [stdioServer('remote')]);

  const response = await post(handler, {
    servers: [
      {
        id: 'remote',
        label: 'Remote',
        transport: 'http',
        url: 'https://example.com/mcp',
      },
    ],
  });

  assert.equal(response.status, 200);
  const remote = await store.get('remote');
  assert.ok(remote !== null);
  assert.equal(remote.transport, 'http');
  assert.equal(remote.command, null);
});

test('invalid documents answer 400 with the offending field paths', async (t) => {
  const { handler, store } = await setup(t, []);

  const response = await post(handler, {
    servers: [{ id: 'broken', transport: 'stdio' }],
  });

  assert.equal(response.status, 400);
  const error = errorBody(response);
  assert.equal(error['code'], 'INVALID_CONFIG');
  const details = error['details'] as { fields?: string[]; errors?: string[] };
  assert.ok(details.fields?.includes('servers[0].command'), JSON.stringify(details));
  assert.ok((details.errors ?? []).some((line) => line.includes('command')));
  assert.deepEqual(store.writes, []);

  const badDryRun = await post(handler, { servers: [], dryRun: 'yes' });
  assert.equal(badDryRun.status, 400);
  assert.equal(errorBody(badDryRun)['code'], 'INVALID_FIELD');

  const unknownField = await post(handler, { servers: [], entries: [] });
  assert.equal(unknownField.status, 400);
  assert.equal(errorBody(unknownField)['code'], 'UNKNOWN_FIELD');

  const notAnObject = await post(handler, []);
  assert.equal(notAnObject.status, 400);
  assert.equal(errorBody(notAnObject)['code'], 'INVALID_BODY');
});

test('dry-run of an invalid document reports valid:false without writing', async (t) => {
  const { handler, store } = await setup(t, []);

  const response = await post(handler, {
    servers: [{ id: 'broken', transport: 'stdio' }],
    dryRun: true,
  });

  assert.equal(response.status, 200);
  const body = response.body as { valid?: boolean; errors?: string[] };
  assert.equal(body.valid, false);
  assert.ok((body.errors ?? []).length > 0);
  assert.deepEqual(store.writes, []);
});

test('responses report secret key names but never values', async (t) => {
  const { handler, store, secrets } = await setup(t, [stdioServer('pg')]);
  await secrets.set('pg_db_url', 'super-secret-database-url');

  const response = await post(handler, {
    servers: [
      {
        id: 'pg',
        label: 'PostgreSQL',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mcp/pg', '--token', '<secret:pg_db_url>'],
        env: {
          DATABASE_URL: '<secret:pg_db_url>',
          NODE_ENV: 'production',
        },
        headers: { Authorization: '<secret:missing_token>' },
      },
    ],
  });

  assert.equal(response.status, 200);
  const body = response.body as {
    operationId?: string;
    diff?: unknown;
    missingSecrets?: string[];
  };
  assert.equal(body.operationId, 'op_test');
  assert.deepEqual(body.missingSecrets, ['missing_token']);

  const serialized = JSON.stringify(body);
  for (const forbidden of ['super-secret-database-url', 'production', '$secret']) {
    assert.equal(serialized.includes(forbidden), false, `response leaked ${forbidden}`);
  }

  const pg = await store.get('pg');
  assert.ok(pg !== null);
  assert.deepEqual(pg.env, {
    DATABASE_URL: { $secret: 'pg_db_url' },
    NODE_ENV: 'production',
  });
  assert.deepEqual(pg.args, ['-y', '@mcp/pg', '--token', { $secret: 'pg_db_url' }]);
  assert.deepEqual(pg.headers, { Authorization: { $secret: 'missing_token' } });
});

test('a failed import rolls back every write it already applied', async (t) => {
  const { handler, store } = await setup(t, [
    stdioServer('pg', { label: 'PostgreSQL', tags: ['db'] }),
    stdioServer('keeper'),
  ]);
  const before = await store.list();
  store.failAtWrite = 3;

  const response = await post(handler, {
    servers: [
      {
        id: 'pg',
        label: 'PostgreSQL (edited)',
        transport: 'stdio',
        command: 'npx',
      },
      { id: 'one', label: 'One', transport: 'stdio', command: 'node' },
      { id: 'two', label: 'Two', transport: 'stdio', command: 'node' },
    ],
  });

  assert.equal(response.status, 500);
  assert.equal(errorBody(response)['code'], 'INTERNAL_ERROR');
  // The compensating rollback restores configuration content; row revision
  // counters still advance because each store write commits its own bump.
  assert.deepEqual(configState(await store.list()), configState(before));
});

test('an operation registry defers the import and answers 202', async (t) => {
  const started: Array<{ kind: string; target?: string; run: () => Promise<void> }> = [];
  const { handler, store } = await setup(t, [stdioServer('pg')], {
    operations: {
      start(input) {
        started.push(input);
        return 'op_async';
      },
    },
  });

  const response = await post(handler, {
    servers: [
      {
        id: 'pg',
        label: 'PostgreSQL (async)',
        transport: 'stdio',
        command: 'npx',
      },
    ],
  });

  assert.equal(response.status, 202);
  const body = response.body as { operationId?: string; diff?: unknown };
  assert.equal(body.operationId, 'op_async');
  assert.deepEqual(body.diff, { added: [], changed: ['pg'], removed: [] });
  assert.equal((await store.get('pg'))?.label, 'pg');

  const operation = started[0];
  assert.ok(operation !== undefined);
  assert.equal(operation.kind, 'config_import');
  await operation.run();
  assert.equal((await store.get('pg'))?.label, 'PostgreSQL (async)');
});

test('dry-run can be requested with the frozen ?dry-run=true query', async (t) => {
  const { handler, store } = await setup(t, [stdioServer('pg')]);

  const response = await post(
    handler,
    {
      servers: [
        {
          id: 'pg',
          label: 'pg',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'pg'],
        },
      ],
    },
    'dry-run=true',
  );

  assert.equal(response.status, 200);
  const body = response.body as { valid?: boolean; diff?: unknown };
  assert.equal(body.valid, true);
  assert.deepEqual(body.diff, { added: [], changed: [], removed: [] });
  assert.deepEqual(store.writes, []);
});
