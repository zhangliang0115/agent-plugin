import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { createConfigAdmin, type ConfigDocument } from '../src/admin/config.ts';
import { createAdminConfigRoutes } from '../src/admin/config-routes.ts';
import {
  createAdminServersHandler,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
  type ServerConfig,
  type ServerConfigPatch,
  type ServerPoolControl,
  type ServerRecord,
  type ServerRuntimeState,
  type ServerStore,
} from '../src/admin/servers.ts';
import { createFileSecretStore } from '../src/secrets/store.ts';

class MemoryServerStore implements ServerStore {
  readonly records = new Map<string, ServerRecord>();
  private current = 1;

  async list(): Promise<ServerRecord[]> {
    return [...this.records.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<ServerRecord | null> {
    return this.records.get(id) ?? null;
  }

  async revision(): Promise<number> {
    return this.current;
  }

  async create(config: ServerConfig): Promise<{ server: ServerRecord; revision: number }> {
    const now = new Date().toISOString();
    const server: ServerRecord = {
      ...config,
      toolDiscovery: config.toolDiscovery ?? null,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    this.records.set(config.id, server);
    this.current += 1;
    return { server, revision: this.current };
  }

  async update(
    id: string,
    patch: ServerConfigPatch,
    expectedRevision: number,
  ): Promise<{ server: ServerRecord; revision: number }> {
    const current = this.records.get(id);
    if (current === undefined) throw new Error(`missing ${id}`);
    assert.equal(expectedRevision, this.current);
    const merged: ServerRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
      revision: current.revision + 1,
    };
    this.records.set(id, merged);
    this.current += 1;
    return { server: merged, revision: this.current };
  }

  async remove(id: string, expectedRevision: number): Promise<{ revision: number }> {
    assert.equal(expectedRevision, this.current);
    this.records.delete(id);
    this.current += 1;
    return { revision: this.current };
  }
}

class FakePool implements ServerPoolControl {
  async state(): Promise<ServerRuntimeState | null> {
    return null;
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async restart(): Promise<void> {}
  async refreshTools(): Promise<void> {}
  async test(): Promise<{ tools: unknown[] }> {
    return { tools: [] };
  }
  async retire(): Promise<{ drained: boolean; inFlight?: number }> {
    return { drained: true };
  }
}

function request(
  method: string,
  path: string,
  options: { body?: unknown; ifMatch?: number } = {},
): AdminRequest {
  const headers: Record<string, string> = {};
  if (options.ifMatch !== undefined) headers['if-match'] = String(options.ifMatch);
  const value: AdminRequest = { method, path, headers };
  if (options.body !== undefined) value.body = options.body;
  return value;
}

async function call(handler: AdminHandler, value: AdminRequest): Promise<AdminResponse> {
  const response = await handler(value);
  assert.ok(response !== null, `expected ${value.method} ${value.path} to be handled`);
  return response;
}

function bodyOf(response: AdminResponse): Record<string, unknown> {
  assert.ok(typeof response.body === 'object' && response.body !== null);
  return response.body as Record<string, unknown>;
}

function errorCode(response: AdminResponse): string {
  const error = bodyOf(response)['error'];
  assert.ok(typeof error === 'object' && error !== null);
  return String((error as Record<string, unknown>)['code']);
}

function createHandler(
  store: MemoryServerStore,
  demoted: string[] = [],
): AdminHandler {
  return createAdminServersHandler({
    servers: store,
    pool: new FakePool(),
    discovery: { demote: (id) => demoted.push(id) },
  });
}

function addHttpServer(store: MemoryServerStore, id: string): Promise<unknown> {
  return store.create({
    id,
    label: id,
    transport: 'http',
    command: null,
    args: [],
    env: {},
    cwd: null,
    url: 'https://example.test/mcp',
    headers: {},
    enabled: true,
    connectMode: 'lazy',
    summary: null,
    summarySource: null,
    category: null,
    tags: [],
    timeoutMs: 60_000,
    maxConcurrency: 8,
  });
}

test('POST /servers normalizes toolDiscovery and the view returns it', async () => {
  const store = new MemoryServerStore();
  const handler = createHandler(store);

  const response = await call(
    handler,
    request('POST', '/servers', {
      body: {
        id: 'hexhub',
        transport: 'http',
        url: 'https://example.test/mcp',
        toolDiscovery: {
          mode: 'search',
          searchTool: ' search_tools ',
          query: 'database',
          args: { q: '$query', limit: 50 },
        },
      },
    }),
  );
  assert.equal(response.status, 201);
  const server = bodyOf(response)['server'] as Record<string, unknown>;
  assert.deepEqual(server['toolDiscovery'], {
    mode: 'search',
    searchTool: 'search_tools',
    query: 'database',
    args: { q: '$query', limit: 50 },
    maxTools: 50,
    prepareOnCall: true,
  });
  assert.deepEqual(store.records.get('hexhub')?.toolDiscovery, server['toolDiscovery']);
});

test('PATCH /servers/:id validates toolDiscovery and clears it with null', async () => {
  const store = new MemoryServerStore();
  await addHttpServer(store, 'hexhub');
  const handler = createHandler(store);
  const revision = await store.revision();

  const secret = await call(
    handler,
    request('PATCH', '/servers/hexhub', {
      body: {
        toolDiscovery: {
          mode: 'search',
          searchTool: 'search_tools',
          args: { token: { $secret: 'TOKEN' } },
        },
      },
      ifMatch: revision,
    }),
  );
  assert.equal(secret.status, 422);
  assert.equal(errorCode(secret), 'DISCOVERY_SECRET_NOT_ALLOWED');
  assert.deepEqual(
    (bodyOf(secret)['error'] as Record<string, unknown>)['details'],
    { path: 'toolDiscovery.args.token' },
  );

  const staticWithField = await call(
    handler,
    request('PATCH', '/servers/hexhub', {
      body: { toolDiscovery: { mode: 'static', maxTools: 10 } },
      ifMatch: revision,
    }),
  );
  assert.equal(staticWithField.status, 422);
  assert.equal(errorCode(staticWithField), 'DISCOVERY_CONFIG_INVALID');

  const tooDeep = (() => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let index = 0; index < 10; index += 1) {
      const next: Record<string, unknown> = {};
      cursor['level'] = next;
      cursor = next;
    }
    return root;
  })();
  const deep = await call(
    handler,
    request('PATCH', '/servers/hexhub', {
      body: {
        toolDiscovery: { mode: 'search', searchTool: 'search_tools', args: tooDeep },
      },
      ifMatch: revision,
    }),
  );
  assert.equal(deep.status, 422);
  assert.equal(errorCode(deep), 'DISCOVERY_CONFIG_INVALID');

  const oversized = await call(
    handler,
    request('PATCH', '/servers/hexhub', {
      body: {
        toolDiscovery: {
          mode: 'search',
          searchTool: 'search_tools',
          args: { blob: 'x'.repeat(17 * 1024) },
        },
      },
      ifMatch: revision,
    }),
  );
  assert.equal(oversized.status, 422);
  assert.equal(errorCode(oversized), 'DISCOVERY_CONFIG_INVALID');

  const unknownKey = await call(
    handler,
    request('PATCH', '/servers/hexhub', {
      body: { toolDiscovery: { mode: 'search', searchTool: 'search_tools', wat: 1 } },
      ifMatch: revision,
    }),
  );
  assert.equal(unknownKey.status, 422);
  assert.equal(errorCode(unknownKey), 'DISCOVERY_CONFIG_INVALID');

  const saved = await call(
    handler,
    request('PATCH', '/servers/hexhub', {
      body: { toolDiscovery: { mode: 'search', searchTool: 'search_tools' } },
      ifMatch: revision,
    }),
  );
  assert.equal(saved.status, 200);
  assert.equal(
    ((bodyOf(saved)['server'] as Record<string, unknown>)['toolDiscovery'] as Record<string, unknown>)['mode'],
    'search',
  );

  const nextRevision = bodyOf(saved)['revision'] as number;
  const cleared = await call(
    handler,
    request('PATCH', '/servers/hexhub', {
      body: { toolDiscovery: null },
      ifMatch: nextRevision,
    }),
  );
  assert.equal(cleared.status, 200);
  assert.equal((bodyOf(cleared)['server'] as Record<string, unknown>)['toolDiscovery'], null);
});

test('switching mode back to static calls the discovery demotion hook', async () => {
  const store = new MemoryServerStore();
  const demoted: string[] = [];
  await addHttpServer(store, 'hexhub');
  const handler = createHandler(store, demoted);
  const revision = await store.revision();

  const saved = await call(
    handler,
    request('PATCH', '/servers/hexhub', {
      body: { toolDiscovery: { mode: 'search', searchTool: 'search_tools' } },
      ifMatch: revision,
    }),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(demoted, []);

  const nextRevision = bodyOf(saved)['revision'] as number;
  const cleared = await call(
    handler,
    request('PATCH', '/servers/hexhub', {
      body: { toolDiscovery: { mode: 'static' } },
      ifMatch: nextRevision,
    }),
  );
  assert.equal(cleared.status, 200);
  assert.deepEqual(demoted, ['hexhub']);
});

test('builtin servers cannot configure tool discovery', async () => {
  const store = new MemoryServerStore();
  await store.create({
    id: '__official__',
    label: 'Official',
    transport: 'builtin',
    command: null,
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
  });
  const handler = createHandler(store);
  const revision = await store.revision();
  const response = await call(
    handler,
    request('PATCH', '/servers/__official__', {
      body: { toolDiscovery: { mode: 'static' } },
      ifMatch: revision,
    }),
  );
  assert.equal(response.status, 422);
  assert.equal(errorCode(response), 'BUILTIN_RESERVED');
});

async function configHarness(
  t: TestContext,
  servers: ServerConfig[],
): Promise<{ store: MemoryServerStore; admin: ReturnType<typeof createConfigAdmin>; handler: AdminHandler }> {
  const directory = await mkdtemp(join(tmpdir(), 'repl-discovery-config-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new MemoryServerStore();
  for (const server of servers) await store.create(server);
  const secrets = createFileSecretStore(directory);
  const admin = createConfigAdmin({
    repository: {
      listServers: () => store.list(),
      getServer: (id) => store.get(id),
    },
    importTarget: { applyImport: () => undefined },
    secrets,
    newOperationId: () => 'op_test',
  });
  const handler = createAdminConfigRoutes({
    secrets,
    servers: store,
    newOperationId: () => 'op_test',
  });
  return { store, admin, handler };
}

function lazyServer(id: string): ServerConfig {
  return {
    id,
    label: id,
    transport: 'stdio',
    command: 'node',
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
    toolDiscovery: {
      mode: 'search',
      searchTool: 'search_tools',
      query: 'database',
      args: { q: '$query' },
      maxTools: 25,
      prepareOnCall: false,
    },
  };
}

test('config export → import round-trip keeps toolDiscovery and reports no change', async (t) => {
  const { handler } = await configHarness(t, [lazyServer('hexhub')]);
  const exported = await call(handler, request('GET', '/config/export'));
  assert.equal(exported.status, 200);
  const document = exported.body as ConfigDocument;
  assert.deepEqual(document.servers[0]?.toolDiscovery, {
    mode: 'search',
    searchTool: 'search_tools',
    query: 'database',
    args: { q: '$query' },
    maxTools: 25,
    prepareOnCall: false,
  });

  const dry = await call(
    handler,
    request('POST', '/config/import', { body: { ...document, dryRun: true } }),
  );
  assert.equal(dry.status, 200);
  assert.deepEqual(bodyOf(dry)['diff'], { added: [], changed: [], removed: [] });
  assert.equal(bodyOf(dry)['valid'], true);
});

test('config import rejects an invalid toolDiscovery with the 422 discovery code', async (t) => {
  const { handler } = await configHarness(t, [lazyServer('hexhub')]);
  const response = await call(
    handler,
    request('POST', '/config/import', {
      body: {
        version: 1,
        servers: [
          {
            id: 'broken',
            transport: 'stdio',
            command: 'node',
            toolDiscovery: {
              mode: 'search',
              searchTool: 'search_tools',
              args: { token: { $secret: 'TOKEN' } },
            },
          },
        ],
      },
    }),
  );
  assert.equal(response.status, 422);
  assert.equal(errorCode(response), 'DISCOVERY_SECRET_NOT_ALLOWED');

  const staticError = await call(
    handler,
    request('POST', '/config/import', {
      body: {
        version: 1,
        servers: [
          {
            id: 'broken',
            transport: 'stdio',
            command: 'node',
            toolDiscovery: { mode: 'static', prepareOnCall: true },
          },
        ],
      },
    }),
  );
  assert.equal(staticError.status, 422);
  assert.equal(errorCode(staticError), 'DISCOVERY_CONFIG_INVALID');
});

test('changing only toolDiscovery marks the config diff as changed', async (t) => {
  const { admin } = await configHarness(t, [lazyServer('hexhub')]);
  const document = await admin.exportConfig();
  const entry = document.servers[0];
  assert.ok(entry !== undefined);
  entry.toolDiscovery = { ...entry.toolDiscovery, prepareOnCall: true } as typeof entry.toolDiscovery;
  const dry = await admin.importConfig(document, { dryRun: true });
  assert.ok('diff' in dry);
  assert.deepEqual(dry.diff.changed, ['hexhub']);
});

test('old documents without toolDiscovery import as static', async (t) => {
  const { store } = await configHarness(t, [lazyServer('hexhub')]);
  const handler = createAdminConfigRoutes({
    secrets: createFileSecretStore(await mkdtemp(join(tmpdir(), 'repl-discovery-config-'))),
    servers: store,
    newOperationId: () => 'op_test',
  });
  const response = await call(
    handler,
    request('POST', '/config/import', {
      body: {
        version: 1,
        servers: [{ id: 'hexhub', transport: 'stdio', command: 'node' }],
      },
    }),
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(store.records.get('hexhub')?.toolDiscovery ?? null, null);
});
