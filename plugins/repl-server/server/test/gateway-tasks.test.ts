import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { TaskStore } from '@zhangliang0115/repl-server-core';

import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { RequestIdentity, ScriptRequest } from '../src/ports.ts';

const IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'test-client/1.0',
  mcp: 'mcp_tasks',
};

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition stayed false past the deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createGateway(t: TestContext, options: Partial<ExecGatewayOptions> = {}): ExecGateway {
  const gateway = new ExecGateway({ callTool: async () => ({ ok: true }), ...options });
  t.after(async () => {
    await gateway.disposeAll();
  });
  return gateway;
}

function request(code: string, extra: Partial<ScriptRequest> = {}): ScriptRequest {
  return { code, timeoutMs: 60_000, async: true, identity: IDENTITY, ...extra };
}

/** A tool call that parks until the gateway aborts it or the test releases it. */
function parkedCall(): {
  call: ExecGatewayOptions['callTool'];
  arrived: () => boolean;
  signal: () => AbortSignal | undefined;
  release: () => void;
} {
  let arrived = false;
  let signal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const call: ExecGatewayOptions['callTool'] = async (_call, _workspace, _binding, callSignal) => {
    arrived = true;
    signal = callSignal;
    return await new Promise((resolve, reject) => {
      release = () => resolve({ ok: true });
      callSignal?.addEventListener('abort', () => reject(callSignal.reason), { once: true });
      if (callSignal?.aborted === true) reject(callSignal.reason);
    });
  };
  return {
    call,
    arrived: () => arrived,
    signal: () => signal,
    release: () => release?.(),
  };
}

type WaitResult = {
  ok: boolean;
  timedOut: boolean;
  pending: number;
  events: Array<{ taskId: string; evalId: number; status: string; result?: string }>;
};

test('wait_tasks rejects unknown and foreign ids with UNKNOWN_TASK + unknownIds', async (t) => {
  const gateway = createGateway(t);
  const dispatched = await gateway.dispatchScript(request('return 1;'));

  await assert.rejects(
    gateway.waitTasks(IDENTITY.mcp, ['t_missing'], 1_000),
    (error: unknown) =>
      (error as { code?: string }).code === 'UNKNOWN_TASK' &&
      JSON.stringify((error as { unknownIds?: string[] }).unknownIds) === JSON.stringify(['t_missing']),
  );

  await assert.rejects(
    gateway.waitTasks('mcp_other', [dispatched.taskId], 1_000),
    (error: unknown) => (error as { code?: string }).code === 'UNKNOWN_TASK',
  );
});

/** Design 02 §4.4: owner is binding-scoped, so a second workspace stays resolvable. */
test('a bound client consumes tasks across workspaces of the same binding', async (t) => {
  const dirA = await mkdtemp(join(tmpdir(), 'repl-ws-a-'));
  const dirB = await mkdtemp(join(tmpdir(), 'repl-ws-b-'));
  t.after(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  const gateway = createGateway(t);
  const identityA: RequestIdentity = {
    identity: 'bound',
    binding: 'cb_ws',
    client: 'test-client/1.0',
    mcp: 'mcp_ws_a',
  };
  const identityB: RequestIdentity = { ...identityA, mcp: 'mcp_ws_b' };

  const inA = await gateway.dispatchScript(request('return "a";', { identity: identityA, workspace: dirA }));
  const inB = await gateway.dispatchScript(request('return "b";', { identity: identityB, workspace: dirB }));

  // A different binding stays isolated; check it before anything is consumed.
  await assert.rejects(
    gateway.waitTasks('cb_other', [inA.taskId], 1_000),
    (error: unknown) => (error as { code?: string }).code === 'UNKNOWN_TASK',
  );

  const waited = (await gateway.waitTasks('cb_ws', [inA.taskId, inB.taskId], 5_000)) as WaitResult;
  assert.equal(waited.ok, true);
  assert.deepEqual(
    waited.events.map((event) => event.taskId),
    [inA.taskId, inB.taskId],
  );
  assert.deepEqual(
    waited.events.map((event) => event.status),
    ['completed', 'completed'],
  );
});

test('a result is consumed exactly once and a second read is ALREADY_CONSUMED', async (t) => {
  const gateway = createGateway(t);
  const dispatched = await gateway.dispatchScript(request('return 41 + 1;'));

  const first = (await gateway.waitTasks(IDENTITY.mcp, [dispatched.taskId], 5_000)) as WaitResult;
  assert.equal(first.ok, true);
  assert.equal(first.pending, 0);
  assert.equal(first.events[0]?.status, 'completed');
  assert.match(first.events[0]?.result ?? '', /<result>42<\/result>/);

  await assert.rejects(
    gateway.waitTasks(IDENTITY.mcp, [dispatched.taskId], 1_000),
    (error: unknown) => (error as { code?: string }).code === 'ALREADY_CONSUMED',
  );
});

test('an expired task reports TASK_EXPIRED', async (t) => {
  let now = 1_000_000;
  const parked = parkedCall();
  const gateway = createGateway(t, {
    now: () => now,
    callTool: parked.call,
    taskStore: new TaskStore({ clock: { now: () => now }, ttlMs: 1_000 }),
  });
  const dispatched = await gateway.dispatchScript(request(`
    await tools.Slow({});
    return 1;
  `));
  await waitFor(parked.arrived);
  now += 2_000;

  await assert.rejects(
    gateway.waitTasks(IDENTITY.mcp, [dispatched.taskId], 1_000),
    (error: unknown) => (error as { code?: string }).code === 'TASK_EXPIRED',
  );
});

test('wait with explicit ids counts working tasks in pending and times out', async (t) => {
  const parked = parkedCall();
  const gateway = createGateway(t, { callTool: parked.call });

  const fast = await gateway.dispatchScript(request('return "fast";'));
  const slow = await gateway.dispatchScript(request(`
    await tools.Slow({});
    return "slow";
  `));
  await waitFor(parked.arrived);

  const waited = (await gateway.waitTasks(
    IDENTITY.mcp,
    [fast.taskId, slow.taskId],
    100,
  )) as WaitResult;
  assert.equal(waited.ok, true);
  assert.equal(waited.timedOut, true);
  assert.equal(waited.pending, 1);
  assert.deepEqual(waited.events.map((event) => event.taskId), [fast.taskId]);
  assert.equal(waited.events[0]?.status, 'completed');

  // The completed result was consumed by the call above; the working one is
  // still queued. Release it and collect the rest.
  parked.release();
  const finished = (await gateway.waitTasks(IDENTITY.mcp, [slow.taskId], 5_000)) as WaitResult;
  assert.equal(finished.timedOut, false);
  assert.equal(finished.pending, 0);
  assert.deepEqual(finished.events.map((event) => event.taskId), [slow.taskId]);
});

test('tasks/cancel aborts the in-flight script and cancelled is not overwritten', async (t) => {
  const parked = parkedCall();
  const gateway = createGateway(t, { callTool: parked.call });
  const dispatched = await gateway.dispatchScript(request(`
    let outcome = 'completed';
    try {
      await tools.Slow({});
    } catch (error) {
      outcome = 'aborted';
    }
    return outcome;
  `));
  await waitFor(parked.arrived);

  assert.equal(await gateway.cancelTask(IDENTITY.mcp, dispatched.taskId), true);
  assert.equal(await gateway.cancelTask(IDENTITY.mcp, dispatched.taskId), false);

  const waited = (await gateway.waitTasks(IDENTITY.mcp, [dispatched.taskId], 5_000)) as WaitResult;
  assert.equal(waited.events[0]?.status, 'cancelled');
});

test('cancelTask leaves an unknown or foreign task alone', async (t) => {
  const gateway = createGateway(t);
  const dispatched = await gateway.dispatchScript(request('return 1;'));
  assert.equal(await gateway.cancelTask('mcp_other', dispatched.taskId), false);
  assert.equal(await gateway.cancelTask(IDENTITY.mcp, 't_missing'), false);
});

test('the async dispatch receipt carries the real evalId', async (t) => {
  const gateway = createGateway(t);
  const first = await gateway.dispatchScript(request('return 1;'));
  const second = await gateway.dispatchScript(request('return 2;'));
  assert.ok(first.evalId > 0);
  assert.ok(second.evalId > first.evalId);

  const waited = (await gateway.waitTasks(
    IDENTITY.mcp,
    [first.taskId, second.taskId],
    5_000,
  )) as WaitResult;
  const events = new Map(waited.events.map((event) => [event.taskId, event]));
  assert.equal(events.get(first.taskId)?.evalId, first.evalId);
  assert.equal(events.get(second.taskId)?.evalId, second.evalId);
});

const BIG_STATE = 'state.blob = "x".repeat(2 * 1024 * 1024); return "done";';

test('sync run fails when state exceeds 1 MiB, normal state still succeeds', async (t) => {
  const gateway = createGateway(t);
  const big = await gateway.runScript(request(BIG_STATE, { async: false }));
  assert.equal(big.isError, true);
  assert.match(big.content, /<error>[^<]*state[^<]*1 MiB/);

  // The oversized state stays live in that worker, so the control uses a fresh gateway.
  const ok = await createGateway(t).runScript(request('state.n = 1; return "ok";', { async: false }));
  assert.equal(ok.isError, false);
});

test('async task fails when state exceeds 1 MiB', async (t) => {
  const gateway = createGateway(t);
  const dispatched = await gateway.dispatchScript(request(BIG_STATE));
  const waited = (await gateway.waitTasks(IDENTITY.mcp, [dispatched.taskId], 10_000)) as WaitResult;
  assert.equal(waited.events[0]?.status, 'failed');
  assert.match(waited.events[0]?.result ?? '', /<error>[^<]*state[^<]*1 MiB/);
});
