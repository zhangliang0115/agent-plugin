import assert from 'node:assert/strict';
import test from 'node:test';

import { McpToolError } from '@zhangliang0115/repl-server-core/src/errors.ts';
import type { ToolCallRequest } from '@zhangliang0115/repl-server-core/src/types.ts';

import { ExecGateway } from '../src/exec/gateway.ts';
import { PoolGates } from '../src/pool/gates.ts';
import type {
  HttpTransportOptions,
  PoolClient,
  PoolClientFactory,
  PoolServerSpec,
  PoolToolInfo,
  PoolTransport,
  PoolTransportFactory,
  StdioTransportOptions,
} from '../src/pool/pool.ts';
import {
  createPoolRuntime,
  UPSTREAM_TASK_UNSUPPORTED,
  type PoolRuntime,
  type PoolRuntimeOptions,
  type PoolRuntimeServerRecord,
  type PoolToolPolicySource,
} from '../src/pool/runtime.ts';
import type { ProcessLedger, RequestIdentity, ScriptRequest } from '../src/ports.ts';

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(5);
  }
  assert.fail('condition was not met before the deadline');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = () => res();
  });
  return { promise, resolve };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
    assert.equal((error as { code?: unknown }).code, code);
    return true;
  };
}

function call(server: string, tool: string, args: Record<string, unknown> = {}): ToolCallRequest {
  return { evalId: 1, epoch: 1, callSeq: 1, tool, server, args };
}

function unqualifiedCall(tool: string, args: Record<string, unknown> = {}): ToolCallRequest {
  return { evalId: 1, epoch: 1, callSeq: 1, tool, args };
}

function baseRecord(
  overrides: Partial<PoolRuntimeServerRecord> = {},
): PoolRuntimeServerRecord {
  return {
    id: 'pg',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: {},
    cwd: null,
    url: null,
    headers: {},
    enabled: true,
    revision: 1,
    ...overrides,
  };
}

class FakeTransport implements PoolTransport {
  readonly kind: 'stdio' | 'http';
  readonly pid?: number;
  readonly pgid?: number;
  readonly lstart?: string;
  closed = false;
  private stderrHandler: ((chunk: string) => void) | null = null;
  private closeHandler: ((error?: unknown) => void) | null = null;

  constructor(kind: 'stdio' | 'http') {
    this.kind = kind;
    if (kind === 'stdio') {
      this.pid = 1_000 + Math.floor(Math.random() * 1_000);
      this.pgid = this.pid;
      this.lstart = 'Mon Nov 17 14:31:58 2026';
    }
  }

  onStderr(handler: (chunk: string) => void): void {
    this.stderrHandler = handler;
  }

  onClose(handler: (error?: unknown) => void): void {
    this.closeHandler = handler;
  }

  emitStderr(chunk: string): void {
    this.stderrHandler?.(chunk);
  }

  emitClose(error?: unknown): void {
    this.closeHandler?.(error);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeClient implements PoolClient {
  connectCalls = 0;
  listCalls = 0;
  pingCalls = 0;
  closed = false;
  readonly callCalls: Array<{ name: string; args: unknown }> = [];
  connectImpl: (() => Promise<void>) | null = null;
  listImpl: (() => Promise<readonly PoolToolInfo[]>) | null = null;
  callImpl:
    | ((name: string, args: unknown, options: { signal: AbortSignal }) => Promise<unknown>)
    | null = null;

  async connect(_transport: PoolTransport, _options: { signal: AbortSignal }): Promise<void> {
    this.connectCalls += 1;
    if (this.connectImpl !== null) await this.connectImpl();
  }

  async listTools(): Promise<readonly PoolToolInfo[]> {
    this.listCalls += 1;
    if (this.listImpl !== null) return await this.listImpl();
    return [{ name: 'echo' }, { name: 'write_row' }];
  }

  async callTool(
    name: string,
    args: unknown,
    options: { signal: AbortSignal },
  ): Promise<unknown> {
    this.callCalls.push({ name, args });
    if (this.callImpl !== null) return await this.callImpl(name, args, options);
    return { content: [{ type: 'text', text: JSON.stringify(args) }] };
  }

  async ping(): Promise<void> {
    this.pingCalls += 1;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeTransportFactory implements PoolTransportFactory {
  readonly stdioOptions: StdioTransportOptions[] = [];
  readonly httpOptions: HttpTransportOptions[] = [];
  readonly transports: FakeTransport[] = [];

  stdio(options: StdioTransportOptions): PoolTransport {
    this.stdioOptions.push(options);
    const transport = new FakeTransport('stdio');
    this.transports.push(transport);
    return transport;
  }

  http(options: HttpTransportOptions): PoolTransport {
    this.httpOptions.push(options);
    const transport = new FakeTransport('http');
    this.transports.push(transport);
    return transport;
  }
}

class FakeClientFactory implements PoolClientFactory {
  readonly clients: FakeClient[] = [];
  configure: ((client: FakeClient, spec: PoolServerSpec, index: number) => void) | null = null;

  create(spec: PoolServerSpec, _transport: PoolTransport): PoolClient {
    const client = new FakeClient();
    const index = this.clients.length;
    this.clients.push(client);
    this.configure?.(client, spec, index);
    return client;
  }
}

class FakeServers {
  readonly records = new Map<string, PoolRuntimeServerRecord>();

  async get(id: string): Promise<PoolRuntimeServerRecord | null> {
    return this.records.get(id) ?? null;
  }

  async list(): Promise<readonly PoolRuntimeServerRecord[]> {
    return [...this.records.values()];
  }
}

class FakeSecrets {
  readonly values = new Map<string, string>();
  readonly gets: string[] = [];

  async get(name: string): Promise<string | undefined> {
    this.gets.push(name);
    return this.values.get(name);
  }
}

class FakeLedger implements ProcessLedger {
  readonly records: Array<Record<string, unknown>> = [];
  readonly removed: string[] = [];

  async recordPool(entry: Record<string, unknown>): Promise<void> {
    this.records.push({ ...entry });
  }

  async removePool(serverId: string): Promise<void> {
    this.removed.push(serverId);
  }
}

interface Harness {
  runtime: PoolRuntime;
  servers: FakeServers;
  transports: FakeTransportFactory;
  clients: FakeClientFactory;
  secrets: FakeSecrets;
  ledger: FakeLedger;
}

function makeHarness(
  overrides: Partial<PoolRuntimeOptions> = {},
  recordOverrides: Partial<PoolRuntimeServerRecord> = {},
): Harness {
  const servers = new FakeServers();
  servers.records.set('pg', baseRecord(recordOverrides));
  const transports = new FakeTransportFactory();
  const clients = new FakeClientFactory();
  const secrets = new FakeSecrets();
  const ledger = new FakeLedger();
  const runtime = createPoolRuntime({
    servers,
    secrets,
    transportFactory: transports,
    clientFactory: clients,
    ledger,
    health: false,
    autoReconnect: false,
    ...overrides,
  });
  return { runtime, servers, transports, clients, secrets, ledger };
}

function policyFor(
  map: Readonly<Record<string, 'parallel' | 'serial' | 'exclusive'>>,
): PoolToolPolicySource {
  return {
    get: (_serverId, toolName) => ({ concurrency: map[toolName] ?? 'parallel' }),
  };
}

test('first calls connect lazily once and share the in-flight attempt', async (t) => {
  const harness = makeHarness();
  t.after(() => harness.runtime.dispose());
  harness.clients.configure = (client) => {
    client.connectImpl = async () => {
      await tick(15);
    };
  };

  assert.equal(harness.transports.stdioOptions.length, 0, 'registration alone must not spawn');

  const qualified = harness.runtime.callTool(call('pg', 'echo', { n: 1 }));
  const unqualified = harness.runtime.callTool(unqualifiedCall('pg.echo', { n: 2 }));
  const [first, second] = await Promise.all([qualified, unqualified]);

  assert.deepEqual(first, { text: '{"n":1}', images: [], documents: [] });
  assert.deepEqual(second, { text: '{"n":2}', images: [], documents: [] });
  assert.equal(harness.transports.stdioOptions.length, 1, 'one stdio child per server');
  assert.equal(harness.clients.clients.length, 1);
  assert.equal(harness.clients.clients[0]?.connectCalls, 1, 'initialize must run once');
  assert.equal(harness.clients.clients[0]?.listCalls, 1, 'tools/list must run once');
});

test('serial calls hold the write lock and block later parallel calls', async (t) => {
  const hold = deferred();
  const events: string[] = [];
  const harness = makeHarness({ policies: policyFor({ write_row: 'serial' }) });
  t.after(() => harness.runtime.dispose());
  harness.clients.configure = (client) => {
    client.callImpl = async (name) => {
      events.push(`${name}:start`);
      if (name === 'write_row') await hold.promise;
      events.push(`${name}:end`);
      return { name };
    };
  };

  const first = harness.runtime.callTool(call('pg', 'write_row'));
  await waitFor(() => events.length >= 1);

  const second = harness.runtime.callTool(call('pg', 'write_row'));
  const reader = harness.runtime.callTool(call('pg', 'echo'));
  await tick(25);

  assert.equal(events.length, 1, 'a serial call must drain in-flight and block new calls');
  assert.equal(harness.clients.clients[0]?.callCalls.length, 1);

  hold.resolve();
  await Promise.all([first, second, reader]);

  assert.equal(events.filter((event) => event === 'write_row:start').length, 2);
  assert.ok(
    events.lastIndexOf('write_row:end') < events.indexOf('echo:start'),
    `parallel reads must wait behind the serial writer: ${events.join(',')}`,
  );
});

test('a deadline aborts a call waiting on a gate and leaves no pending upstream work', async (t) => {
  const hold = deferred();
  const harness = makeHarness({ policies: policyFor({ write_row: 'serial' }) });
  t.after(() => harness.runtime.dispose());
  harness.clients.configure = (client) => {
    client.callImpl = async (name) => {
      if (name === 'write_row') await hold.promise;
      return { name };
    };
  };

  const first = harness.runtime.callTool(call('pg', 'write_row'));
  await waitFor(() => (harness.clients.clients[0]?.callCalls.length ?? 0) === 1);

  const startedAt = Date.now();
  await assert.rejects(
    harness.runtime.callTool(call('pg', 'write_row'), { deadline: Date.now() + 30 }),
    hasCode('MCP_CALL_TIMEOUT'),
  );
  assert.ok(Date.now() - startedAt < 500, 'the queued call rejects at its deadline');

  hold.resolve();
  await first;
  await tick(20);
  assert.equal(
    harness.clients.clients[0]?.callCalls.filter((entry) => entry.name === 'write_row').length,
    1,
    'the aborted call never reaches the upstream server',
  );

  // The runtime is still usable once the gate drains.
  assert.deepEqual(await harness.runtime.callTool(call('pg', 'echo')), {
    text: '',
    images: [],
    documents: [],
  });
});

test('an already-aborted caller signal rejects before any upstream call', async (t) => {
  const harness = makeHarness();
  t.after(() => harness.runtime.dispose());

  const controller = new AbortController();
  controller.abort(new McpToolError('cancelled by test', { code: 'MCP_CALL_CANCELLED' }));
  await assert.rejects(
    harness.runtime.callTool(call('pg', 'echo'), { signal: controller.signal }),
    hasCode('MCP_CALL_CANCELLED'),
  );
  assert.equal(harness.transports.stdioOptions.length, 0, 'no transport is opened');
});

test('exclusive admission drains in-flight calls and times out with EXCLUSIVE_TIMEOUT', async (t) => {
  const hold = deferred();
  const harness = makeHarness({
    policies: policyFor({ migrate: 'exclusive' }),
    gates: new PoolGates({ exclusiveTimeoutMs: 40 }),
  });
  t.after(() => harness.runtime.dispose());
  harness.clients.configure = (client) => {
    client.callImpl = async (name) => {
      if (name === 'query') await hold.promise;
      return { name };
    };
  };

  const query = harness.runtime.callTool(call('pg', 'query'));
  await waitFor(() => (harness.clients.clients[0]?.callCalls.length ?? 0) === 1);

  await assert.rejects(harness.runtime.callTool(call('pg', 'migrate')), hasCode('EXCLUSIVE_TIMEOUT'));
  assert.equal(
    harness.clients.clients[0]?.callCalls.some((entry) => entry.name === 'migrate'),
    false,
    'a timed-out exclusive call must never reach the upstream server',
  );

  hold.resolve();
  await query;
});

test('an upstream CreateTaskResult is rejected instead of returned', async (t) => {
  const harness = makeHarness();
  t.after(() => harness.runtime.dispose());
  harness.clients.configure = (client) => {
    client.callImpl = async (name) => {
      if (name === 'slow_tool') {
        return { resultType: 'task', taskId: 't_upstream', status: 'working' };
      }
      return { taskId: 't_bare' };
    };
  };

  await assert.rejects(harness.runtime.callTool(call('pg', 'slow_tool')), (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.code, UPSTREAM_TASK_UNSUPPORTED);
    assert.match(error.message, /does not forward upstream tasks/);
    assert.deepEqual(error.detail, {
      resultType: 'task',
      taskId: 't_upstream',
      status: 'working',
    });
    return true;
  });

  await assert.rejects(
    harness.runtime.callTool(call('pg', 'bare_task')),
    hasCode(UPSTREAM_TASK_UNSUPPORTED),
  );
});

test('dispose closes the transport, clears the ledger and rejects later calls', async (t) => {
  const harness = makeHarness();
  t.after(() => harness.runtime.dispose());

  await harness.runtime.callTool(call('pg', 'echo'));
  const transport = harness.transports.transports[0];
  const client = harness.clients.clients[0];
  assert.ok(transport !== undefined);
  assert.ok(client !== undefined);
  assert.equal(transport.closed, false);

  await harness.runtime.dispose();

  assert.equal(transport.closed, true);
  assert.equal(client.closed, true);
  assert.deepEqual(harness.ledger.removed, ['pg']);
  await assert.rejects(
    harness.runtime.callTool(call('pg', 'echo')),
    hasCode('MCP_SERVER_UNAVAILABLE'),
  );

  await harness.runtime.dispose();
});

test('$secret refs are resolved for the transport and never passed through raw', async (t) => {
  const harness = makeHarness({}, { env: { DB_URL: { $secret: 'db_url' } } });
  t.after(() => harness.runtime.dispose());
  harness.secrets.values.set('db_url', `synthetic-${Date.now()}`);

  await harness.runtime.callTool(call('pg', 'echo'));

  const env = harness.transports.stdioOptions[0]?.env;
  assert.ok(env !== undefined);
  assert.equal(typeof env['DB_URL'], 'string');
  assert.equal(
    Object.values(env).some((value) => value.includes('$secret')),
    false,
    'the literal ref object must never reach the transport',
  );
  assert.deepEqual(harness.secrets.gets, ['db_url']);
});

test('missing secrets fail before a transport is created', async (t) => {
  const harness = makeHarness({}, { env: { DB_URL: { $secret: 'db_url' } } });
  t.after(() => harness.runtime.dispose());

  await assert.rejects(harness.runtime.callTool(call('pg', 'echo')), (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.code, 'MCP_SERVER_UNAVAILABLE');
    assert.match(error.message, /db_url/);
    return true;
  });
  assert.equal(harness.transports.stdioOptions.length, 0);
});

test('control.test opens a throwaway connection and registers nothing', async (t) => {
  const harness = makeHarness();
  t.after(() => harness.runtime.dispose());

  const result = await harness.runtime.control.test('pg', { timeoutMs: 1_000 });
  assert.deepEqual(
    result.tools.map((tool) => (tool as { name: string }).name),
    ['echo', 'write_row'],
  );
  assert.equal(harness.runtime.snapshot().total, 0);
  assert.equal(harness.transports.transports[0]?.closed, true);
  assert.equal(harness.clients.clients[0]?.closed, true);
  assert.equal(harness.ledger.records.length, 0, 'a test connection must not touch the ledger');
});

test('control.state follows idle -> ready -> idle without spawning on read', async (t) => {
  const harness = makeHarness();
  t.after(() => harness.runtime.dispose());

  assert.deepEqual(await harness.runtime.control.state('pg'), { state: 'idle' });
  assert.equal(harness.transports.stdioOptions.length, 0);

  await harness.runtime.control.connect('pg');
  assert.equal((await harness.runtime.control.state('pg'))?.state, 'ready');

  await harness.runtime.control.disconnect('pg');
  assert.equal((await harness.runtime.control.state('pg'))?.state, 'idle');
});

test('unknown servers are reported as MCP_SERVER_NOT_FOUND', async (t) => {
  const harness = makeHarness();
  t.after(() => harness.runtime.dispose());

  await assert.rejects(
    harness.runtime.callTool(call('missing', 'echo')),
    hasCode('MCP_SERVER_NOT_FOUND'),
  );
  assert.equal(await harness.runtime.control.state('missing'), null);
});

test('retire reports in-flight work and force unregisters the server', async (t) => {
  const hold = deferred();
  const harness = makeHarness();
  t.after(async () => {
    hold.resolve();
    await harness.runtime.dispose();
  });
  harness.clients.configure = (client) => {
    client.callImpl = async () => {
      await hold.promise;
      return { ok: true };
    };
  };

  const running = harness.runtime.callTool(call('pg', 'echo'));
  await waitFor(() => (harness.clients.clients[0]?.callCalls.length ?? 0) === 1);

  assert.deepEqual(await harness.runtime.control.retire('pg', { force: false }), {
    drained: false,
    inFlight: 1,
  });

  assert.equal((await harness.runtime.control.retire('pg', { force: true })).drained, true);
  assert.equal(harness.runtime.snapshot().total, 0);
  await assert.rejects(running, hasCode('MCP_SERVER_UNAVAILABLE'));
});

test('third-party results are normalized to text plus media', async (t) => {
  const harness = makeHarness();
  t.after(() => harness.runtime.dispose());
  const imageBase64 = 'aW1n';
  const pdfBase64 = 'cGRm';
  harness.clients.configure = (client) => {
    client.callImpl = async () => ({
      content: [
        { type: 'text', text: 'saved' },
        { type: 'image', data: imageBase64, mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///note.txt', text: 'resource text' } },
        {
          type: 'resource',
          resource: { uri: 'file:///report.pdf', mimeType: 'application/pdf', blob: pdfBase64 },
        },
      ],
    });
  };

  assert.deepEqual(await harness.runtime.callTool(call('pg', 'fetch')), {
    text: 'saved\nresource text',
    images: [{ base64: imageBase64, mediaType: 'image/png' }],
    documents: [{ base64: pdfBase64 }],
  });
});

test('normalized MCP media reaches the gateway media collector', async (t) => {
  const harness = makeHarness();
  t.after(() => harness.runtime.dispose());
  const imageBase64 = 'aW1n';
  const pdfBase64 = 'cGRm';
  harness.clients.configure = (client) => {
    client.callImpl = async () => ({
      content: [
        { type: 'text', text: 'saved' },
        { type: 'image', data: imageBase64, mimeType: 'image/png' },
        {
          type: 'resource',
          resource: { uri: 'file:///report.pdf', mimeType: 'application/pdf', blob: pdfBase64 },
        },
      ],
    });
  };

  const gateway = new ExecGateway({
    callTool: (chatCall, _workspace, binding, signal, deadline) =>
      harness.runtime.callTool(chatCall, {
        bindingId: binding ?? null,
        ...(signal === undefined ? {} : { signal }),
        ...(deadline === undefined ? {} : { deadline }),
      }),
  });
  t.after(async () => {
    await gateway.disposeAll();
  });

  const identity: RequestIdentity = {
    identity: 'unbound',
    binding: null,
    client: 'test-client/1.0',
    mcp: 'mcp_pool_media',
  };
  const request: ScriptRequest = {
    code: `
      const result = await tools.mcp.pg.fetch({ path: '/tmp/a' });
      return result.text;
    `,
    timeoutMs: 10_000,
    async: false,
    identity,
  };

  const outcome = await gateway.runScript(request);
  assert.equal(outcome.isError, false, outcome.content);
  assert.match(outcome.content, /<result>saved<\/result>/);
  assert.doesNotMatch(outcome.content, /aW1n|cGRm/);
  assert.deepEqual(outcome.images, [{ base64: imageBase64, mediaType: 'image/png' }]);
  assert.deepEqual(outcome.documents, [{ base64: pdfBase64 }]);
});

test('independent MCP calls overlap under Promise.all', async (t) => {
  const harness = makeHarness();
  t.after(() => harness.runtime.dispose());
  const delayMs = 200;
  const calls: Array<{ name: string; startedAt: number; endedAt?: number }> = [];
  harness.clients.configure = (client) => {
    client.callImpl = async (name) => {
      const record: { name: string; startedAt: number; endedAt?: number } = {
        name,
        startedAt: Date.now(),
      };
      calls.push(record);
      await tick(delayMs);
      record.endedAt = Date.now();
      return { content: [{ type: 'text', text: name }] };
    };
  };

  const gateway = new ExecGateway({
    callTool: (poolCall, _workspace, binding, signal, deadline) =>
      harness.runtime.callTool(poolCall, {
        bindingId: binding ?? null,
        ...(signal === undefined ? {} : { signal }),
        ...(deadline === undefined ? {} : { deadline }),
      }),
  });
  t.after(async () => {
    await gateway.disposeAll();
  });

  const identity: RequestIdentity = {
    identity: 'unbound',
    binding: null,
    client: 'test-client/1.0',
    mcp: 'mcp_pool_parallel',
  };
  const request: ScriptRequest = {
    code: `
      const [first, second] = await Promise.all([
        tools.mcp.pg.echo({ n: 1 }),
        tools.mcp.pg.write_row({ n: 2 }),
      ]);
      return first.text + '/' + second.text;
    `,
    timeoutMs: 10_000,
    async: false,
    identity,
  };

  const outcome = await gateway.runScript(request);
  assert.equal(outcome.isError, false, outcome.content);
  assert.match(outcome.content, /<result>echo\/write_row<\/result>/);

  assert.equal(calls.length, 2);
  const first = calls[0];
  const second = calls[1];
  assert.ok(first !== undefined && second !== undefined);
  const firstEnd = first.endedAt;
  const secondEnd = second.endedAt;
  assert.ok(firstEnd !== undefined && secondEnd !== undefined);
  assert.ok(
    second.startedAt < firstEnd,
    `the second call must start before the first ends: ${JSON.stringify(calls)}`,
  );
  const span = Math.max(firstEnd, secondEnd) - first.startedAt;
  assert.ok(span < delayMs * 2, `overlapping calls spanned ${span}ms, serial would be ~${delayMs * 2}ms`);
});
