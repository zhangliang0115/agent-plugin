import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { createHttpServer } from '../src/http.ts';

async function listen(): Promise<{ server: ReturnType<typeof createHttpServer>; base: string }> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { server, base: `http://127.0.0.1:${(address as AddressInfo).port}` };
}

test('GET /health reports ok and the plugin version', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, version: '0.1.0' });
});

test('unknown paths return a structured 404', async (t) => {
  const { server, base } = await listen();
  t.after(() => server.close());
  const response = await fetch(`${base}/nope`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'NOT_FOUND' } });
});
