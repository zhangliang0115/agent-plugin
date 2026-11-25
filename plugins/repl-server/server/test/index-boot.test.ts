import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const INDEX = new URL('../src/index.ts', import.meta.url).pathname;

test('a listen failure is logged and exits 1 instead of crashing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'repl-index-'));
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  assert.ok(address !== null && typeof address === 'object');
  t.after(async () => {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const child = spawn(process.execPath, [INDEX, '--port', String(address.port)], {
    env: { ...process.env, AGENTS_HOME: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit: ${stderr}`));
    }, 15_000);
    timer.unref();
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /http server failed: listen EADDRINUSE/);
  assert.doesNotMatch(stderr, /Unhandled 'error' event/);
});
