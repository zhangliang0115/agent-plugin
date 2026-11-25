import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRetention } from '../src/audit/retention.ts';
import type { LogFields, LogFn } from '../src/log.ts';

const NOW = Date.parse('2026-11-25T00:00:00.000Z');

async function tempDir(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'repl-retention-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before the deadline');
}

test('the background timer does not depend on `this`', async () => {
  const { root, cleanup } = await tempDir();
  try {
    let sweeps = 0;
    const retention = createRetention({
      logDir: join(root, 'log'),
      now: () => {
        sweeps += 1;
        return NOW;
      },
      intervalMs: 5,
    });
    // A detached start used to throw `this.runOnce is not a function` inside
    // the interval, which Node reports as an uncaught exception.
    const { start, stop } = retention;
    start();
    try {
      await until(() => sweeps > 0);
    } finally {
      stop();
    }
  } finally {
    await cleanup();
  }
});

test('a rejected background run is logged instead of left unhandled', async () => {
  const { root, cleanup } = await tempDir();
  try {
    const warnings: Array<{ message: string; fields?: LogFields }> = [];
    const log: LogFn = (message, fields) => warnings.push({ message, fields });
    const retention = createRetention({
      logDir: join(root, 'log'),
      now: () => NOW,
      log,
      intervalMs: 5,
    });
    retention.runOnce = async () => {
      throw new Error('sweep exploded');
    };
    retention.start();
    try {
      await until(() => warnings.some((line) => line.message.includes('sweep exploded')));
    } finally {
      retention.stop();
    }
    const warning = warnings.find((line) => line.message.includes('sweep exploded'));
    assert.equal(warning?.fields?.['level'], 'warn');
  } finally {
    await cleanup();
  }
});

test('a failing sweep records the error and warns at most once per minute', async () => {
  const { root, cleanup } = await tempDir();
  try {
    const warnings: string[] = [];
    const retention = createRetention({
      // An infinite retention window makes `cutoff` an invalid date, so the
      // sweep rejects without breaking the clock used by the failure path.
      retentionDays: Number.POSITIVE_INFINITY,
      logDir: join(root, 'log'),
      now: () => NOW,
      log: (message, fields) => {
        if (fields?.['level'] === 'warn') warnings.push(message);
      },
    });

    const first = await retention.runOnce();
    const second = await retention.runOnce();

    assert.match(first.error ?? '', /Invalid time value/);
    assert.equal(second.error, first.error, 'the second failure is still recorded');
    assert.equal(retention.stats().lastRunAt, NOW);
    assert.equal(
      warnings.filter((line) => line.startsWith('retention failed')).length,
      1,
      'repeated failures are rate-limited to one warning',
    );
  } finally {
    await cleanup();
  }
});
