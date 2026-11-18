import assert from 'node:assert/strict';
import test from 'node:test';

import { RwLock, Semaphore } from '../src/concurrency.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test('readers run concurrently', async () => {
  const lock = new RwLock();
  const events: string[] = [];
  await Promise.all([
    lock.read(async () => {
      events.push('a-start');
      await tick();
      events.push('a-end');
    }),
    lock.read(async () => {
      events.push('b-start');
      await tick();
      events.push('b-end');
    }),
  ]);
  assert.deepEqual(events.slice(0, 2).sort(), ['a-start', 'b-start']);
});

test('a writer waits for readers and blocks new readers', async () => {
  const lock = new RwLock();
  const events: string[] = [];
  const reader = lock.read(async () => {
    events.push('read-start');
    await tick();
    events.push('read-end');
  });
  const writer = lock.write(async () => {
    events.push('write');
  });
  const lateReader = lock.read(async () => {
    events.push('late-read');
  });
  await Promise.all([reader, writer, lateReader]);
  assert.deepEqual(events, ['read-start', 'read-end', 'write', 'late-read']);
});

test('a queued writer blocks readers that arrive later', async () => {
  const lock = new RwLock();
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = lock.read(async () => {
    order.push('first');
    await held;
  });
  await tick();

  const writer = lock.write(async () => {
    order.push('writer');
  });
  const lateReader = lock.read(async () => {
    order.push('late-reader');
  });

  release();
  await Promise.all([first, writer, lateReader]);
  assert.deepEqual(order, ['first', 'writer', 'late-reader']);
});

test('semaphore caps concurrency and releases in FIFO order', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      sem.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        order.push(index);
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});
