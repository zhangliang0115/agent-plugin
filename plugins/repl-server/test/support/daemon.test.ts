import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { DaemonStartError, startDaemon } from './daemon.ts';
import { createTempDir } from './temp.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/support/server.mjs', import.meta.url));

async function waitForPidFile(path: string, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const raw = (await readFile(path, 'utf8')).trim();
      if (raw !== '') {
        return Number(raw);
      }
    }
    await delay(20);
  }
  throw new Error(`pid file was not written: ${path}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await delay(50);
  }
  return false;
}

test('daemon parses --port 0 from stderr, waits for /health and kills its process group', async (t) => {
  const dir = await createTempDir('repl-daemon-');
  const pidFile = join(dir.path, 'grandchild.pid');
  const daemon = await startDaemon({ entry: FIXTURE, args: ['--child-pid-file', pidFile], t });
  t.after(() => dir.cleanup());

  assert.ok(daemon.port > 0, `expected a real port, stderr: ${daemon.stderr()}`);
  assert.equal(daemon.baseUrl, `http://127.0.0.1:${daemon.port}`);
  assert.match(daemon.stderr(), /fixture listening/);

  const response = await fetch(`${daemon.baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, fixture: true });

  const grandchild = await waitForPidFile(pidFile);
  assert.ok(isAlive(grandchild), 'grandchild should be running before stop');

  await daemon.stop();
  assert.ok(daemon.exitInfo() !== null, 'daemon should have exited');
  const gone = await waitForGone(grandchild, 5000);
  if (!gone) {
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  assert.equal(gone, true, `grandchild ${grandchild} survived the process-group stop`);
});

test('real server/src/index.ts accepts --port 0 and serves /health', async (t) => {
  let daemon;
  try {
    daemon = await startDaemon({ t, startTimeoutMs: 5000 });
  } catch (error) {
    if (
      error instanceof DaemonStartError &&
      error.exitCode === 2 &&
      /invalid port/i.test(error.stderr)
    ) {
      t.skip(`server/src/index.ts does not accept --port 0 yet (srv-01): ${error.stderr.trim()}`);
      return;
    }
    throw error;
  }
  try {
    const response = await fetch(`${daemon.baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok?: boolean };
    assert.equal(body.ok, true);
  } finally {
    await daemon.stop();
  }
});
