import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { EvalTimeoutError, ReplError, StaleEvalError, WorkerKilledError } from '../src/errors.ts';
import {
  ExecSession,
  type EvalExecutor,
  type EvalExecutorOutcome,
  type EvalSettlement,
  type EvalSessionEvent,
  type ExecSessionLimits,
  type ExecSessionOptions,
} from '../src/eval/exec-session.ts';
import { resolveEvalTimeout, runEval } from '../src/eval/run-eval.ts';
import type { Sandbox } from '../src/worker/sandbox.ts';

/**
 * Typecheck-only seam: the production `Sandbox` must stay assignable to the
 * executor interface `runEval` depends on.
 */
function assertSandboxImplementsExecutor(sandbox: Sandbox): EvalExecutor {
  return sandbox;
}
void assertSandboxImplementsExecutor;

interface PendingEval {
  evalId: number;
  code: string;
  syncMs: number | undefined;
  resolve: (outcome: EvalExecutorOutcome) => void;
  reject: (error: unknown) => void;
}

/** Deterministic stand-in for `Sandbox`; no worker, no serve. */
class FakeExecutor implements EvalExecutor {
  epoch = 1;
  readonly pending: PendingEval[] = [];
  readonly cancelled: number[] = [];
  readonly terminateCalls: Array<number | undefined> = [];
  startCalls = 0;
  terminateResult = true;
  rejectOnTerminate = false;
  onCancel: ((evalId: number) => void) | undefined;

  async start(): Promise<{ epoch: number }> {
    this.startCalls += 1;
    return { epoch: this.epoch };
  }

  eval(code: string, options: { evalId: number; syncMs?: number }): Promise<EvalExecutorOutcome> {
    return new Promise<EvalExecutorOutcome>((resolve, reject) => {
      this.pending.push({ evalId: options.evalId, code, syncMs: options.syncMs, resolve, reject });
    });
  }

  cancel(evalId: number): void {
    this.cancelled.push(evalId);
    this.onCancel?.(evalId);
  }

  async terminate(timeoutMs?: number): Promise<boolean> {
    this.terminateCalls.push(timeoutMs);
    if (this.rejectOnTerminate) {
      for (const call of this.pending.splice(0)) call.reject(new WorkerKilledError());
    }
    return this.terminateResult;
  }

  complete(evalId: number, outcome: EvalExecutorOutcome): void {
    const index = this.pending.findIndex((call) => call.evalId === evalId);
    assert.notEqual(index, -1, `eval ${evalId} has no pending executor call`);
    const [call] = this.pending.splice(index, 1);
    call?.resolve(outcome);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition is still false after timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSession(
  executor: FakeExecutor,
  overrides: Partial<ExecSessionLimits> = {},
  options: Partial<Pick<ExecSessionOptions, 'serve' | 'onEvent'>> = {},
): ExecSession {
  return new ExecSession({
    id: 'es_test',
    createExecutor: () => executor,
    limits: { graceMs: 30, terminateMs: 20, ...overrides },
    ...options,
  });
}

function track(t: TestContext, session: ExecSession): ExecSession {
  t.after(async () => {
    await session.dispose();
  });
  return session;
}

test('resolveEvalTimeout has no default or maximum', () => {
  assert.equal(resolveEvalTimeout(), undefined);
  assert.equal(resolveEvalTimeout(5_000), 5_000);
  assert.equal(resolveEvalTimeout(7_200_001), 7_200_001);

  const isInvalid = (error: unknown): boolean => error instanceof ReplError && error.code === 'INVALID_ARGUMENT';
  assert.throws(() => resolveEvalTimeout(0), isInvalid);
  assert.throws(() => resolveEvalTimeout(-10), isInvalid);
  assert.throws(() => resolveEvalTimeout(Number.NaN), isInvalid);
});

test('synchronous evals run one at a time under the session lock', async (t) => {
  const executor = new FakeExecutor();
  const session = track(t, makeSession(executor));

  const first = runEval(session, 'first', { timeoutMs: 60_000 });
  const second = runEval(session, 'second', { timeoutMs: 60_000 });

  await waitFor(() => executor.pending.length === 1);
  assert.equal(executor.pending[0]?.code, 'first');
  assert.equal(session.lock.queued, 1);

  let secondDone = false;
  void second.then(() => {
    secondDone = true;
  });
  await tick();
  assert.equal(secondDone, false);
  assert.equal(executor.pending.length, 1);

  executor.complete(1, { ok: true, result: 'one', stdout: 'out-1', stderr: '', ms: 1 });
  await waitFor(() => executor.pending.length === 1 && executor.pending[0]?.code === 'second');

  executor.complete(2, { ok: true, result: 'two', ms: 2 });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.result, 'one');
  assert.equal(one.stdout, 'out-1');
  assert.equal(one.async, false);
  assert.equal(two.result, 'two');
  assert.equal(session.inFlightEvals, 0);
});

test('an async eval releases the lock after dispatch and settles through onSettled', async (t) => {
  const executor = new FakeExecutor();
  const session = track(t, makeSession(executor));
  const settled = deferred<EvalSettlement>();

  const receipt = await runEval(session, 'background', {
    async: true,
    timeoutMs: 60_000,
    evalTaskId: 't_background',
    onSettled: (value) => settled.resolve(value),
  });

  assert.equal(receipt.asyncDispatched, true);
  assert.equal(receipt.async, true);
  assert.equal(receipt.evalId, 1);
  assert.equal(receipt.evalTaskId, 't_background');
  assert.equal(session.inFlightEvals, 1);
  assert.equal(session.lock.held, false);
  assert.equal(executor.pending.length, 1);

  // A sync eval can start while the background eval is still running.
  const foreground = runEval(session, 'foreground', { timeoutMs: 60_000 });
  await waitFor(() => executor.pending.length === 2);
  assert.equal(executor.pending[1]?.code, 'foreground');

  executor.complete(2, { ok: true, result: 'foreground-result', ms: 1 });
  assert.equal((await foreground).result, 'foreground-result');
  assert.equal(session.inFlightEvals, 1);

  executor.complete(1, { ok: true, result: 'background-result', ms: 2 });
  const final = await settled.promise;
  assert.equal(final.result, 'background-result');
  assert.equal(final.async, true);
  assert.equal(final.evalTaskId, 't_background');
  assert.equal(session.inFlightEvals, 0);
});

test('an eval beyond the in-flight limit is rejected with CAPACITY_EXCEEDED', async (t) => {
  const executor = new FakeExecutor();
  const session = track(t, makeSession(executor, { inFlightLimit: 2 }));
  assert.equal(session.limits.inFlightLimit, 2);

  for (let index = 1; index <= 2; index += 1) {
    const receipt = await runEval(session, `bg-${index}`, { async: true, timeoutMs: 60_000 });
    assert.equal(receipt.evalId, index);
  }
  assert.equal(session.inFlightEvals, 2);

  await assert.rejects(
    runEval(session, 'overflow', { async: true, timeoutMs: 60_000 }),
    (error: unknown) => error instanceof ReplError && error.code === 'CAPACITY_EXCEEDED',
  );
  assert.equal(session.inFlightEvals, 2);
});

test('tool calls require a live (epoch, evalId, callSeq) triple', async (t) => {
  const executor = new FakeExecutor();
  const events: EvalSessionEvent[] = [];
  const session = track(t, makeSession(executor, {}, { onEvent: (event) => events.push(event) }));
  const settled = deferred<EvalSettlement>();
  const receipt = await runEval(session, 'pending', {
    async: true,
    timeoutMs: 60_000,
    onSettled: (value) => settled.resolve(value),
  });

  const ev = session.activeEvals.get(receipt.evalId);
  assert.ok(ev);
  const base = { evalId: ev.evalId, epoch: ev.epoch, tool: 'Read', args: { file_path: '/tmp/x' } };

  const first = session.acceptToolCall({ ...base, callSeq: 1 });
  assert.ok(first);
  assert.equal(first.signal.aborted, false);
  assert.equal(session.acceptToolCall({ ...base, callSeq: 1 }), undefined); // still in flight
  first.complete();
  assert.equal(session.acceptToolCall({ ...base, callSeq: 1 }), undefined); // completed
  assert.equal(session.acceptToolCall({ ...base, callSeq: 0 }), undefined);
  assert.equal(session.acceptToolCall({ ...base, epoch: ev.epoch + 1, callSeq: 2 }), undefined);
  assert.equal(session.acceptToolCall({ ...base, evalId: ev.evalId + 100, callSeq: 2 }), undefined);

  const second = session.acceptToolCall({ ...base, callSeq: 2 });
  assert.ok(second);
  second.complete();

  const handled = await session.handleToolCall({ ...base, callSeq: 3 }, (call) => {
    assert.equal(call.signal.aborted, false);
    return 'tool-result';
  });
  assert.equal(handled, 'tool-result');
  assert.equal(ev.calls, 3);

  await assert.rejects(
    session.handleToolCall({ ...base, epoch: ev.epoch + 1, callSeq: 4 }, () => 'never'),
    (error: unknown) => error instanceof StaleEvalError,
  );

  executor.complete(ev.evalId, { ok: true, result: 'done', ms: 1 });
  await settled.promise;
  assert.equal(session.acceptToolCall({ ...base, callSeq: 5 }), undefined);

  const reasons = events
    .filter((event): event is Extract<EvalSessionEvent, { type: 'tool_call_dropped' }> => event.type === 'tool_call_dropped')
    .map((event) => event.reason);
  assert.ok(reasons.includes('duplicate_call'));
  assert.ok(reasons.includes('invalid_call_seq'));
  assert.ok(reasons.includes('stale_epoch'));
  assert.ok(reasons.includes('unknown_eval'));
});

test('tool calls are counted but never rejected', async (t) => {
  const executor = new FakeExecutor();
  const session = track(t, makeSession(executor));
  const settled = deferred<EvalSettlement>();
  const receipt = await runEval(session, 'many-calls', {
    async: true,
    timeoutMs: 60_000,
    onSettled: (value) => settled.resolve(value),
  });
  const ev = session.activeEvals.get(receipt.evalId);
  assert.ok(ev);
  const base = { evalId: ev.evalId, epoch: ev.epoch, tool: 'Bash', args: {} };

  for (let seq = 1; seq <= 100; seq += 1) {
    const call = session.acceptToolCall({ ...base, callSeq: seq });
    assert.ok(call);
    call.complete();
  }

  executor.complete(ev.evalId, { ok: true, ms: 1 });
  const settlement = await settled.promise;
  assert.deepEqual(settlement.budget, { calls: 100 });
});

test('the soft wall stops acceptance, aborts in-flight calls and rebuilds the worker', async (t) => {
  const executor = new FakeExecutor();
  executor.onCancel = (evalId) => {
    executor.complete(evalId, {
      ok: false,
      layer: 'soft',
      error: 'eval cancelled',
      stdout: 'partial output',
      ms: 5,
    });
  };
  const session = track(t, makeSession(executor, { graceMs: 1_000 }));

  const running = runEval(session, 'stuck', { timeoutMs: 30 });
  await waitFor(() => executor.pending.length === 1);
  const ev = [...session.activeEvals.values()][0];
  assert.ok(ev);
  const call = session.acceptToolCall({
    evalId: ev.evalId,
    epoch: ev.epoch,
    callSeq: 1,
    tool: 'Bash',
    args: {},
  });
  assert.ok(call);

  const settlement = await running;
  assert.equal(settlement.ok, false);
  assert.equal(settlement.outcome, 'timeout');
  assert.equal(settlement.layer, 'soft');
  assert.deepEqual(settlement.timeout, { layer: 'soft', limitMs: 30 });
  assert.equal(settlement.stdout, 'partial output');
  assert.equal(call.signal.aborted, true);
  assert.ok(call.signal.reason instanceof EvalTimeoutError);
  assert.equal(executor.cancelled.includes(ev.evalId), true);
  assert.equal(ev.accepting, false);
  assert.equal(ev.stopped, true);
  assert.equal(executor.terminateCalls.length, 1);
  assert.equal(session.inFlightEvals, 0);
});

test('the hard wall terminates the worker and settles every active eval as worker_dead', async (t) => {
  const executor = new FakeExecutor();
  executor.rejectOnTerminate = true;
  const events: EvalSessionEvent[] = [];
  let restarts = 0;
  const serve = {
    healthy: () => true,
    restart: async () => {
      restarts += 1;
    },
  };
  const session = track(
    t,
    makeSession(executor, { graceMs: 20 }, { serve, onEvent: (event) => events.push(event) }),
  );
  const firstSettlement = deferred<EvalSettlement>();
  const secondSettlement = deferred<EvalSettlement>();

  await runEval(session, 'first', {
    async: true,
    timeoutMs: 10,
    onSettled: (value) => firstSettlement.resolve(value),
  });
  const secondReceipt = await runEval(session, 'second', {
    async: true,
    timeoutMs: 60_000,
    onSettled: (value) => secondSettlement.resolve(value),
  });
  const secondEv = session.activeEvals.get(secondReceipt.evalId);
  assert.ok(secondEv);
  const secondCall = session.acceptToolCall({
    evalId: secondReceipt.evalId,
    epoch: secondEv.epoch,
    callSeq: 1,
    tool: 'Bash',
    args: {},
  });
  assert.ok(secondCall);

  const [firstResult, secondResult] = await Promise.all([firstSettlement.promise, secondSettlement.promise]);
  assert.equal(firstResult.outcome, 'worker_dead');
  assert.equal(firstResult.ok, false);
  assert.equal(secondResult.outcome, 'worker_dead');
  assert.match(secondResult.error ?? '', /terminated/);
  assert.equal(secondCall.signal.aborted, true);
  assert.ok(secondCall.signal.reason instanceof WorkerKilledError);
  assert.equal(executor.terminateCalls.length, 1);
  assert.ok(session.workerEpoch >= 2);
  assert.equal(restarts, 1); // the second eval had an accepted call in flight

  const reset = events.find(
    (event): event is Extract<EvalSessionEvent, { type: 'worker_reset' }> => event.type === 'worker_reset',
  );
  assert.ok(reset);
  assert.equal(reset.report.hadInflight, true);
  assert.deepEqual(reset.report.killedEvals.sort((a, b) => a - b), [1, 2]);
});

test('a hard wall skips the serve restart when nothing requires it', async (t) => {
  const executor = new FakeExecutor();
  const events: EvalSessionEvent[] = [];
  let restarts = 0;
  const session = track(
    t,
    makeSession(executor, { graceMs: 10 }, {
      serve: {
        healthy: () => true,
        restart: async () => {
          restarts += 1;
        },
      },
      onEvent: (event) => events.push(event),
    }),
  );
  const settled = deferred<EvalSettlement>();

  await runEval(session, 'clean', {
    async: true,
    timeoutMs: 5,
    onSettled: (value) => settled.resolve(value),
  });
  const result = await settled.promise;

  assert.equal(result.outcome, 'worker_dead');
  assert.equal(restarts, 0);
  const reset = events.find(
    (event): event is Extract<EvalSessionEvent, { type: 'worker_reset' }> => event.type === 'worker_reset',
  );
  assert.ok(reset);
  assert.equal(reset.report.needRestart, false);
  assert.equal(reset.report.terminated, true);
  assert.equal(reset.report.hadInflight, false);
  assert.equal(reset.report.serveRestarted, false);
});

test('a wedged terminate or unhealthy serve forces a restart', async (t) => {
  const executor = new FakeExecutor();
  executor.terminateResult = false;
  const events: EvalSessionEvent[] = [];
  let restarts = 0;
  const session = track(
    t,
    makeSession(executor, { graceMs: 10 }, {
      serve: {
        healthy: () => false,
        restart: async () => {
          restarts += 1;
        },
      },
      onEvent: (event) => events.push(event),
    }),
  );
  const settled = deferred<EvalSettlement>();

  await runEval(session, 'wedged', {
    async: true,
    timeoutMs: 5,
    onSettled: (value) => settled.resolve(value),
  });
  await settled.promise;

  assert.equal(restarts, 1);
  const reset = events.find(
    (event): event is Extract<EvalSessionEvent, { type: 'worker_reset' }> => event.type === 'worker_reset',
  );
  assert.ok(reset);
  assert.equal(reset.report.terminated, false);
  assert.equal(reset.report.needRestart, true);
  assert.equal(reset.report.serveRestarted, true);
});

test('settlement is idempotent and late results are ignored', async (t) => {
  const executor = new FakeExecutor();
  const session = track(t, makeSession(executor));
  let settledCalls = 0;

  const running = runEval(session, 'once', {
    timeoutMs: 60_000,
    onSettled: () => {
      settledCalls += 1;
    },
  });
  await waitFor(() => executor.pending.length === 1);
  const ev = [...session.activeEvals.values()][0];
  assert.ok(ev);

  executor.complete(ev.evalId, { ok: true, result: 'first', ms: 3 });
  const settlement = await running;
  assert.equal(settlement.result, 'first');
  assert.equal(settledCalls, 1);

  const replay = session.settleEval(ev, { ok: false, error: 'replay' });
  assert.equal(replay, settlement);
  assert.equal(replay.result, 'first');
  assert.equal(session.inFlightEvals, 0);
  assert.equal(session.activeEvals.size, 0);
  assert.equal(settledCalls, 1);
});

test('rejected dispatch does not leak an in-flight slot', async (t) => {
  const executor = new FakeExecutor();
  const session = track(t, makeSession(executor));

  await assert.rejects(
    runEval(session, 'invalid-timeout', { timeoutMs: 0 }),
    (error: unknown) => error instanceof ReplError && error.code === 'INVALID_ARGUMENT',
  );
  assert.equal(session.inFlightEvals, 0);
  assert.equal(executor.pending.length, 0);
});
