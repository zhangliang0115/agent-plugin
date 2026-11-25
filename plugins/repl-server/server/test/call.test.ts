import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  Catalog,
  CatalogSnapshot,
  CatalogTool,
  ExecutionGateway,
  RequestIdentity,
  ScriptOutcome,
  ScriptRequest,
  TaskSnapshot,
} from '../src/ports.ts';
import { callTool, UnknownToolError, type ToolCallContext, type ToolCallResponse } from '../src/tools/call.ts';
import {
  buildSearchToolsDefinition,
  type CallToolResult,
  type ToolDefinition,
} from '../src/tools/registry.ts';
import type { ToolVisibility } from '../src/tools/search.ts';
import {
  isCreateTaskResult,
  McpTaskStore,
  TASK_TTL_MS,
  type CreateTaskResult,
} from '../src/tasks/mcp-tasks.ts';

const IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'test-client/1.0',
  mcp: 'mcp_1',
};

const BOUND_IDENTITY: RequestIdentity = {
  identity: 'bound',
  binding: 'cb_1',
  client: 'test-client/1.0',
  mcp: 'mcp_1',
};

const TOOLS: CatalogTool[] = [
  {
    name: 'Read',
    kind: 'builtin',
    description: 'Read a file',
    tags: ['files'],
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } },
    concurrency: 'parallel',
    enabled: true,
  },
  {
    name: 'pg.query',
    kind: 'mcp',
    server: 'pg',
    description: 'Run a SQL query',
    tags: ['db', 'read'],
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    concurrency: 'parallel',
    enabled: true,
  },
];

class FakeCatalog implements Catalog {
  calls = 0;
  private readonly tools: readonly CatalogTool[];

  constructor(tools: readonly CatalogTool[]) {
    this.tools = tools;
  }

  snapshot(): CatalogSnapshot {
    this.calls += 1;
    return { revision: 1, tools: this.tools };
  }
}

class FakeGateway implements ExecutionGateway {
  readonly runCalls: ScriptRequest[] = [];
  readonly dispatchCalls: ScriptRequest[] = [];
  readonly waitCalls: Array<{ owner: string; taskIds: string[]; timeoutMs: number }> = [];
  runOutcome: ScriptOutcome = {
    content: '<repl-output eval="1"><result>ok</result></repl-output>',
    isError: false,
  };
  runError: unknown = null;
  dispatchError: unknown = null;
  dispatched: { taskId: string; evalId: number; runId: string } = {
    taskId: 'ev_1',
    evalId: 7,
    runId: 'run_1',
  };
  waitResult: unknown = { ok: true, timedOut: false, events: [], pending: 0 };
  waitError: unknown = null;

  async runScript(request: ScriptRequest): Promise<ScriptOutcome> {
    this.runCalls.push(request);
    if (this.runError !== null) throw this.runError;
    return this.runOutcome;
  }

  async dispatchScript(request: ScriptRequest): Promise<{ taskId: string; evalId: number; runId: string }> {
    this.dispatchCalls.push(request);
    if (this.dispatchError !== null) throw this.dispatchError;
    return this.dispatched;
  }

  async waitTasks(owner: string, taskIds: string[], timeoutMs: number): Promise<unknown> {
    this.waitCalls.push({ owner, taskIds, timeoutMs });
    if (this.waitError !== null) throw this.waitError;
    return this.waitResult;
  }

  async getTask(): Promise<TaskSnapshot | null> {
    return null;
  }

  async cancelTask(): Promise<boolean> {
    return true;
  }

  async destroyOwner(): Promise<void> {}
  async destroyTransport(): Promise<void> {}
}

interface Harness {
  ctx: ToolCallContext;
  gateway: FakeGateway;
  catalog: FakeCatalog;
  tasks: McpTaskStore;
}

function harness(
  options: {
    identity?: RequestIdentity;
    tasksDeclared?: boolean;
    visibility?: ToolVisibility;
    searchToolsDefinition?: ToolDefinition;
  } = {},
): Harness {
  let nextTask = 0;
  const gateway = new FakeGateway();
  const catalog = new FakeCatalog(TOOLS);
  const tasks = new McpTaskStore({
    clock: { now: () => Date.UTC(2026, 10, 18, 6, 0, 0) },
    idFactory: () => `t_${(nextTask += 1)}`,
  });
  const ctx: ToolCallContext = {
    identity: options.identity ?? IDENTITY,
    gateway,
    catalog,
    tasks,
  };
  if (options.tasksDeclared !== undefined) ctx.tasksDeclared = options.tasksDeclared;
  if (options.visibility !== undefined) ctx.visibility = options.visibility;
  if (options.searchToolsDefinition !== undefined) {
    ctx.searchToolsDefinition = options.searchToolsDefinition;
  }
  return { ctx, gateway, catalog, tasks };
}

function asCallResult(result: ToolCallResponse): CallToolResult {
  assert.equal(isCreateTaskResult(result), false, 'expected a CallToolResult');
  return result as CallToolResult;
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  assert.ok(block !== undefined);
  assert.equal(block.type, 'text');
  if (block.type !== 'text') throw new Error('unreachable');
  return block.text;
}

function parseText(result: CallToolResult): unknown {
  return JSON.parse(textOf(result));
}

test('tools/call run_script runs synchronously by default and keeps media outside the XML', async () => {
  const h = harness();
  h.gateway.runOutcome = {
    content: '<repl-output eval="1"><result>ok</result></repl-output>',
    isError: false,
    images: [{ base64: 'aW1n', mediaType: 'image/png' }],
    documents: [{ base64: 'cGRm' }],
  };

  const result = asCallResult(await callTool('run_script', { code: 'return 1' }, h.ctx));
  assert.equal(result.isError, false);
  assert.equal(result.resultType, 'complete');
  assert.equal(textOf(result), '<repl-output eval="1"><result>ok</result></repl-output>');
  assert.doesNotMatch(textOf(result), /aW1n|cGRm/);
  assert.deepEqual(result.content[1], { type: 'image', data: 'aW1n', mimeType: 'image/png' });
  assert.deepEqual(result.content[2], {
    type: 'resource',
    resource: { uri: 'repl://document/0', mimeType: 'application/pdf', blob: 'cGRm' },
  });

  assert.equal(h.gateway.runCalls.length, 1);
  assert.equal(h.gateway.dispatchCalls.length, 0);
  const request = h.gateway.runCalls[0];
  assert.ok(request !== undefined);
  assert.equal(request.code, 'return 1');
  assert.equal(request.timeoutMs, undefined);
  assert.equal(request.async, false);
  assert.equal(request.identity, IDENTITY);
});

test('run_script forwards workspace, visibleTools, excludeTags and the requested timeout', async () => {
  const h = harness();
  await callTool(
    'run_script',
    {
      code: 'x',
      timeout: 2000,
      workspace: '/repo',
      visibleTools: ['Read', 'pg.query'],
      excludeTags: ['destructive'],
    },
    h.ctx,
  );
  const request = h.gateway.runCalls[0];
  assert.ok(request !== undefined);
  assert.equal(request.timeoutMs, 2000);
  assert.equal(request.workspace, '/repo');
  assert.deepEqual(request.visibleTools, ['Read', 'pg.query']);
  assert.deepEqual(request.excludeTags, ['destructive']);
});

test('sync timeouts are not capped', async () => {
  const h = harness();
  const result = asCallResult(await callTool('run_script', { code: 'x', timeout: 600_001 }, h.ctx));
  assert.equal(result.isError, false);
  assert.equal(h.gateway.runCalls[0]?.timeoutMs, 600_001);
});

test('argument validation failures are tool-layer errors', async () => {
  const h = harness();
  const missing = asCallResult(await callTool('run_script', {}, h.ctx));
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /<error>INVALID_ARGUMENT: exactly one of code or scriptName is required/);

  const extra = asCallResult(await callTool('run_script', { code: 'x', nope: 1 }, h.ctx));
  assert.equal(extra.isError, true);
  assert.match(textOf(extra), /does not accept the argument/);

  const badTimeout = asCallResult(await callTool('run_script', { code: 'x', timeout: 0 }, h.ctx));
  assert.equal(badTimeout.isError, true);
  assert.match(textOf(badTimeout), /timeout must be &gt;= 1/);
  assert.equal(h.gateway.runCalls.length, 0);
});

test('async: true always returns a normal result with an evalTaskId', async () => {
  const h = harness({ tasksDeclared: true });
  h.gateway.dispatched = { taskId: 'ev_42', evalId: 12, runId: 'run_42' };

  const result = asCallResult(
    await callTool('run_script', { code: 'x', async: true, timeout: 5000 }, h.ctx),
  );
  assert.deepEqual(result, {
    resultType: 'complete',
    content: [
      {
        type: 'text',
        text: '<repl-output eval="12" run="run_42" async="true" task="ev_42"></repl-output>',
      },
    ],
    isError: false,
  });
  assert.equal(h.gateway.runCalls.length, 0);
  assert.equal(h.gateway.dispatchCalls.length, 1);
  const request = h.gateway.dispatchCalls[0];
  assert.ok(request !== undefined);
  assert.equal(request.timeoutMs, 5000);
  assert.equal(request.async, true);
  assert.equal(h.tasks.size, 0, 'async: true never creates an MCP task');
});

test('async: true without timeout has no deadline', async () => {
  const h = harness();
  await callTool('run_script', { code: 'x', async: true }, h.ctx);
  assert.equal(h.gateway.dispatchCalls[0]?.timeoutMs, undefined);
});

test('a declaring client gets a CreateTaskResult above 30000 ms', async () => {
  const h = harness({ tasksDeclared: true });
  h.gateway.dispatched = { taskId: 'ev_9', evalId: 4, runId: 'run_9' };

  const result = await callTool('run_script', { code: 'x', timeout: 35_000 }, h.ctx);
  assert.equal(isCreateTaskResult(result), true);
  const created = result as CreateTaskResult;
  assert.deepEqual(created, {
    resultType: 'task',
    taskId: 't_1',
    status: 'working',
    createdAt: '2026-11-18T06:00:00.000Z',
    lastUpdatedAt: '2026-11-18T06:00:00.000Z',
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: 500,
  });
  assert.equal(h.gateway.dispatchCalls.length, 1);
  const request = h.gateway.dispatchCalls[0];
  assert.ok(request !== undefined);
  assert.equal(request.timeoutMs, 35_000);
  assert.equal(request.async, true);
  assert.equal(h.tasks.resolve('mcp_1', created.taskId).evalTaskId, 'ev_9');
});

test('the task decision follows the frozen table boundaries', async () => {
  const declaring = harness({ tasksDeclared: true });
  const atBoundary = asCallResult(
    await callTool('run_script', { code: 'x', timeout: 30_000 }, declaring.ctx),
  );
  assert.equal(atBoundary.isError, false);
  assert.equal(declaring.gateway.runCalls.length, 1);
  assert.equal(declaring.gateway.dispatchCalls.length, 0);

  const explicitFalse = harness({ tasksDeclared: true });
  const task = await callTool(
    'run_script',
    { code: 'x', timeout: 35_000, async: false },
    explicitFalse.ctx,
  );
  assert.equal(isCreateTaskResult(task), true);

  const headless = harness({ tasksDeclared: false });
  const sync = asCallResult(
    await callTool('run_script', { code: 'x', timeout: 35_000 }, headless.ctx),
  );
  assert.equal(sync.isError, false);
  assert.equal(headless.gateway.runCalls.length, 1);
  assert.equal(headless.gateway.dispatchCalls.length, 0);
});

test('long timeouts are accepted for every client', async () => {
  const declaring = harness({ tasksDeclared: true });
  const result = await callTool('run_script', { code: 'x', timeout: 700_000 }, declaring.ctx);
  assert.equal(isCreateTaskResult(result), true);
  assert.equal(declaring.gateway.dispatchCalls[0]?.timeoutMs, 700_000);

  const syncOnly = harness({ tasksDeclared: false });
  const sync = asCallResult(await callTool('run_script', { code: 'x', timeout: 700_000 }, syncOnly.ctx));
  assert.equal(sync.isError, false);
  assert.equal(syncOnly.gateway.runCalls[0]?.timeoutMs, 700_000);
});

test('gateway failures become <repl-output><error> results', async () => {
  const h = harness();
  h.gateway.runError = Object.assign(new Error('workspace is not a directory'), {
    code: 'WS_INVALID',
  });
  const sync = asCallResult(await callTool('run_script', { code: 'x' }, h.ctx));
  assert.equal(sync.isError, true);
  assert.match(textOf(sync), /<error>WS_INVALID: workspace is not a directory<\/error>/);

  const dispatched = harness();
  dispatched.gateway.dispatchError = Object.assign(new Error('full'), { code: 'CAPACITY_EXCEEDED' });
  const async = asCallResult(await callTool('run_script', { code: 'x', async: true }, dispatched.ctx));
  assert.equal(async.isError, true);
  assert.match(textOf(async), /<error>CAPACITY_EXCEEDED: full<\/error>/);
});

test('search_tools returns JSON items from the catalog snapshot', async () => {
  const h = harness();
  const result = asCallResult(await callTool('search_tools', { query: 'query' }, h.ctx));
  assert.equal(result.isError, false);
  assert.deepEqual(parseText(result), [
    {
      name: 'pg.query',
      kind: 'mcp',
      server: 'pg',
      description: 'Run a SQL query',
      tags: ['db', 'read'],
    },
  ]);
  assert.equal(h.catalog.calls, 1);

  const overview = asCallResult(await callTool('search_tools', {}, h.ctx));
  const items = parseText(overview) as Array<{ name: string }>;
  assert.deepEqual(items.map((item) => item.name), ['__official__', 'pg']);
});

test('omitted arguments are treated as an empty object', async () => {
  const h = harness();
  const result = asCallResult(await callTool('search_tools', undefined, h.ctx));
  assert.equal(result.isError, false);
  const items = parseText(result) as Array<{ name: string }>;
  assert.deepEqual(items.map((item) => item.name), ['__official__', 'pg']);
});

test('search_tools and describe_tools report validation failures as isError JSON', async () => {
  const h = harness();
  const search = asCallResult(await callTool('search_tools', { max: 0 }, h.ctx));
  assert.equal(search.isError, true);
  assert.deepEqual(parseText(search), {
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message: 'search_tools.max must be >= 1' },
  });

  const describe = asCallResult(await callTool('describe_tools', { names: [] }, h.ctx));
  assert.equal(describe.isError, true);
  assert.equal((parseText(describe) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');
  assert.equal(h.catalog.calls, 0);
});

test('describe_tools returns known schemas and reports unknown names without failing', async () => {
  const h = harness();
  const result = asCallResult(
    await callTool('describe_tools', { names: ['Read', 'pg.query', 'missing'] }, h.ctx),
  );
  assert.equal(result.isError, false);
  const parsed = parseText(result) as {
    tools: Array<{ name: string }>;
    unknown: string[];
  };
  assert.deepEqual(parsed.tools.map((tool) => tool.name), ['Read', 'pg.query']);
  assert.deepEqual(parsed.unknown, ['missing']);
});

test('describe_tools rejects more than ten names at validation', async () => {
  const h = harness();
  const names = Array.from({ length: 11 }, (_value, index) => `tool_${index}`);
  const result = asCallResult(await callTool('describe_tools', { names }, h.ctx));
  assert.equal(result.isError, true);
  assert.equal((parseText(result) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');
  assert.match(textOf(result), /at most 10 item/);
});

test('search_tools applies the request visibility before matching', async () => {
  const serverBound = harness({ visibility: { allowedServers: [], allowedTags: null } });
  const hiddenServers = asCallResult(
    await callTool('search_tools', { query: 'query' }, serverBound.ctx),
  );
  assert.deepEqual(parseText(hiddenServers), [], 'allowedServers: [] hides MCP tools');
  const builtin = asCallResult(
    await callTool('search_tools', { query: 'read' }, serverBound.ctx),
  );
  assert.deepEqual(
    (parseText(builtin) as Array<{ name: string }>).map((item) => item.name),
    ['Read'],
    'builtins ignore the server allow list',
  );

  const tagBound = harness({ visibility: { allowedServers: null, allowedTags: [] } });
  const hiddenAll = asCallResult(await callTool('search_tools', { query: 'read' }, tagBound.ctx));
  assert.deepEqual(parseText(hiddenAll), [], 'allowedTags: [] hides every tool');

  const filesOnly = harness({ visibility: { allowedServers: null, allowedTags: ['files'] } });
  const filtered = asCallResult(await callTool('search_tools', { query: 'read' }, filesOnly.ctx));
  assert.deepEqual(
    (parseText(filtered) as Array<{ name: string }>).map((item) => item.name),
    ['Read'],
  );
});

test('describe_tools reports tools outside the request visibility without failing', async () => {
  const h = harness({ visibility: { allowedServers: ['github'], allowedTags: null } });
  const result = asCallResult(
    await callTool('describe_tools', { names: ['Read', 'pg.query'] }, h.ctx),
  );
  assert.equal(result.isError, false);
  const parsed = parseText(result) as {
    tools: Array<{ name: string }>;
    unknown: string[];
  };
  assert.deepEqual(parsed.tools.map((tool) => tool.name), ['Read']);
  assert.deepEqual(parsed.unknown, ['pg.query']);
});

test('search_tools rejects server, category and tags outside the per-request enums', async () => {
  const h = harness({
    searchToolsDefinition: buildSearchToolsDefinition(['database'], ['db', 'read'], ['pg']),
  });

  const server = asCallResult(await callTool('search_tools', { server: 'github' }, h.ctx));
  assert.equal(server.isError, true);
  assert.equal((parseText(server) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');
  assert.match(textOf(server), /server must be one of/);

  const category = asCallResult(
    await callTool('search_tools', { category: 'pg' }, h.ctx),
  );
  assert.equal(category.isError, true);
  assert.equal((parseText(category) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');
  assert.match(textOf(category), /category must be one of/);

  const tags = asCallResult(await callTool('search_tools', { tags: ['db', 'nope'] }, h.ctx));
  assert.equal(tags.isError, true);
  assert.equal((parseText(tags) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');

  const allowed = asCallResult(
    await callTool(
      'search_tools',
      { server: 'pg', category: 'database', tags: ['db', 'read'] },
      h.ctx,
    ),
  );
  assert.equal(allowed.isError, false);
  assert.equal(h.catalog.calls, 1, 'only the accepted call reaches the catalog');
});

test('wait_tasks forwards the owner, task ids and timeout, and passes the result through', async () => {
  const h = harness();
  h.gateway.waitResult = {
    ok: true,
    timedOut: false,
    events: [{ taskId: 'ev_1', evalId: 3, status: 'completed', result: 'ok', elapsedMs: 12 }],
    pending: 0,
  };

  const result = asCallResult(await callTool('wait_tasks', { taskIds: ['ev_1'] }, h.ctx));
  assert.equal(result.isError, false);
  assert.deepEqual(parseText(result), h.gateway.waitResult);
  assert.deepEqual(h.gateway.waitCalls, [
    { owner: 'mcp_1', taskIds: ['ev_1'], timeoutMs: 270_000 },
  ]);

  const explicit = asCallResult(
    await callTool('wait_tasks', { taskIds: ['ev_1'], timeoutMs: 1500 }, h.ctx),
  );
  assert.equal(explicit.isError, false);
  assert.deepEqual(h.gateway.waitCalls[1], {
    owner: 'mcp_1',
    taskIds: ['ev_1'],
    timeoutMs: 1500,
  });

  const bound = harness({ identity: BOUND_IDENTITY });
  await callTool('wait_tasks', { taskIds: ['ev_1'] }, bound.ctx);
  assert.equal(bound.gateway.waitCalls[0]?.owner, 'cb_1', 'bound clients are keyed by binding');
});

test('wait_tasks marks ok:false results and thrown task errors as isError', async () => {
  const h = harness();
  h.gateway.waitResult = { ok: false, error: { code: 'ALREADY_CONSUMED' } };
  const consumed = asCallResult(await callTool('wait_tasks', { taskIds: ['ev_1'] }, h.ctx));
  assert.equal(consumed.isError, true);
  assert.deepEqual(parseText(consumed), { ok: false, error: { code: 'ALREADY_CONSUMED' } });

  const thrown = harness();
  thrown.gateway.waitError = Object.assign(new Error('unknown task'), {
    code: 'UNKNOWN_TASK',
    data: { unknownIds: ['ev_missing'] },
  });
  const unknown = asCallResult(await callTool('wait_tasks', { taskIds: ['ev_missing'] }, thrown.ctx));
  assert.equal(unknown.isError, true);
  assert.deepEqual(parseText(unknown), {
    ok: false,
    error: { code: 'UNKNOWN_TASK', unknownIds: ['ev_missing'] },
  });

  const dataOnly = harness();
  dataOnly.gateway.waitError = Object.assign(new Error('expired'), {
    data: { code: 'TASK_EXPIRED' },
  });
  const expired = asCallResult(await callTool('wait_tasks', { taskIds: ['ev_1'] }, dataOnly.ctx));
  assert.equal(expired.isError, true);
  assert.deepEqual(parseText(expired), { ok: false, error: { code: 'TASK_EXPIRED' } });
});

test('wait_tasks validation errors are tool-layer errors', async () => {
  const h = harness();

  const missing = asCallResult(await callTool('wait_tasks', {}, h.ctx));
  assert.equal(missing.isError, true);
  const missingError = parseText(missing) as { error: { code: string; message: string } };
  assert.equal(missingError.error.code, 'INVALID_ARGUMENT');
  assert.match(missingError.error.message, /taskIds is required/);

  const empty = asCallResult(await callTool('wait_tasks', { taskIds: [] }, h.ctx));
  assert.equal(empty.isError, true);
  const emptyError = parseText(empty) as { error: { code: string; message: string } };
  assert.equal(emptyError.error.code, 'INVALID_ARGUMENT');
  assert.match(emptyError.error.message, /at least 1 item/);

  const result = asCallResult(
    await callTool('wait_tasks', { taskIds: ['ev_1'], timeoutMs: 999 }, h.ctx),
  );
  assert.equal(result.isError, true);
  assert.equal((parseText(result) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');
  assert.equal(h.gateway.waitCalls.length, 0);
});

test('unknown tool names are invalid params at the JSON-RPC layer', async () => {
  const h = harness();
  await assert.rejects(
    callTool('does_not_exist', {}, h.ctx),
    (error: unknown) =>
      error instanceof UnknownToolError &&
      error.code === -32602 &&
      error.toolName === 'does_not_exist',
  );
});

test('discovery tools never touch the task queue', async () => {
  const h = harness();
  await callTool('search_tools', { query: 'sql' }, h.ctx);
  await callTool('describe_tools', { names: ['pg.query'] }, h.ctx);
  assert.equal(h.gateway.waitCalls.length, 0);
  assert.equal(h.gateway.runCalls.length, 0);
  assert.equal(h.gateway.dispatchCalls.length, 0);
});

test('top-level calls report usage once; failures report ok:false and unknown tools report nothing', async () => {
  const h = harness();
  const seen: Array<[string, boolean]> = [];
  h.ctx.onUsage = (name, ok) => {
    seen.push([name, ok]);
  };

  await callTool('search_tools', { query: 'query' }, h.ctx);
  await callTool('search_tools', { max: 0 }, h.ctx);
  await assert.rejects(callTool('does_not_exist', {}, h.ctx), UnknownToolError);

  assert.deepEqual(seen, [
    ['search_tools', true],
    ['search_tools', false],
  ]);
});

test('a CreateTaskResult counts as a successful top-level call', async () => {
  const h = harness({ tasksDeclared: true });
  const seen: Array<[string, boolean]> = [];
  h.ctx.onUsage = (name, ok) => {
    seen.push([name, ok]);
  };

  const result = await callTool('run_script', { code: 'x', timeout: 35_000 }, h.ctx);
  assert.equal(isCreateTaskResult(result), true);
  assert.deepEqual(seen, [['run_script', true]]);
});
