import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { McpToolError } from '@zhangliang0115/repl-server-core';

import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { Catalog, CatalogTool, RequestIdentity, ScriptRequest } from '../src/ports.ts';

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
  assert.match(
    outcome.content,
    /<error>eval exceeded the 1000ms timeout set by the caller \(not an MCP server failure\)/,
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
});

const SEARCH_TOOL: CatalogTool = {
  name: 'sentry.search_issues',
  kind: 'mcp',
  server: 'sentry',
  inputSchema: {
    type: 'object',
    properties: {
      project_slug_or_id: { type: 'string' },
      query: { type: 'string' },
    },
    required: ['project_slug_or_id'],
  },
  concurrency: 'parallel',
  enabled: true,
};

function catalogWith(inputSchema: unknown): Catalog {
  return {
    snapshot: () => ({ revision: 1, tools: [{ ...SEARCH_TOOL, inputSchema }] }),
  };
}

/** The shape seen in the 24h logs: the model guessed `organizationSlug`. */
const ARGUMENT_ERROR =
  '1 validation error for call[search_issues]\norganizationSlug\n  Unexpected keyword argument';

const CALL_SEARCH = `
  try {
    await tools.mcp.sentry.search_issues({ organizationSlug: 'x' });
    return 'no-error';
  } catch (error) {
    return error.message;
  }
`;

test('an argument-shape MCP failure appends the catalog fields once', async (t) => {
  const { gateway } = createGateway(t, {
    catalog: catalogWith(SEARCH_TOOL.inputSchema),
    onCall: async () => {
      throw new McpToolError(ARGUMENT_ERROR, { server: 'sentry', tool: 'search_issues' });
    },
  });
  const outcome = await gateway.runScript(request(CALL_SEARCH));
  assert.equal(outcome.isError, false, outcome.content);
  assert.ok(outcome.content.includes(ARGUMENT_ERROR), 'the original message must stay');
  const hint =
    '[repl-server] expected arguments for sentry.search_issues: ' +
    'required: project_slug_or_id; available: project_slug_or_id, query';
  assert.ok(outcome.content.includes(hint), outcome.content);
  assert.equal(outcome.content.split(hint).length, 2, 'the hint must be appended once');
});

test('a non-argument MCP failure is left untouched', async (t) => {
  const { gateway } = createGateway(t, {
    catalog: catalogWith(SEARCH_TOOL.inputSchema),
    onCall: async () => {
      throw new McpToolError('sentry.search_issues timed out after 60000ms', {
        code: 'MCP_CALL_TIMEOUT',
        server: 'sentry',
        tool: 'search_issues',
      });
    },
  });
  const outcome = await gateway.runScript(request(CALL_SEARCH));
  assert.equal(outcome.isError, false, outcome.content);
  assert.ok(outcome.content.includes('timed out after 60000ms'));
  assert.ok(!outcome.content.includes('[repl-server] expected arguments for'), outcome.content);
});

test('an argument-shape MCP failure without a schema appends nothing', async (t) => {
  const { gateway } = createGateway(t, {
    catalog: catalogWith({ type: 'object' }),
    onCall: async () => {
      throw new McpToolError(ARGUMENT_ERROR, { server: 'sentry', tool: 'search_issues' });
    },
  });
  const outcome = await gateway.runScript(request(CALL_SEARCH));
  assert.equal(outcome.isError, false, outcome.content);
  assert.ok(outcome.content.includes(ARGUMENT_ERROR));
  assert.ok(!outcome.content.includes('[repl-server] expected arguments for'), outcome.content);
});
