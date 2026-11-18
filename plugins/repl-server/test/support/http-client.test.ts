import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startDaemon } from './daemon.ts';
import { HttpMcpClient, HttpStatusError } from './http-client.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/support/server.mjs', import.meta.url));
const COMPLIANT_FIXTURE = fileURLToPath(new URL('../fixtures/compliant-mcp/server.mjs', import.meta.url));

test('HTTP client covers JSON-RPC, session id, bearer auth and SSE', async (t) => {
  const daemon = await startDaemon({ entry: FIXTURE, args: ['--token', 'secret'], t });
  const client = new HttpMcpClient({ url: `${daemon.baseUrl}/mcp`, token: 'secret' });

  const discover = await client.request('server/discover', {});
  const discoverResult = discover.result as { resultType?: string; supportedVersions?: string[] };
  assert.equal(discoverResult.resultType, 'complete');
  assert.deepEqual(discoverResult.supportedVersions, ['2026-07-28']);
  assert.equal(client.sessionId, 's_1');

  const echo = await client.request('fixture/echo', { hello: 'world' });
  const echoed = echo.result as {
    params: { hello: string };
    authorization: string;
    sessionId: string;
  };
  assert.deepEqual(echoed.params, { hello: 'world' });
  assert.equal(echoed.authorization, 'Bearer secret');
  assert.equal(echoed.sessionId, 's_1');

  const notification = await client.notify('notifications/initialized', {});
  assert.equal(notification.status, 202);

  const sse = await client.openSse();
  try {
    const message = await sse.nextMessage(2000);
    assert.ok(message !== null && 'method' in message);
    assert.equal(message.method, 'notifications/fixture');
    assert.deepEqual(message.params, { hello: true });
  } finally {
    await sse.close();
  }

  const status = await client.deleteSession();
  assert.equal(status, 204);
  assert.equal(client.sessionId, null);
});

test('HTTP client surfaces authorization failures without hiding the body', async (t) => {
  const daemon = await startDaemon({ entry: FIXTURE, args: ['--token', 'secret'], t });
  const anonymous = new HttpMcpClient({ url: `${daemon.baseUrl}/mcp` });

  const denied = await anonymous.post({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(denied.status, 401);
  assert.match(denied.text ?? '', /UNAUTHORIZED/);

  await assert.rejects(
    () => anonymous.request('ping'),
    (error: unknown) => error instanceof HttpStatusError && error.status === 401,
  );
});

test('HTTP client sends an explicit Mcp-Session-Id', async (t) => {
  const daemon = await startDaemon({ entry: FIXTURE, t });
  const client = new HttpMcpClient({ url: `${daemon.baseUrl}/mcp`, sessionId: 'bogus' });
  const echo = await client.request('fixture/echo', {});
  assert.equal((echo.result as { sessionId: string }).sessionId, 'bogus');
});

test('HTTP client works against the compliant MCP fixture when present', async (t) => {
  if (!existsSync(COMPLIANT_FIXTURE)) {
    t.skip('compliant-mcp fixture is not ready yet (RST-T01)');
    return;
  }
  const daemon = await startDaemon({ entry: COMPLIANT_FIXTURE, healthPath: null, t });
  const client = new HttpMcpClient({ url: `${daemon.baseUrl}/mcp` });

  const discover = await client.request('server/discover', {});
  const result = discover.result as { resultType?: string; supportedVersions?: string[] };
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.supportedVersions, ['2026-07-28']);
  assert.ok(client.sessionId?.startsWith('s_'), `expected a session id, got ${String(client.sessionId)}`);

  const list = await client.request('tools/list', {});
  const tools = (list.result as { tools?: { name: string }[] }).tools;
  assert.deepEqual(tools?.map((tool) => tool.name), ['slow']);
});
