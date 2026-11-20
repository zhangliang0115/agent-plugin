import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecGateway } from '../src/exec/gateway.ts';

const identity = { identity: 'unbound' as const, binding: null, client: 'test', mcp: 'mcp_test' };

function gateway(): ExecGateway {
  return new ExecGateway({ callTool: async () => 1 });
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
