import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { ProcessLedger } from '../src/process/ledger.ts';
import type { ServeRecord, StateFile } from '../src/process/ledger.ts';
import {
  SERVE_ENV_ALLOWLIST,
  SERVE_HEALTH_DEFAULTS,
  ServeManager,
  buildServeEnv,
} from '../src/process/serve-manager.ts';
import type {
  LaunchedServe,
  ServeIdentity,
  ServeLaunchSpec,
  ServeLedger,
  ServeManagerEvent,
  ServeProbe,
} from '../src/process/serve-manager.ts';

const SESSION = 'es_serve01';
const BOOT = 'b_serve01';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeChildOptions {
  readonly identity: ServeIdentity;
  readonly autoReady?: boolean;
  readonly exitOn?: 'SIGTERM' | 'SIGKILL' | 'never';
}

/** Stands in for a keeper process; never touches the real process table. */
class FakeChild implements LaunchedServe {
  readonly identity: ServeIdentity;
  readonly ready: Promise<ServeIdentity>;
  readonly exited: Promise<void>;
  readonly signals: Array<'SIGTERM' | 'SIGKILL'> = [];

  private readonly readyDeferred = deferred<ServeIdentity>();
  private readonly exitDeferred = deferred<void>();
  private readonly exitOn: 'SIGTERM' | 'SIGKILL' | 'never';

  constructor(options: FakeChildOptions) {
    this.identity = options.identity;
    this.exitOn = options.exitOn ?? 'SIGTERM';
    this.ready = this.readyDeferred.promise;
    this.exited = this.exitDeferred.promise;
    if (options.autoReady !== false) this.readyDeferred.resolve(this.identity);
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal);
    if (this.exitOn === signal) this.exitNow();
  }

  resolveReady(identity: ServeIdentity = this.identity): void {
    this.readyDeferred.resolve(identity);
  }

  exitNow(): void {
    this.exitDeferred.resolve();
  }
}

class MemoryLedger implements ServeLedger {
  readonly serveRecords = new Map<string, ServeRecord>();
  readonly serveWrites: ServeRecord[] = [];
  readonly removals: string[] = [];
  readonly stateWrites: StateFile[] = [];
  state: StateFile = { bootId: '', pid: 0, sessions: {} };

  writeServe(record: ServeRecord): void {
    const copy = structuredClone(record);
    this.serveRecords.set(record.sessionId, copy);
    this.serveWrites.push(copy);
  }

  removeServe(sessionId: string): void {
    this.removals.push(sessionId);
    this.serveRecords.delete(sessionId);
  }

  readState(): StateFile {
    return structuredClone(this.state);
  }

  writeState(state: StateFile): void {
    this.state = structuredClone(state);
    this.stateWrites.push(structuredClone(state));
  }
}

type ProbeResult = 'ok' | 'fail' | 'hang' | Error;

class FakeProbe implements ServeProbe {
  readonly calls: number[] = [];
  private readonly results: ProbeResult[];

  constructor(results: ProbeResult[] = []) {
    this.results = [...results];
  }

  ping(): Promise<void> {
    this.calls.push(Date.now());
    const result = this.results.shift() ?? 'ok';
    if (result === 'hang') return new Promise<void>(() => undefined);
    if (result === 'fail') return Promise.reject(new Error('ping failed'));
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve();
  }
}

interface HarnessOptions {
  readonly sessionId?: string;
  readonly bootId?: string;
  readonly ledger?: ServeLedger;
  readonly probe?: ServeProbe;
  readonly autoReady?: boolean;
  readonly exitOn?: 'SIGTERM' | 'SIGKILL' | 'never';
  readonly sourceEnv?: Record<string, string | undefined>;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => number;
  readonly readyTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly pingTimeoutMs?: number;
  readonly pingFailureThreshold?: number;
  readonly terminateGraceMs?: number;
  readonly killWaitMs?: number;
}

interface Harness {
  readonly manager: ServeManager;
  readonly memLedger: MemoryLedger;
  readonly launches: FakeChild[];
  readonly specs: ServeLaunchSpec[];
  readonly events: ServeManagerEvent[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const memLedger = new MemoryLedger();
  const launches: FakeChild[] = [];
  const specs: ServeLaunchSpec[] = [];
  const events: ServeManagerEvent[] = [];
  let nextPid = 3_000;

  const manager = new ServeManager({
    sessionId: options.sessionId ?? SESSION,
    bootId: options.bootId ?? BOOT,
    ledger: options.ledger ?? memLedger,
    probe: options.probe ?? new FakeProbe(),
    launch: async (spec) => {
      specs.push(spec);
      nextPid += 10;
      const child = new FakeChild({
        identity: {
          pid: nextPid + 1,
          pgid: nextPid + 1,
          keeperPid: nextPid,
          lstart: `Mon Nov 17 14:31:${String(nextPid % 60).padStart(2, '0')} 2026`,
        },
        autoReady: options.autoReady,
        exitOn: options.exitOn,
      });
      launches.push(child);
      return child;
    },
    serve: { command: 'claude', args: ['mcp', 'serve'] },
    cwd: '/tmp/workspace',
    sourceEnv: options.sourceEnv,
    env: options.env,
    now: options.now,
    readyTimeoutMs: options.readyTimeoutMs,
    pingIntervalMs: options.pingIntervalMs,
    pingTimeoutMs: options.pingTimeoutMs,
    pingFailureThreshold: options.pingFailureThreshold,
    terminateGraceMs: options.terminateGraceMs,
    killWaitMs: options.killWaitMs,
    onEvent: (event) => events.push(event),
  });

  return { manager, memLedger, launches, specs, events };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  if (predicate()) return;
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function methodNotFound(): Error {
  return Object.assign(new Error('Method not found'), { code: -32601 });
}

test('env allowlist copies five keys plus explicit injection and nothing else', () => {
  assert.deepEqual([...SERVE_ENV_ALLOWLIST], ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG']);

  const source = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/me',
    USER: 'me',
    TMPDIR: '/var/folders/tmp',
    LANG: 'en_US.UTF-8',
    SECRET_TOKEN: 'do-not-leak-this-token',
    ANTHROPIC_API_KEY: 'sk-test-placeholder-not-real',
    NODE_OPTIONS: '--inspect',
  };

  const env = buildServeEnv(source, { REPL_CLAUDE_BIN: '/opt/claude', LANG: 'C' });
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/me',
    USER: 'me',
    TMPDIR: '/var/folders/tmp',
    LANG: 'C',
    REPL_CLAUDE_BIN: '/opt/claude',
  });
  assert.equal('SECRET_TOKEN' in env, false);
  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal('NODE_OPTIONS' in env, false);
  assert.notEqual(env, source);

  const withoutHome = buildServeEnv(source, { HOME: undefined });
  assert.equal('HOME' in withoutHome, false);
  assert.equal(withoutHome.PATH, '/usr/bin:/bin');
});

test('start launches one keeper+serve and records the full identity', async () => {
  const h = createHarness({
    sourceEnv: { PATH: '/usr/bin', HOME: '/Users/me', SECRET_TOKEN: 'nope' },
    env: { REPL_CLAUDE_BIN: '/fake/claude' },
    now: () => Date.parse('2026-11-18T06:00:00.000Z'),
  });
  try {
    const record = await h.manager.start();

    assert.equal(h.launches.length, 1);
    const spec = h.specs[0];
    assert.ok(spec);
    assert.equal(spec.sessionId, SESSION);
    assert.equal(spec.bootId, BOOT);
    assert.equal(spec.command, 'claude');
    assert.deepEqual(spec.args, ['mcp', 'serve']);
    assert.equal(spec.cwd, '/tmp/workspace');
    assert.deepEqual(spec.env, { PATH: '/usr/bin', HOME: '/Users/me', REPL_CLAUDE_BIN: '/fake/claude' });
    assert.equal('SECRET_TOKEN' in spec.env, false);

    const identity = h.launches[0]?.identity;
    assert.ok(identity);
    assert.equal(record.pid, identity.pid);
    assert.equal(record.pgid, identity.pgid);
    assert.equal(record.keeperPid, identity.keeperPid);
    assert.equal(record.lstart, identity.lstart);
    assert.equal(record.sessionId, SESSION);
    assert.equal(record.bootId, BOOT);
    assert.equal(record.transport, 'stdio');
    assert.equal(record.startedAt, '2026-11-18T06:00:00.000Z');

    assert.deepEqual(h.memLedger.serveRecords.get(SESSION), record);
    const state = h.memLedger.state;
    assert.equal(state.bootId, BOOT);
    assert.equal(state.pid, process.pid);
    assert.equal(state.sessions[SESSION]?.serve?.pid, record.pid);

    const again = await h.manager.start();
    assert.deepEqual(again, record);
    assert.equal(h.launches.length, 1);
  } finally {
    await h.manager.dispose();
  }
});

test('transport close restarts, rewrites the ledger and ignores that stale generation', async () => {
  const h = createHarness();
  try {
    const first = await h.manager.start();
    const firstGeneration = h.manager.generation;
    const firstChild = h.launches[0];
    assert.ok(firstChild);

    await h.manager.markDead('transport_close', firstGeneration);

    assert.equal(h.launches.length, 2);
    assert.deepEqual(firstChild.signals, ['SIGTERM']);
    const second = h.manager.record;
    assert.ok(second);
    assert.notEqual(second.pid, first.pid);
    assert.equal(second.sessionId, SESSION);
    assert.equal(h.memLedger.serveRecords.get(SESSION)?.pid, second.pid);
    assert.equal(h.memLedger.state.sessions[SESSION]?.serve?.pid, second.pid);
    assert.equal(h.memLedger.serveWrites.length, 2);
    assert.equal(h.manager.restartCount, 1);

    // A callback from the old transport must not kill the replacement.
    await h.manager.markDead('transport_close', firstGeneration);
    assert.equal(h.launches.length, 2);
    assert.equal(h.memLedger.serveRecords.get(SESSION)?.pid, second.pid);
  } finally {
    await h.manager.dispose();
  }
});

test('keeper exit and a concurrent transport close share one restart', async () => {
  const h = createHarness();
  try {
    await h.manager.start();
    const generation = h.manager.generation;
    const child = h.launches[0];
    assert.ok(child);

    child.exitNow();
    const transportReport = h.manager.markDead('transport_close', generation);
    const exitReport = h.manager.markDead('serve_exit', generation);
    await Promise.all([transportReport, exitReport]);

    assert.equal(h.launches.length, 2);
    assert.equal(h.manager.restartCount, 1);
    assert.deepEqual(h.memLedger.state.sessions[SESSION]?.serve?.pid, h.manager.record?.pid);
  } finally {
    await h.manager.dispose();
  }
});

test('a transport close before ready restarts once the first record exists', async () => {
  const h = createHarness({ autoReady: false, readyTimeoutMs: 500 });
  try {
    const starting = h.manager.start();
    await waitFor(() => h.launches.length === 1, 'launch');
    const generation = h.manager.generation;

    await h.manager.markDead('transport_close', generation);
    h.launches[0]?.resolveReady();
    const first = await starting;

    await waitFor(() => h.launches.length === 2, 'deferred restart');
    h.launches[1]?.resolveReady();
    await waitFor(() => h.manager.restartCount === 1, 'restart to complete');
    assert.deepEqual(h.launches[0]?.signals, ['SIGTERM']);
    assert.equal(h.manager.restartCount, 1);
    const current = h.manager.record;
    assert.ok(current);
    assert.notEqual(current.pid, first.pid);
  } finally {
    await h.manager.dispose();
  }
});

test('defaults are 10s interval and two consecutive failures', () => {
  assert.equal(SERVE_HEALTH_DEFAULTS.pingIntervalMs, 10_000);
  assert.equal(SERVE_HEALTH_DEFAULTS.pingFailureThreshold, 2);
});

test('two consecutive ping failures restart the serve pair', async () => {
  const probe = new FakeProbe(['fail', 'fail']);
  const h = createHarness({
    probe,
    pingIntervalMs: 5,
    pingTimeoutMs: 50,
    pingFailureThreshold: 2,
  });
  try {
    await h.manager.start();
    await waitFor(() => h.launches.length === 2, 'restart after two ping failures');
    const first = h.launches[0];
    assert.ok(first);
    assert.deepEqual(first.signals, ['SIGTERM']);
    assert.equal(h.manager.restartCount, 1);
    assert.equal(h.memLedger.serveRecords.get(SESSION)?.pid, h.manager.record?.pid);
  } finally {
    await h.manager.dispose();
  }
});

test('a successful ping resets the failure counter', async () => {
  const probe = new FakeProbe(['fail', 'ok', 'fail', 'fail']);
  const h = createHarness({ probe, pingIntervalMs: 5, pingTimeoutMs: 50 });
  try {
    await h.manager.start();
    await waitFor(() => probe.calls.length >= 4, 'four ping attempts');
    await waitFor(() => h.launches.length === 2, 'restart after the reset failures');
    assert.equal(h.manager.restartCount, 1);
  } finally {
    await h.manager.dispose();
  }
});

test('a hung ping counts as a failure after the per-ping timeout', async () => {
  const probe = new FakeProbe(['hang', 'hang']);
  const h = createHarness({ probe, pingIntervalMs: 5, pingTimeoutMs: 10 });
  try {
    await h.manager.start();
    await waitFor(() => h.launches.length === 2, 'restart after two ping timeouts');
    assert.equal(h.manager.restartCount, 1);
  } finally {
    await h.manager.dispose();
  }
});

test('method-not-found disables ping and leaves exit as the only signal', async () => {
  const probe = new FakeProbe([methodNotFound()]);
  const h = createHarness({ probe, pingIntervalMs: 5, pingTimeoutMs: 20 });
  try {
    await h.manager.start();
    await waitFor(() => h.manager.pingUnsupported, 'ping unsupported flag');

    const callsAfterDisable = probe.calls.length;
    await delay(40);
    assert.equal(probe.calls.length, callsAfterDisable, 'the ping timer must stop');
    assert.equal(h.launches.length, 1);
    assert.equal(h.manager.restartCount, 0);
    assert.ok(h.events.some((event) => event.type === 'ping_unsupported'));

    h.launches[0]?.exitNow();
    await waitFor(() => h.launches.length === 2, 'restart from process exit');
  } finally {
    await h.manager.dispose();
  }
});

test('stop escalates to SIGKILL, clears the ledger and suppresses restarts', async () => {
  const h = createHarness({ exitOn: 'SIGKILL', terminateGraceMs: 10, killWaitMs: 100 });
  try {
    await h.manager.start();
    const child = h.launches[0];
    assert.ok(child);

    await h.manager.stop('idle');

    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(h.manager.running, false);
    assert.equal(h.memLedger.serveRecords.has(SESSION), false);
    assert.equal(h.memLedger.state.sessions[SESSION]?.serve, null);

    child.exitNow();
    await delay(30);
    assert.equal(h.launches.length, 1);
    assert.equal(h.manager.restartCount, 0);
  } finally {
    await h.manager.dispose();
  }
});

test('stop is reversible: a later start launches a fresh serve', async () => {
  const h = createHarness();
  try {
    const first = await h.manager.start();
    await h.manager.stop('idle');
    const second = await h.manager.start();

    assert.equal(h.launches.length, 2);
    assert.notEqual(second.pid, first.pid);
    assert.deepEqual(h.manager.record, second);
    assert.equal(h.memLedger.serveRecords.get(SESSION)?.pid, second.pid);
  } finally {
    await h.manager.dispose();
  }
});

test('a serve that never becomes ready is killed and start fails', async () => {
  const h = createHarness({ autoReady: false, readyTimeoutMs: 10 });
  try {
    await assert.rejects(h.manager.start(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'SERVE_START_FAILED');
      assert.match(String((error as Error).message), /did not become ready/);
      return true;
    });
    assert.deepEqual(h.launches[0]?.signals, ['SIGTERM']);
    assert.equal(h.manager.running, false);
    assert.equal(h.memLedger.serveWrites.length, 0);
  } finally {
    await h.manager.dispose();
  }
});

test('keeper exit before ready fails start without recording a serve', async () => {
  const h = createHarness({ autoReady: false, readyTimeoutMs: 500 });
  try {
    const starting = h.manager.start();
    await waitFor(() => h.launches.length === 1, 'launch');
    h.launches[0]?.exitNow();

    await assert.rejects(starting, (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'SERVE_START_FAILED');
      return true;
    });
    assert.equal(h.manager.running, false);
    assert.equal(h.memLedger.serveWrites.length, 0);
  } finally {
    await h.manager.dispose();
  }
});

test('managers for different exec sessions keep separate ledger entries', async () => {
  const ledger = new MemoryLedger();
  const a = createHarness({ ledger, sessionId: 'es_a' });
  const b = createHarness({ ledger, sessionId: 'es_b' });
  try {
    const recordA = await a.manager.start();
    const recordB = await b.manager.start();

    assert.equal(a.specs[0]?.sessionId, 'es_a');
    assert.equal(b.specs[0]?.sessionId, 'es_b');
    assert.equal(ledger.serveRecords.get('es_a')?.pid, recordA.pid);
    assert.equal(ledger.serveRecords.get('es_b')?.pid, recordB.pid);
    assert.equal(ledger.state.sessions['es_a']?.serve?.pid, recordA.pid);
    assert.equal(ledger.state.sessions['es_b']?.serve?.pid, recordB.pid);
  } finally {
    await a.manager.dispose();
    await b.manager.dispose();
  }
});

test('works with the real ProcessLedger on disk', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'repl-serve-manager-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ledger = new ProcessLedger({ root });
  const h = createHarness({ ledger, now: () => 0 });
  try {
    const record = await h.manager.start();
    assert.deepEqual(ledger.readServe(SESSION), record);

    const state = ledger.readState();
    assert.equal(state.bootId, BOOT);
    assert.equal(state.pid, process.pid);
    assert.equal(state.sessions[SESSION]?.serve?.pid, record.pid);

    await h.manager.markDead('transport_close');
    const restarted = h.manager.record;
    assert.ok(restarted);
    assert.equal(ledger.readServe(SESSION)?.pid, restarted.pid);
    assert.equal(ledger.readState().sessions[SESSION]?.serve?.pid, restarted.pid);

    await h.manager.stop('idle');
    assert.equal(ledger.readServe(SESSION), null);
    assert.equal(ledger.readState().sessions[SESSION]?.serve, null);
  } finally {
    await h.manager.dispose();
  }
});
