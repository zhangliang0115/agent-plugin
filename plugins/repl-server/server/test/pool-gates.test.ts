import assert from 'node:assert/strict';
import test from 'node:test';

import { PoolGates } from '../src/pool/gates.ts';

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = () => res();
  });
  return { promise, resolve };
}

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
    assert.equal((error as { code?: unknown }).code, code);
    return true;
  };
}

test('pool gates use the frozen defaults and the 30s exclusive timeout', () => {
  const gates = new PoolGates();
  assert.equal(gates.callsPerBinding, 64);
  assert.equal(gates.queuedPerBinding, 256);
  assert.equal(gates.exclusiveGate.timeoutMs, 30_000);
  assert.equal(gates.inFlight, 0);
  assert.equal(gates.admissionClosed, false);
});

test('bindingStats reports live running and queued calls per binding x server', async () => {
  const gates = new PoolGates({ callsPerBinding: 1, queuedPerBinding: 2 });
  const release = deferred();
  const running = gates.run('srv', 'cb_a', 'parallel', async () => {
    await release.promise;
  });
  await tick();
  const queued = gates.run('srv', 'cb_a', 'parallel', async () => undefined);
  await tick();

  assert.deepEqual(gates.bindingStats(), [
    { binding: 'cb_a', serverId: 'srv', running: 1, queued: 1 },
  ]);

  release.resolve();
  await Promise.all([running, queued]);
  assert.deepEqual(gates.bindingStats(), []);
});

test('parallel calls share the per-server read lock and overlap', async () => {
  const gates = new PoolGates();
  const events: string[] = [];
  const hold = deferred();

  const first = gates.run('pg', 'cb_a', 'parallel', async () => {
    events.push('a:start');
    await hold.promise;
    events.push('a:end');
  });
  const second = gates.run('pg', 'cb_b', 'parallel', async () => {
    events.push('b:start');
    events.push('b:end');
  });

  await tick();
  assert.deepEqual(events, ['a:start', 'b:start', 'b:end']);

  hold.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['a:start', 'b:start', 'b:end', 'a:end']);
});

test('serial takes the server write lock: it drains reads and blocks later reads', async () => {
  const gates = new PoolGates();
  const events: string[] = [];
  const hold = deferred();

  const reader = gates.run('pg', 'cb_a', 'parallel', async () => {
    events.push('read:start');
    await hold.promise;
    events.push('read:end');
  });
  await tick();

  const writer = gates.run('pg', 'cb_b', 'serial', async () => {
    events.push('write:start');
    events.push('write:end');
  });
  await tick();

  const lateReader = gates.run('pg', 'cb_c', 'parallel', async () => {
    events.push('late:start');
  });
  await tick();
  assert.deepEqual(events, ['read:start'], 'the write lock must hold new readers behind the writer');

  hold.resolve();
  await Promise.all([reader, writer, lateReader]);
  assert.deepEqual(events, ['read:start', 'read:end', 'write:start', 'write:end', 'late:start']);
});

test('one server serialized does not block another server', async () => {
  const gates = new PoolGates();
  const events: string[] = [];
  const hold = deferred();

  const blocked = gates.run('pg', 'cb_a', 'serial', async () => {
    events.push('pg:start');
    await hold.promise;
    events.push('pg:end');
  });
  await tick();

  await gates.run('redis', 'cb_b', 'serial', () => {
    events.push('redis');
  });
  assert.deepEqual(events, ['pg:start', 'redis']);

  hold.resolve();
  await blocked;
});

test('a binding x server allows 4 in flight and starts the fifth when one finishes', async () => {
  const gates = new PoolGates({ callsPerBinding: 4, queuedPerBinding: 32 });
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];

  const runOne = (value: number): Promise<number> =>
    gates.run('pg', 'cb_a', 'parallel', async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return value;
    });

  const calls = Array.from({ length: 5 }, (_value, index) => runOne(index));
  await tick(10);
  assert.equal(peak, 4, 'only 4 calls may be in flight for one binding');
  assert.equal(releases.length, 4);

  releases.shift()!();
  await tick(10);
  assert.equal(releases.length, 4, 'the queued fifth call must start after a slot frees');
  assert.equal(peak, 4);

  for (const release of releases.splice(0)) release();
  assert.deepEqual(await Promise.all(calls), [0, 1, 2, 3, 4]);
});

test('the 33rd queued call for one binding x server is rejected with MCP_QUEUE_FULL', async () => {
  const gates = new PoolGates({ callsPerBinding: 1, queuedPerBinding: 2 });
  const hold = deferred();

  const running = gates.run('pg', 'cb_a', 'parallel', () => hold.promise);
  await tick();
  const queuedOne = gates.run('pg', 'cb_a', 'parallel', () => 'one');
  const queuedTwo = gates.run('pg', 'cb_a', 'parallel', () => 'two');

  await assert.rejects(
    gates.run('pg', 'cb_a', 'parallel', () => 'overflow'),
    isCode('MCP_QUEUE_FULL'),
  );

  // The quota is per binding x server: other bindings and other servers run.
  assert.equal(await gates.run('pg', 'cb_b', 'parallel', () => 'other-binding'), 'other-binding');
  assert.equal(await gates.run('redis', 'cb_a', 'parallel', () => 'other-server'), 'other-server');

  hold.resolve();
  assert.deepEqual(await Promise.all([running, queuedOne, queuedTwo]), [undefined, 'one', 'two']);
});

test('a saturated binding does not starve other bindings on the same server', async () => {
  const gates = new PoolGates({ callsPerBinding: 1 });
  const hold = deferred();

  const saturated = gates.run('pg', 'cb_a', 'parallel', () => hold.promise);
  const queued = gates.run('pg', 'cb_a', 'parallel', () => 'queued');
  await tick();

  const results = await Promise.all(
    ['cb_b', 'cb_c', 'cb_d'].map((binding, index) =>
      gates.run('pg', binding, 'parallel', () => `b${index}`),
    ),
  );
  assert.deepEqual(results, ['b0', 'b1', 'b2']);

  hold.resolve();
  await Promise.all([saturated, queued]);
});

test('exclusive closes admission first, drains global in-flight calls and runs alone', async () => {
  const gates = new PoolGates({ exclusiveTimeoutMs: 1_000 });
  const events: string[] = [];
  const hold = deferred();

  const running = gates.run('pg', 'cb_a', 'parallel', async () => {
    events.push('p:start');
    await hold.promise;
    events.push('p:end');
  });
  await tick();

  const exclusive = gates.run('other', 'cb_a', 'exclusive', async () => {
    events.push('x:start');
    await tick();
    events.push('x:end');
  });

  const late = [1, 2, 3].map((n) =>
    gates.run('pg', 'cb_b', 'parallel', async () => {
      events.push(`late:${n}`);
    }),
  );

  await tick();
  assert.equal(gates.admissionClosed, true, 'new calls must queue while exclusive waits');
  assert.deepEqual(events, ['p:start'], 'exclusive must wait for the in-flight call');

  hold.resolve();
  await Promise.all([running, exclusive, ...late]);

  assert.deepEqual(events.slice(0, 4), ['p:start', 'p:end', 'x:start', 'x:end']);
  assert.deepEqual(events.slice(4).sort(), ['late:1', 'late:2', 'late:3']);
  assert.equal(gates.admissionClosed, false);
  assert.equal(gates.inFlight, 0);
});

test('EXCLUSIVE_TIMEOUT bounds the wait and reopens admission', async () => {
  const gates = new PoolGates({ exclusiveTimeoutMs: 20 });
  const hold = deferred();
  const events: string[] = [];

  const running = gates.run('pg', 'cb_a', 'parallel', () => hold.promise);
  await tick();

  const startedAt = Date.now();
  await assert.rejects(
    gates.run('pg', 'cb_b', 'exclusive', () => {
      events.push('exclusive-ran');
    }),
    isCode('EXCLUSIVE_TIMEOUT'),
  );
  assert.ok(Date.now() - startedAt >= 10, 'the wait must be bounded by the injected timeout');
  assert.equal(gates.admissionClosed, false);

  // The slow call is still held, but ordinary calls are admitted again.
  assert.equal(await gates.run('redis', 'cb_c', 'parallel', () => 'after-timeout'), 'after-timeout');
  assert.deepEqual(events, []);

  hold.resolve();
  await running;
});

test('updateLimits hot-applies the in-flight limit to new admissions', async () => {
  const gates = new PoolGates();
  const events: string[] = [];
  const hold = deferred();

  const first = gates.run('pg', 'cb_a', 'parallel', async () => {
    events.push('a:start');
    await hold.promise;
    events.push('a:end');
  });
  await tick();
  gates.updateLimits({ callsPerBinding: 1 });
  assert.equal(gates.callsPerBinding, 1);

  let secondStarted = false;
  const second = gates.run('pg', 'cb_a', 'parallel', () => {
    secondStarted = true;
    events.push('b:start');
  });
  await tick();
  assert.equal(secondStarted, false, 'the lowered limit must queue the second call');

  hold.resolve();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start']);
});

test('raising the in-flight limit releases queued calls immediately', async () => {
  const gates = new PoolGates({ callsPerBinding: 1, queuedPerBinding: 1 });
  const events: string[] = [];
  const hold = deferred();

  const running = gates.run('pg', 'cb_a', 'parallel', async () => {
    events.push('run');
    await hold.promise;
  });
  await tick();

  const queued = gates.run('pg', 'cb_a', 'parallel', () => {
    events.push('queued');
    return 'queued';
  });
  await tick();
  assert.deepEqual(events, ['run']);

  gates.updateLimits({ callsPerBinding: 2 });
  await tick();
  assert.deepEqual(events, ['run', 'queued'], 'a raised limit must admit waiters');

  hold.resolve();
  await running;
  assert.equal(await queued, 'queued');
});

test('updateLimits hot-applies the queue limit and queue-full rejection', async () => {
  const gates = new PoolGates({ callsPerBinding: 1, queuedPerBinding: 0 });
  const hold = deferred();

  const running = gates.run('pg', 'cb_a', 'parallel', () => hold.promise);
  await tick();

  await assert.rejects(
    gates.run('pg', 'cb_a', 'parallel', () => 'blocked'),
    isCode('MCP_QUEUE_FULL'),
  );

  gates.updateLimits({ queuedPerBinding: 1 });
  assert.equal(gates.queuedPerBinding, 1);
  const queued = gates.run('pg', 'cb_a', 'parallel', () => 'now queued');
  await tick();

  hold.resolve();
  await running;
  assert.equal(await queued, 'now queued');
});

test('updateLimits validates values and keeps the previous ones on rejection', () => {
  const gates = new PoolGates({ callsPerBinding: 2, queuedPerBinding: 3 });
  assert.throws(() => gates.updateLimits({ callsPerBinding: 0 }), RangeError);
  assert.throws(() => gates.updateLimits({ callsPerBinding: 1.5 }), RangeError);
  assert.throws(() => gates.updateLimits({ queuedPerBinding: -1 }), RangeError);
  assert.equal(gates.callsPerBinding, 2);
  assert.equal(gates.queuedPerBinding, 3);
});
