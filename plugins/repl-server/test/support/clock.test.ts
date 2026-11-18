import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FakeClock, createFileClock, sleep, toEpochMs } from './clock.ts';

test('FakeClock resolves sleeps only when virtual time reaches the deadline', async () => {
  const clock = new FakeClock('2026-11-18T00:00:00.000Z');
  assert.equal(clock.nowIso(), '2026-11-18T00:00:00.000Z');
  let resolved = false;
  const sleeper = clock.sleep(500).then(() => {
    resolved = true;
  });
  assert.equal(clock.pendingSleeps(), 1);
  clock.advance(499);
  await Promise.resolve();
  assert.equal(resolved, false);
  clock.advance(1);
  await sleeper;
  assert.equal(resolved, true);
  assert.equal(clock.pendingSleeps(), 0);
});

test('FakeClock sleep rejects when its signal aborts', async () => {
  const clock = new FakeClock(1000);
  const controller = new AbortController();
  const sleeper = clock.sleep(1000, { signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(sleeper, /stop/);
  assert.equal(clock.pendingSleeps(), 0);
});

test('toEpochMs accepts numbers, ISO strings and Dates', () => {
  assert.equal(toEpochMs(1234), 1234);
  assert.equal(toEpochMs('2026-11-18T00:00:00.000Z'), Date.parse('2026-11-18T00:00:00.000Z'));
  assert.equal(toEpochMs(new Date(42)), 42);
  assert.throws(() => toEpochMs('not a date'), RangeError);
});

test('FileClock writes a readable JSON clock and advances atomically', async (t) => {
  const clock = await createFileClock({ start: 1000, t });
  assert.equal(await clock.read(), 1000);
  assert.deepEqual({ ...clock.env }, { REPL_TEST_CLOCK: clock.path });
  await clock.advance(250);
  assert.equal(await clock.read(), 1250);
  const parsed = JSON.parse(await readFile(clock.path, 'utf8')) as { nowMs: number };
  assert.equal(parsed.nowMs, 1250);
  await clock.set(2000);
  assert.equal(await clock.read(), 2000);
});

test('sleep waits in real time', async () => {
  const start = Date.now();
  await sleep(10);
  assert.ok(Date.now() - start >= 5, 'sleep returned too early');
});
