import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { McpToolError, ProcessLedger, writeJsonAtomic } from '@zhangliang0115/repl-server-core';

import type { ServeClientProcess } from '../src/serve/client.ts';
import { createServeCallTool } from '../src/serve/adapter.ts';
import { createServeRuntime, type ServeSpawn, type ServeSpawnOptions } from '../src/serve/runtime.ts';

type FakeMode = 'ok' | 'hang' | 'no-record';

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ServeSpawnOptions;
  readonly process: FakeServeProcess;
}

/** Stands in for the keeper process; never touches the real process table. */
class FakeServeProcess {
  readonly pid: number;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  private readonly exitListeners: Array<() => void> = [];
  private exited = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  on(event: 'exit', listener: () => void): this {
    if (event === 'exit') this.exitListeners.push(listener);
    return this;
  }

  once(event: 'exit', listener: () => void): this {
    return this.on(event, listener);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.exit();
    return true;
  }

  exit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners.splice(0)) listener();
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
  }

  reply(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }
}

/**
 * Fake keeper + fake serve in one object: writes the `serve.json` record the
 * way `keeper.mjs` does, then answers newline-delimited JSON-RPC on the pipes.
 */
class FakeSpawner {
  readonly spawns: SpawnRecord[] = [];
  mode: FakeMode;
  failWith: Error | null = null;
  private nextPid = 51_000;

  constructor(mode: FakeMode = 'ok') {
    this.mode = mode;
  }

  readonly spawn: ServeSpawn = (command, args, options) => {
    if (this.failWith !== null) throw this.failWith;
    const pid = this.nextPid;
    this.nextPid += 1;
    const process = new FakeServeProcess(pid);
    this.spawns.push({ command, args, options, process });
    this.simulateKeeper(process, args);
    return process as unknown as ServeClientProcess;
  };

  private simulateKeeper(process: FakeServeProcess, args: readonly string[]): void {
    const sessionId = optionValue(args, '--session');
    const bootId = optionValue(args, '--boot');
    const stateDir = optionValue(args, '--state-dir');
    if (this.mode !== 'no-record') {
      writeJsonAtomic(join(stateDir, 'sessions', sessionId, 'serve.json'), {
        pid: process.pid,
        pgid: process.pid,
        keeperPid: process.pid,
        sessionId,
        bootId,
        lstart: `Mon Nov 17 14:31:${String(process.pid % 60).padStart(2, '0')} 2026`,
        transport: 'stdio',
      });
    }
    if (this.mode === 'hang') return;

    const lines = createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      let message: { id?: unknown; method?: unknown; params?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (typeof message.id !== 'number') return;
      if (message.method === 'initialize') {
        process.reply(message.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-serve', version: '0.0.0' },
        });
      } else if (message.method === 'ping') {
        process.reply(message.id, {});
      } else if (message.method === 'tools/list') {
        process.reply(message.id, { tools: [{ name: 'Bash' }] });
      } else if (message.method === 'tools/call') {
        process.reply(message.id, {
          content: [{ type: 'text', text: JSON.stringify(message.params ?? null) }],
        });
      } else {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`,
        );
      }
    });
    process.on('exit', () => lines.close());
  }
}

function optionValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, `missing ${flag} in keeper argv`);
  const value = args[index + 1];
  assert.ok(typeof value === 'string' && value !== '', `${flag} has no value`);
  return value;
}

interface HarnessOptions {
  readonly mode?: FakeMode;
  readonly readyTimeoutMs?: number;
  readonly bin?: string;
  readonly stateBootId?: string;
  readonly maxProcesses?: number;
}

interface Harness {
  readonly dataDir: string;
  readonly spawner: FakeSpawner;
  readonly runtime: ReturnType<typeof createServeRuntime>;
  readonly ledger: ProcessLedger;
  readonly logs: string[];
  cleanup(): Promise<void>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'repl-serve-runtime-'));
  if (options.stateBootId !== undefined) {
    writeJsonAtomic(join(dataDir, 'state.json'), {
      bootId: options.stateBootId,
      pid: process.pid,
      sessions: {},
    });
  }
  const spawner = new FakeSpawner(options.mode ?? 'ok');
  const logs: string[] = [];
  const runtime = createServeRuntime({
    dataDir,
    ...(options.bin === undefined ? {} : { bin: options.bin }),
    ...(options.maxProcesses === undefined ? {} : { maxProcesses: options.maxProcesses }),
    log: (line) => logs.push(line),
    spawn: spawner.spawn,
    pingIntervalMs: 0,
    readyTimeoutMs: options.readyTimeoutMs ?? 500,
    requestTimeoutMs: 500,
    terminateGraceMs: 20,
    killWaitMs: 20,
  });
  return {
    dataDir,
    spawner,
    runtime,
    logs,
    ledger: new ProcessLedger({ root: dataDir }),
    async cleanup() {
      await runtime.disposeAll();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function assertUnavailable(error: unknown, workspace: string): boolean {
  assert.ok(error instanceof McpToolError, `expected McpToolError, got ${String(error)}`);
  assert.equal(error.code, 'MCP_SERVER_UNAVAILABLE');
  assert.equal(error.retryable, true);
  assert.match(error.message, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return true;
}

test('different workspaces get independent serve processes', async (t) => {
  const harness = await createHarness();
  t.after(async () => await harness.cleanup());

  const alpha = await harness.runtime.acquire('/ws/alpha');
  const beta = await harness.runtime.acquire('/ws/beta');

  assert.notEqual(alpha, beta);
  assert.equal(harness.spawner.spawns.length, 2);
  assert.deepEqual(
    harness.spawner.spawns.map((spawn) => spawn.options.cwd).sort(),
    ['/ws/alpha', '/ws/beta'],
  );
  assert.equal(harness.ledger.listServeRecords().length, 2);

  assert.deepEqual(await alpha.listTools(), [{ name: 'Bash' }]);
  assert.deepEqual(await beta.listTools(), [{ name: 'Bash' }]);

  const alphaCall = createServeCallTool(alpha);
  const betaCall = createServeCallTool(beta);
  assert.deepEqual(
    await alphaCall({ evalId: 1, epoch: 1, callSeq: 1, tool: 'Echo', args: { who: 'alpha' } }),
    { name: 'Echo', arguments: { who: 'alpha' } },
  );
  assert.deepEqual(
    await betaCall({ evalId: 1, epoch: 1, callSeq: 1, tool: 'Echo', args: { who: 'beta' } }),
    { name: 'Echo', arguments: { who: 'beta' } },
  );
});

test('the same workspace reuses one serve and one client', async (t) => {
  const harness = await createHarness();
  t.after(async () => await harness.cleanup());

  const first = await harness.runtime.acquire('/ws/same');
  const second = await harness.runtime.acquire('/ws/same');

  assert.equal(first, second);
  assert.equal(harness.spawner.spawns.length, 1);
  assert.equal(harness.ledger.listServeRecords().length, 1);
});

test('execution sessions in one workspace get separate serves and release independently', async (t) => {
  const harness = await createHarness();
  t.after(async () => await harness.cleanup());

  const first = await harness.runtime.acquire('/ws/shared', { execSessionId: 'es_a' });
  const second = await harness.runtime.acquire('/ws/shared', { execSessionId: 'es_b' });
  assert.notEqual(first, second);
  assert.equal(harness.spawner.spawns.length, 2);

  // The same execution session keeps reusing its own handle.
  const again = await harness.runtime.acquire('/ws/shared', { execSessionId: 'es_a' });
  assert.equal(again, first);
  assert.equal(harness.spawner.spawns.length, 2);

  await harness.runtime.release('/ws/shared', { execSessionId: 'es_a' });
  assert.equal(first.isClosed, true);
  assert.equal(second.isClosed, false);
  assert.equal(harness.ledger.listServeRecords().length, 1);

  // The surviving session still answers.
  assert.deepEqual(await second.listTools(), [{ name: 'Bash' }]);
});

test('concurrent acquire calls share one startup', async (t) => {
  const harness = await createHarness();
  t.after(async () => await harness.cleanup());

  const clients = await Promise.all(
    Array.from({ length: 5 }, async () => await harness.runtime.acquire('/ws/race')),
  );

  for (const client of clients) assert.equal(client, clients[0]);
  assert.equal(harness.spawner.spawns.length, 1);
});

test('release closes the transport, stops the keeper and clears the ledger', async (t) => {
  const harness = await createHarness();
  t.after(async () => await harness.cleanup());

  const client = await harness.runtime.acquire('/ws/release');
  const records = harness.ledger.listServeRecords();
  const record = records[0];
  assert.ok(record !== undefined);
  const spawned = harness.spawner.spawns[0];
  assert.ok(spawned !== undefined);

  await harness.runtime.release('/ws/release');

  assert.ok(spawned.process.signals.includes('SIGTERM'));
  assert.equal(client.isClosed, true);
  await assert.rejects(client.request('ping', {}), /closed|exited/);
  assert.equal(harness.ledger.listServeRecords().length, 0);
  assert.equal(harness.ledger.readState().sessions[record.sessionId], undefined);

  const replacement = await harness.runtime.acquire('/ws/release');
  assert.notEqual(replacement, client);
  assert.equal(harness.spawner.spawns.length, 2);
  assert.deepEqual(await replacement.listTools(), [{ name: 'Bash' }]);

  await harness.runtime.release('/ws/release');
  await harness.runtime.release('/ws/release'); // idempotent
  assert.equal(harness.ledger.listServeRecords().length, 0);
});

test('disposeAll stops every workspace and rejects further acquisitions', async (t) => {
  const harness = await createHarness();
  t.after(async () => await harness.cleanup());

  const alpha = await harness.runtime.acquire('/ws/a');
  const beta = await harness.runtime.acquire('/ws/b');
  const [spawnedAlpha, spawnedBeta] = harness.spawner.spawns;
  assert.ok(spawnedAlpha !== undefined);
  assert.ok(spawnedBeta !== undefined);

  await harness.runtime.disposeAll();

  assert.ok(spawnedAlpha.process.signals.includes('SIGTERM'));
  assert.ok(spawnedBeta.process.signals.includes('SIGTERM'));
  assert.equal(alpha.isClosed, true);
  assert.equal(beta.isClosed, true);
  assert.equal(harness.ledger.listServeRecords().length, 0);
  assert.deepEqual(harness.ledger.readState().sessions, {});

  await harness.runtime.disposeAll(); // idempotent
  await harness.runtime.release('/ws/a'); // no-op after dispose
  await assert.rejects(
    harness.runtime.acquire('/ws/c'),
    (error: unknown) => assertUnavailable(error, '/ws/c'),
  );
});

test('a keeper that never becomes ready fails with MCP_SERVER_UNAVAILABLE', async (t) => {
  const harness = await createHarness({ mode: 'hang', readyTimeoutMs: 80 });
  t.after(async () => await harness.cleanup());

  await assert.rejects(
    harness.runtime.acquire('/ws/slow'),
    (error: unknown) => assertUnavailable(error, '/ws/slow'),
  );

  const spawned = harness.spawner.spawns[0];
  assert.ok(spawned !== undefined);
  assert.ok(spawned.process.signals.includes('SIGTERM'));
  assert.equal(harness.ledger.listServeRecords().length, 0);
});

test('a spawn failure is mapped and does not poison later acquisitions', async (t) => {
  const harness = await createHarness();
  t.after(async () => await harness.cleanup());

  harness.spawner.failWith = new Error('spawn ENOENT');
  await assert.rejects(
    harness.runtime.acquire('/ws/retry'),
    (error: unknown) => assertUnavailable(error, '/ws/retry'),
  );
  assert.equal(harness.spawner.spawns.length, 0);

  harness.spawner.failWith = null;
  const client = await harness.runtime.acquire('/ws/retry');
  assert.deepEqual(await client.listTools(), [{ name: 'Bash' }]);
  assert.equal(harness.spawner.spawns.length, 1);
});

test('a keeper that answers without writing serve.json is rejected', async (t) => {
  const harness = await createHarness({ mode: 'no-record' });
  t.after(async () => await harness.cleanup());

  await assert.rejects(
    harness.runtime.acquire('/ws/no-record'),
    (error: unknown) => assertUnavailable(error, '/ws/no-record'),
  );

  const spawned = harness.spawner.spawns[0];
  assert.ok(spawned !== undefined);
  assert.ok(spawned.process.signals.includes('SIGTERM'));
  assert.equal(harness.ledger.listServeRecords().length, 0);
});

test('adopts the boot id already recorded in state.json', async (t) => {
  const harness = await createHarness({ stateBootId: 'b_existing' });
  t.after(async () => await harness.cleanup());

  const client = await harness.runtime.acquire('/ws/boot');
  assert.deepEqual(await client.listTools(), [{ name: 'Bash' }]);

  const state = harness.ledger.readState();
  assert.equal(state.bootId, 'b_existing');
  const record = harness.ledger.listServeRecords()[0];
  assert.ok(record !== undefined);
  assert.equal(record.bootId, 'b_existing');
});

test('REPL_CLAUDE_BIN overrides the serve command, and bin wins over it', async (t) => {
  const previous = process.env['REPL_CLAUDE_BIN'];
  process.env['REPL_CLAUDE_BIN'] = '/opt/env-claude';
  t.after(() => {
    if (previous === undefined) delete process.env['REPL_CLAUDE_BIN'];
    else process.env['REPL_CLAUDE_BIN'] = previous;
  });

  const fromEnv = await createHarness();
  t.after(async () => await fromEnv.cleanup());
  await fromEnv.runtime.acquire('/ws/env');
  const envSpawn = fromEnv.spawner.spawns[0];
  assert.ok(envSpawn !== undefined);
  const envSeparator = envSpawn.args.indexOf('--');
  assert.ok(envSeparator > 0);
  assert.deepEqual(envSpawn.args.slice(envSeparator + 1), ['/opt/env-claude', 'mcp', 'serve']);
  assert.equal(envSpawn.command, process.execPath);

  const fromOption = await createHarness({ bin: '/opt/option-claude' });
  t.after(async () => await fromOption.cleanup());
  await fromOption.runtime.acquire('/ws/option');
  const optionSpawn = fromOption.spawner.spawns[0];
  assert.ok(optionSpawn !== undefined);
  const optionSeparator = optionSpawn.args.indexOf('--');
  assert.ok(optionSeparator > 0);
  assert.deepEqual(optionSpawn.args.slice(optionSeparator + 1), ['/opt/option-claude', 'mcp', 'serve']);
});

test('maxProcesses defaults to the capacity default and rejects the extra entry', async (t) => {
  const harness = await createHarness({ maxProcesses: 1 });
  t.after(async () => await harness.cleanup());

  assert.equal(harness.runtime.maxProcesses, 1);
  const alpha = await harness.runtime.acquire('/ws/alpha');

  await assert.rejects(
    harness.runtime.acquire('/ws/beta'),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError, `expected McpToolError, got ${String(error)}`);
      assert.equal(error.code, 'CAPACITY_EXCEEDED');
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /cannot start claude mcp serve/, 'must fail before spawning');
      return true;
    },
  );
  assert.equal(harness.spawner.spawns.length, 1, 'the rejected acquisition must not spawn');

  // An existing entry is handed back even while the cap is reached.
  assert.equal(await harness.runtime.acquire('/ws/alpha'), alpha);

  // Releasing the entry frees its slot for a new workspace.
  await harness.runtime.release('/ws/alpha');
  const beta = await harness.runtime.acquire('/ws/beta');
  assert.notEqual(beta, alpha);
  assert.equal(harness.spawner.spawns.length, 2);
});

test('updateLimits hot-applies maxProcesses without stopping existing entries', async (t) => {
  const harness = await createHarness({ maxProcesses: 2 });
  t.after(async () => await harness.cleanup());

  const alpha = await harness.runtime.acquire('/ws/alpha');
  const beta = await harness.runtime.acquire('/ws/beta');
  assert.equal(harness.spawner.spawns.length, 2);

  harness.runtime.updateLimits({ maxProcesses: 1 });
  assert.equal(harness.runtime.maxProcesses, 1);
  await assert.rejects(
    harness.runtime.acquire('/ws/gamma'),
    (error: unknown) => (error as { code?: string }).code === 'CAPACITY_EXCEEDED',
  );

  // The two running entries keep working; only new entries are blocked.
  assert.deepEqual(await alpha.listTools(), [{ name: 'Bash' }]);
  assert.deepEqual(await beta.listTools(), [{ name: 'Bash' }]);

  harness.runtime.updateLimits({ maxProcesses: 3 });
  const gamma = await harness.runtime.acquire('/ws/gamma');
  assert.deepEqual(await gamma.listTools(), [{ name: 'Bash' }]);

  assert.throws(() => harness.runtime.updateLimits({ maxProcesses: 0 }), RangeError);
  assert.equal(harness.runtime.maxProcesses, 3, 'a rejected update must not change the limit');
});

test('the default serve process cap is sixty-four', async (t) => {
  const harness = await createHarness();
  t.after(async () => await harness.cleanup());
  assert.equal(harness.runtime.maxProcesses, 64);
});
