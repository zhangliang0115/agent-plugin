import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  buildKeeperArgs,
  keeperLaunch,
  keeperScriptPath,
  serveRecordPath,
} from '../src/process/keeper.ts';

const READY = 'ready\n';

interface ServeRecord {
  pid: number;
  pgid: number;
  keeperPid: number;
  sessionId: string;
  bootId: string;
  lstart: string;
  transport: string;
  startedAt: string;
}

interface RunningKeeper {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  waitForOutput: (needle: string, timeoutMs?: number) => Promise<void>;
}

interface KeeperFixture {
  stateDir: string;
  sessionId: string;
  bootId: string;
  serveCode: string;
  serveArgs?: string[];
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  if (predicate()) return;
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for pid ${child.pid} to exit`));
    }, timeoutMs);
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once('exit', onExit);
  });
}

function waitForDead(pid: number, timeoutMs = 5_000): Promise<void> {
  return waitFor(() => !isAlive(pid), timeoutMs, `pid ${pid} to disappear`);
}

async function readWhenNonEmpty(filePath: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await readFile(filePath, 'utf8');
      if (text !== '') return text;
    } catch {
      // not written yet
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await delay(10);
  }
}

async function readRecord(stateDir: string, sessionId: string): Promise<ServeRecord> {
  return JSON.parse(
    await readFile(serveRecordPath(stateDir, sessionId), 'utf8'),
  ) as ServeRecord;
}

function startKeeper(fixture: KeeperFixture): RunningKeeper {
  const launch = keeperLaunch({
    sessionId: fixture.sessionId,
    bootId: fixture.bootId,
    stateDir: fixture.stateDir,
    serve: {
      command: process.execPath,
      args: ['-e', fixture.serveCode, ...(fixture.serveArgs ?? [])],
    },
  });
  const child = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitForOutput: (needle, timeoutMs = 5_000) =>
      waitFor(() => stdout.includes(needle), timeoutMs, `stdout to contain ${JSON.stringify(needle)}`),
  };
}

/**
 * Ends stdin so the keeper shuts down, escalating only if it refuses to exit.
 * If the keeper itself had to be SIGKILLed, kill the recorded serve group so a
 * failed test never leaks a detached process.
 */
async function stopKeeper(
  child: ChildProcessWithoutNullStreams,
  stateDir: string,
  sessionId: string,
): Promise<void> {
  let forced = false;
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    try {
      await waitExit(child, 3_000);
    } catch {
      child.kill('SIGTERM');
      try {
        await waitExit(child, 3_000);
      } catch {
        forced = true;
        child.kill('SIGKILL');
        await waitExit(child, 1_000).catch(() => undefined);
      }
    }
  }
  if (!forced) return;
  try {
    const record = await readRecord(stateDir, sessionId);
    if (record.pgid === record.pid && isAlive(record.pid)) {
      process.kill(-record.pid, 'SIGKILL');
    }
  } catch {
    // The keeper died before it wrote a record.
  }
}

async function makeFixture(serveCode: string, serveArgs?: string[]): Promise<KeeperFixture> {
  const stateDir = await mkdtemp(join(tmpdir(), 'repl-keeper-'));
  return {
    stateDir,
    sessionId: 's_keeper01',
    bootId: 'b_keeper01',
    serveCode,
    serveArgs,
  };
}

function keepaliveServeCode(): string {
  return [
    `process.stdout.write(${JSON.stringify(READY)});`,
    'process.stdin.resume();',
  ].join('\n');
}

test('host-side launch builds keeper argv and the serve record path', () => {
  const options = {
    sessionId: 's_1',
    bootId: 'b_1',
    stateDir: join(tmpdir(), 'state'),
    serve: { command: 'claude', args: ['mcp', 'serve'] },
  } as const;

  assert.deepEqual(buildKeeperArgs(options), [
    '--session',
    's_1',
    '--boot',
    'b_1',
    '--state-dir',
    join(tmpdir(), 'state'),
    '--',
    'claude',
    'mcp',
    'serve',
  ]);

  const launch = keeperLaunch(options);
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [keeperScriptPath(), ...buildKeeperArgs(options)]);
  assert.equal(
    serveRecordPath(join(tmpdir(), 'state'), 's_1'),
    join(tmpdir(), 'state', 'sessions', 's_1', 'serve.json'),
  );

  assert.deepEqual(
    buildKeeperArgs({ ...options, serve: { command: 'claude' } }).slice(-2),
    ['--', 'claude'],
  );
});

test('keeper rejects missing arguments and unsafe session ids', () => {
  const noArgs = spawnSync(process.execPath, [keeperScriptPath()], { encoding: 'utf8' });
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /keeper: /);

  const traversal = spawnSync(
    process.execPath,
    [
      keeperScriptPath(),
      '--session',
      '../escape',
      '--boot',
      'b_1',
      '--state-dir',
      join(tmpdir(), 'state'),
      '--',
      'true',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(traversal.status, 2);
  assert.match(traversal.stderr, /invalid --session/);
});

test('writes serve.json before forwarding stdio and starts serve in its own group', async (t) => {
  const fixture = await makeFixture(keepaliveServeCode());
  const keeper = startKeeper(fixture);
  t.after(async () => {
    await stopKeeper(keeper.child, fixture.stateDir, fixture.sessionId);
    await rm(fixture.stateDir, { recursive: true, force: true });
  });

  await keeper.waitForOutput(READY);
  const record = await readRecord(fixture.stateDir, fixture.sessionId);

  assert.equal(record.sessionId, fixture.sessionId);
  assert.equal(record.bootId, fixture.bootId);
  assert.equal(record.keeperPid, keeper.child.pid);
  assert.ok(Number.isInteger(record.pid) && record.pid > 0);
  assert.equal(record.pgid, record.pid, 'detached serve must lead its own process group');
  assert.equal(record.transport, 'stdio');
  assert.notEqual(record.lstart, '', 'lstart is captured from ps for PID reuse checks');
  assert.ok(!Number.isNaN(Date.parse(record.startedAt)));

  const recordDir = dirname(serveRecordPath(fixture.stateDir, fixture.sessionId));
  assert.deepEqual(await readdir(recordDir), ['serve.json'], 'atomic write leaves no temp file');

  keeper.child.stdin.end();
  const exit = await waitExit(keeper.child);
  assert.equal(exit.signal, null);
  await waitForDead(record.pid);
});

test('stdin EOF tears down the whole serve process group', async (t) => {
  const serveCode = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'writeFileSync(process.argv[1], String(grandchild.pid));',
    `process.stdout.write(${JSON.stringify(READY)});`,
    'process.stdin.resume();',
  ].join('\n');
  const fixture = await makeFixture(serveCode);
  const markerPath = join(fixture.stateDir, 'grandchild.pid');
  fixture.serveArgs = [markerPath];
  const keeper = startKeeper(fixture);
  t.after(async () => {
    await stopKeeper(keeper.child, fixture.stateDir, fixture.sessionId);
    await rm(fixture.stateDir, { recursive: true, force: true });
  });

  await keeper.waitForOutput(READY);
  const record = await readRecord(fixture.stateDir, fixture.sessionId);
  const grandchildPid = Number(await readWhenNonEmpty(markerPath));
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
  assert.ok(isAlive(record.pid));
  assert.ok(isAlive(grandchildPid));

  keeper.child.stdin.end();
  await waitExit(keeper.child);

  await waitForDead(record.pid);
  await waitForDead(grandchildPid);
});

test('passes serve stdout/stderr through and forwards the exit code', async (t) => {
  const serveCode = [
    `process.stdout.write(${JSON.stringify('serve-out\n')});`,
    `process.stderr.write(${JSON.stringify('serve-err\n')});`,
    'process.stdin.resume();',
    'setTimeout(() => process.exit(7), 150);',
  ].join('\n');
  const fixture = await makeFixture(serveCode);
  const keeper = startKeeper(fixture);
  t.after(async () => {
    await stopKeeper(keeper.child, fixture.stateDir, fixture.sessionId);
    await rm(fixture.stateDir, { recursive: true, force: true });
  });

  const exit = await waitExit(keeper.child);
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 7, 'serve exit code is propagated verbatim');
  assert.match(keeper.stdout(), /serve-out/);
  assert.match(keeper.stderr(), /serve-err/);

  const record = await readRecord(fixture.stateDir, fixture.sessionId);
  assert.equal(record.sessionId, fixture.sessionId);
});

test('SIGTERM to the keeper stops the serve group', async (t) => {
  const fixture = await makeFixture(keepaliveServeCode());
  const keeper = startKeeper(fixture);
  t.after(async () => {
    await stopKeeper(keeper.child, fixture.stateDir, fixture.sessionId);
    await rm(fixture.stateDir, { recursive: true, force: true });
  });

  await keeper.waitForOutput(READY);
  const record = await readRecord(fixture.stateDir, fixture.sessionId);

  keeper.child.kill('SIGTERM');
  const exit = await waitExit(keeper.child);
  assert.equal(exit.signal, null, 'the keeper handles SIGTERM instead of dying from it');
  await waitForDead(record.pid);
});

test('escalates to SIGKILL when serve ignores SIGTERM', async (t) => {
  const serveCode = [
    `process.stdout.write(${JSON.stringify(READY)});`,
    "process.on('SIGTERM', () => {});",
    'process.stdin.resume();',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const fixture = await makeFixture(serveCode);
  const keeper = startKeeper(fixture);
  t.after(async () => {
    await stopKeeper(keeper.child, fixture.stateDir, fixture.sessionId);
    await rm(fixture.stateDir, { recursive: true, force: true });
  });

  await keeper.waitForOutput(READY);
  const record = await readRecord(fixture.stateDir, fixture.sessionId);

  const startedAt = Date.now();
  keeper.child.stdin.end();
  const exit = await waitExit(keeper.child, 8_000);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs >= 1_800, `expected the 2s grace period, waited ${elapsedMs}ms`);
  assert.equal(exit.code, 0);
  await waitForDead(record.pid);
});
