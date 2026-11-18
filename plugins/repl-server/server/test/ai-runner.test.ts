/** AI runner: fixed argv, env whitelist, envelope parsing and failure modes. */
import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AI_ENV_KEYS } from '../src/ai/constants.ts';
import { AiRunnerError } from '../src/ai/errors.ts';
import {
  createAiRunner,
  stripFences,
  type AiRunner,
  type SpawnFn,
} from '../src/ai/runner.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));

class FakeChild extends EventEmitter {
  readonly pid = 2_000_000;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: Array<NodeJS.Signals | number> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
}

interface Capture {
  command: string;
  args: string[];
  options: Parameters<SpawnFn>[2];
  stdin: string;
}

function fakeSpawn(output: { stdout?: string; stderr?: string; code?: number | null }): {
  spawn: SpawnFn;
  child: FakeChild;
  capture: Capture;
} {
  const child = new FakeChild();
  const capture: Capture = {
    command: '',
    args: [],
    options: { shell: false } as Parameters<SpawnFn>[2],
    stdin: '',
  };
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk: string) => {
    capture.stdin += chunk;
  });
  const spawn: SpawnFn = (command, args, options) => {
    capture.command = command;
    capture.args = [...args];
    capture.options = options;
    setTimeout(() => {
      if (output.stderr !== undefined) child.stderr.write(output.stderr);
      child.stderr.end();
      if (output.stdout !== undefined) child.stdout.write(output.stdout);
      child.stdout.end();
      setTimeout(() => child.emit('close', output.code ?? 0, null), 10);
    }, 5);
    return child as unknown as ChildProcess;
  };
  return { spawn, child, capture };
}

interface RunnerFixture {
  runner: AiRunner;
  dir: string;
}

async function fixture(
  t: TestContext,
  options: {
    spawn?: SpawnFn;
    extraEnv?: Record<string, string>;
  } = {},
): Promise<RunnerFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'repl-ai-runner-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const runner = createAiRunner({
    dataDir: dir,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
  });
  return { runner, dir };
}

function envelope(result: unknown): string {
  return JSON.stringify({ is_error: false, subtype: 'success', num_turns: 1, result });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AiRunnerError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AiRunnerError, `expected AiRunnerError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  return caught;
}

const CONFIG = { claudeBin: 'fake-claude', model: null, timeoutMs: 2_000 };

test('stripFences only unwraps a whole-value fence', () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('~~~\n{"a":1}\n~~~'), '{"a":1}');
  assert.equal(stripFences('prefix {"a":1}'), 'prefix {"a":1}');
  assert.equal(stripFences('```json'), '');
});

test('fixed argv, stdin-only prompt, temp cwd and cleanup', async (t) => {
  const json = JSON.stringify({ ok: true });
  const { spawn, capture } = fakeSpawn({ stdout: envelope(json) });
  const { runner } = await fixture(t, { spawn });

  const result = await runner.run('SECRET PROMPT', CONFIG);
  assert.deepEqual(result.payload, { ok: true });
  assert.equal(capture.command, 'fake-claude');
  assert.equal(capture.stdin, 'SECRET PROMPT');
  assert.equal(capture.args[0], '-p');
  assert.deepEqual(capture.args.slice(0, 10), [
    '-p',
    '--output-format',
    'json',
    '--tools',
    '',
    '--strict-mcp-config',
    '--safe-mode',
    '--no-session-persistence',
    '--max-turns',
    '1',
  ]);
  assert.equal(capture.args[10], '--mcp-config');
  const runDir = capture.options.cwd;
  assert.ok(typeof runDir === 'string');
  assert.ok(runDir.includes('ai-run-'));
  assert.equal(capture.args[11], join(runDir, 'mcp.json'));
  assert.equal(capture.args.length, 12);
  assert.equal(capture.options.shell, false);
  assert.equal(capture.options.detached, true);
  assert.equal(existsSync(runDir), false, 'run directory must be removed');
});

test('--model is appended only when configured', async (t) => {
  const { spawn, capture } = fakeSpawn({ stdout: envelope('{}') });
  const { runner } = await fixture(t, { spawn });
  await runner.run('p', { ...CONFIG, model: 'claude-sonnet-4-5' });
  assert.deepEqual(capture.args.slice(-2), ['--model', 'claude-sonnet-4-5']);
});

test('child env contains only the whitelist plus the test seam', async (t) => {
  process.env['REPL_AI_TEST_SENTINEL'] = 'do-not-forward';
  t.after(() => {
    delete process.env['REPL_AI_TEST_SENTINEL'];
  });
  const { spawn, capture } = fakeSpawn({ stdout: envelope('{}') });
  const { runner } = await fixture(t, { spawn, extraEnv: { FAKE_CLAUDE_MODE: 'ok' } });
  await runner.run('p', CONFIG);
  const env = capture.options.env as Record<string, string | undefined>;
  assert.equal(env['REPL_AI_TEST_SENTINEL'], undefined);
  assert.equal(env['FAKE_CLAUDE_MODE'], 'ok');
  const allowed = new Set<string>([...AI_ENV_KEYS, 'FAKE_CLAUDE_MODE']);
  for (const key of Object.keys(env)) assert.ok(allowed.has(key), `unexpected env key ${key}`);
});

test('success envelope and fenced result both parse', async (t) => {
  const ok = fakeSpawn({ stdout: envelope('{"server":null,"warnings":["x"]}') });
  const okFixture = await fixture(t, { spawn: ok.spawn });
  assert.deepEqual(
    (await okFixture.runner.run('p', CONFIG)).payload,
    { server: null, warnings: ['x'] },
  );

  const fence = fakeSpawn({ stdout: envelope('```json\n{"a":1}\n```') });
  const fenceFixture = await fixture(t, { spawn: fence.spawn });
  assert.deepEqual((await fenceFixture.runner.run('p', CONFIG)).payload, { a: 1 });
});

test('bad envelope and invalid embedded JSON are distinct codes', async (t) => {
  const badEnvelope = fakeSpawn({ stdout: 'not json at all' });
  const badEnvelopeFixture = await fixture(t, { spawn: badEnvelope.spawn });
  const envelopeError = await expectCode(
    badEnvelopeFixture.runner.run('p', CONFIG),
    'AI_BAD_ENVELOPE',
  );
  assert.ok(typeof envelopeError.details === 'object');

  const badResult = fakeSpawn({ stdout: envelope('not json') });
  const badResultFixture = await fixture(t, { spawn: badResult.spawn });
  await expectCode(badResultFixture.runner.run('p', CONFIG), 'AI_INVALID_JSON');
});

test('is_error is checked before result typing', async (t) => {
  for (const payload of [
    { is_error: true, subtype: 'error', result: 'auth failed' },
    { is_error: true, subtype: 'error' },
    { is_error: true, subtype: 'error', result: { message: 'auth failed' } },
  ]) {
    const fake = fakeSpawn({ stdout: JSON.stringify(payload) });
    const { runner } = await fixture(t, { spawn: fake.spawn });
    await expectCode(runner.run('p', CONFIG), 'AI_RUN_FAILED');
  }
});

test('non-zero exit redacts bearer and provider tokens in stderr', async (t) => {
  const providerToken = `ghp_${'a'.repeat(36)}`;
  const { spawn } = fakeSpawn({
    stdout: '',
    stderr: `Authorization: Bearer abcdefghijklmnop\n${providerToken}`,
    code: 1,
  });
  const { runner } = await fixture(t, { spawn });
  const error = await expectCode(runner.run('p', CONFIG), 'AI_RUN_FAILED');
  const details = error.details as { stderr?: string; exitCode?: number };
  assert.equal(details.exitCode, 1);
  assert.ok(typeof details.stderr === 'string');
  assert.ok(!details.stderr.includes('abcdefghijklmnop'));
  assert.ok(!details.stderr.includes(providerToken));
  assert.ok(details.stderr.includes('<redacted>'));
});

test('oversized stdout rejects and kills the child', async (t) => {
  const { spawn, child } = fakeSpawn({ stdout: 'x'.repeat(300 * 1024) });
  const { runner } = await fixture(t, { spawn });
  await expectCode(runner.run('p', CONFIG), 'AI_OUTPUT_TOO_LARGE');
  assert.ok(child.signals.length > 0);
});

test('stderr is drained past its cap without failing the run', async (t) => {
  const { spawn } = fakeSpawn({
    stdout: envelope('{"ok":true}'),
    stderr: 'E'.repeat(9 * 1024),
  });
  const { runner } = await fixture(t, { spawn });
  const result = await runner.run('p', CONFIG);
  assert.deepEqual(result.payload, { ok: true });
});

test('spawn failure maps to AI_RUNNER_UNAVAILABLE', async (t) => {
  const { runner } = await fixture(t);
  const error = await expectCode(
    runner.run('p', { ...CONFIG, claudeBin: '/nonexistent/claude-binary' }),
    'AI_RUNNER_UNAVAILABLE',
  );
  const details = error.details as { command?: string };
  assert.equal(details.command, '/nonexistent/claude-binary');
});

test('fixture success, fence and invalid modes', async (t) => {
  await chmod(FIXTURE, 0o755);

  const ok = await fixture(t, {
    extraEnv: { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_PIDFILE: '' },
  });
  const okResult = await ok.runner.run('propose please', {
    ...CONFIG,
    claudeBin: FIXTURE,
  });
  assert.equal((okResult.payload as { server: { id: string } }).server.id, 'github');

  const fence = await fixture(t, { extraEnv: { FAKE_CLAUDE_MODE: 'fence' } });
  const fenceResult = await fence.runner.run('propose please', {
    ...CONFIG,
    claudeBin: FIXTURE,
  });
  assert.equal((fenceResult.payload as { server: { id: string } }).server.id, 'github');

  const invalid = await fixture(t, { extraEnv: { FAKE_CLAUDE_MODE: 'invalid' } });
  await expectCode(
    invalid.runner.run('propose please', { ...CONFIG, claudeBin: FIXTURE }),
    'AI_INVALID_JSON',
  );

  const envelopeMode = await fixture(t, {
    extraEnv: { FAKE_CLAUDE_MODE: 'envelope', FAKE_CLAUDE_ENVELOPE: '{"is_error":true}' },
  });
  await expectCode(
    envelopeMode.runner.run('propose please', { ...CONFIG, claudeBin: FIXTURE }),
    'AI_RUN_FAILED',
  );
});

test('fixture exit1, huge and stderr-flood modes', async (t) => {
  await chmod(FIXTURE, 0o755);

  const exit1 = await fixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'exit1',
      FAKE_CLAUDE_STDERR: 'Authorization: Bearer abcdefghijklmnop',
    },
  });
  const error = await expectCode(
    exit1.runner.run('p', { ...CONFIG, claudeBin: FIXTURE }),
    'AI_RUN_FAILED',
  );
  assert.ok(!JSON.stringify(error.details).includes('abcdefghijklmnop'));

  const huge = await fixture(t, { extraEnv: { FAKE_CLAUDE_MODE: 'huge' } });
  await expectCode(
    huge.runner.run('p', { ...CONFIG, claudeBin: FIXTURE }),
    'AI_OUTPUT_TOO_LARGE',
  );

  const flood = await fixture(t, { extraEnv: { FAKE_CLAUDE_MODE: 'stderr-flood' } });
  const floodResult = await flood.runner.run('p', { ...CONFIG, claudeBin: FIXTURE });
  assert.equal(
    (floodResult.payload as { server: { id: string } }).server.id,
    'github',
  );
});

test('timeout kills the fixture process group', async (t) => {
  await chmod(FIXTURE, 0o755);
  const knownPidfile = join(tmpdir(), `repl-ai-pid-${process.pid}-timeout`);
  await rm(knownPidfile, { force: true });
  t.after(async () => {
    await rm(knownPidfile, { force: true });
  });
  const timeoutFixture = await fixture(t, {
    extraEnv: { FAKE_CLAUDE_MODE: 'sleep', FAKE_CLAUDE_PIDFILE: knownPidfile },
  });

  await expectCode(
    timeoutFixture.runner.run('p', {
      ...CONFIG,
      claudeBin: FIXTURE,
      timeoutMs: 500,
    }),
    'AI_TIMEOUT',
  );

  const pidText = await readFile(knownPidfile, 'utf8');
  const pid = Number(pidText);
  assert.ok(Number.isInteger(pid) && pid > 0);
  let gone = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      gone = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(gone, true, 'fixture process must be gone after the timeout');
});
