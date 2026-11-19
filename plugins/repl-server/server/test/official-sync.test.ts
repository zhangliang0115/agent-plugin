import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import {
  createAdminServersHandler,
  createOperationLauncher,
  type AdminOperation,
  type OperationLauncher,
  type ServerPoolControl,
  type ServerRuntimeState,
} from '../src/admin/servers.ts';
import { createAdminToolsHandler } from '../src/admin/tools.ts';
import { DbServerStore, DbToolStore } from '../src/assembly-stores.ts';
import { createSearchPreview } from '../src/catalog/index.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { BUILTIN_SERVER_ID, OFFICIAL_SERVER_ID } from '../src/db/servers.ts';
import { getTool, listTools, patchTool } from '../src/db/tools.ts';
import type { ToolListEntry } from '../src/serve/client.ts';
import {
  createOfficialToolsSync,
  type OfficialSyncRuntime,
} from '../src/serve/official-sync.ts';

class FakeRuntime implements OfficialSyncRuntime {
  acquires = 0;
  releases = 0;
  tools: ToolListEntry[] = [];
  acquireError: Error | null = null;
  listError: Error | null = null;

  async acquire(): Promise<{ listTools(): Promise<ToolListEntry[]> }> {
    this.acquires += 1;
    if (this.acquireError !== null) throw this.acquireError;
    return {
      listTools: async (): Promise<ToolListEntry[]> => {
        if (this.listError !== null) throw this.listError;
        return this.tools;
      },
    };
  }

  async release(): Promise<void> {
    this.releases += 1;
  }
}

class FakePool implements ServerPoolControl {
  readonly calls: string[] = [];
  readonly states = new Map<string, ServerRuntimeState>();

  async state(id: string): Promise<ServerRuntimeState | null> {
    this.calls.push(`state:${id}`);
    return this.states.get(id) ?? null;
  }

  async connect(id: string): Promise<void> {
    this.calls.push(`connect:${id}`);
  }

  async disconnect(id: string): Promise<void> {
    this.calls.push(`disconnect:${id}`);
  }

  async restart(id: string): Promise<void> {
    this.calls.push(`restart:${id}`);
  }

  async refreshTools(id: string): Promise<void> {
    this.calls.push(`refresh:${id}`);
  }

  async test(id: string): Promise<{ tools: unknown[] }> {
    this.calls.push(`test:${id}`);
    return { tools: [] };
  }

  async retire(id: string, options: { force: boolean }): Promise<{ drained: boolean }> {
    this.calls.push(`retire:${id}:${options.force}`);
    return { drained: true };
  }
}

interface Harness {
  db: ReturnType<typeof openStateDb>;
  runtime: FakeRuntime;
  workspace: string;
  sync: ReturnType<typeof createOfficialToolsSync>;
  syncedCounts: number[];
}

async function harness(t: TestContext, resolveBin: (bin: string) => string | null): Promise<Harness> {
  const db = openStateDb(':memory:');
  const workspace = await mkdtemp(join(tmpdir(), 'repl-official-sync-'));
  t.after(async () => {
    db.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const runtime = new FakeRuntime();
  const syncedCounts: number[] = [];
  const sync = createOfficialToolsSync({
    db,
    runtime,
    workspace,
    bin: 'claude-test',
    resolveBin,
    onSynced: (count) => syncedCounts.push(count),
  });
  return { db, runtime, workspace, sync, syncedCounts };
}

function officialTools(): ToolListEntry[] {
  return [
    {
      name: 'Read',
      description: 'Read a file from disk',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
    { name: 'Bash', description: 'Run a shell command', inputSchema: { type: 'object' } },
  ];
}

async function waitForOperation(
  operations: OperationLauncher,
  operationId: string,
): Promise<AdminOperation> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = operations.get?.(operationId);
    if (operation !== undefined && operation !== null && operation.state !== 'running') {
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`operation ${operationId} never settled`);
}

test('a missing claude binary degrades to an empty result with a readable notice', async (t) => {
  const { db, runtime, sync } = await harness(t, () => null);

  const result = await sync.ensure();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.count, 0);
  assert.match(result.notice ?? '', /claude-test/);
  assert.equal(runtime.acquires, 0);
  assert.deepEqual(listTools(db, OFFICIAL_SERVER_ID), []);
});

test('the sync stores schemas, preserves overrides, caches and refreshes on force', async (t) => {
  const { db, runtime, sync, syncedCounts } = await harness(t, () => '/fake/claude');
  runtime.tools = officialTools();

  const first = await sync.ensure();
  assert.equal(first.status, 'synced');
  assert.equal(first.count, 2);
  assert.equal(runtime.acquires, 1);
  assert.equal(runtime.releases, 1);
  assert.deepEqual(syncedCounts, [2]);

  const read = getTool(db, OFFICIAL_SERVER_ID, 'Read');
  assert.ok(read);
  assert.equal(read.description, 'Read a file from disk');
  assert.deepEqual(read.inputSchema, {
    type: 'object',
    properties: { path: { type: 'string' } },
  });

  const cached = await sync.ensure();
  assert.equal(cached.status, 'synced');
  assert.equal(runtime.acquires, 1, 'a successful sync is not repeated by GET');
  assert.deepEqual(syncedCounts, [2]);

  patchTool(db, OFFICIAL_SERVER_ID, 'Read', {
    description: '管理员描述',
    enabled: false,
    tags: ['files'],
  });
  const forced = await sync.ensure({ force: true });
  assert.equal(forced.status, 'synced');
  assert.equal(runtime.acquires, 2);
  assert.equal(runtime.releases, 2);
  assert.deepEqual(syncedCounts, [2, 2]);

  const kept = getTool(db, OFFICIAL_SERVER_ID, 'Read');
  assert.ok(kept);
  assert.equal(kept.descriptionOverride, '管理员描述');
  assert.equal(kept.enabled, false);
  assert.deepEqual(kept.tags, ['files']);
  assert.equal(listTools(db, OFFICIAL_SERVER_ID).length, 2, 'the second sync must not duplicate rows');
});

test('a serve failure is reported, not thrown', async (t) => {
  const { runtime, sync } = await harness(t, () => '/fake/claude');
  runtime.acquireError = new Error('spawn failed');

  const result = await sync.ensure();
  assert.equal(result.status, 'failed');
  assert.match(result.notice ?? '', /spawn failed/);
  assert.equal(runtime.acquires, 1);
});

test('GET /servers/__official__/tools returns an empty list plus the reason', async (t) => {
  const { db, sync } = await harness(t, () => null);
  const handler = createAdminToolsHandler({
    servers: new DbServerStore(db),
    tools: new DbToolStore(db),
    retrieval: createSearchPreview({ db }),
    official: sync,
  });

  const response = await handler({ method: 'GET', path: `/servers/${OFFICIAL_SERVER_ID}/tools` });
  assert.ok(response !== null);
  assert.equal(response.status, 200);
  const body = response.body as Record<string, unknown>;
  assert.deepEqual(body['tools'], []);
  assert.match(String(body['notice']), /claude-test/);
});

test('GET /servers/__official__/tools lists the synced rows', async (t) => {
  const { db, runtime, sync } = await harness(t, () => '/fake/claude');
  runtime.tools = officialTools();
  const handler = createAdminToolsHandler({
    servers: new DbServerStore(db),
    tools: new DbToolStore(db),
    retrieval: createSearchPreview({ db }),
    official: sync,
  });

  const response = await handler({ method: 'GET', path: `/servers/${OFFICIAL_SERVER_ID}/tools` });
  assert.ok(response !== null);
  const body = response.body as Record<string, unknown>;
  assert.equal((body['tools'] as unknown[]).length, 2);
  assert.equal(body['notice'], undefined);
});

test('POST /servers/__official__/tools/refresh forces a sync; __builtin__ stays rejected', async (t) => {
  const { db, runtime, sync } = await harness(t, () => '/fake/claude');
  runtime.tools = officialTools();
  const operations = createOperationLauncher();
  const pool = new FakePool();
  const handler = createAdminServersHandler({
    servers: new DbServerStore(db),
    pool,
    operations,
    official: sync,
  });

  const accepted = await handler({
    method: 'POST',
    path: `/servers/${OFFICIAL_SERVER_ID}/tools/refresh`,
  });
  assert.ok(accepted !== null);
  assert.equal(accepted.status, 202);
  const operation = await waitForOperation(operations, String((accepted.body as Record<string, unknown>)['operationId']));
  assert.equal(operation.state, 'ok');
  assert.equal(runtime.acquires, 1);
  assert.equal(runtime.releases, 1);
  assert.equal(pool.calls.some((entry) => entry.startsWith('refresh:')), false);

  const builtin = await handler({
    method: 'POST',
    path: `/servers/${BUILTIN_SERVER_ID}/tools/refresh`,
  });
  assert.ok(builtin !== null);
  assert.equal(builtin.status, 422);
  assert.equal((builtin.body as { error: { code: string } }).error.code, 'NOT_CONNECTABLE');
});
