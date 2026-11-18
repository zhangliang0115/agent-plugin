/** AI limiter: 2 running, 4 queued, AI_BUSY when full or when the wait expires. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AiRunnerError } from '../src/ai/errors.ts';
import { createAiLimiter } from '../src/ai/limiter.ts';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

test('two run, four queue and the seventh is rejected', async () => {
  const limiter = createAiLimiter();
  const releases: Array<() => void> = [];
  const task = (): Promise<void> =>
    new Promise<void>((resolve) => {
      releases.push(resolve);
    });

  const running = [limiter.run(task), limiter.run(task), limiter.run(task), limiter.run(task)];
  const queued = [limiter.run(task), limiter.run(task)];
  await tick();
  assert.deepEqual(limiter.snapshot(), { running: 2, queued: 4 });

  const error = await expectCode(limiter.run(task), 'AI_BUSY');
  assert.deepEqual(error.details, { running: 2, queued: 4 });

  // Drain: releasing a slot starts the next waiter, whose release lands on a later tick.
  for (let round = 0; round < 8 && (releases.length > 0 || limiter.snapshot().queued > 0); round += 1) {
    for (const release of releases.splice(0)) release();
    await tick();
  }
  await Promise.all([...running, ...queued]);
  assert.deepEqual(limiter.snapshot(), { running: 0, queued: 0 });
});

test('a waiter that exceeds maxWaitMs is rejected with waitedMs', async () => {
  const limiter = createAiLimiter({ maxRunning: 1, maxQueued: 2, maxWaitMs: 40 });
  let release: () => void = () => undefined;
  const blocker = limiter.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await tick();

  const error = await expectCode(limiter.run(() => Promise.resolve()), 'AI_BUSY');
  const details = error.details as { waitedMs?: number };
  assert.ok(typeof details.waitedMs === 'number' && details.waitedMs >= 30);

  release();
  await blocker;
});
