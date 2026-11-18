import assert from 'node:assert/strict';
import test from 'node:test';

import { LIMITS } from '../src/constants.ts';
import { ReplError } from '../src/errors.ts';
import type { StructuredToolError } from '../src/types.ts';
import {
  AlreadyConsumedError,
  TaskExpiredError,
  TaskStore,
  UnknownTaskError,
  type TaskClock,
} from '../src/eval/task-store.ts';

interface FakeClock extends TaskClock {
  advance(ms: number): void;
}

function fakeClock(start = 1_000): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function newStore(options: { ttlMs?: number; capacity?: number; start?: number } = {}): {
  clock: FakeClock;
  store: TaskStore;
} {
  const clock = fakeClock(options.start);
  const store = new TaskStore({
    clock,
    ttlMs: options.ttlMs ?? 1_000,
    capacity: options.capacity ?? 8,
  });
  return { clock, store };
}

/** Matcher for `assert.throws` / `assert.rejects`. */
function codeIs(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ReplError);
    assert.equal(error.code, code);
    return true;
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

test('create allocates an evalTaskId and get is idempotent', () => {
  const { clock, store } = newStore();
  const taskId = store.create(7, 'cb_a');
  assert.match(taskId, /^t_[0-9a-f]{32}$/);

  clock.advance(25);
  const first = store.get('cb_a', taskId);
  const second = store.get('cb_a', taskId);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    taskId,
    evalId: 7,
    status: 'working',
    elapsedMs: 25,
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 2_000,
    consumed: false,
  });
});

test('wait events use exactly the frozen shape', async () => {
  const { clock, store } = newStore();
  const taskId = store.create(7, 'cb_a');
  clock.advance(25);
  store.complete(taskId, { result: '42', stdout: '$ echo 42' });

  const waited = await store.wait('cb_a', [taskId], 100);
  assert.equal(waited.events.length, 1);
  assert.deepEqual(waited.events[0], {
    taskId,
    evalId: 7,
    status: 'completed',
    result: '42',
    stdout: '$ echo 42',
    elapsedMs: 25,
  });
  assert.deepEqual(Object.keys(waited.events[0]!).sort(), [
    'elapsedMs',
    'evalId',
    'result',
    'status',
    'stdout',
    'taskId',
  ]);
});

test('fail keeps the structured error and cancel reports the cancelled state', async () => {
  const { store } = newStore();
  const failing = store.create(1, 'cb_a');
  const cancelled = store.create(2, 'cb_a');
  const error: StructuredToolError = {
    code: 'MCP_CALL_TIMEOUT',
    server: 'pg',
    tool: 'query',
    retryable: true,
    retryAfterMs: 50,
  };

  store.fail(failing, error, { stdout: 'partial' });
  store.cancel(cancelled);

  const waited = await store.wait('cb_a', [failing, cancelled], 100);
  assert.deepEqual(waited.events, [
    { taskId: failing, evalId: 1, status: 'failed', stdout: 'partial', elapsedMs: 0, error },
    { taskId: cancelled, evalId: 2, status: 'cancelled', elapsedMs: 0 },
  ]);
});

test('the first terminal transition wins', () => {
  const { clock, store } = newStore();
  const taskId = store.create(1, 'cb_a');
  clock.advance(10);
  assert.equal(store.complete(taskId, { result: 'first' }), true);
  clock.advance(10);
  assert.equal(store.fail(taskId, { code: 'LATE', retryable: false }), false);
  assert.equal(store.cancel(taskId), false);

  const snapshot = store.get('cb_a', taskId);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.result, 'first');
  assert.equal(snapshot.elapsedMs, 10);
  assert.equal(snapshot.updatedAt, 1_010);
});

test('wait resolves only after every requested task reaches a terminal state', async () => {
  const { store } = newStore();
  const a = store.create(1, 'cb_a');
  const b = store.create(2, 'cb_a');

  let settled = false;
  const waiting = store.wait('cb_a', [a, b], 1_000).then((result) => {
    settled = true;
    return result;
  });

  await tick();
  store.complete(a);
  await tick();
  assert.equal(settled, false);

  store.fail(b, { code: 'BOOM', retryable: false });
  const waited = await waiting;
  assert.equal(settled, true);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.pending, 0);
  assert.deepEqual(
    waited.events.map((event) => [event.taskId, event.status]),
    [
      [a, 'completed'],
      [b, 'failed'],
    ],
  );
});

test('wait times out with completed events and a pending count', async () => {
  const { store } = newStore();
  const done = store.create(1, 'cb_a');
  const running = store.create(2, 'cb_a');
  store.complete(done, { result: 'done' });

  const waited = await store.wait('cb_a', [done, running], 20);
  assert.equal(waited.timedOut, true);
  assert.equal(waited.pending, 1);
  assert.deepEqual(waited.events.map((event) => event.taskId), [done]);
  assert.equal(store.get('cb_a', done).consumed, false);

  const runningWait = store.wait('cb_a', [running], 1_000);
  await tick();
  store.cancel(running);
  const second = await runningWait;
  assert.equal(second.timedOut, false);
  assert.deepEqual(second.events.map((event) => event.status), ['cancelled']);
});

test('wait without ids selects every unconsumed, unexpired task of the owner', async () => {
  const { store } = newStore();
  const a = store.create(1, 'cb_a');
  const b = store.create(2, 'cb_a');
  const consumed = store.create(3, 'cb_a');
  const foreign = store.create(4, 'cb_b');
  store.complete(consumed);
  store.consume('cb_a', [consumed]);
  store.complete(foreign);

  const waiting = store.wait('cb_a', undefined, 1_000);
  await tick();
  store.complete(a);
  store.complete(b);

  const waited = await waiting;
  assert.deepEqual(waited.events.map((event) => event.taskId), [a, b]);
  assert.equal(waited.pending, 0);
  assert.equal(store.get('cb_a', consumed).consumed, true);
  assert.equal(store.get('cb_b', foreign).consumed, false);
});

test('a wait without ids uses the snapshot taken at call time', async () => {
  const { store } = newStore();
  const first = store.create(1, 'cb_a');
  const waiting = store.wait('cb_a', undefined, 1_000);
  const late = store.create(2, 'cb_a');
  store.complete(first);

  const waited = await waiting;
  assert.deepEqual(waited.events.map((event) => event.taskId), [first]);
  assert.equal(store.get('cb_a', late).consumed, false);
});

test('an empty wait set resolves immediately', async () => {
  const { store } = newStore();
  assert.deepEqual(await store.wait('cb_a', undefined, 1_000), {
    timedOut: false,
    events: [],
    pending: 0,
  });
  assert.deepEqual(await store.wait('cb_a', [], 1_000), {
    timedOut: false,
    events: [],
    pending: 0,
  });
  assert.deepEqual(store.consume('cb_a'), { events: [], pending: 0 });
});

test('wait rejects unknown ids without consuming other results', async () => {
  const { store } = newStore();
  const a = store.create(1, 'cb_a');
  store.complete(a, { result: 'kept' });

  await assert.rejects(store.wait('cb_a', [a, 't_missing'], 100), (error: unknown) => {
    assert.ok(error instanceof UnknownTaskError);
    assert.equal(error.code, 'UNKNOWN_TASK');
    assert.deepEqual(error.unknownIds, ['t_missing']);
    return true;
  });

  const waited = await store.wait('cb_a', [a], 100);
  assert.deepEqual(waited.events.map((event) => event.result), ['kept']);
  assert.equal(store.get('cb_a', a).consumed, false);
});

test('tasks expire at ttlMs and report TASK_EXPIRED', async () => {
  const { clock, store } = newStore({ ttlMs: 100 });
  const taskId = store.create(1, 'cb_a');

  clock.advance(99);
  assert.equal(store.get('cb_a', taskId).status, 'working');
  clock.advance(1);

  assert.throws(() => store.get('cb_a', taskId), codeIs('TASK_EXPIRED'));
  assert.throws(() => store.get('cb_a', taskId), codeIs('TASK_EXPIRED'));
  assert.equal(store.complete(taskId), false);
  assert.throws(() => store.consume('cb_a', [taskId]), codeIs('TASK_EXPIRED'));
  await assert.rejects(store.wait('cb_a', [taskId], 10), codeIs('TASK_EXPIRED'));
  assert.deepEqual(await store.wait('cb_a', undefined, 10), {
    timedOut: false,
    events: [],
    pending: 0,
  });
});

test('consume collects once and rejects a second collection', () => {
  const { store } = newStore();
  const a = store.create(1, 'cb_a');
  const b = store.create(2, 'cb_a');
  store.complete(a, { result: 'one' });
  store.complete(b, { result: 'two' });

  const first = store.consume('cb_a', [a]);
  assert.deepEqual(first.events.map((event) => event.result), ['one']);
  assert.equal(first.pending, 0);

  assert.throws(
    () => store.consume('cb_a', [a]),
    (error: unknown) => {
      assert.ok(error instanceof AlreadyConsumedError);
      assert.equal(error.code, 'ALREADY_CONSUMED');
      return true;
    },
  );

  // The failed retry did not consume b.
  const second = store.consume('cb_a', [b]);
  assert.deepEqual(second.events.map((event) => event.result), ['two']);
  assert.equal(store.get('cb_a', a).consumed, true);
  assert.equal(store.get('cb_a', b).consumed, true);
});

test('an unknown id rejects the whole consume call', () => {
  const { store } = newStore();
  const taskId = store.create(1, 'cb_a');
  store.complete(taskId);

  assert.throws(() => store.consume('cb_a', [taskId, 't_missing']), UnknownTaskError);
  assert.equal(store.get('cb_a', taskId).consumed, false);
});

test('consume without ids takes terminal tasks and leaves working ones pending', () => {
  const { store } = newStore();
  const done = store.create(1, 'cb_a');
  const working = store.create(2, 'cb_a');
  store.complete(done, { result: 'ok' });

  const first = store.consume('cb_a');
  assert.deepEqual(first.events.map((event) => event.taskId), [done]);
  assert.equal(first.pending, 1);

  const second = store.consume('cb_a');
  assert.deepEqual(second.events, []);
  assert.equal(second.pending, 1);
  assert.equal(store.get('cb_a', working).consumed, false);
});

test('wait observes without consuming and an explicit subset leaves other results queued', async () => {
  const { store } = newStore();
  const a = store.create(1, 'cb_a');
  const b = store.create(2, 'cb_a');
  store.complete(a);
  store.complete(b);

  const waited = await store.wait('cb_a', [b], 100);
  assert.deepEqual(waited.events.map((event) => event.taskId), [b]);
  assert.equal(store.get('cb_a', b).consumed, false);

  const collectedB = store.consume('cb_a', [b]);
  assert.deepEqual(collectedB.events.map((event) => event.taskId), [b]);
  const collectedRest = store.consume('cb_a');
  assert.deepEqual(collectedRest.events.map((event) => event.taskId), [a]);
});

test('wait then consume composes the wait_tasks handler flow', async () => {
  const { store } = newStore();
  const a = store.create(1, 'cb_a');
  const b = store.create(2, 'cb_a');
  store.complete(a);

  const waited = await store.wait('cb_a', [a, b], 20);
  assert.equal(waited.timedOut, true);
  assert.equal(waited.pending, 1);

  const consumed = store.consume('cb_a', [a, b]);
  assert.deepEqual(consumed.events.map((event) => event.taskId), [a]);
  assert.equal(consumed.pending, 1);

  store.complete(b);
  const secondWait = await store.wait('cb_a', undefined, 100);
  assert.deepEqual(secondWait.events.map((event) => event.taskId), [b]);
  const secondConsume = store.consume('cb_a');
  assert.deepEqual(secondConsume.events.map((event) => event.taskId), [b]);
});

test('owner scoping rejects foreign ids and hides them from omitted-id calls', async () => {
  const { store } = newStore();
  const taskId = store.create(1, 'cb_a');

  assert.throws(() => store.get('cb_b', taskId), UnknownTaskError);
  assert.throws(() => store.consume('cb_b', [taskId]), UnknownTaskError);
  await assert.rejects(store.wait('cb_b', [taskId], 10), UnknownTaskError);
  assert.deepEqual(await store.wait('cb_b', undefined, 10), {
    timedOut: false,
    events: [],
    pending: 0,
  });
  assert.deepEqual(store.consume('cb_b'), { events: [], pending: 0 });
});

test('elapsedMs stops at the terminal transition', () => {
  const { clock, store } = newStore();
  const taskId = store.create(1, 'cb_a');
  clock.advance(250);
  store.complete(taskId);
  clock.advance(500);

  assert.equal(store.get('cb_a', taskId).elapsedMs, 250);
  assert.equal(store.consume('cb_a', [taskId]).events[0]!.elapsedMs, 250);
});

test('capacity evicts expired then consumed records before rejecting', () => {
  const clock = fakeClock(0);
  const store = new TaskStore({ clock, ttlMs: 1_000, capacity: 2 });
  const a = store.create(1, 'cb_a');
  const b = store.create(2, 'cb_a');
  store.complete(a);
  store.consume('cb_a', [a]);

  const c = store.create(3, 'cb_a');
  assert.equal(store.size, 2);
  assert.notEqual(c, a);
  assert.notEqual(c, b);
  assert.throws(() => store.get('cb_a', a), UnknownTaskError);

  assert.throws(() => store.create(4, 'cb_a'), codeIs('CAPACITY_EXCEEDED'));

  const clock2 = fakeClock(0);
  const store2 = new TaskStore({ clock: clock2, ttlMs: 50, capacity: 1 });
  const old = store2.create(1, 'cb_a');
  clock2.advance(50);
  store2.create(2, 'cb_a');
  assert.equal(store2.size, 1);
  assert.throws(() => store2.get('cb_a', old), UnknownTaskError);
});

test('defaults come from constants.ts', () => {
  const clock = fakeClock(5_000);
  const store = new TaskStore({ clock });
  const taskId = store.create(1, 'cb_a');
  const snapshot = store.get('cb_a', taskId);
  assert.equal(snapshot.createdAt, 5_000);
  assert.equal(snapshot.expiresAt, 5_000 + LIMITS.taskTtlMs);

  for (let evalId = 2; evalId <= LIMITS.inFlightPerExecSession; evalId += 1) {
    store.create(evalId, 'cb_a');
  }
  assert.throws(() => store.create(99, 'cb_a'), codeIs('CAPACITY_EXCEEDED'));
});

test('settling unknown or expired tasks is a no-op', () => {
  const { clock, store } = newStore({ ttlMs: 10 });
  assert.equal(store.complete('t_missing'), false);
  assert.equal(store.fail('t_missing', { code: 'X', retryable: false }), false);
  assert.equal(store.cancel('t_missing'), false);

  const taskId = store.create(1, 'cb_a');
  clock.advance(10);
  assert.equal(store.complete(taskId), false);
});

test('rejects invalid store options', () => {
  assert.throws(() => new TaskStore({ clock: fakeClock(), ttlMs: 0 }), RangeError);
  assert.throws(() => new TaskStore({ clock: fakeClock(), capacity: 0 }), RangeError);
});

test('rejects an empty owner', () => {
  const { store } = newStore();
  assert.throws(() => store.create(1, ''), TypeError);
});
