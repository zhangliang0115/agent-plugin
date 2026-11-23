import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyedGate } from '../src/gates.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('the same key serializes and different keys do not', async () => {
  const gate = new KeyedGate();
  const order: string[] = [];
  const first = deferred();

  const a = gate.run('file:x', async () => {
    order.push('a:start');
    await first.promise;
    order.push('a:end');
  });
  const b = gate.run('file:x', () => {
    order.push('b:start');
  });
  const c = gate.run('file:y', () => {
    order.push('c:start');
  });

  await tick();
  assert.deepEqual(order, ['a:start', 'c:start']);
  assert.equal(gate.queueDepth('file:x'), 1);

  first.resolve();
  await Promise.all([a, b, c]);
  // The slot passes on only after the holder finished, so `b` starts last.
  assert.deepEqual(order, ['a:start', 'c:start', 'a:end', 'b:start']);
  assert.deepEqual(gate.stats(), { lanes: 2, running: 0, queued: 0 });
});

test('a queued call can be cancelled before it starts', async () => {
  const gate = new KeyedGate();
  const holder = deferred();
  const controller = new AbortController();
  let ran = false;

  const running = gate.run('official:Bash', () => holder.promise);
  const queued = gate.run(
    'official:Bash',
    () => {
      ran = true;
    },
    controller.signal,
  );
  await tick();
  controller.abort(new Error('eval timed out'));
  await assert.rejects(queued, /eval timed out/u);
  assert.equal(ran, false);
  assert.equal(gate.queueDepth('official:Bash'), 0);

  holder.resolve();
  await running;
});

test('an already-aborted signal never enters the lane', async () => {
  const gate = new KeyedGate();
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    gate.run('k', () => undefined, controller.signal),
    /cancelled/u,
  );
  assert.deepEqual(gate.stats(), { lanes: 0, running: 0, queued: 0 });
});

test('a throwing task releases its slot', async () => {
  const gate = new KeyedGate();
  await assert.rejects(
    gate.run('k', () => {
      throw new Error('boom');
    }),
    /boom/u,
  );
  assert.equal(gate.stats().running, 0);
  assert.equal(await gate.run('k', () => 'next'), 'next');
});

test('width above one admits that many calls in parallel', async () => {
  const gate = new KeyedGate({ width: 2 });
  const hold = deferred();
  let started = 0;
  const run = (): Promise<void> =>
    gate.run('k', async () => {
      started += 1;
      await hold.promise;
    });
  const all = [run(), run(), run()];
  await tick();
  assert.equal(started, 2);
  assert.equal(gate.queueDepth('k'), 1);
  hold.resolve();
  await Promise.all(all);
  assert.equal(started, 3);
});

test('maxQueue refuses the overflow instead of growing forever', async () => {
  const gate = new KeyedGate({ maxQueue: 1 });
  const hold = deferred();
  const running = gate.run('k', () => hold.promise);
  const queued = gate.run('k', () => undefined);
  await assert.rejects(gate.run('k', () => undefined), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'MCP_QUEUE_FULL');
    return true;
  });
  hold.resolve();
  await Promise.all([running, queued]);
});
