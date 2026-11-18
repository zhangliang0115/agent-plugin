// hook-allow: localhost-only test fetch, no external egress
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, type McpContext } from '../src/app.ts';
import { JsonRpcDispatcher } from '../src/mcp/jsonrpc.ts';
import { TransportSessionRegistry } from '../src/sessions/transport.ts';
import { McpTaskStore } from '../src/tasks/mcp-tasks.ts';
import type { Catalog, ExecutionGateway } from '../src/ports.ts';

const gateway: ExecutionGateway = {
  runScript: async () => ({ content: '<repl-output eval="1"></repl-output>', isError: false }),
  dispatchScript: async () => ({ taskId: 't_test', evalId: 1 }),
  waitTasks: async () => ({ ok: true, events: [], pending: 0 }),
  getTask: async () => null,
  cancelTask: async () => false,
  destroyOwner: async () => undefined,
};

const catalog: Catalog = { snapshot: () => ({ revision: 1, tools: [] }) };

function dispatcher(): JsonRpcDispatcher<McpContext> {
  const d = new JsonRpcDispatcher<McpContext>();
  d.register('server/discover', () => ({
    resultType: 'complete',
    supportedVersions: ['2026-07-28'],
    capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } },
  }));
  d.register('initialize', () => ({ protocolVersion: '2025-11-25', capabilities: { tools: {} } }));
  d.register('tools/list', () => ({ tools: [] }));
  d.register('tools/call', (_params, context) => context.identity);
  return d;
}

async function listen(): Promise<{ server: ReturnType<typeof createApp>; base: string }> {
  const server = createApp({
    identity: { mode: 'loose', bindings: { findByTokenHash: async () => null } },
    sessions: new TransportSessionRegistry(),
    gateway,
    catalog,
    tasks: new McpTaskStore(),
    dispatcher: dispatcher(),
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { server, base: `http://127.0.0.1:${(address as AddressInfo).port}` };
}

async function rpc(base: string, body: unknown, session?: string) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session === undefined ? {} : { 'mcp-session-id': session }),
    },
    body: JSON.stringify(body),
  });
}

test('health reports ok', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { ok: boolean }).ok, true);
});

test('a request without a session header opens an implicit session', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());
  const response = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('mcp-session-id') ?? '', /^mcp_[0-9a-f]{32}$/);
});

test('an unknown session header is rejected', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());
  const response = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'mcp_00000000000000000000000000000000');
  assert.equal(response.status, 404);
});

test('discover opens a session and later requests reuse it', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());

  const discover = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  assert.equal(discover.status, 200);
  const session = discover.headers.get('mcp-session-id');
  assert.match(session ?? '', /^mcp_[0-9a-f]{32}$/);

  const list = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session ?? '');
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { jsonrpc: '2.0', id: 2, result: { tools: [] } });
});

test('an unknown token is rejected even in loose mode', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
  });
  assert.equal(response.status, 401);
});

test('DELETE closes the session and a later request 404s', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());
  const discover = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';
  const deleted = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': session } });
  assert.equal(deleted.status, 204);
  const afterDelete = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  assert.equal(afterDelete.status, 404);
});

test('GET /mcp is 405', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());
  const response = await fetch(`${base}/mcp`);
  assert.equal(response.status, 405);
});
