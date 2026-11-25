/** `POST /tools/:serverId/:name/test`, exercised through the admin handler factory. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAdminToolsHandler,
  type AdminToolsDeps,
  type ToolRecord,
  type ToolTestCall,
  type ToolTestResult,
  type ToolStore,
} from '../src/admin/tools.ts';
import {
  BUILTIN_SERVER_ID,
  OFFICIAL_SERVER_ID,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
  type ServerRecord,
  type ServerStore,
} from '../src/admin/servers.ts';

type AuditEvent = Record<string, unknown> & { event: string };

const RESULT_LIMIT_BYTES = 1024 * 1024;

function serverRecord(id: string, patch: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id,
    label: id,
    transport: id === BUILTIN_SERVER_ID ? 'builtin' : 'stdio',
    command: null,
    args: [],
    env: {},
    cwd: null,
    url: null,
    headers: {},
    enabled: true,
    connectMode: 'lazy',
    summary: null,
    summarySource: null,
    category: null,
    tags: [],
    timeoutMs: 60_000,
    maxConcurrency: 8,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    ...patch,
  };
}

function toolRecord(serverId: string, name: string): ToolRecord {
  return {
    serverId,
    name,
    displayName: null,
    description: null,
    descriptionOverride: null,
    enabled: true,
    concurrency: 'parallel',
    type: null,
    tags: [],
    category: null,
    schema: {},
    discoveredVia: 'static',
    stale: false,
    staleOverride: false,
    callCount: 0,
    successCount: 0,
    successRate: null,
    lastCalledAt: null,
  };
}

function serverStoreOf(servers: ServerRecord[]): ServerStore {
  return {
    list: async () => servers,
    get: async (id) => servers.find((server) => server.id === id) ?? null,
    revision: async () => 1,
    create: async () => {
      throw new Error('not used');
    },
    update: async () => {
      throw new Error('not used');
    },
    remove: async () => {
      throw new Error('not used');
    },
  };
}

function toolStoreOf(tools: ToolRecord[]): ToolStore {
  return {
    listByServer: async (serverId) => tools.filter((tool) => tool.serverId === serverId),
    get: async (serverId, name) =>
      tools.find((tool) => tool.serverId === serverId && tool.name === name) ?? null,
    revision: async () => 1,
    update: async () => {
      throw new Error('not used');
    },
    batch: async () => {
      throw new Error('not used');
    },
  };
}

function makeRequest(serverId: string, name: string, body?: unknown): AdminRequest {
  const request: AdminRequest = {
    method: 'POST',
    path: `/tools/${encodeURIComponent(serverId)}/${encodeURIComponent(name)}/test`,
  };
  if (body !== undefined) request.body = body;
  return request;
}

async function call(handler: AdminHandler, request: AdminRequest): Promise<AdminResponse> {
  const response = await handler(request);
  assert.ok(response !== null, `expected ${request.method} ${request.path} to be handled`);
  return response;
}

function bodyOf(response: AdminResponse): ToolTestResult & Record<string, unknown> {
  assert.equal(typeof response.body, 'object');
  assert.ok(response.body !== null);
  return response.body as ToolTestResult & Record<string, unknown>;
}

function errorCode(response: AdminResponse): string {
  const error = (response.body as { error?: { code?: string } }).error;
  assert.ok(error !== undefined);
  return error.code ?? '';
}

/** Standard deps: one third-party server with one tool. */
function handlerWith(
  options: {
    servers?: ServerRecord[];
    tools?: ToolRecord[];
    testTool?: AdminToolsDeps['testTool'];
    audit?: AdminToolsDeps['audit'];
  } = {},
): AdminHandler {
  return createAdminToolsHandler({
    servers: serverStoreOf(options.servers ?? [serverRecord('pg')]),
    tools: toolStoreOf(options.tools ?? [toolRecord('pg', 'query')]),
    retrieval: { search: () => ({ results: [] }) },
    ...(options.testTool === undefined ? {} : { testTool: options.testTool }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
}

test('POST /tools/:serverId/:name/test returns the result and audits without payloads', async () => {
  const calls: ToolTestCall[] = [];
  const audits: AuditEvent[] = [];
  const secretArgs = { apiKey: 'args-value-should-not-be-audited' };
  const result = {
    text: 's3cr3t-in-result',
    images: [{ base64: 'aW1n', mediaType: 'image/png' }],
  };
  const handler = handlerWith({
    testTool: async (call) => {
      calls.push(call);
      return result;
    },
    audit: (event) => audits.push(event),
  });

  const response = await call(
    handler,
    makeRequest('pg', 'query', { args: secretArgs, timeoutMs: 500 }),
  );
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body.ok, true);
  assert.deepEqual(body.result, result);
  assert.ok(body.durationMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(body.testedAt)));
  assert.equal(body.resultBytes, Buffer.byteLength(JSON.stringify(result), 'utf8'));
  assert.equal('truncated' in body, false);

  assert.equal(calls.length, 1);
  const call0 = calls[0]!;
  assert.equal(call0.serverId, 'pg');
  assert.equal(call0.name, 'query');
  assert.deepEqual(call0.args, secretArgs);
  assert.ok(call0.signal instanceof AbortSignal);
  assert.ok(call0.deadline > Date.now(), 'deadline is an absolute epoch-ms budget');
  assert.ok(call0.deadline <= Date.now() + 500);

  assert.equal(audits.length, 1);
  const event = audits[0]!;
  assert.equal(event['event'], 'tool_test');
  assert.equal(event['server'], 'pg');
  assert.equal(event['tool'], 'query');
  assert.equal(event['ok'], true);
  assert.equal(event['durationMs'], body.durationMs);
  assert.equal(event['argsBytes'], Buffer.byteLength(JSON.stringify(secretArgs), 'utf8'));
  assert.equal(event['resultBytes'], body.resultBytes);
  assert.equal(event['error'], undefined);
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes('args-value-should-not-be-audited'), 'audit must not carry raw args');
  assert.ok(!serialized.includes('s3cr3t-in-result'), 'audit must not carry the result body');
});

test('a failing call is HTTP 200 with TOOL_CALL_FAILED and an error audit', async () => {
  const audits: AuditEvent[] = [];
  const handler = handlerWith({
    testTool: async () => {
      throw new Error('upstream exploded');
    },
    audit: (event) => audits.push(event),
  });

  const response = await call(handler, makeRequest('pg', 'query'));
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body.ok, false);
  assert.deepEqual(body.error, { code: 'TOOL_CALL_FAILED', message: 'upstream exploded' });
  assert.equal('result' in body, false);
  assert.equal('resultBytes' in body, false);

  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0]!['error'], {
    code: 'TOOL_CALL_FAILED',
    message: 'upstream exploded',
  });
  assert.equal(audits[0]!['ok'], false);
});

test('a hanging executor still returns TOOL_TEST_TIMEOUT', async () => {
  const handler = handlerWith({
    testTool: async () => await new Promise(() => undefined),
  });

  const response = await call(handler, makeRequest('pg', 'query', { timeoutMs: 20 }));
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body.ok, false);
  assert.equal(body.error?.code, 'TOOL_TEST_TIMEOUT');
  assert.match(body.error?.message ?? '', /timed out/);
});

test("the pool's MCP_CALL_TIMEOUT maps to TOOL_TEST_TIMEOUT", async () => {
  const handler = handlerWith({
    testTool: async () => {
      throw Object.assign(new Error('call budget exhausted'), { code: 'MCP_CALL_TIMEOUT' });
    },
  });

  const body = bodyOf(await call(handler, makeRequest('pg', 'query')));
  assert.equal(body.ok, false);
  assert.equal(body.error?.code, 'TOOL_TEST_TIMEOUT');
});

test('args and timeoutMs are validated; unknown fields and bodies are rejected', async () => {
  let called = 0;
  const handler = handlerWith({
    testTool: async () => {
      called += 1;
      return {};
    },
  });

  const cases: Array<{ body: unknown; code: string }> = [
    { body: { args: [] }, code: 'INVALID_FIELD' },
    { body: { args: null }, code: 'INVALID_FIELD' },
    { body: { timeoutMs: 0 }, code: 'INVALID_FIELD' },
    { body: { timeoutMs: 60_001 }, code: 'INVALID_FIELD' },
    { body: { timeoutMs: 12.5 }, code: 'INVALID_FIELD' },
    { body: { timeoutMs: '10' }, code: 'INVALID_FIELD' },
    { body: { extra: true }, code: 'UNKNOWN_FIELD' },
    { body: [], code: 'INVALID_BODY' },
    { body: '{oops', code: 'INVALID_JSON' },
  ];
  for (const entry of cases) {
    const response = await call(handler, makeRequest('pg', 'query', entry.body));
    assert.equal(response.status, 400, JSON.stringify(entry.body));
    assert.equal(errorCode(response), entry.code, JSON.stringify(entry.body));
  }
  assert.equal(called, 0, 'validation failures must not reach the executor');
});

test('an omitted body defaults to empty args and a 10s budget', async () => {
  const calls: ToolTestCall[] = [];
  const handler = handlerWith({
    testTool: async (call) => {
      calls.push(call);
      return { ok: true };
    },
  });

  const before = Date.now();
  const response = await call(handler, makeRequest('pg', 'query'));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, {});
  assert.ok(calls[0]!.deadline >= before + 9_000);
  assert.ok(calls[0]!.deadline <= Date.now() + 10_000);
});

test('missing server or tool is 404; only read-only builtins are testable', async () => {
  const servers = [
    serverRecord('pg'),
    serverRecord(BUILTIN_SERVER_ID),
    serverRecord(OFFICIAL_SERVER_ID, { transport: 'builtin' }),
  ];
  const tools = [
    toolRecord('pg', 'query'),
    toolRecord(BUILTIN_SERVER_ID, 'search_tools'),
    toolRecord(BUILTIN_SERVER_ID, 'run_script'),
    toolRecord(OFFICIAL_SERVER_ID, 'Read'),
  ];
  const calls: ToolTestCall[] = [];
  const handler = handlerWith({
    servers,
    tools,
    testTool: async (call) => {
      calls.push(call);
      return { ok: true };
    },
  });

  const missingServer = await call(handler, makeRequest('nope', 'query'));
  assert.equal(missingServer.status, 404);
  assert.equal(errorCode(missingServer), 'SERVER_NOT_FOUND');

  const missingTool = await call(handler, makeRequest('pg', 'nope'));
  assert.equal(missingTool.status, 404);
  assert.equal(errorCode(missingTool), 'TOOL_NOT_FOUND');

  const builtin = await call(handler, makeRequest(BUILTIN_SERVER_ID, 'search_tools'));
  assert.equal(builtin.status, 200);
  assert.equal(calls.length, 1, 'read-only builtins use the builtin test path');

  const unsupported = await call(handler, makeRequest(BUILTIN_SERVER_ID, 'run_script'));
  assert.equal(unsupported.status, 400);
  assert.equal(errorCode(unsupported), 'TOOL_TEST_UNSUPPORTED');
  assert.equal(calls.length, 1, 'write/run builtins never reach the executor');

  const official = await call(handler, makeRequest(OFFICIAL_SERVER_ID, 'Read'));
  assert.equal(official.status, 200);
  assert.equal(calls.length, 2, 'official tools run through the serve path');
});

test('without testTool the route fails closed with TOOL_TEST_UNAVAILABLE', async () => {
  const audits: AuditEvent[] = [];
  const handler = handlerWith({ audit: (event) => audits.push(event) });

  const response = await call(handler, makeRequest('pg', 'query'));
  assert.equal(response.status, 503);
  assert.equal(errorCode(response), 'TOOL_TEST_UNAVAILABLE');
  assert.equal(audits.length, 0, 'a call that never ran writes no audit event');
});

test('results above 1 MiB become a bounded preview and keep the true byte count', async () => {
  const audits: AuditEvent[] = [];
  const result = { text: 'x'.repeat(RESULT_LIMIT_BYTES + 50_000) };
  const handler = handlerWith({
    testTool: async () => result,
    audit: (event) => audits.push(event),
  });

  const response = await call(handler, makeRequest('pg', 'query'));
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body.ok, true);
  assert.equal(body.truncated, true);
  assert.equal('result' in body, false);
  assert.equal(typeof body.resultPreview, 'string');
  assert.ok(
    Buffer.byteLength(body.resultPreview ?? '', 'utf8') <= RESULT_LIMIT_BYTES,
    'the preview itself stays within the budget',
  );
  assert.equal(body.resultBytes, Buffer.byteLength(JSON.stringify(result), 'utf8'));
  assert.ok((body.resultBytes ?? 0) > RESULT_LIMIT_BYTES);
  assert.equal(audits[0]!['resultBytes'], body.resultBytes);
});

test('a result exactly at the preview budget is returned in full', async () => {
  const payload = 'y'.repeat(1_000);
  const result = { text: payload };
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  assert.ok(bytes < RESULT_LIMIT_BYTES);

  const handler = handlerWith({ testTool: async () => result });
  const body = bodyOf(await call(handler, makeRequest('pg', 'query')));
  assert.equal('truncated' in body, false);
  assert.deepEqual(body.result, result);
  assert.equal(body.resultBytes, bytes);
});

test('an undefined result is reported as null with its 4-byte JSON size', async () => {
  const handler = handlerWith({ testTool: async () => undefined });
  const body = bodyOf(await call(handler, makeRequest('pg', 'query')));
  assert.equal(body.ok, true);
  assert.equal(body.result, null);
  assert.equal(body.resultBytes, 4);
});

test('non-POST and unrouted shapes return null so the router can continue', async () => {
  const handler = handlerWith({ testTool: async () => ({}) });
  assert.equal(await handler({ method: 'GET', path: '/tools/pg/query/test' }), null);
  assert.equal(await handler({ method: 'POST', path: '/tools/pg/query' }), null);
  // A `/test` route for an unknown path shape is not this handler's.
  assert.equal(await handler({ method: 'POST', path: '/servers/pg/tools/test' }), null);
});
