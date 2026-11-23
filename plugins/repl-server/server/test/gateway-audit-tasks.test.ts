import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { RequestIdentity, ScriptRequest } from '../src/ports.ts';

const IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'test-client/1.0',
  mcp: 'mcp_audit_tasks',
};

type AuditRecord = Record<string, unknown> & { event: string };

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition stayed false past the deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createGateway(t: TestContext, events: AuditRecord[], callTool?: ExecGatewayOptions['callTool']): ExecGateway {
  const gateway = new ExecGateway({
    callTool: callTool ?? (async () => ({ ok: true })),
    onAudit: (event) => events.push(event as AuditRecord),
  });
  t.after(async () => {
    await gateway.disposeAll();
  });
  return gateway;
}

function request(code: string): ScriptRequest {
  return { code, timeoutMs: 60_000, async: true, identity: IDENTITY, requestId: 7 };
}

/** A tool call that parks until the gateway aborts it. */
function parkedCall(): { call: ExecGatewayOptions['callTool']; arrived: () => boolean } {
  let arrived = false;
  const call: ExecGatewayOptions['callTool'] = async (_call, _workspace, _binding, signal) => {
    arrived = true;
    return await new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (signal?.aborted === true) reject(signal.reason);
    });
  };
  return { call, arrived: () => arrived };
}

test('async dispatch emits async_dispatch with evalTaskId, evalId and the task ttl', async (t) => {
  const events: AuditRecord[] = [];
  const gateway = createGateway(t, events);

  const dispatched = await gateway.dispatchScript(request('return 1;'));

  const dispatch = events.find((event) => event.event === 'async_dispatch');
  assert.ok(dispatch, `no async_dispatch in ${JSON.stringify(events.map((e) => e.event))}`);
  assert.equal(dispatch['evalTaskId'], dispatched.taskId);
  assert.equal(dispatch['evalId'], dispatched.evalId);
  assert.equal(typeof dispatch['ttlMs'], 'number');
  assert.ok((dispatch['ttlMs'] as number) > 0);
  assert.equal(dispatch['binding'], null);
  assert.equal(dispatch['mcp'], IDENTITY.mcp);
  assert.equal(dispatch['requestId'], 7);
});

test('task_cancel records both the honoured cancel and the refusal that follows it', async (t) => {
  const events: AuditRecord[] = [];
  const parked = parkedCall();
  const gateway = createGateway(t, events, parked.call);

  const dispatched = await gateway.dispatchScript(
    request(`
      await tools.Slow({});
      return 1;
    `),
  );
  await waitFor(parked.arrived);

  assert.equal(await gateway.cancelTask(IDENTITY.mcp, dispatched.taskId), true);
  const honoured = events.find(
    (event) => event.event === 'task_cancel' && event['honoured'] === true,
  );
  assert.ok(honoured, 'a working task must produce task_cancel honoured=true');
  assert.equal(honoured['evalTaskId'], dispatched.taskId);
  assert.equal(honoured['evalId'], dispatched.evalId);
  assert.equal(honoured['by'], 'client');

  // The task is cancelled now; a second request is still recorded, as a refusal.
  assert.equal(await gateway.cancelTask(IDENTITY.mcp, dispatched.taskId), false);
  const refused = events.filter(
    (event) => event.event === 'task_cancel' && event['honoured'] === false,
  );
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.['evalTaskId'], dispatched.taskId);
});

test('task_cancel on an unknown task id is audited as refused', async (t) => {
  const events: AuditRecord[] = [];
  const gateway = createGateway(t, events);

  assert.equal(await gateway.cancelTask(IDENTITY.mcp, 't_missing'), false);

  const cancelled = events.find((event) => event.event === 'task_cancel');
  assert.ok(cancelled);
  assert.equal(cancelled['evalTaskId'], 't_missing');
  assert.equal(cancelled['honoured'], false);
});
