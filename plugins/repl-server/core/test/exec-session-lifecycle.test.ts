import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { WorkerKilledError } from '../src/errors.ts';
import {
  ExecSession,
  type EvalExecutor,
  type EvalExecutorOutcome,
  type EvalSessionEvent,
  type ExecSessionOptions,
} from '../src/eval/exec-session.ts';
import { runEval } from '../src/eval/run-eval.ts';

interface PendingEval {
  evalId: number;
  resolve: (outcome: EvalExecutorOutcome) => void;
  reject: (error: unknown) => void;
}

class FakeExecutor implements EvalExecutor {
  epoch = 1;
  readonly pending: PendingEval[] = [];
  readonly terminateCalls: Array<number | undefined> = [];
  startCalls = 0;

  async start(): Promise<{ epoch: number }> {
    this.startCalls += 1;
    return { epoch: this.epoch };
  }

  eval(_code: string, options: { evalId: number }): Promise<EvalExecutorOutcome> {
    return new Promise<EvalExecutorOutcome>((resolve, reject) => {
      this.pending.push({ evalId: options.evalId, resolve, reject });
    });
  }

  cancel(): void {}

  async terminate(timeoutMs?: number): Promise<boolean> {
    this.terminateCalls.push(timeoutMs);
    for (const call of this.pending.splice(0)) call.reject(new WorkerKilledError());
    return true;
  }

  complete(outcome: EvalExecutorOutcome): void {
    const [call] = this.pending.splice(0, 1);
    assert.ok(call, 'no eval is pending');
    call.resolve(outcome);
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition stayed false past the deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function track(t: TestContext, session: ExecSession): ExecSession {
  t.after(async () => {
    await session.dispose();
  });
  return session;
}

function makeSession(
  executor: EvalExecutor,
  options: { serve?: ExecSessionOptions['serve']; events?: EvalSessionEvent[] } = {},
): ExecSession {
  return new ExecSession({
    id: 'es_lifecycle',
    createExecutor: () => executor,
    limits: { graceMs: 20, terminateMs: 20 },
    ...(options.serve === undefined ? {} : { serve: options.serve }),
    ...(options.events === undefined ? {} : { onEvent: (event) => options.events?.push(event) }),
  });
}

test('serve hooks resolve per execution session id', async (t) => {
  const executor = new FakeExecutor();
  const resolvedIds: string[] = [];
  const restarts: string[] = [];
  let healthy = false;

  const session = track(
    t,
    makeSession(executor, {
      serve: (id) => {
        resolvedIds.push(id);
        return {
          healthy: () => healthy,
          restart: () => {
            restarts.push(id);
            healthy = true;
          },
        };
      },
    }),
  );

  assert.equal(session.serveHealthy(), false);
  assert.equal(await session.restartServe(), true);
  assert.equal(session.serveHealthy(), true);
  assert.deepEqual(resolvedIds, ['es_lifecycle', 'es_lifecycle', 'es_lifecycle']);
  assert.deepEqual(restarts, ['es_lifecycle']);
});

test('a session without a serve handle reports healthy and skips restarts', async (t) => {
  const session = track(t, makeSession(new FakeExecutor()));
  assert.equal(session.serveHealthy(), true);
  assert.equal(await session.restartServe(), false);
});

test('hibernateWorker terminates the worker but keeps the executor for the next eval', async (t) => {
  const executor = new FakeExecutor();
  const session = track(t, makeSession(executor));

  const first = runEval(session, 'return 1;', { timeoutMs: 60_000 });
  await waitFor(() => executor.pending.length === 1);
  executor.complete({ ok: true, result: 1, stdout: '', stderr: '', ms: 1, truncated: {}, contextReset: false, stateRestored: 'none' });
  const firstOutcome = await first;
  assert.equal(firstOutcome.ok, true);

  assert.equal(await session.hibernateWorker(), true);
  assert.equal(executor.terminateCalls.length, 1);
  assert.equal(session.executor, executor, 'the same executor keeps the last snapshot');
  assert.ok(session.workerEpoch >= 2, 'late worker messages from before hibernation are dropped');

  const second = runEval(session, 'return 2;', { timeoutMs: 60_000 });
  await waitFor(() => executor.pending.length === 1);
  assert.equal(executor.startCalls, 2, 'the next eval respawns through start()');
  executor.complete({ ok: true, result: 2, stdout: '', stderr: '', ms: 1, truncated: {}, contextReset: true, stateRestored: 'lastGood' });
  const secondOutcome = await second;
  assert.equal(secondOutcome.ok, true);
  assert.equal(secondOutcome.stateRestored, 'lastGood');
  assert.equal(secondOutcome.contextReset, true);
});

test('hibernateWorker is a no-op while an eval is in flight', async (t) => {
  const executor = new FakeExecutor();
  const session = track(t, makeSession(executor));

  const running = runEval(session, 'await new Promise(() => {});', { timeoutMs: 60_000 });
  await waitFor(() => executor.pending.length === 1);

  assert.equal(await session.hibernateWorker(), false);
  assert.equal(executor.terminateCalls.length, 0);
  assert.equal(session.inFlightEvals, 1);

  executor.complete({ ok: false, error: 'stopped', stdout: '', stderr: '', ms: 1, truncated: {}, contextReset: false, stateRestored: 'none' });
  await running;
});

test('updateLimits hot-applies the in-flight quota and rejects invalid values', async (t) => {
  const executor = new FakeExecutor();
  const session = track(t, makeSession(executor));

  session.updateLimits({ inFlightLimit: 2 });
  assert.equal(session.limits.inFlightLimit, 2);
  const first = await session.beginEval({ async: true, timeoutMs: 60_000 });
  const second = await session.beginEval({ async: true, timeoutMs: 60_000 });
  await assert.rejects(
    session.beginEval({ async: true, timeoutMs: 60_000 }),
    (error: unknown) => (error as { code?: string }).code === 'CAPACITY_EXCEEDED',
  );

  session.settleEval(first, { ok: true });
  session.settleEval(second, { ok: true });
  assert.throws(() => session.updateLimits({ inFlightLimit: 0 }), RangeError);
});
