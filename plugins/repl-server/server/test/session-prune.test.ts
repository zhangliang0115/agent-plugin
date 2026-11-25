import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  backdate,
  createSessionPruner,
  SESSION_STALE_MS,
  type SessionPruneStats,
} from '../src/serve/session-prune.ts';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');

async function fixture(): Promise<{ root: string; sessions: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'repl-session-prune-'));
  const sessions = join(root, 'sessions');
  await mkdir(sessions, { recursive: true });
  return { root, sessions, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function dir(sessions: string, name: string, record?: unknown): Promise<string> {
  const path = join(sessions, name);
  await mkdir(path, { recursive: true });
  if (record !== undefined) await writeFile(join(path, 'serve.json'), JSON.stringify(record));
  return path;
}

function pruner(sessions: string, overrides: { now?: () => number; staleMs?: number; pidAlive?: (pid: number) => boolean; onPrune?: (info: SessionPruneStats) => void } = {}) {
  return createSessionPruner({
    sessionsDir: sessions,
    now: () => NOW,
    pidAlive: () => false,
    ...overrides,
  });
}

test('removes only stale empty session directories', async () => {
  const { sessions, cleanup } = await fixture();
  try {
    const stale = await dir(sessions, 'es_stale_1');
    const fresh = await dir(sessions, 'es_fresh_1');
    await backdate(stale, NOW - SESSION_STALE_MS - 1000);

    const stats = await pruner(sessions).runOnce();
    assert.equal(stats.removedDirs, 1);
    assert.equal(stats.keptDirs, 1);
    assert.equal(stats.keptFresh, 1);
    await assert.rejects(stat(stale));
    assert.equal((await stat(fresh)).isDirectory(), true);
  } finally {
    await cleanup();
  }
});

test('a serve record with a live pid is kept even when it is old', async () => {
  const { sessions, cleanup } = await fixture();
  try {
    const live = await dir(sessions, 'es_live_1', { pid: 4242, sessionId: 'es_live_1' });
    await backdate(live, NOW - 10 * SESSION_STALE_MS);

    const stats = await pruner(sessions, { pidAlive: (pid) => pid === 4242 }).runOnce();
    assert.equal(stats.removedDirs, 0);
    assert.equal(stats.keptLivePid, 1);
    assert.equal(JSON.parse(await readFile(join(live, 'serve.json'), 'utf8')).pid, 4242);
  } finally {
    await cleanup();
  }
});

test('a dead serve pid is not enough on its own — the staleness window still applies', async () => {
  const { sessions, cleanup } = await fixture();
  try {
    const deadOld = await dir(sessions, 'es_dead_old', { pid: 999999 });
    const deadFresh = await dir(sessions, 'es_dead_fresh', { pid: 999999 });
    await backdate(deadOld, NOW - SESSION_STALE_MS - 1);
    await backdate(deadFresh, NOW - SESSION_STALE_MS + 1000);

    const stats = await pruner(sessions).runOnce();
    assert.equal(stats.removedDirs, 1);
    assert.equal(stats.keptFresh, 1);
  } finally {
    await cleanup();
  }
});

test('an unreadable serve record is kept, never guessed at', async () => {
  const { sessions, cleanup } = await fixture();
  try {
    const broken = await dir(sessions, 'es_broken');
    await writeFile(join(broken, 'serve.json'), '{ not json');
    await backdate(broken, NOW - 10 * SESSION_STALE_MS);

    const stats = await pruner(sessions).runOnce();
    assert.equal(stats.removedDirs, 0);
    assert.equal(stats.keptUnreadable, 1);
  } finally {
    await cleanup();
  }
});

test('files inside a directory count as recent activity', async () => {
  const { sessions, cleanup } = await fixture();
  try {
    const stale = await dir(sessions, 'es_touched');
    await backdate(stale, NOW - 10 * SESSION_STALE_MS);
    await writeFile(join(stale, 'workspace.json'), '{}'); // fresh file inside old dir

    const stats = await pruner(sessions).runOnce();
    assert.equal(stats.removedDirs, 0);
    assert.equal(stats.keptFresh, 1);
  } finally {
    await cleanup();
  }
});

test('a missing sessions directory is normal, not an error', async () => {
  const { root, cleanup } = await fixture();
  try {
    const stats = await pruner(join(root, 'absent')).runOnce();
    assert.equal(stats.error, null);
    assert.equal(stats.removedDirs, 0);
  } finally {
    await cleanup();
  }
});

test('onPrune fires once per sweep and non-directory entries are ignored', async () => {
  const { sessions, cleanup } = await fixture();
  try {
    const stale = await dir(sessions, 'es_stale_2');
    await backdate(stale, NOW - SESSION_STALE_MS - 1);
    await writeFile(join(sessions, 'README'), 'not a session');
    const seen: SessionPruneStats[] = [];
    const p = pruner(sessions, { onPrune: (info) => seen.push(info) });
    await p.runOnce();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.removedDirs, 1);
    assert.ok(await readFile(join(sessions, 'README'), 'utf8') === 'not a session');
    // Idempotent: a second sweep has nothing left to remove.
    await p.runOnce();
    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.removedDirs, 0);
  } finally {
    await cleanup();
  }
});

test('a rejected background run is logged instead of left unhandled', async () => {
  const { sessions, cleanup } = await fixture();
  try {
    const warnings: string[] = [];
    // A throwing clock makes both the sweep and its own error path reject.
    const p = createSessionPruner({
      sessionsDir: sessions,
      now: () => {
        throw new Error('clock failed');
      },
      intervalMs: 5,
      log: (message, fields) => {
        if (fields?.['level'] === 'warn') warnings.push(message);
      },
    });
    // A detached start also proves the interval does not rely on `this`.
    const { start, stop } = p;
    start();
    try {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && !warnings.some((line) => line.includes('clock failed'))) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      stop();
    }
    assert.ok(warnings.some((line) => line.includes('clock failed')), warnings.join('\n'));
  } finally {
    await cleanup();
  }
});
