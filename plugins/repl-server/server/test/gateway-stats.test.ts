import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecGateway, STUCK_EVAL_WARN_MS, stuckEvalOf, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { InFlightEvalView } from '../src/ports.ts';

const identity = { identity: 'unbound' as const, binding: null, client: 'test', mcp: 'mcp_test' };

function gateway(): ExecGateway {
  return new ExecGateway({ callTool: async () => 1 });
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition stayed false past the deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A tool call that parks until the gateway aborts it; no long worker timer. */
function hangingTool(): ExecGatewayOptions['callTool'] {
  return async (_call, _workspace, _binding, signal) =>
    await new Promise((_resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

function evalView(evalId: number, startedAt: number, now: number): InFlightEvalView {
  return {
    exec: 'es_1',
    evalId,
    binding: null,
    workspace: '.',
    async: true,
    startedAt,
    ageMs: now - startedAt,
  };
}

test('stats report exec sessions and in-flight evals', async (t) => {
  const exec = gateway();
  t.after(async () => {
    await exec.disposeAll();
  });

  assert.deepEqual(exec.stats(), { sessions: 0, inFlightEvals: 0 });

  const dispatched = await exec.dispatchScript({
    code: 'await new Promise((resolve) => setTimeout(resolve, 150)); return 1',
    timeoutMs: 60_000,
    async: true,
    identity,
  });

  assert.equal(exec.stats().sessions, 1);

  // The async run registers its eval on a later turn; poll briefly.
  const deadline = Date.now() + 2_000;
  while (exec.stats().inFlightEvals !== 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(exec.stats().inFlightEvals, 1);

  const settled = await exec.waitTasks('mcp_test', [dispatched.taskId], 5_000);
  assert.equal((settled as { ok: boolean }).ok, true);
  assert.equal(exec.stats().inFlightEvals, 0);

  await exec.destroyTransport('mcp_test');
  assert.deepEqual(exec.stats(), { sessions: 0, inFlightEvals: 0 });
});

test('bindingStats groups live sessions and in-flight evals by binding', async (t) => {
  const exec = gateway();
  t.after(async () => {
    await exec.disposeAll();
  });

  await exec.dispatchScript({
    code: 'await new Promise((resolve) => setTimeout(resolve, 60_000)); return 1',
    timeoutMs: 120_000,
    async: true,
    identity,
  });
  await exec.runScript({
    code: 'return 2',
    timeoutMs: 5_000,
    async: false,
    identity: { ...identity, identity: 'bound', binding: 'b_a' },
  });

  const deadline = Date.now() + 2_000;
  while ((exec.bindingStats()[0]?.inFlightEvals ?? 0) !== 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(exec.bindingStats(), [
    { binding: null, execSessions: 1, inFlightEvals: 1 },
    { binding: 'b_a', execSessions: 1, inFlightEvals: 0 },
  ]);
});

test('destroyOwner and destroyTransport only remove their own scope', async (t) => {
  const exec = gateway();
  t.after(async () => {
    await exec.disposeAll();
  });
  await exec.runScript({ code: 'return 1', timeoutMs: 5_000, async: false, identity });
  await exec.runScript({
    code: 'return 2',
    timeoutMs: 5_000,
    async: false,
    identity: { ...identity, identity: 'bound', binding: 'b_other' },
  });

  // The exec-session key includes the binding, so one MCP session using two
  // identities owns two isolated JS contexts.
  assert.equal(exec.stats().sessions, 2);
  await exec.destroyOwner('b_other');
  assert.equal(exec.stats().sessions, 1);

  await exec.destroyTransport('mcp_test');
  assert.equal(exec.stats().sessions, 0);
});

test('inFlightEvals lists the oldest eval first and cancelEval aborts only it', async (t) => {
  const exec = new ExecGateway({ callTool: hangingTool() });
  t.after(async () => {
    await exec.disposeAll();
  });
  const code = 'await tools.Hang({}); return 1';

  const first = await exec.dispatchScript({
    code,
    timeoutMs: 120_000,
    async: true,
    identity,
  });
  await waitFor(() => exec.inFlightEvals().total === 1);
  const firstExec = exec.inFlightEvals().items[0]?.exec;
  assert.ok(firstExec !== undefined);

  const second = await exec.dispatchScript({
    code,
    timeoutMs: 120_000,
    async: true,
    identity: { ...identity, identity: 'bound', binding: 'b_a' },
  });
  await waitFor(() => exec.inFlightEvals().total === 2);

  const truncated = exec.inFlightEvals(1);
  assert.equal(truncated.total, 2);
  assert.equal(truncated.items.length, 1);
  assert.equal(truncated.items[0]?.exec, firstExec);
  assert.equal(truncated.items[0]?.evalId, first.evalId);
  assert.equal(truncated.items[0]?.binding, null);
  assert.equal(truncated.items[0]?.workspace, '.');
  assert.equal(truncated.items[0]?.async, true);
  assert.equal(truncated.items[0]?.timeoutMs, 120_000);
  assert.ok((truncated.items[0]?.ageMs ?? -1) >= 0);

  const ordered = exec.inFlightEvals().items;
  assert.deepEqual(
    ordered.map((item) => item.evalId),
    [first.evalId, second.evalId],
    'items are oldest first',
  );
  const newest = ordered[1];
  assert.ok(newest !== undefined);
  assert.equal(newest.binding, 'b_a');

  assert.equal(await exec.cancelEval('es_missing', 1), false);
  assert.equal(await exec.cancelEval(firstExec, first.evalId), true);
  await waitFor(() => exec.inFlightEvals().total === 1);
  assert.equal(exec.inFlightEvals().items[0]?.exec, newest.exec);

  assert.equal(await exec.cancelEval(newest.exec, newest.evalId), true);
  await waitFor(() => exec.inFlightEvals().total === 0);
  await exec.waitTasks(identity.mcp, [first.taskId], 5_000);
  await exec.waitTasks('b_a', [second.taskId], 5_000);
});

test('cancelEval force-stops a pure-JS stuck eval within the grace', async (t) => {
  const exec = new ExecGateway({ callTool: async () => 1 });
  t.after(async () => {
    await exec.disposeAll();
  });
  const dispatched = await exec.dispatchScript({
    code: 'await new Promise(() => {}); return 1',
    timeoutMs: 120_000,
    async: true,
    identity,
  });
  await waitFor(() => exec.inFlightEvals().total === 1);
  const item = exec.inFlightEvals().items[0];
  assert.ok(item !== undefined);

  const started = Date.now();
  assert.equal(await exec.cancelEval(item.exec, item.evalId), true);
  assert.ok(Date.now() - started < 3_000, 'forced cancel finishes inside 3s');
  assert.equal(exec.inFlightEvals().total, 0, 'the eval leaves the in-flight list');

  const waited = (await exec.waitTasks(identity.mcp, [dispatched.taskId], 5_000)) as {
    events: Array<{ status: string }>;
  };
  assert.equal(waited.events[0]?.status, 'failed', 'worker_dead settles as a failed task');
});

test('stuckEvalOf returns only the oldest eval past the threshold', () => {
  const now = 10_000_000;
  assert.equal(stuckEvalOf([]), null, 'no eval means no warning');
  assert.equal(
    stuckEvalOf([evalView(1, now - 29 * 60_000, now)]),
    null,
    'one minute below the 30-minute threshold stays quiet',
  );
  assert.equal(stuckEvalOf([evalView(1, now - 31 * 60_000, now)])?.evalId, 1);
  assert.equal(
    stuckEvalOf([
      evalView(1, now - 1_000, now),
      evalView(2, now - 40 * 60_000, now),
      evalView(3, now - 10 * 60_000, now),
    ])?.evalId,
    2,
    'the oldest eval decides, regardless of array order',
  );
});
