// hook-allow: localhost-only test fetch, no external egress
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, type AppOptions, type McpContext } from '../src/app.ts';
import { JsonRpcDispatcher } from '../src/mcp/jsonrpc.ts';
import { createMethodTable } from '../src/mcp/methods.ts';
import { TransportSessionRegistry } from '../src/sessions/transport.ts';
import { McpTaskStore, ownerOf, TaskMethodError } from '../src/tasks/mcp-tasks.ts';
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

async function listen(options: {
  gateway?: ExecutionGateway;
  tasks?: McpTaskStore;
  sessions?: TransportSessionRegistry;
  dispatcher?: JsonRpcDispatcher<McpContext>;
  identity?: AppOptions['identity'];
} = {}): Promise<{ server: ReturnType<typeof createApp>; base: string }> {
  const server = createApp({
    identity: options.identity ?? { mode: 'loose', bindings: { findByTokenHash: async () => null } },
    sessions: options.sessions ?? new TransportSessionRegistry(),
    gateway: options.gateway ?? gateway,
    catalog,
    tasks: options.tasks ?? new McpTaskStore(),
    dispatcher: options.dispatcher ?? dispatcher(),
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { server, base: `http://127.0.0.1:${(address as AddressInfo).port}` };
}

/** Raw `node:http` request so a non-local `Host` header can be sent. */
function rawRequest(
  base: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk as Buffer)));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function rpc(base: string, body: unknown, session?: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
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

test('_meta clientInfo is split into clientName and clientVersion on the identity', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());

  const withVersion = await rpc(base, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'run_script',
      arguments: {},
      _meta: {
        'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.327' },
      },
    },
  });
  const full = (await withVersion.json()) as {
    result: { client: string; clientName: string; clientVersion: string };
  };
  assert.equal(full.result.client, 'claude-code/2.1.327');
  assert.equal(full.result.clientName, 'claude-code');
  assert.equal(full.result.clientVersion, '2.1.327');

  const nameOnly = await rpc(base, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'run_script', arguments: {}, clientInfo: { name: 'probe' } },
  });
  const partial = (await nameOnly.json()) as {
    result: { client: string; clientName: string; clientVersion: string };
  };
  assert.equal(partial.result.client, 'probe');
  assert.equal(partial.result.clientName, 'probe');
  assert.equal(partial.result.clientVersion, '');
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

test('/health and /mcp reject a non-local Host header with 403', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());

  const port = new URL(base).port;
  const health = await rawRequest(base, '/health', { headers: { host: `evil.example:${port}` } });
  assert.equal(health.status, 403);
  assert.equal((JSON.parse(health.text) as { error: { code: string } }).error.code, 'FORBIDDEN_HOST');

  const mcp = await rawRequest(base, '/mcp', {
    method: 'POST',
    headers: { host: `evil.example:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(mcp.status, 403);

  // A local host with a port is still accepted (the port is stripped).
  const local = await rawRequest(base, '/health', { headers: { host: `localhost:${port}` } });
  assert.equal(local.status, 200);
});

test('DELETE /mcp cascades execution sessions and task cleanup', async (t) => {
  const destroyed: string[] = [];
  const cleared: string[] = [];
  const tasks = new McpTaskStore();
  const clearSession = tasks.clearSession.bind(tasks);
  tasks.clearSession = (sessionId: string): number => {
    cleared.push(sessionId);
    return clearSession(sessionId);
  };
  const scopedGateway: ExecutionGateway = {
    ...gateway,
    destroyOwner: async (owner: string) => {
      destroyed.push(owner);
    },
  };

  const { server, base } = await listen({ gateway: scopedGateway, tasks });
  t.after(() => server.close());

  const discover = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';
  const deleted = await fetch(`${base}/mcp`, {
    method: 'DELETE',
    headers: { 'mcp-session-id': session },
  });
  assert.equal(deleted.status, 204);
  assert.deepEqual(destroyed, [session]);
  assert.deepEqual(cleared, [session]);

  const afterDelete = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  assert.equal(afterDelete.status, 404);
});

test('idle transport expiry runs the same cascade', async (t) => {
  const destroyed: string[] = [];
  const cleared: string[] = [];
  const tasks = new McpTaskStore();
  const clearSession = tasks.clearSession.bind(tasks);
  tasks.clearSession = (sessionId: string): number => {
    cleared.push(sessionId);
    return clearSession(sessionId);
  };
  const scopedGateway: ExecutionGateway = {
    ...gateway,
    destroyOwner: async (owner: string) => {
      destroyed.push(owner);
    },
  };

  const { server, base } = await listen({
    gateway: scopedGateway,
    tasks,
    sessions: new TransportSessionRegistry({ idleMs: 10 }),
  });
  t.after(() => server.close());

  const discover = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';
  await new Promise((resolve) => setTimeout(resolve, 30));

  const expired = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  assert.equal(expired.status, 404);
  assert.deepEqual(destroyed, [session]);
  assert.deepEqual(cleared, [session]);
});

test('DELETE /mcp clears only the bound tasks created through that transport session', async (t) => {
  let next = 0;
  const tasks = new McpTaskStore({ idFactory: () => `t_${(next += 1)}` });
  const boundDispatcher = new JsonRpcDispatcher<McpContext>();
  boundDispatcher.register('server/discover', () => ({ resultType: 'complete', supportedVersions: ['2026-07-28'] }));
  boundDispatcher.register('tools/call', (_params, context) =>
    context.tasks.create(ownerOf(context.identity), `ev_${context.identity.mcp}`),
  );

  const { server, base } = await listen({
    tasks,
    dispatcher: boundDispatcher,
    identity: { mode: 'loose', bindings: { findByTokenHash: async () => ({ id: 'cb_bound' }) } },
  });
  t.after(() => server.close());

  const auth = { authorization: 'Bearer client-token' };
  const createTask = async (id: number): Promise<{ session: string; taskId: string }> => {
    const response = await rpc(
      base,
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'run_script', arguments: {} } },
      undefined,
      auth,
    );
    const session = response.headers.get('mcp-session-id') ?? '';
    const body = (await response.json()) as { result: { taskId: string } };
    return { session, taskId: body.result.taskId };
  };

  const first = await createTask(1);
  const second = await createTask(2);
  assert.equal(tasks.resolve('cb_bound', first.taskId).owner, 'cb_bound');

  const deleted = await fetch(`${base}/mcp`, {
    method: 'DELETE',
    headers: { 'mcp-session-id': first.session, ...auth },
  });
  assert.equal(deleted.status, 204);

  assert.throws(() => tasks.resolve('cb_bound', first.taskId), TaskMethodError);
  assert.equal(tasks.resolve('cb_bound', second.taskId).evalTaskId, `ev_${second.session}`);
});

test('server/discover rejects an unsupported pinned protocol version over HTTP', async (t) => {
  const realDispatcher = createMethodTable<McpContext>({ toolsList: () => ({ tools: [] }) });
  const { server, base } = await listen({ dispatcher: realDispatcher });
  t.after(() => server.close());

  const unsupported = await rpc(base, {
    jsonrpc: '2.0',
    id: 7,
    method: 'server/discover',
    params: {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' },
    },
  });
  assert.equal(unsupported.status, 200);
  const body = (await unsupported.json()) as {
    error?: { code: number; data?: unknown };
  };
  assert.equal(body.error?.code, -32600);
  assert.deepEqual(body.error?.data, { supportedVersions: ['2026-07-28'] });

  const accepted = await rpc(base, {
    jsonrpc: '2.0',
    id: 8,
    method: 'server/discover',
    params: {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    },
  });
  const acceptedBody = (await accepted.json()) as { result?: { supportedVersions: string[] } };
  assert.deepEqual(acceptedBody.result?.supportedVersions, ['2026-07-28']);

  const missing = await rpc(base, { jsonrpc: '2.0', id: 9, method: 'server/discover', params: {} });
  const missingBody = (await missing.json()) as { result?: { supportedVersions: string[] } };
  assert.deepEqual(missingBody.result?.supportedVersions, ['2026-07-28']);
});
