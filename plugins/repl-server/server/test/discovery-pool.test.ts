import assert from 'node:assert/strict';
import test from 'node:test';

import { McpToolError } from '@zhangliang0115/repl-server-core/src/errors.ts';
import type { ToolCallRequest } from '@zhangliang0115/repl-server-core/src/types.ts';

import { PoolGates } from '../src/pool/gates.ts';
import {
  ConnectionPool,
  POOL_DEFAULTS,
  type HttpTransportOptions,
  type PoolCallPrepare,
  type PoolClient,
  type PoolClientFactory,
  type PoolOptions,
  type PoolServerSpec,
  type PoolToolInfo,
  type PoolTransport,
  type PoolTransportFactory,
  type StdioTransportOptions,
} from '../src/pool/pool.ts';
import {
  createPoolRuntime,
  type PoolPrepareProvider,
  type PoolRuntime,
  type PoolRuntimeOptions,
  type PoolRuntimePrepareInfo,
  type PoolRuntimeServerRecord,
  type PoolToolPolicy,
} from '../src/pool/runtime.ts';

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(5);
  }
  assert.fail('condition was not met before the deadline');
}

class FakeTransport implements PoolTransport {
  readonly kind: 'stdio' | 'http' = 'stdio';
  closed = false;
  private closeHandler: ((error?: unknown) => void) | null = null;

  onStderr(): void {}
  onClose(handler: (error?: unknown) => void): void {
    this.closeHandler = handler;
  }
  emitClose(error?: unknown): void {
    this.closeHandler?.(error);
  }
  close(): void {
    this.closed = true;
  }
}

class FakeClient implements PoolClient {
  readonly calls: Array<{ name: string; args: unknown }> = [];
  active = 0;
  maxActive = 0;
  closed = false;
  impl: ((name: string, args: unknown) => Promise<unknown>) | null = null;

  async connect(): Promise<void> {}
  async listTools(): Promise<readonly PoolToolInfo[]> {
    return [{ name: 'search_tools' }, { name: 'echo' }];
  }
  async callTool(name: string, args: unknown): Promise<unknown> {
    this.calls.push({ name, args });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.impl !== null) return await this.impl(name, args);
      return { content: [{ type: 'text', text: `ok:${name}` }] };
    } finally {
      this.active -= 1;
    }
  }
  async ping(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
}

class FakeClients implements PoolClientFactory {
  readonly clients: FakeClient[] = [];
  configure: ((client: FakeClient, index: number) => void) | null = null;

  create(): PoolClient {
    const client = new FakeClient();
    const index = this.clients.length;
    this.clients.push(client);
    this.configure?.(client, index);
    return client;
  }
}

class FakeTransports implements PoolTransportFactory {
  readonly transports: FakeTransport[] = [];
  stdio(_options: StdioTransportOptions): PoolTransport {
    const transport = new FakeTransport();
    this.transports.push(transport);
    return transport;
  }
  http(_options: HttpTransportOptions): PoolTransport {
    const transport = new FakeTransport();
    this.transports.push(transport);
    return transport;
  }
}

function spec(overrides: Partial<PoolServerSpec> = {}): PoolServerSpec {
  return {
    id: 'lazy',
    cfgVersion: 1,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    ...overrides,
  };
}

interface PoolHarness {
  pool: ConnectionPool;
  clients: FakeClients;
  transports: FakeTransports;
}

function createPool(options: Partial<PoolOptions> = {}): PoolHarness {
  const clients = new FakeClients();
  const transports = new FakeTransports();
  const pool = new ConnectionPool({
    transportFactory: transports,
    clientFactory: clients,
    connectTimeoutMs: 500,
    callTimeoutMs: 1_000,
    autoReconnect: true,
    backoffMs: [1, 1, 1],
    servers: [spec()],
    ...options,
  });
  return { pool, clients, transports };
}

function prepareFor(toolName: string, extra: Partial<PoolCallPrepare> = {}): PoolCallPrepare {
  return {
    tool: 'search_tools',
    args: { query: toolName },
    cacheKey: toolName,
    ...extra,
  };
}

function call(server: string, tool: string, args: Record<string, unknown> = {}): ToolCallRequest {
  return { evalId: 1, epoch: 1, callSeq: 1, tool, server, args };
}

// ---------------------------------------------------------------------------
// Connection pool: prepare / cache / dedupe / failure
// ---------------------------------------------------------------------------

test('R-01/R-02: the first call searches then calls; a cached key calls only the tool', async () => {
  const env = createPool();
  await env.pool.ensureConnected('lazy');
  const client = env.clients.clients[0];
  assert.ok(client);

  await env.pool.callTool('lazy', 'list_tables', {}, { prepare: prepareFor('list_tables') });
  assert.deepEqual(client.calls.map((entry) => entry.name), ['search_tools', 'list_tables']);

  await env.pool.callTool('lazy', 'list_tables', {}, { prepare: prepareFor('list_tables') });
  assert.deepEqual(client.calls.map((entry) => entry.name), [
    'search_tools',
    'list_tables',
    'list_tables',
  ]);
});

test('R-03b: concurrent calls with one prepare key share a single search', async () => {
  const env = createPool();
  await env.pool.ensureConnected('lazy');
  const client = env.clients.clients[0];
  assert.ok(client);

  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  client.impl = async (name) => {
    if (name === 'search_tools') await blocker;
    return { content: [{ type: 'text', text: `ok:${name}` }] };
  };

  const first = env.pool.callTool('lazy', 'a', {}, { prepare: prepareFor('a') });
  const second = env.pool.callTool('lazy', 'a', {}, { prepare: prepareFor('a') });
  await tick();
  release();
  await Promise.all([first, second]);

  assert.equal(
    client.calls.filter((entry) => entry.name === 'search_tools').length,
    1,
    'preparePending deduplicates the warm-up',
  );
  assert.equal(client.calls.filter((entry) => entry.name === 'a').length, 2);
});

test('R-06: a failed warm-up never sends the business call', async () => {
  const env = createPool();
  await env.pool.ensureConnected('lazy');
  const client = env.clients.clients[0];
  assert.ok(client);
  client.impl = async (name) => {
    if (name === 'search_tools') {
      throw new McpToolError('search exploded', { code: 'MCP_TOOL_ERROR', retryable: false });
    }
    return { content: [] };
  };

  await assert.rejects(
    env.pool.callTool('lazy', 'list_tables', {}, { prepare: prepareFor('list_tables') }),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError);
      assert.equal(error.code, 'MCP_DISCOVERY_PREPARE_FAILED');
      const detail = error.detail as { searchTool?: string; cause?: { code?: string } };
      assert.equal(detail.searchTool, 'search_tools');
      assert.equal(detail.cause?.code, 'MCP_TOOL_ERROR');
      return true;
    },
  );
  assert.deepEqual(client.calls.map((entry) => entry.name), ['search_tools']);
});

test('a warm-up timeout fails the call and aborts before the business call', async () => {
  const env = createPool();
  await env.pool.ensureConnected('lazy');
  const client = env.clients.clients[0];
  assert.ok(client);
  client.impl = async (name) => {
    if (name === 'search_tools') return await new Promise(() => {});
    return { content: [] };
  };

  await assert.rejects(
    env.pool.callTool('lazy', 'list_tables', {}, {
      prepare: prepareFor('list_tables', { timeoutMs: 10 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError);
      assert.equal(error.code, 'MCP_DISCOVERY_PREPARE_FAILED');
      assert.equal((error.detail as { reason?: string }).reason, 'timeout');
      return true;
    },
  );
  assert.deepEqual(client.calls.map((entry) => entry.name), ['search_tools']);
});

test('R-07: an unknown-tool answer clears the cache key but does not retry', async () => {
  const env = createPool();
  await env.pool.ensureConnected('lazy');
  const client = env.clients.clients[0];
  assert.ok(client);
  let businessCalls = 0;
  client.impl = async (name) => {
    if (name === 'search_tools') return { content: [] };
    businessCalls += 1;
    throw new McpToolError('unknown tool', { code: 'MCP_TOOL_NOT_FOUND' });
  };

  await assert.rejects(
    env.pool.callTool('lazy', 'list_tables', {}, { prepare: prepareFor('list_tables') }),
    (error: unknown) => (error as { code?: string }).code === 'MCP_TOOL_NOT_FOUND',
  );
  assert.equal(businessCalls, 1, 'the pool never replays a business call');

  client.impl = async (name) => ({ content: [{ type: 'text', text: name }] });
  await env.pool.callTool('lazy', 'list_tables', {}, { prepare: prepareFor('list_tables') });
  assert.equal(
    client.calls.filter((entry) => entry.name === 'search_tools').length,
    2,
    'the next call prepares again',
  );
});

test('a transport-level warm-up failure still degrades the entry', async () => {
  const env = createPool();
  await env.pool.ensureConnected('lazy');
  const client = env.clients.clients[0];
  assert.ok(client);
  client.impl = async (name) => {
    if (name === 'search_tools') {
      throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    }
    return { content: [] };
  };

  await assert.rejects(
    env.pool.callTool('lazy', 'list_tables', {}, { prepare: prepareFor('list_tables') }),
    (error: unknown) => (error as { code?: string }).code === 'MCP_DISCOVERY_PREPARE_FAILED',
  );
  assert.equal(env.pool.entry('lazy')?.state, 'degraded');
});

test('R-11: onPrepared replaces the prepared set', async () => {
  const env = createPool();
  await env.pool.ensureConnected('lazy');
  const client = env.clients.clients[0];
  assert.ok(client);
  client.impl = async (name) =>
    name === 'search_tools'
      ? { content: [{ type: 'text', text: '{"tools":[]}' }] }
      : { content: [{ type: 'text', text: `ok:${name}` }] };

  const onPrepared = (): readonly string[] => ['a', 'b'];
  await env.pool.callTool('lazy', 'a', {}, { prepare: prepareFor('a', { onPrepared }) });
  await env.pool.callTool('lazy', 'b', {}, { prepare: prepareFor('b', { onPrepared }) });
  assert.equal(
    client.calls.filter((entry) => entry.name === 'search_tools').length,
    1,
    'b was registered by the first search',
  );
});

test('invalidatePrepared drops the cache and discards a late in-flight result', async () => {
  const env = createPool();
  await env.pool.ensureConnected('lazy');
  const client = env.clients.clients[0];
  assert.ok(client);

  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  client.impl = async (name) => {
    if (name === 'search_tools') await blocker;
    return { content: [{ type: 'text', text: `ok:${name}` }] };
  };

  const pending = env.pool.callTool('lazy', 'a', {}, { prepare: prepareFor('a') });
  await tick();
  env.pool.invalidatePrepared('lazy');
  release();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.code, 'MCP_DISCOVERY_PREPARE_FAILED');
    assert.equal((error.detail as { reason?: string }).reason, 'invalidated');
    return true;
  });

  client.impl = async (name) => ({ content: [{ type: 'text', text: `ok:${name}` }] });
  await env.pool.callTool('lazy', 'a', {}, { prepare: prepareFor('a') });
  assert.equal(
    client.calls.filter((entry) => entry.name === 'search_tools').length,
    2,
    'the invalidated result did not repopulate the cache',
  );
  assert.deepEqual(
    client.calls.filter((entry) => entry.name === 'a').map((entry) => entry.name),
    ['a'],
    'the invalidated call never reached the business tool',
  );
});

test('a reconnect discards a warm-up that resolves on the old generation', async () => {
  const env = createPool();
  await env.pool.ensureConnected('lazy');
  const firstClient = env.clients.clients[0];
  assert.ok(firstClient);

  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  firstClient.impl = async (name) => {
    if (name === 'search_tools') await blocker;
    return { content: [{ type: 'text', text: `ok:${name}` }] };
  };

  const pending = env.pool.callTool('lazy', 'a', {}, { prepare: prepareFor('a') });
  await tick();
  env.transports.transports[0]?.emitClose(new Error('socket gone'));
  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'MCP_SERVER_UNAVAILABLE');
    return true;
  });
  release();
  await tick(20);
  await waitFor(() => env.pool.entry('lazy')?.state === 'ready');

  const secondClient = env.clients.clients[1];
  assert.ok(secondClient);
  await env.pool.callTool('lazy', 'a', {}, { prepare: prepareFor('a') });
  assert.deepEqual(
    secondClient.calls.map((entry) => entry.name).slice(0, 2),
    ['search_tools', 'a'],
    'the new connection prepares itself instead of trusting the old result',
  );
});

test('callToolDirect bypasses gates and preparation', async () => {
  const env = createPool();
  await env.pool.ensureConnected('lazy');
  const client = env.clients.clients[0];
  assert.ok(client);
  await env.pool.callToolDirect('lazy', 'search_tools', { query: 'x' });
  assert.deepEqual(client.calls, [{ name: 'search_tools', args: { query: 'x' } }]);
});

// ---------------------------------------------------------------------------
// Runtime: provider, serial promotion, stale interception, discoverTools
// ---------------------------------------------------------------------------

class RuntimeServers {
  readonly records = new Map<string, PoolRuntimeServerRecord>();
  async get(id: string): Promise<PoolRuntimeServerRecord | null> {
    return this.records.get(id) ?? null;
  }
}

interface RuntimeHarness {
  runtime: PoolRuntime;
  clients: FakeClients;
  transports: FakeTransports;
  servers: RuntimeServers;
  prepared: Array<[string, string]>;
}

function runtimeHarness(options: {
  toolDiscovery?: PoolRuntimeServerRecord['toolDiscovery'];
  policies?: (serverId: string, toolName: string) => PoolToolPolicy;
  prepare?: PoolPrepareProvider;
  clock?: { now(): number };
  callTimeoutMs?: number;
} = {}): RuntimeHarness {
  const clients = new FakeClients();
  const transports = new FakeTransports();
  const servers = new RuntimeServers();
  servers.records.set('lazy', {
    id: 'lazy',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: {},
    cwd: null,
    url: null,
    headers: {},
    enabled: true,
    revision: 1,
    toolDiscovery: options.toolDiscovery ?? {
      mode: 'search',
      searchTool: 'search_tools',
      query: '',
      args: {},
      maxTools: 50,
      prepareOnCall: true,
    },
  });
  const prepared: Array<[string, string]> = [];
  const runtimeOptions: PoolRuntimeOptions = {
    servers,
    secrets: { get: async () => undefined },
    transportFactory: transports,
    clientFactory: clients,
    gates: new PoolGates(),
    health: false,
    connectTimeoutMs: 500,
    callTimeoutMs: options.callTimeoutMs ?? 1_000,
    backoffMs: [1, 1, 1],
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    policies: {
      get: (serverId, toolName) =>
        options.policies === undefined
          ? { concurrency: 'parallel', discoveredVia: 'search' }
          : options.policies(serverId, toolName),
    },
    ...(options.prepare === undefined
      ? {}
      : {
          prepareProvider: (serverId: string, toolName: string) => {
            prepared.push([serverId, toolName]);
            return options.prepare?.(serverId, toolName) ?? null;
          },
        }),
  };
  return {
    runtime: createPoolRuntime(runtimeOptions),
    clients,
    transports,
    servers,
    prepared,
  };
}

function prepareInfo(toolName: string): PoolRuntimePrepareInfo {
  return {
    prepare: { tool: 'search_tools', args: { query: toolName }, cacheKey: toolName },
    searchTool: 'search_tools',
    query: toolName,
    args: { query: toolName },
  };
}

test('R-01 via runtime: prepareOnCall warms the connection before the tool call', async () => {
  const env = runtimeHarness({ prepare: (_server, tool) => prepareInfo(tool) });
  try {
    await env.runtime.callTool(call('lazy', 'list_tables', {}));
    const client = env.clients.clients[0];
    assert.ok(client);
    assert.deepEqual(client.calls.map((entry) => entry.name), ['search_tools', 'list_tables']);
    assert.deepEqual(env.prepared, [['lazy', 'list_tables']]);

    await env.runtime.callTool(call('lazy', 'list_tables', {}));
    assert.deepEqual(client.calls.map((entry) => entry.name), [
      'search_tools',
      'list_tables',
      'list_tables',
    ]);
  } finally {
    await env.runtime.dispose();
  }
});

test('R-08: prepareOnCall=false and static rows skip the provider', async () => {
  const disabled = runtimeHarness({
    toolDiscovery: {
      mode: 'search',
      searchTool: 'search_tools',
      query: '',
      args: {},
      maxTools: 50,
      prepareOnCall: false,
    },
    prepare: (_server, tool) => prepareInfo(tool),
  });
  try {
    await disabled.runtime.callTool(call('lazy', 'list_tables', {}));
    assert.deepEqual(disabled.prepared, []);
    assert.deepEqual(
      disabled.clients.clients[0]?.calls.map((entry) => entry.name),
      ['list_tables'],
    );
  } finally {
    await disabled.runtime.dispose();
  }

  const staticRow = runtimeHarness({
    policies: () => ({ concurrency: 'parallel', discoveredVia: 'static' }),
    prepare: (_server, tool) => prepareInfo(tool),
  });
  try {
    await staticRow.runtime.callTool(call('lazy', 'echo', {}));
    assert.deepEqual(staticRow.prepared, []);
    assert.deepEqual(staticRow.clients.clients[0]?.calls.map((entry) => entry.name), ['echo']);
  } finally {
    await staticRow.runtime.dispose();
  }
});

test('C-04: a stale discovered row is not callable, even with staleOverride', async () => {
  const env = runtimeHarness({
    policies: () => ({
      concurrency: 'parallel',
      discoveredVia: 'search',
      stale: true,
      staleOverride: true,
    }),
    prepare: (_server, tool) => prepareInfo(tool),
  });
  try {
    await assert.rejects(env.runtime.callTool(call('lazy', 'list_tables')), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'MCP_DISCOVERY_TOOL_STALE');
      return true;
    });
    assert.equal(env.clients.clients.length, 0, 'no connection was opened');
    assert.deepEqual(env.prepared, []);
  } finally {
    await env.runtime.dispose();
  }
});

test('R-10: prepared calls on a parallel policy are promoted to serial', async () => {
  const env = runtimeHarness({ prepare: (_server, tool) => prepareInfo(tool) });
  try {
    await env.runtime.callTool(call('lazy', 'a'));
    const client = env.clients.clients[0];
    assert.ok(client);
    client.impl = async (name) => {
      await tick(10);
      return { content: [{ type: 'text', text: name }] };
    };
    const start = Date.now();
    await Promise.all([
      env.runtime.callTool(call('lazy', 'b')),
      env.runtime.callTool(call('lazy', 'c')),
    ]);
    assert.ok(Date.now() - start >= 15);
    assert.equal(client.maxActive, 1, 'search/call pairs never interleave');
  } finally {
    await env.runtime.dispose();
  }
});

test('R-04: two different tools called concurrently keep search/call pairs serial', async () => {
  const env = runtimeHarness({ prepare: (_server, tool) => prepareInfo(tool) });
  try {
    await env.runtime.callTool(call('lazy', 'warmup'));
    const client = env.clients.clients[0];
    assert.ok(client);
    client.impl = async (name) => {
      await tick(5);
      return { content: [{ type: 'text', text: name }] };
    };

    const before = client.calls.length;
    await Promise.all([
      env.runtime.callTool(call('lazy', 'alpha')),
      env.runtime.callTool(call('lazy', 'beta')),
    ]);

    const names = client.calls.slice(before).map((entry) => entry.name);
    const alphaFirst =
      names[0] === 'search_tools'
      && names[1] === 'alpha'
      && names[2] === 'search_tools'
      && names[3] === 'beta';
    const betaFirst =
      names[0] === 'search_tools'
      && names[1] === 'beta'
      && names[2] === 'search_tools'
      && names[3] === 'alpha';
    assert.ok(
      alphaFirst || betaFirst,
      `search/call pairs must not interleave, got ${names.join(',')}`,
    );
    assert.equal(client.maxActive, 1, 'the serial promotion also covers parallel rows');
  } finally {
    await env.runtime.dispose();
  }
});

test('R-05: after a reconnect the next call searches again', async () => {
  const env = runtimeHarness({ prepare: (_server, tool) => prepareInfo(tool) });
  try {
    await env.runtime.callTool(call('lazy', 'alpha'));
    const firstClient = env.clients.clients[0];
    assert.ok(firstClient);
    assert.deepEqual(firstClient.calls.map((entry) => entry.name), ['search_tools', 'alpha']);

    env.transports.transports[0]?.emitClose(new Error('socket gone'));
    await waitFor(() => env.runtime.snapshot().entries[0]?.state === 'ready');

    const secondClient = env.clients.clients[1];
    assert.ok(secondClient, 'the reconnect opened a new connection');
    await env.runtime.callTool(call('lazy', 'alpha'));
    assert.deepEqual(
      secondClient.calls.map((entry) => entry.name).slice(0, 2),
      ['search_tools', 'alpha'],
      'the new connection has an empty prepare cache',
    );
  } finally {
    await env.runtime.dispose();
  }
});

test('R-14: prepare uses min(15s, remaining) and shares the call deadline', async () => {
  assert.equal(POOL_DEFAULTS.callTimeoutMs, 60_000);
  assert.equal(POOL_DEFAULTS.prepareTimeoutMs, 15_000);

  // Clock reads: the lazy connect, the in-flight start and the deadline all see
  // t=0, so the call gets the default 60s budget. The prepare start then jumps
  // to t=59_950, leaving only 50ms; a prepare that ignored the remaining budget
  // would run for its own 15s. The test therefore finishes in ~50ms.
  let reads = 0;
  const capped = runtimeHarness({
    callTimeoutMs: POOL_DEFAULTS.callTimeoutMs,
    prepare: (_server, tool) => prepareInfo(tool),
    clock: {
      now: () => {
        reads += 1;
        return reads < 4 ? 0 : 59_950;
      },
    },
  });
  try {
    // The client is created lazily on connect; install the impl before that.
    capped.clients.configure = (created) => {
      created.impl = async (name) => {
        if (name === 'search_tools') return await new Promise(() => {});
        return { content: [] };
      };
    };
    const started = Date.now();
    await assert.rejects(
      capped.runtime.callTool(call('lazy', 'alpha')),
      (error: unknown) => {
        assert.ok(error instanceof McpToolError);
        assert.equal(error.code, 'MCP_DISCOVERY_PREPARE_FAILED');
        assert.equal((error.detail as { reason?: string }).reason, 'timeout');
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 20, `prepare should wait for the remaining budget, took ${elapsed}ms`);
    assert.ok(elapsed < 900, `prepare must not use 15s, took ${elapsed}ms`);
    assert.deepEqual(
      capped.clients.clients[0]?.calls.map((entry) => entry.name),
      ['search_tools'],
      'the business call is never sent after a failed warm-up',
    );
  } finally {
    await capped.runtime.dispose();
  }

  // Slow search + slow business fit in one budget when together they stay
  // within it, and the combined call is cut at the shared deadline when not.
  const fitting = runtimeHarness({ callTimeoutMs: 120, prepare: (_s, tool) => prepareInfo(tool) });
  try {
    fitting.clients.configure = (created) => {
      created.impl = async (name) => {
        await tick(30);
        return { content: [{ type: 'text', text: name }] };
      };
    };
    const started = Date.now();
    await fitting.runtime.callTool(call('lazy', 'alpha'));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `search+business stayed inside the budget, took ${elapsed}ms`);
    assert.deepEqual(
      fitting.clients.clients[0]?.calls.map((entry) => entry.name),
      ['search_tools', 'alpha'],
    );
  } finally {
    await fitting.runtime.dispose();
  }

  const overBudget = runtimeHarness({
    callTimeoutMs: 120,
    prepare: (_s, tool) => prepareInfo(tool),
  });
  try {
    overBudget.clients.configure = (created) => {
      created.impl = async (name) => {
        if (name === 'search_tools') {
          await tick(80);
          return { content: [] };
        }
        await tick(200);
        return { content: [] };
      };
    };
    const started = Date.now();
    await assert.rejects(
      overBudget.runtime.callTool(call('lazy', 'alpha')),
      (error: unknown) => (error as { code?: string }).code === 'MCP_CALL_TIMEOUT',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `the shared 120ms deadline cut the call, took ${elapsed}ms`);
  } finally {
    await overBudget.runtime.dispose();
  }
});

test('discoverTools runs directly on the serial gate and respects cancellation', async () => {
  const env = runtimeHarness();
  try {
    await env.runtime.discoverTools('lazy', { tool: 'search_tools', args: { query: 'x' } });
    const client = env.clients.clients[0];
    assert.ok(client);
    assert.deepEqual(client.calls, [{ name: 'search_tools', args: { query: 'x' } }]);

    const controller = new AbortController();
    controller.abort(new Error('caller went away'));
    await assert.rejects(
      env.runtime.discoverTools('lazy', {
        tool: 'search_tools',
        args: {},
        signal: controller.signal,
      }),
      (error: unknown) => (error as { code?: string }).code === 'MCP_CALL_CANCELLED',
    );
    assert.equal(client.calls.length, 1, 'an aborted scan never reaches the upstream');
  } finally {
    await env.runtime.dispose();
  }
});
