import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { RequestIdentity, ScriptRequest } from '../src/ports.ts';

const IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'test-client/1.0',
  mcp: 'mcp_destroy',
};

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition stayed false past the deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createGateway(
  t: TestContext,
  options: Partial<ExecGatewayOptions> & { onCall?: ExecGatewayOptions['callTool'] } = {},
): ExecGateway {
  const { onCall, ...rest } = options;
  const gateway = new ExecGateway({ callTool: onCall ?? (async () => ({ ok: true })), ...rest });
  t.after(async () => {
    await gateway.disposeAll();
  });
  return gateway;
}

function request(code: string, extra: Partial<ScriptRequest> = {}): ScriptRequest {
  return { code, timeoutMs: 60_000, async: true, identity: IDENTITY, ...extra };
}

test('destroyOwner cancels in-flight evals, clears tasks and is idempotent', async (t) => {
  let arrived = false;
  let aborted = false;
  const closed: string[] = [];
  const gateway = createGateway(t, {
    onCall: async (_call, _workspace, _binding, signal) => {
      arrived = true;
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    onSessionClosed: (workspace) => {
      closed.push(workspace);
    },
  });

  const dispatched = await gateway.dispatchScript(request(`
    await tools.Slow({});
    return 'done';
  `));
  await waitFor(() => arrived);
  assert.equal(gateway.stats().inFlightEvals, 1);

  await gateway.destroyOwner(IDENTITY.mcp);
  assert.equal(aborted, true);
  assert.deepEqual(gateway.stats(), { sessions: 0, inFlightEvals: 0 });
  assert.deepEqual(closed, ['.']);

  await assert.rejects(
    gateway.waitTasks(IDENTITY.mcp, [dispatched.taskId], 1_000),
    (error: unknown) => (error as { code?: string }).code === 'UNKNOWN_TASK',
  );

  // Idempotent: a second cascade is a no-op.
  await gateway.destroyOwner(IDENTITY.mcp);
  assert.deepEqual(gateway.stats(), { sessions: 0, inFlightEvals: 0 });

  // A dispatch after the cascade starts a fresh session.
  const again = await gateway.dispatchScript(request('return 7;'));
  assert.ok(again.evalId > 0);
  const waited = (await gateway.waitTasks(IDENTITY.mcp, [again.taskId], 5_000)) as {
    events: Array<{ status: string; result?: string }>;
  };
  assert.equal(waited.events[0]?.status, 'completed');
});

test('destroyOwner drops already-consumed tasks of the session too', async (t) => {
  const gateway = createGateway(t);
  const bound = { identity: 'bound' as const, binding: 'cb_x', client: 'test', mcp: 'mcp_x' };

  const dispatched = await gateway.dispatchScript(request('return 1;', { identity: bound }));
  await gateway.waitTasks('cb_x', [dispatched.taskId], 5_000);
  assert.ok((await gateway.getTask('cb_x', dispatched.taskId)) !== null);

  await gateway.destroyOwner('mcp_x');
  assert.equal(await gateway.getTask('cb_x', dispatched.taskId), null);
});

test('destroyOwner matches a binding across MCP sessions and leaves others alone', async (t) => {
  const gateway = createGateway(t);
  const bound = { identity: 'bound' as const, binding: 'cb_work', client: 'test', mcp: 'mcp_1' };
  const other = { identity: 'bound' as const, binding: 'cb_other', client: 'test', mcp: 'mcp_1' };

  await gateway.runScript(request('return 1;', { identity: bound }));
  await gateway.runScript(request('return 2;', { identity: bound }));
  await gateway.runScript(request('return 3;', { identity: other }));
  assert.equal(gateway.stats().sessions, 2);

  await gateway.destroyOwner('cb_work');
  assert.equal(gateway.stats().sessions, 1);
  await gateway.destroyOwner('mcp_1');
  assert.equal(gateway.stats().sessions, 0);
});
