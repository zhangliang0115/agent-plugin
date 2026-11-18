import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startStdioClient } from './stdio-client.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/support/server.mjs', import.meta.url));

test('stdio client exchanges newline JSON-RPC and answers server-initiated requests', async (t) => {
  const client = await startStdioClient({
    args: [FIXTURE, '--stdio', '--server-request', 'roots/list'],
    t,
  });
  client.setRequestHandler((request) => {
    if (request.method === 'roots/list') {
      return { roots: [] };
    }
    throw new Error(`unexpected server request: ${request.method}`);
  });

  const pong = await client.request('ping');
  assert.deepEqual(pong.result, {});
  assert.equal(client.serverRequests[0]?.method, 'roots/list');

  const notification = await client.waitForNotification(
    (message) => message.method === 'notifications/fixture/response',
    2000,
  );
  assert.deepEqual(notification.params, {
    jsonrpc: '2.0',
    id: 'srv_1',
    result: { roots: [] },
  });

  const echo = await client.request('fixture/echo', { n: 1 });
  assert.deepEqual((echo.result as { params: unknown }).params, { n: 1 });
  assert.equal(client.badLines.length, 0);

  const exit = await client.close();
  assert.equal(exit.code, 0);
  assert.match(client.stderr(), /fixture stdio ready/);
});

test('stdio client survives a malformed response line and keeps reading', async (t) => {
  const client = await startStdioClient({ args: [FIXTURE, '--stdio'], t });
  client.sendRaw('{not json');
  await delay(100);
  assert.equal(client.orphanResponses.length, 1);
  assert.equal(client.orphanResponses[0]?.error?.code, -32700);

  const pong = await client.request('ping');
  assert.deepEqual(pong.result, {});
  assert.equal(client.badLines.length, 0);
});
