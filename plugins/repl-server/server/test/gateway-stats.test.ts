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

  await exec.destroyOwner('mcp_test');
  assert.deepEqual(exec.stats(), { sessions: 0, inFlightEvals: 0 });
});

test('destroyOwner only removes the matching owner', async (t) => {
  const exec = gateway();
  t.after(async () => {
    await exec.disposeAll();
  });
  await exec.runScript({ code: 'return 1', timeoutMs: 5_000, async: false, identity });
  await exec.runScript({
    code: 'return 2',
    timeoutMs: 5_000,
    async: false,
    identity: { ...identity, binding: 'b_other' },
  });

  assert.equal(exec.stats().sessions, 1); // same workspace → one exec session, owner stays first
  await exec.destroyOwner('b_other');
  assert.equal(exec.stats().sessions, 1);

  await exec.destroyOwner('mcp_test');
  assert.equal(exec.stats().sessions, 0);
});
