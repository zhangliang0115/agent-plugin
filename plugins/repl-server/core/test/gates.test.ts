import assert from 'node:assert/strict';
import test from 'node:test';

import { LIMITS } from '../src/constants.ts';
import { ReplError } from '../src/errors.ts';
import { EXCLUSIVE_TIMEOUT_MS, ServerGates } from '../src/gates.ts';

const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = () => res();
  });
  return { promise, resolve };
}

function isReplError(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ReplError, `expected ReplError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('defaults come from the frozen LIMITS and the 30s exclusive timeout', () => {
  const gates = new ServerGates();
  assert.equal(gates.callsPerBinding, LIMITS.callsPerBindingPerServer);
  assert.equal(gates.queuedPerBinding, LIMITS.queuedPerBindingPerServer);
  assert.equal(LIMITS.callsPerBindingPerServer, 64);
  assert.equal(LIMITS.queuedPerBindingPerServer, 256);
  assert.equal(gates.exclusiveGate.timeoutMs, EXCLUSIVE_TIMEOUT_MS);
  assert.equal(EXCLUSIVE_TIMEOUT_MS, 30_000);
});

test('parallel calls share the server read lock and overlap', async () => {
  const gates = new ServerGates();
  const events: string[] = [];
  const hold = deferred();

  const first = gates.withTool('pg', 'parallel', 'cb_a', async () => {
    events.push('a:start');
    await hold.promise;
    events.push('a:end');
  });
  const second = gates.withTool('pg', 'parallel', 'cb_b', async () => {
    events.push('b:start');
    events.push('b:end');
  });

  await tick();
  assert.deepEqual(events.slice(0, 3), ['a:start', 'b:start', 'b:end']);

  hold.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['a:start', 'b:start', 'b:end', 'a:end']);
});

test('serial takes the write lock: it drains parallel calls and blocks later parallel calls', async () => {
  const gates = new ServerGates();
  const events: string[] = [];
  const hold = deferred();

  const reader = gates.withTool('pg', 'parallel', 'cb_a', async () => {
    events.push('read:start');
    await hold.promise;
    events.push('read:end');
  });
  await tick();

  // Different binding on purpose: the write lock is per server, not per binding.
  const writer = gates.withTool('pg', 'serial', 'cb_b', async () => {
    events.push('write:start');
    events.push('write:end');
  });
  await tick();

  const lateReader = gates.withTool('pg', 'parallel', 'cb_c', async () => {
    events.push('late:start');
  });
  await tick();

  assert.deepEqual(events, ['read:start']);

  hold.resolve();
  await Promise.all([reader, writer, lateReader]);
  assert.deepEqual(events, ['read:start', 'read:end', 'write:start', 'write:end', 'late:start']);
});

test('a held server does not block another server', async () => {
  const gates = new ServerGates();
  const events: string[] = [];
  const hold = deferred();

  const blocked = gates.withTool('pg', 'serial', 'cb_a', async () => {
    events.push('pg:start');
    await hold.promise;
    events.push('pg:end');
  });
  await tick();

  await gates.withTool('redis', 'serial', 'cb_b', async () => {
    events.push('redis');
  });
  assert.deepEqual(events, ['pg:start', 'redis']);

  hold.resolve();
  await blocked;
});

test('per binding x server queue rejects the overflowing call with MCP_QUEUE_FULL', async () => {
  const gates = new ServerGates({ callsPerBinding: 1, queuedPerBinding: 2 });
  const hold = deferred();

  const running = gates.withTool('pg', 'parallel', 'cb_a', () => hold.promise);
  const queuedOne = gates.withTool('pg', 'parallel', 'cb_a', () => 'one');
  const queuedTwo = gates.withTool('pg', 'parallel', 'cb_a', () => 'two');

  await assert.rejects(
    gates.withTool('pg', 'parallel', 'cb_a', () => 'overflow'),
    isReplError('MCP_QUEUE_FULL'),
  );

  // The quota is scoped to binding x server: another binding and another
  // server still run while cb_a is saturated.
  assert.equal(await gates.withTool('pg', 'parallel', 'cb_b', () => 'other-binding'), 'other-binding');
  assert.equal(await gates.withTool('redis', 'parallel', 'cb_a', () => 'other-server'), 'other-server');

  hold.resolve();
  assert.deepEqual(await Promise.all([running, queuedOne, queuedTwo]), [undefined, 'one', 'two']);
});

test('exclusive closes admission first and is not starved by calls arriving later', async () => {
  const gates = new ServerGates({ exclusiveTimeoutMs: 1_000 });
  const events: string[] = [];
  const hold = deferred();

  const running = gates.withTool('pg', 'parallel', 'cb_a', async () => {
    events.push('p:start');
    await hold.promise;
    events.push('p:end');
  });
  await tick();

  const exclusive = gates.withTool('other', 'exclusive', 'cb_a', async () => {
    events.push('x:start');
    await tick();
    events.push('x:end');
  });

  // These arrive after admission closed and must wait behind the exclusive.
  const late = [1, 2, 3].map((n) =>
    gates.withTool('pg', 'parallel', 'cb_b', async () => {
      events.push(`late:${n}`);
    }),
  );

  await tick();
  assert.equal(gates.exclusiveGate.admissionClosed, true);
  assert.deepEqual(events, ['p:start']);

  hold.resolve();
  await Promise.all([running, exclusive, ...late]);

  assert.deepEqual(events.slice(0, 4), ['p:start', 'p:end', 'x:start', 'x:end']);
  assert.deepEqual(events.slice(4).sort(), ['late:1', 'late:2', 'late:3']);
  assert.equal(gates.exclusiveGate.admissionClosed, false);
  assert.equal(gates.exclusiveGate.inFlightCount, 0);
});

test('EXCLUSIVE_TIMEOUT bounds the wait and reopens admission', async () => {
  const gates = new ServerGates({ exclusiveTimeoutMs: 25 });
  const hold = deferred();
  const events: string[] = [];

  const running = gates.withTool('pg', 'parallel', 'cb_a', () => hold.promise);
  await tick();

  const startedAt = Date.now();
  await assert.rejects(
    gates.withTool('pg', 'exclusive', 'cb_b', () => {
      events.push('exclusive-ran');
    }),
    isReplError('EXCLUSIVE_TIMEOUT'),
  );
  assert.ok(Date.now() - startedAt >= 15, 'the wait should be bounded by the injected timeout');
  assert.equal(gates.exclusiveGate.admissionClosed, false);

  // The slow call is still held, but regular calls are admitted again.
  await gates.withTool('redis', 'parallel', 'cb_c', async () => {
    events.push('after-timeout');
  });
  assert.deepEqual(events, ['after-timeout']);

  hold.resolve();
  await running;
});

test('EXCLUSIVE_TIMEOUT also bounds queueing behind another exclusive call', async () => {
  const gates = new ServerGates({ exclusiveTimeoutMs: 25 });
  const hold = deferred();
  const events: string[] = [];

  const first = gates.withTool('pg', 'exclusive', 'cb_a', async () => {
    events.push('first:start');
    await hold.promise;
    events.push('first:end');
  });
  await tick();

  await assert.rejects(
    gates.withTool('pg', 'exclusive', 'cb_b', () => {
      events.push('second:ran');
    }),
    isReplError('EXCLUSIVE_TIMEOUT'),
  );

  hold.resolve();
  await first;
  assert.deepEqual(events, ['first:start', 'first:end']);

  // Release restores admission for ordinary calls.
  await gates.withTool('pg', 'parallel', 'cb_c', async () => {
    events.push('after');
  });
  assert.deepEqual(events, ['first:start', 'first:end', 'after']);
  assert.equal(gates.exclusiveGate.admissionClosed, false);
});
