import assert from 'node:assert/strict';
import test from 'node:test';

import { isTransportTimeout, McpToolError } from '@zhangliang0115/repl-server-core/src/errors.ts';

import { HealthMonitor, type HealthPool, type HealthTarget, type HealthTimerApi } from '../src/pool/health.ts';
import {
  ConnectionPool,
  type HttpTransportOptions,
  type PoolClient,
  type PoolClientFactory,
  type PoolOptions,
  type PoolServerSpec,
  type PoolToolInfo,
  type PoolTransport,
  type PoolTransportFactory,
  type StdioTransportOptions,
} from '../src/pool/pool.ts';
import type { ProcessLedger } from '../src/ports.ts';

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(5);
  }
  assert.fail('condition was not met before the deadline');
}

function spec(overrides: Partial<PoolServerSpec> = {}): PoolServerSpec {
  return {
    id: 'pg',
    cfgVersion: 1,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { PG_URL: 'postgres://local' },
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

  constructor(kind: 'stdio' | 'http', process?: { pid: number; pgid: number; lstart: string }) {
    this.kind = kind;
    if (process !== undefined) {
      this.pid = process.pid;
      this.pgid = process.pgid;
      this.lstart = process.lstart;
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
  callCalls: Array<{ name: string; args: unknown }> = [];
  pingCalls = 0;
  closed = false;
  lastCallSignal: AbortSignal | null = null;
  connectImpl: (() => Promise<void>) | null = null;
  listImpl: (() => Promise<readonly PoolToolInfo[]>) | null = null;
  callImpl: ((name: string, args: unknown, options: { signal: AbortSignal }) => Promise<unknown>) | null = null;
  pingImpl: (() => Promise<void>) | null = null;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectImpl !== null) await this.connectImpl();
  }

  async listTools(): Promise<readonly PoolToolInfo[]> {
    this.listCalls += 1;
    if (this.listImpl !== null) return await this.listImpl();
    return [{ name: 'echo' }, { name: 'write_row' }];
  }

  async callTool(name: string, args: unknown, options: { signal: AbortSignal }): Promise<unknown> {
    this.callCalls.push({ name, args });
    this.lastCallSignal = options.signal;
    if (this.callImpl !== null) return await this.callImpl(name, args, options);
    return { echo: args };
  }

  async ping(): Promise<void> {
    this.pingCalls += 1;
    if (this.pingImpl !== null) await this.pingImpl();
  }

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
  readonly stdioOptions: StdioTransportOptions[] = [];
  readonly httpOptions: HttpTransportOptions[] = [];
  readonly transports: FakeTransport[] = [];
  failStdio = 0;
  private readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  stdio(options: StdioTransportOptions): PoolTransport {
    this.events.push('spawn:stdio');
    this.stdioOptions.push(options);
    if (this.failStdio > 0) {
      this.failStdio -= 1;
      throw new Error('spawn failed');
    }
    const pid = 1_000 + this.transports.length;
    const transport = new FakeTransport('stdio', {
      pid,
      pgid: pid,
      lstart: 'Mon Nov 17 14:31:58 2026',
    });
    this.transports.push(transport);
    return transport;
  }

  http(options: HttpTransportOptions): PoolTransport {
    this.events.push('spawn:http');
    this.httpOptions.push(options);
    const transport = new FakeTransport('http');
    this.transports.push(transport);
    return transport;
  }
}

class FakeLedger implements ProcessLedger {
  readonly records: Array<Record<string, unknown>> = [];
  readonly removed: string[] = [];
  private readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async recordPool(entry: Record<string, unknown>): Promise<void> {
    this.events.push(`record:${String(entry.state)}`);
    this.records.push({ ...entry });
  }

  async removePool(serverId: string): Promise<void> {
    this.events.push('remove');
    this.removed.push(serverId);
  }
}

interface Harness {
  pool: ConnectionPool;
  transports: FakeTransports;
  clients: FakeClients;
  ledger: FakeLedger;
}

function makePool(options: Partial<PoolOptions> = {}, events: string[] = []): Harness {
  const transports = new FakeTransports(events);
  const clients = new FakeClients();
  const ledger = new FakeLedger(events);
  const pool = new ConnectionPool({
    transportFactory: transports,
    clientFactory: clients,
    ledger,
    autoReconnect: false,
    ...options,
  });
  return { pool, transports, clients, ledger };
}

test('first call connects lazily and concurrent callers share one attempt', async (t) => {
  const { pool, transports, clients } = makePool({ servers: [spec()] });
  t.after(() => pool.close());

  assert.equal(transports.stdioOptions.length, 0, 'registration alone must not spawn');
  assert.equal(pool.entry('pg')?.state, 'idle');

  await Promise.all([pool.ensureConnected('pg'), pool.ensureConnected('pg'), pool.ensureConnected('pg')]);

  assert.equal(transports.stdioOptions.length, 1);
  assert.equal(clients.clients.length, 1);
  assert.equal(clients.clients[0]!.connectCalls, 1);
  assert.equal(clients.clients[0]!.listCalls, 1);
  const entry = pool.entry('pg');
  assert.equal(entry?.state, 'ready');
  assert.deepEqual(entry?.tools.map((tool) => tool.name), ['echo', 'write_row']);
});

test('stdio transports are spawned detached with a pipe and a whitelisted env', async (t) => {
  const { pool, transports } = makePool({
    servers: [spec({ cwd: '/repo', env: { PG_URL: 'postgres://local' } })],
    baseEnv: { PATH: '/bin', HOME: '/home/u', LANG: 'C', SECRET_TOKEN: 'leak-me' },
  });
  t.after(() => pool.close());

  await pool.ensureConnected('pg');

  const options = transports.stdioOptions[0];
  assert.ok(options !== undefined);
  assert.equal(options.command, 'node');
  assert.deepEqual(options.args, ['server.js']);
  assert.equal(options.detached, true);
  assert.equal(options.stderr, 'pipe');
  assert.equal(options.cwd, '/repo');
  assert.deepEqual(options.env, { PATH: '/bin', HOME: '/home/u', LANG: 'C', PG_URL: 'postgres://local' });
  assert.equal(Object.hasOwn(options.env, 'SECRET_TOKEN'), false);
});

test('pool.json intent is written before spawn and completed after initialize', async (t) => {
  const events: string[] = [];
  const { pool, ledger } = makePool({ servers: [spec()] }, events);
  t.after(() => pool.close());

  await pool.ensureConnected('pg');

  assert.deepEqual(events, ['record:spawning', 'spawn:stdio', 'record:running']);
  assert.equal(ledger.records.length, 2);
  assert.deepEqual(ledger.records[0], {
    serverId: 'pg',
    cfgVersion: 1,
    pid: null,
    pgid: null,
    lstart: null,
    state: 'spawning',
    startedAt: ledger.records[0]!.startedAt,
  });
  assert.equal(ledger.records[1]!.state, 'running');
  assert.equal(ledger.records[1]!.pid, 1_000);
  assert.equal(ledger.records[1]!.pgid, 1_000);
  assert.equal(typeof ledger.records[1]!.lstart, 'string');

  await pool.disconnect('pg');
  assert.deepEqual(ledger.removed, ['pg']);
  assert.equal(pool.entry('pg')?.state, 'idle');
});

test('http servers use the transport headers and skip the process ledger', async (t) => {
  const { pool, transports, ledger } = makePool({
    servers: [
      {
        id: 'web',
        cfgVersion: 3,
        transport: 'http',
        url: 'http://127.0.0.1:9911/mcp',
        headers: { 'x-api-key': 'k' },
      },
    ],
  });
  t.after(() => pool.close());

  await pool.ensureConnected('web');

  assert.deepEqual(transports.httpOptions, [
    { url: 'http://127.0.0.1:9911/mcp', headers: { 'x-api-key': 'k' } },
  ]);
  assert.deepEqual(ledger.records, []);
  assert.equal(pool.entry('web')?.state, 'ready');
  assert.equal(pool.entry('web')?.pid, null);
});

test('stderr is consumed, truncated and counted when nothing consumes it', async (t) => {
  const received: string[] = [];
  const consumed = makePool({
    servers: [spec()],
    stderrChunkChars: 4,
    onStderr: (serverId, chunk) => {
      received.push(`${serverId}:${chunk}`);
    },
  });
  const dropped = makePool({ servers: [spec()] });
  t.after(() => Promise.all([consumed.pool.close(), dropped.pool.close()]));

  await consumed.pool.ensureConnected('pg');
  await dropped.pool.ensureConnected('pg');
  consumed.transports.transports[0]!.emitStderr('abcdefgh');
  dropped.transports.transports[0]!.emitStderr('lost');

  assert.deepEqual(received, ['pg:abcd']);
  assert.equal(consumed.pool.entry('pg')?.stderrDropped, 0);
  assert.equal(dropped.pool.entry('pg')?.stderrDropped, 1);
});

test('stderr falls back to the audit sink before the drop counter', async (t) => {
  const written: Array<Record<string, unknown>> = [];
  const { pool, transports } = makePool({
    servers: [spec()],
    audit: { write: (event) => written.push(event as unknown as Record<string, unknown>) },
  });
  t.after(() => pool.close());

  await pool.ensureConnected('pg');
  transports.transports[0]!.emitStderr('child says hi');

  assert.equal(written.length, 1);
  assert.equal(written[0]!.event, 'pool_stderr');
  assert.equal(written[0]!.serverId, 'pg');
  assert.equal(written[0]!.text, 'child says hi');
  assert.equal(pool.entry('pg')?.stderrDropped, 0);
});

test('a connect timeout closes the transport and the client, then backs off', async (t) => {
  const { pool, transports, clients } = makePool({
    servers: [spec()],
    connectTimeoutMs: 20,
    backoffMs: [50],
  });
  t.after(() => pool.close());
  clients.configure = (client) => {
    client.connectImpl = () => new Promise<void>(() => {
      // Simulates a child that never answers initialize.
    });
  };

  await assert.rejects(
    pool.ensureConnected('pg'),
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_SERVER_UNAVAILABLE',
  );

  assert.equal(transports.transports[0]?.closed, true);
  assert.equal(clients.clients[0]?.closed, true);
  const entry = pool.entry('pg');
  assert.equal(entry?.state, 'reconnecting');
  assert.ok((entry?.nextRetryAt ?? 0) > Date.now());
  assert.equal(entry?.lastError?.code, 'MCP_SERVER_UNAVAILABLE');
});

test('a failed connect names the old transport and the retry spawns a new one', async (t) => {
  const { pool, transports, clients } = makePool({
    servers: [spec()],
    backoffMs: [5],
  });
  t.after(() => pool.close());
  clients.configure = (client, index) => {
    if (index === 0) {
      client.connectImpl = async () => {
        throw new Error('initialize rejected');
      };
    }
  };

  await assert.rejects(pool.ensureConnected('pg'));
  assert.equal(transports.transports[0]?.closed, true, 'the failed transport must be closed');
  assert.equal(clients.clients[0]?.closed, true);

  await awaitDue(pool, 'pg');
  await pool.ensureConnected('pg');

  assert.equal(transports.transports.length, 2);
  assert.notEqual(transports.transports[0], transports.transports[1]);
  assert.equal(transports.transports[1]?.closed, false);
  assert.equal(pool.entry('pg')?.state, 'ready');
});

test('calls pass args and the abort signal through and never replay', async (t) => {
  const { pool, clients } = makePool({ servers: [spec()] });
  t.after(() => pool.close());
  await pool.ensureConnected('pg');

  const controller = new AbortController();
  const result = await pool.callTool(
    'pg',
    'echo',
    { row: 7 },
    { bindingId: 'cb_a', signal: controller.signal },
  );
  assert.deepEqual(result, { echo: { row: 7 } });
  assert.deepEqual(clients.clients[0]!.callCalls, [{ name: 'echo', args: { row: 7 } }]);
  assert.equal(clients.clients[0]!.lastCallSignal?.aborted, false);

  clients.clients[0]!.callImpl = async () => {
    throw new McpToolError('row rejected', { code: 'MCP_TOOL_ERROR', server: 'pg', tool: 'echo' });
  };
  await assert.rejects(
    pool.callTool('pg', 'echo', {}),
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_TOOL_ERROR',
  );
  assert.equal(clients.clients[0]!.callCalls.length, 2, 'a tool error must not be replayed');
  assert.equal(pool.entry('pg')?.state, 'ready');
  assert.equal(pool.entry('pg')?.consecutiveFailures, 0);
});

test('transport close fails in-flight calls immediately and starts reconnecting', async (t) => {
  const { pool, transports, clients } = makePool({ servers: [spec()], backoffMs: [50] });
  t.after(() => pool.close());
  await pool.ensureConnected('pg');

  const observedSignals: AbortSignal[] = [];
  clients.clients[0]!.callImpl = (_name, _args, options) => {
    observedSignals.push(options.signal);
    return new Promise<unknown>(() => {
      // A wedged call: only the pool's close path can settle it.
    });
  };

  const startedAt = Date.now();
  const call = pool.callTool('pg', 'slow', {});
  await tick(10);
  transports.transports[0]!.emitClose(new Error('child exited'));

  await assert.rejects(
    call,
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_SERVER_UNAVAILABLE',
  );
  assert.ok(Date.now() - startedAt < 200, 'the close signal must not wait for a ping');
  assert.equal(observedSignals[0]?.aborted, true);
  const entry = pool.entry('pg');
  assert.equal(entry?.state, 'reconnecting');
  assert.equal(entry?.inflight, 0);
  assert.equal(entry?.consecutiveFailures, 1);
});

test('backoff rejects early calls with retryAfterMs and reconnects in the background', async (t) => {
  const { pool, transports, clients } = makePool({
    servers: [spec()],
    backoffMs: [100],
    autoReconnect: true,
  });
  t.after(() => pool.close());
  clients.configure = (client, index) => {
    if (index === 0) {
      client.connectImpl = async () => {
        throw new Error('flaky network');
      };
    }
  };

  await assert.rejects(pool.ensureConnected('pg'));
  assert.equal(pool.entry('pg')?.state, 'reconnecting');

  await assert.rejects(
    pool.ensureConnected('pg'),
    (error: unknown) =>
      error instanceof McpToolError
      && error.code === 'MCP_SERVER_UNAVAILABLE'
      && error.retryable === true
      && (error.retryAfterMs ?? 0) > 0,
  );

  await waitFor(() => pool.entry('pg')?.state === 'ready');
  assert.equal(transports.transports.length, 2, 'the background retry must create a new transport');
  assert.equal(pool.entry('pg')?.consecutiveFailures, 0);
});

test('five consecutive failures open the circuit with a cooldown probe', async (t) => {
  const { pool, clients } = makePool({
    servers: [spec()],
    backoffMs: [1],
    circuitThreshold: 2,
    circuitCooldownMs: 60,
  });
  t.after(() => pool.close());
  clients.configure = (client) => {
    client.connectImpl = async () => {
      throw new Error('still down');
    };
  };

  await assert.rejects(pool.ensureConnected('pg'));
  await awaitDue(pool, 'pg');
  await assert.rejects(pool.ensureConnected('pg'));

  const entry = pool.entry('pg');
  assert.equal(entry?.state, 'failed');
  assert.equal(entry?.consecutiveFailures, 2);
  assert.ok((entry?.nextRetryAt ?? 0) - Date.now() > 20, 'the circuit cooldown must be armed');

  await assert.rejects(
    pool.ensureConnected('pg'),
    (error: unknown) =>
      error instanceof McpToolError
      && error.code === 'MCP_SERVER_UNAVAILABLE'
      && (error.retryAfterMs ?? 0) > 0,
  );
});

test('a call timeout rejects with MCP_CALL_TIMEOUT and degrades the entry', async (t) => {
  const { pool, transports, clients } = makePool({ servers: [spec()], callTimeoutMs: 20 });
  t.after(() => pool.close());
  await pool.ensureConnected('pg');

  clients.clients[0]!.callImpl = (name) =>
    name === 'slow'
      ? new Promise<unknown>(() => {
        // Never answers; the pool's call timeout must fire.
      })
      : Promise.resolve({ echo: name });
  await assert.rejects(
    pool.callTool('pg', 'slow', {}),
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_CALL_TIMEOUT',
  );

  const entry = pool.entry('pg');
  assert.equal(entry?.consecutiveFailures, 1);
  assert.equal(entry?.state, 'degraded');
  assert.equal(clients.clients[0]!.callCalls.length, 1, 'a timeout must not be replayed');

  // Degraded is still connected: the next call reuses the same transport.
  assert.deepEqual(await pool.callTool('pg', 'echo', {}), { echo: 'echo' });
  assert.equal(transports.transports.length, 1, 'degraded must not trigger a reconnect');
  assert.equal(pool.entry('pg')?.state, 'ready');
  assert.equal(pool.entry('pg')?.consecutiveFailures, 0);
});

test("the pool's own call timeout aborts with an MCP_CALL_TIMEOUT reason", async (t) => {
  const { pool, clients } = makePool({ servers: [spec()], callTimeoutMs: 20 });
  t.after(() => pool.close());
  await pool.ensureConnected('pg');

  let reason: unknown;
  clients.clients[0]!.callImpl = (_name, _args, options) =>
    new Promise<unknown>(() => {
      options.signal.addEventListener(
        'abort',
        () => {
          reason = options.signal.reason;
        },
        { once: true },
      );
    });

  await assert.rejects(
    pool.callTool('pg', 'slow', {}),
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_CALL_TIMEOUT',
  );
  assert.equal(isTransportTimeout(reason), true);
});

test('a per-call cancellation does not close the shared connection', async (t) => {
  const { pool, transports, clients } = makePool({ servers: [spec()] });
  t.after(() => pool.close());
  await pool.ensureConnected('pg');

  clients.clients[0]!.callImpl = (name, _args, options) => {
    if (name === 'echo') return Promise.resolve({ echo: true });
    return new Promise<unknown>((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => {
          reject(new McpToolError('cancelled', { code: 'MCP_CALL_CANCELLED', server: 'pg', tool: name }));
        },
        { once: true },
      );
    });
  };

  const controller = new AbortController();
  const cancelled = pool.callTool('pg', 'slow', {}, { signal: controller.signal });
  await tick(10);
  controller.abort();
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_CALL_CANCELLED',
  );

  assert.equal(pool.entry('pg')?.state, 'ready');
  assert.equal(pool.entry('pg')?.consecutiveFailures, 0);
  assert.equal(transports.transports[0]?.closed, false);
  assert.deepEqual(await pool.callTool('pg', 'echo', {}), { echo: true });
});

test('ping distinguishes method-not-found from transport failures', async (t) => {
  const { pool, clients } = makePool({ servers: [spec()] });
  t.after(() => pool.close());
  await pool.ensureConnected('pg');

  await pool.ping('pg');
  assert.equal(clients.clients[0]!.pingCalls, 1);

  clients.clients[0]!.pingImpl = async () => {
    throw Object.assign(new Error('method not found'), { code: -32601 });
  };
  await assert.rejects(
    pool.ping('pg'),
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_PING_UNSUPPORTED',
  );

  clients.clients[0]!.pingImpl = async () => {
    throw Object.assign(new Error('socket reset'), { code: 'MCP_SERVER_UNAVAILABLE' });
  };
  await assert.rejects(
    pool.ping('pg'),
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_SERVER_UNAVAILABLE',
  );
});

test('an expired HTTP session drops the transport without replaying the call', async (t) => {
  const { pool, transports, clients } = makePool({
    servers: [{ id: 'pg', cfgVersion: 1, transport: 'http', url: 'http://127.0.0.1:9/mcp' }],
    backoffMs: [50],
  });
  t.after(() => pool.close());
  await pool.ensureConnected('pg');

  clients.clients[0]!.callImpl = async () => {
    throw new McpToolError('session is gone', {
      code: 'MCP_SESSION_EXPIRED_RETRY',
      server: 'pg',
      tool: 'echo',
    });
  };
  await assert.rejects(
    pool.callTool('pg', 'echo', {}),
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_SESSION_EXPIRED_RETRY',
  );
  await tick(5);

  assert.equal(clients.clients[0]!.callCalls.length, 1, 'the expired call must not be replayed');
  assert.equal(transports.transports[0]?.closed, true);
  const entry = pool.entry('pg');
  assert.equal(entry?.state, 'reconnecting');
  assert.equal(entry?.consecutiveFailures, 1);
});

test('unknown and disabled servers fail before any transport is opened', async (t) => {
  const { pool, transports } = makePool({ servers: [spec({ enabled: false })] });
  t.after(() => pool.close());

  await assert.rejects(
    pool.callTool('missing', 'echo', {}),
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_SERVER_NOT_FOUND',
  );
  await assert.rejects(
    pool.ensureConnected('pg'),
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_SERVER_DISABLED',
  );
  assert.equal(transports.stdioOptions.length, 0);
  assert.equal(pool.entry('pg')?.state, 'disabled');
});

class FakeTimers implements HealthTimerApi {
  readonly scheduled: Array<{ callback: () => void; ms: number; handle: number }> = [];
  readonly cleared: number[] = [];
  private nextHandle = 0;

  set(callback: () => void, ms: number): unknown {
    this.nextHandle += 1;
    this.scheduled.push({ callback, ms, handle: this.nextHandle });
    return this.nextHandle;
  }

  clear(handle: unknown): void {
    this.cleared.push(handle as number);
  }
}

interface FakeHealthPool extends HealthPool {
  targets: HealthTarget[];
  pings: string[];
  unsupported: string[];
  failures: string[];
}

function makeHealthPool(): FakeHealthPool {
  const pool: FakeHealthPool = {
    targets: [],
    pings: [],
    unsupported: [],
    failures: [],
    entries() {
      return pool.targets;
    },
    async ping(serverId) {
      pool.pings.push(serverId);
      if (serverId === 'methodless') {
        throw Object.assign(new Error('method not found'), { code: -32601 });
      }
      if (serverId === 'broken') {
        throw Object.assign(new Error('socket reset'), { code: 'MCP_SERVER_UNAVAILABLE' });
      }
    },
    markPingUnsupported(serverId) {
      pool.unsupported.push(serverId);
    },
    markTransportFailure(serverId) {
      pool.failures.push(serverId);
    },
  };
  return pool;
}

test('health pings only ready/degraded entries and skips ping-unsupported ones', async () => {
  const pool = makeHealthPool();
  pool.targets = [
    { id: 'ready', state: 'ready', pingUnsupported: false },
    { id: 'degraded', state: 'degraded', pingUnsupported: false },
    { id: 'idle', state: 'idle', pingUnsupported: false },
    { id: 'starting', state: 'starting', pingUnsupported: false },
    { id: 'quiet', state: 'ready', pingUnsupported: true },
  ];
  const monitor = new HealthMonitor({ pool, intervalMs: 15_000 });

  await monitor.tick();

  assert.deepEqual(pool.pings, ['ready', 'degraded']);
  assert.equal(monitor.stats.pings, 2);
});

test('health records pingUnsupported and transport failures separately', async () => {
  const pool = makeHealthPool();
  pool.targets = [
    { id: 'methodless', state: 'ready', pingUnsupported: false },
    { id: 'broken', state: 'ready', pingUnsupported: false },
  ];
  const monitor = new HealthMonitor({ pool, intervalMs: 15_000 });

  await monitor.tick();

  assert.deepEqual(pool.unsupported, ['methodless']);
  assert.deepEqual(pool.failures, ['broken']);
  assert.equal(monitor.stats.pingUnsupported, 1);
  assert.equal(monitor.stats.failures, 1);
});

test('ping interval jitters within 15s ±20%', () => {
  const pool = makeHealthPool();
  const low = new HealthMonitor({ pool, intervalMs: 15_000, jitterRatio: 0.2, random: () => 0 });
  const middle = new HealthMonitor({ pool, intervalMs: 15_000, jitterRatio: 0.2, random: () => 0.5 });
  const high = new HealthMonitor({ pool, intervalMs: 15_000, jitterRatio: 0.2, random: () => 1 });

  assert.equal(low.nextDelayMs(), 12_000);
  assert.equal(middle.nextDelayMs(), 15_000);
  assert.equal(high.nextDelayMs(), 18_000);
});

test('start arms a jittered timer and stop clears it', async () => {
  const pool = makeHealthPool();
  const timers = new FakeTimers();
  const monitor = new HealthMonitor({
    pool,
    intervalMs: 100,
    jitterRatio: 0.5,
    random: () => 0.5,
    timers,
  });

  monitor.start();
  assert.equal(monitor.started, true);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0]?.ms, 100);

  pool.targets = [{ id: 'ready', state: 'ready', pingUnsupported: false }];
  timers.scheduled[0]!.callback();
  await tick(5);
  assert.equal(timers.scheduled.length, 2, 'a completed tick must schedule the next one');

  monitor.stop();
  assert.equal(monitor.started, false);
  assert.deepEqual(timers.cleared, [2]);
});

test('a rejected health tick is reported once and the loop keeps scheduling', async () => {
  const timers = new FakeTimers();
  const reported: Array<{ id: string; error: unknown }> = [];
  const boom = new Error('entries failed');
  const pool: HealthPool = {
    entries() {
      throw boom;
    },
    async ping() {
      // never reached
    },
    markPingUnsupported() {},
    markTransportFailure() {},
  };
  const monitor = new HealthMonitor({
    pool,
    intervalMs: 100,
    timers,
    onFailure: (id, error) => reported.push({ id, error }),
  });

  monitor.start();
  timers.scheduled[0]!.callback();
  await tick(5);
  assert.equal(timers.scheduled.length, 2, 'a rejected tick must still schedule the next one');
  assert.deepEqual(reported, [{ id: '*', error: boom }]);

  timers.scheduled[1]!.callback();
  await tick(5);
  assert.equal(timers.scheduled.length, 3, 'the loop survives repeated failures');
  assert.equal(reported.length, 1, 'monitor-level failures are rate-limited');
  monitor.stop();
});

test('health monitor drives the real pool: unsupported servers stop being pinged', async (t) => {
  const { pool, clients } = makePool({ servers: [spec()] });
  t.after(() => pool.close());
  await pool.ensureConnected('pg');

  clients.clients[0]!.pingImpl = async () => {
    throw Object.assign(new Error('method not found'), { code: -32601 });
  };
  const monitor = new HealthMonitor({ pool, intervalMs: 15_000 });
  await monitor.tick();
  assert.equal(pool.entry('pg')?.pingUnsupported, true);

  clients.clients[0]!.pingImpl = null;
  const pingsBefore = clients.clients[0]!.pingCalls;
  await monitor.tick();
  assert.equal(clients.clients[0]!.pingCalls, pingsBefore);
});

test('health monitor degrades the real pool on a transport-level ping failure', async (t) => {
  const { pool, clients } = makePool({ servers: [spec()], circuitThreshold: 5 });
  t.after(() => pool.close());
  await pool.ensureConnected('pg');

  clients.clients[0]!.pingImpl = async () => {
    throw Object.assign(new Error('socket reset'), { code: 'MCP_SERVER_UNAVAILABLE' });
  };
  const monitor = new HealthMonitor({ pool, intervalMs: 15_000 });
  await monitor.tick();

  const entry = pool.entry('pg');
  assert.equal(entry?.state, 'degraded');
  assert.equal(entry?.consecutiveFailures, 1);
});

/** Waits until the entry's backoff window has elapsed, without sleeping the whole test. */
async function awaitDue(pool: ConnectionPool, serverId: string, timeoutMs = 500): Promise<void> {
  await waitFor(() => {
    const entry = pool.entry(serverId);
    return entry !== null && (entry.state !== 'reconnecting' || Date.now() >= entry.nextRetryAt);
  }, timeoutMs);
}
