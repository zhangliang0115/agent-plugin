import assert from 'node:assert/strict';
import test from 'node:test';

import { VERSION } from '@zhangliang0115/repl-server-core';

import {
  DISCOVER_CACHE_SCOPE,
  DISCOVER_TTL_MS,
  INSTRUCTIONS,
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  discoverResult,
  initializeResult,
} from '../src/mcp/discover.ts';
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_INTERNAL_ERROR,
  JsonRpcError,
} from '../src/mcp/errors.ts';
import {
  type JsonRpcErrorResponse,
  type JsonRpcHandler,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
} from '../src/mcp/jsonrpc.ts';
import { METHOD_TABLE, createMethodTable } from '../src/mcp/methods.ts';

function expectResult(response: JsonRpcResponse | null): JsonRpcSuccessResponse {
  if (response === null || !('result' in response)) {
    assert.fail(`expected a result response, got ${JSON.stringify(response)}`);
  }
  return response;
}

function expectError(response: JsonRpcResponse | null): JsonRpcErrorResponse {
  if (response === null || !('error' in response)) {
    assert.fail(`expected an error response, got ${JSON.stringify(response)}`);
  }
  return response;
}

test('server/discover returns the shape frozen in protocol.md §3.1', async () => {
  const rpc = createMethodTable();
  const response = expectResult(
    await rpc.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.327' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  );

  assert.deepEqual(response.result, {
    resultType: 'complete',
    supportedVersions: ['2026-07-28'],
    capabilities: {
      tools: {},
      extensions: { 'io.modelcontextprotocol/tasks': {} },
    },
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: 'repl-server', version: SERVER_VERSION },
    },
    instructions: INSTRUCTIONS,
    ttlMs: 3_600_000,
    cacheScope: 'public',
  });

  assert.equal(PROTOCOL_VERSION, '2026-07-28');
  assert.equal(DISCOVER_TTL_MS, 3_600_000);
  assert.equal(DISCOVER_CACHE_SCOPE, 'public');
  assert.equal(SERVER_NAME, 'repl-server');
  assert.equal(SERVER_VERSION, VERSION);
  assert.ok(INSTRUCTIONS.includes('persistent sandbox'));
  assert.ok(INSTRUCTIONS.includes('tools.mcp.<server>.<tool>'));
  assert.ok(INSTRUCTIONS.includes('search_tools'));
});

test('legacy initialize returns protocolVersion and a top-level serverInfo', async () => {
  const rpc = createMethodTable();
  const response = expectResult(
    await rpc.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'probe', version: '1.0.0' },
      },
    }),
  );

  assert.deepEqual(response.result, {
    protocolVersion: '2026-07-28',
    capabilities: { tools: {} },
    serverInfo: { name: 'repl-server', version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  });
});

test('server/discover rejects an unsupported pinned version with data.supportedVersions', async () => {
  const rpc = createMethodTable();

  for (const pinned of ['2025-11-25', '']) {
    const response = expectError(
      await rpc.handle({
        jsonrpc: '2.0',
        id: 10,
        method: 'server/discover',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': pinned } },
      }),
    );
    assert.equal(response.error.code, JSON_RPC_INVALID_REQUEST);
    assert.deepEqual(response.error.data, { supportedVersions: ['2026-07-28'] });
  }

  // A missing pin and a supported pin both succeed.
  for (const params of [{}, { _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION } }]) {
    const response = expectResult(
      await rpc.handle({ jsonrpc: '2.0', id: 11, method: 'server/discover', params }),
    );
    assert.deepEqual((response.result as { supportedVersions: string[] }).supportedVersions, [
      '2026-07-28',
    ]);
  }
});

test('initialize with an unsupported version is -32600 with data.supportedVersions', async () => {
  const rpc = createMethodTable();
  const response = expectError(
    await rpc.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
  );

  assert.equal(response.id, 3);
  assert.equal(response.error.code, JSON_RPC_INVALID_REQUEST);
  assert.deepEqual(response.error.data, { supportedVersions: ['2026-07-28'] });
});

test('initialize without a protocolVersion string is -32602', async () => {
  const rpc = createMethodTable();

  for (const params of [{}, { protocolVersion: 20260728 }]) {
    const response = expectError(
      await rpc.handle({ jsonrpc: '2.0', id: 4, method: 'initialize', params }),
    );
    assert.equal(response.error.code, JSON_RPC_INVALID_PARAMS);
  }
});

test('initialize ignores the requested version once it is supported', () => {
  assert.deepEqual(initializeResult({ protocolVersion: PROTOCOL_VERSION }), {
    protocolVersion: '2026-07-28',
    capabilities: { tools: {} },
    serverInfo: { name: 'repl-server', version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  });
  assert.throws(
    () => initializeResult({ protocolVersion: '2024-11-05' }),
    (error: unknown) =>
      error instanceof JsonRpcError &&
      error.code === JSON_RPC_INVALID_REQUEST &&
      Array.isArray((error.data as { supportedVersions?: unknown }).supportedVersions),
  );
});

test('the method table exposes exactly the frozen v1 methods in order', () => {
  const rpc = createMethodTable();

  assert.deepEqual(rpc.methods(), [...METHOD_TABLE]);
  assert.deepEqual(rpc.methods(), [
    'server/discover',
    'initialize',
    'notifications/initialized',
    'ping',
    'tools/list',
    'tools/call',
    'tasks/get',
    'tasks/cancel',
    'tasks/update',
  ]);
});

test('discover and initialize use the instructions override', async () => {
  const rpc = createMethodTable({ instructions: 'custom prompt' });

  const discover = expectResult(
    await rpc.handle({ jsonrpc: '2.0', id: 6, method: 'server/discover', params: {} }),
  );
  const initialize = expectResult(
    await rpc.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION },
    }),
  );

  assert.equal((discover.result as { instructions: string }).instructions, 'custom prompt');
  assert.equal((initialize.result as { instructions: string }).instructions, 'custom prompt');
});

test('tools and tasks methods delegate to their handlers with params and context', async () => {
  type Context = { binding: string | null };
  const calls: Array<{ name: string; params: Record<string, unknown>; binding: string | null }> = [];
  const record = (name: string): JsonRpcHandler<Context> => (params, context) => {
    calls.push({ name, params, binding: context.binding });
    return { handled: name };
  };
  const rpc = createMethodTable<Context>({
    toolsList: record('tools/list'),
    toolsCall: record('tools/call'),
    tasksGet: record('tasks/get'),
    tasksCancel: record('tasks/cancel'),
    tasksUpdate: record('tasks/update'),
  });
  const context: Context = { binding: 'cb_1' };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['tools/list', {}],
    ['tools/call', { name: 'run_script', arguments: { code: '1 + 1' } }],
    ['tasks/get', { taskId: 't_1' }],
    ['tasks/cancel', { taskId: 't_1' }],
    ['tasks/update', { taskId: 't_1', inputResponses: {} }],
  ];

  for (const [method, params] of cases) {
    const response = expectResult(await rpc.handle({ jsonrpc: '2.0', id: method, method, params }, context));
    assert.deepEqual(response.result, { handled: method });
  }

  assert.deepEqual(
    calls.map((call) => call.name),
    ['tools/list', 'tools/call', 'tasks/get', 'tasks/cancel', 'tasks/update'],
  );
  assert.ok(calls.every((call) => call.binding === 'cb_1'));
  assert.deepEqual(calls[1]?.params, { name: 'run_script', arguments: { code: '1 + 1' } });
});

test('unwired tools and tasks methods fail with -32603 instead of -32601', async () => {
  const rpc = createMethodTable();

  for (const method of ['tools/list', 'tools/call', 'tasks/get', 'tasks/cancel', 'tasks/update']) {
    const response = expectError(await rpc.handle({ jsonrpc: '2.0', id: 8, method, params: {} }));
    assert.equal(response.error.code, JSON_RPC_INTERNAL_ERROR);
    assert.equal(response.error.message, `${method} is not wired`);
  }
});

test('ping carries resultType and notifications/initialized stays silent', async () => {
  const rpc = createMethodTable();

  assert.deepEqual(await rpc.handle({ jsonrpc: '2.0', id: 9, method: 'ping', params: {} }), {
    jsonrpc: '2.0',
    id: 9,
    result: { resultType: 'complete' },
  });
  assert.equal(
    await rpc.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    null,
  );
});

test('discoverResult builds a fresh object per call', () => {
  const first = discoverResult();
  const second = discoverResult();

  assert.notEqual(first, second);
  assert.notEqual(first.capabilities, second.capabilities);
  assert.deepEqual(first, second);
});
