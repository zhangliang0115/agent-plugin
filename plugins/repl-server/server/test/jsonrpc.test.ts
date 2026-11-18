import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JsonRpcError,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
} from '../src/mcp/errors.ts';
import {
  JsonRpcDispatcher,
  type JsonRpcErrorResponse,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
} from '../src/mcp/jsonrpc.ts';

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

test('dispatches requests and echoes numeric, string and null ids', async () => {
  const rpc = new JsonRpcDispatcher();
  rpc.register('echo', (params) => params);

  assert.deepEqual(await rpc.handle({ jsonrpc: '2.0', id: 1, method: 'echo', params: { a: 1 } }), {
    jsonrpc: '2.0',
    id: 1,
    result: { a: 1 },
  });
  assert.deepEqual(await rpc.handle({ jsonrpc: '2.0', id: 'abc', method: 'echo' }), {
    jsonrpc: '2.0',
    id: 'abc',
    result: {},
  });
  assert.deepEqual(await rpc.handle({ jsonrpc: '2.0', id: null, method: 'echo', params: {} }), {
    jsonrpc: '2.0',
    id: null,
    result: {},
  });
});

test('awaits asynchronous handlers and passes the per-call context', async () => {
  const rpc = new JsonRpcDispatcher<{ binding: string }>();
  rpc.register('who', async (_params, context) => ({ binding: context.binding }));

  const response = expectResult(
    await rpc.handle({ jsonrpc: '2.0', id: 2, method: 'who', params: {} }, { binding: 'cb_1' }),
  );
  assert.deepEqual(response, { jsonrpc: '2.0', id: 2, result: { binding: 'cb_1' } });
});

test('returns -32601 for an unknown request method', async () => {
  const rpc = new JsonRpcDispatcher();

  const response = expectError(await rpc.handle({ jsonrpc: '2.0', id: 3, method: 'tools/nope', params: {} }));
  assert.equal(response.id, 3);
  assert.deepEqual(response.error, {
    code: JSON_RPC_METHOD_NOT_FOUND,
    message: 'Method not found: tools/nope',
  });
});

test('returns -32602 when params is not an object', async () => {
  const rpc = new JsonRpcDispatcher();
  rpc.register('echo', (params) => params);

  for (const params of [[], 'nope', 42, null]) {
    const response = expectError(await rpc.handle({ jsonrpc: '2.0', id: 4, method: 'echo', params }));
    assert.equal(response.id, 4);
    assert.equal(response.error.code, JSON_RPC_INVALID_PARAMS);
  }
});

test('rejects batch requests with a single -32600 response', async () => {
  const rpc = new JsonRpcDispatcher();
  rpc.register('ping', () => ({}));

  const response = expectError(
    await rpc.handle([
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
    ]),
  );
  assert.deepEqual(response, {
    jsonrpc: '2.0',
    id: null,
    error: { code: JSON_RPC_INVALID_REQUEST, message: 'Batch requests are not supported' },
  });
});

test('never responds to notifications', async () => {
  const rpc = new JsonRpcDispatcher();
  let calls = 0;
  rpc.register('notifications/initialized', () => {
    calls += 1;
  });

  assert.equal(await rpc.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }), null);
  assert.equal(calls, 1);
  assert.equal(await rpc.handle({ jsonrpc: '2.0', method: 'unknown/notification' }), null);
});

test('a throwing notification handler still produces no response', async () => {
  const rpc = new JsonRpcDispatcher();
  rpc.register('boom', () => {
    throw new Error('boom');
  });

  assert.equal(await rpc.handle({ jsonrpc: '2.0', method: 'boom' }), null);
});

test('rejects malformed envelopes with -32600', async () => {
  const rpc = new JsonRpcDispatcher();
  rpc.register('ping', () => ({}));

  const malformed: unknown[] = [
    null,
    'text',
    42,
    { id: 1, method: 'ping' },
    { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: true, method: 'ping' },
  ];
  for (const message of malformed) {
    const response = expectError(await rpc.handle(message));
    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: null,
      error: { code: JSON_RPC_INVALID_REQUEST, message: response.error.message },
    });
  }
});

test('serializes JsonRpcError and maps unexpected throws to -32603', async () => {
  const rpc = new JsonRpcDispatcher();
  rpc.register('bad-params', () => {
    throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, 'missing code', { field: 'code' });
  });
  rpc.register('boom', () => {
    throw new Error('kaboom');
  });

  assert.deepEqual(await rpc.handle({ jsonrpc: '2.0', id: 5, method: 'bad-params', params: {} }), {
    jsonrpc: '2.0',
    id: 5,
    error: { code: JSON_RPC_INVALID_PARAMS, message: 'missing code', data: { field: 'code' } },
  });
  assert.deepEqual(await rpc.handle({ jsonrpc: '2.0', id: 6, method: 'boom', params: {} }), {
    jsonrpc: '2.0',
    id: 6,
    error: { code: JSON_RPC_INTERNAL_ERROR, message: 'kaboom' },
  });
});

test('parses raw text and reports -32700 for invalid JSON', async () => {
  const rpc = new JsonRpcDispatcher();
  rpc.register('ping', () => ({}));

  assert.deepEqual(await rpc.handleText('{"jsonrpc":"2.0","id":7,"method":"ping","params":{}}'), {
    jsonrpc: '2.0',
    id: 7,
    result: {},
  });
  assert.deepEqual(await rpc.handleText('{oops'), {
    jsonrpc: '2.0',
    id: null,
    error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' },
  });
});

test('registers methods once and lists them in order', () => {
  const rpc = new JsonRpcDispatcher();
  rpc.register('a', () => null);
  rpc.register('b', () => null);

  assert.deepEqual(rpc.methods(), ['a', 'b']);
  assert.equal(rpc.has('a'), true);
  assert.equal(rpc.has('c'), false);
  assert.throws(() => rpc.register('a', () => null), /Duplicate JSON-RPC method/);
});
