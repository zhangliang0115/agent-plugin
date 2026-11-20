import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { RequestIdentity, ScriptRequest } from '../src/ports.ts';

const IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'test-client/1.0',
  mcp: 'mcp_tools',
};

interface RecordedCall {
  tool: string;
  server?: string;
  args: Record<string, unknown>;
  signal: AbortSignal | undefined;
  deadline: number | undefined;
}

type OnCall = (
  call: { tool: string; server?: string; args: Record<string, unknown> },
  signal: AbortSignal | undefined,
  deadline: number | undefined,
) => Promise<unknown>;

function createGateway(
  t: TestContext,
  options: Partial<ExecGatewayOptions> & { onCall?: OnCall } = {},
): { gateway: ExecGateway; calls: RecordedCall[] } {
  const { onCall, ...rest } = options;
  const calls: RecordedCall[] = [];
  const gateway = new ExecGateway({
    ...rest,
    callTool: async (call, _workspace, _binding, signal, deadline) => {
      const recorded: RecordedCall = { tool: call.tool, args: call.args, signal, deadline };
      if (call.server !== undefined) recorded.server = call.server;
      calls.push(recorded);
      return onCall === undefined ? { ok: true } : await onCall(recorded, signal, deadline);
    },
  });
  t.after(async () => {
    await gateway.disposeAll();
  });
  return { gateway, calls };
}

function request(code: string, extra: Partial<ScriptRequest> = {}): ScriptRequest {
  return { code, timeoutMs: 10_000, async: false, identity: IDENTITY, ...extra };
}

test('Bash args are clamped to the eval deadline and keep the 120s default', async (t) => {
  const { gateway, calls } = createGateway(t);
  const outcome = await gateway.runScript(
    request(`const result = await tools.Bash({ command: 'echo hi' }); return result.ok;`, { timeoutMs: 5_000 }),
  );
  assert.equal(outcome.isError, false, outcome.content);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.tool, 'Bash');
  const timeout = call.args['timeout'];
  assert.equal(typeof timeout, 'number');
  // deadline - now - 500ms reserve; worker startup can only shrink the budget.
  assert.ok((timeout as number) >= 250, String(timeout));
  assert.ok((timeout as number) <= 4_500, String(timeout));
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(typeof call.deadline, 'number');
});

test('without an eval deadline Bash keeps its 120s default', async (t) => {
  const { gateway, calls } = createGateway(t);
  const base = request(`await tools.Bash({ command: 'echo hi' }); return 'done';`);
  const noDeadline: ScriptRequest = {
    code: base.code,
    async: base.async,
    identity: base.identity,
  };
  const outcome = await gateway.runScript(noDeadline);
  assert.equal(outcome.isError, false, outcome.content);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.args['timeout'], 120_000);
  assert.equal(typeof call.deadline, 'number');
});

test('a requested Bash timeout is clamped by the eval deadline', async (t) => {
  const { gateway, calls } = createGateway(t);
  const outcome = await gateway.runScript(
    request(`await tools.Bash({ command: 'sleep 600', timeout: 600_000 }); return 'done';`, {
      timeoutMs: 3_000,
    }),
  );
  assert.equal(outcome.isError, false, outcome.content);
  const timeout = calls[0]?.args['timeout'];
  assert.ok(typeof timeout === 'number' && timeout <= 2_500, String(timeout));
});

test('official tool calls obey the L1 default and reject into the script', async (t) => {
  const { gateway } = createGateway(t, {
    toolTimeouts: { officialMs: 40 },
    onCall: async () => await new Promise(() => undefined),
  });
  const started = Date.now();
  const outcome = await gateway.runScript(request(`
    try {
      await tools.Read({ path: '/tmp/a' });
      return 'no-timeout';
    } catch (error) {
      return 'caught';
    }
  `));
  assert.equal(outcome.isError, false, outcome.content);
  assert.match(outcome.content, /<result>caught<\/result>/);
  assert.ok(Date.now() - started < 5_000, 'the L1 budget must end the call, not the eval deadline');
});

test('MCP tool calls obey their own L1 default', async (t) => {
  const { gateway, calls } = createGateway(t, {
    toolTimeouts: { mcpMs: 40 },
    onCall: async () => await new Promise(() => undefined),
  });
  const outcome = await gateway.runScript(request(`
    try {
      await tools.mcp.pg.query({ sql: 'select 1' });
      return 'no-timeout';
    } catch (error) {
      return 'caught';
    }
  `));
  assert.equal(outcome.isError, false, outcome.content);
  assert.match(outcome.content, /<result>caught<\/result>/);
  assert.equal(calls[0]?.server, 'pg');
});

test('the eval deadline aborts the in-flight tool signal', async (t) => {
  const signals: AbortSignal[] = [];
  const { gateway } = createGateway(t, {
    onCall: async (_call, signal) => {
      assert.ok(signal !== undefined);
      signals.push(signal);
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });

  const outcome = await gateway.runScript(
    request(`await tools.Read({ path: '/tmp/a' }); return 'finished';`, { timeoutMs: 1_000 }),
  );

  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /<error>(eval cancelled|eval stopped at layer soft|Read timed out)/);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
});
