/** GET /admin/api/secrets lists keys; POST /secrets/:name/reveal is the only read. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { createAdminConfigRoutes } from '../src/admin/config-routes.ts';
import type { AdminRequest, AdminResponse } from '../src/admin/servers.ts';
import { DbServerStore } from '../src/assembly-stores.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { createServer } from '../src/db/servers.ts';
import { createFileSecretStore } from '../src/secrets/store.ts';

async function fixture(
  t: TestContext,
): Promise<{ db: DatabaseSync; handler: ReturnType<typeof createAdminConfigRoutes> }> {
  const directory = await mkdtemp(join(tmpdir(), 'repl-secrets-route-'));
  const db = openStateDb(':memory:');
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  createServer(db, {
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio',
    command: 'npx',
    args: ['--token', { $secret: 'arg_token' }],
    env: {
      DATABASE_URL: { $secret: 'pg_db_url' },
      NODE_ENV: 'production',
    },
    headers: { Authorization: { $secret: 'github_pat' } },
  });
  createServer(db, {
    id: 'remote',
    label: 'Remote',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { 'X-Literal': 'literal-value' },
  });

  const secrets = createFileSecretStore(directory);
  await secrets.set('pg_db_url', 'postgres://secret-value');
  await secrets.set('stored_only', 'stored-value');

  const handler = createAdminConfigRoutes({
    secrets,
    servers: new DbServerStore(db),
    newOperationId: () => 'op_test',
  });
  return { db, handler };
}

async function getSecrets(
  handler: ReturnType<typeof createAdminConfigRoutes>,
): Promise<AdminResponse> {
  const request: AdminRequest = { method: 'GET', path: '/admin/api/secrets' };
  const response = await handler(request);
  assert.ok(response !== null);
  return response;
}

test('DELETE /secrets/:name reports whether the key existed and removes it', async (t) => {
  const { handler } = await fixture(t);

  const first = await handler({ method: 'DELETE', path: '/admin/api/secrets/stored_only' });
  assert.deepEqual(first, {
    status: 200,
    body: { name: 'stored_only', deleted: true },
  });

  const second = await handler({ method: 'DELETE', path: '/admin/api/secrets/stored_only' });
  assert.deepEqual(second, {
    status: 200,
    body: { name: 'stored_only', deleted: false },
  });

  const listed = await getSecrets(handler);
  assert.equal(JSON.stringify(listed.body).includes('stored_only'), false);

  const invalid = await handler({ method: 'DELETE', path: '/admin/api/secrets/__proto__' });
  assert.equal(invalid?.status, 400);
  assert.equal(
    (invalid?.body as { error: { code: string } }).error.code,
    'INVALID_FIELD',
  );

  assert.equal(await handler({ method: 'DELETE', path: '/admin/api/secrets' }), null);
});

test('GET /secrets unions stored names with env, header and arg declarations', async (t) => {
  const { handler } = await fixture(t);
  const response = await getSecrets(handler);
  assert.equal(response.status, 200);

  assert.deepEqual(response.body, {
    secrets: [
      { name: 'Authorization', configured: false },
      { name: 'DATABASE_URL', configured: false },
      { name: 'NODE_ENV', configured: false },
      { name: 'X-Literal', configured: false },
      { name: 'arg_token', configured: false },
      { name: 'github_pat', configured: false },
      { name: 'pg_db_url', configured: true },
      { name: 'stored_only', configured: true },
    ],
  });

  const serialized = JSON.stringify(response.body);
  for (const forbidden of ['secret-value', 'stored-value', 'literal-value', 'production']) {
    assert.equal(serialized.includes(forbidden), false, `response leaked ${forbidden}`);
  }
});

test('POST /secrets/:name/reveal returns exactly one stored value', async (t) => {
  const { handler } = await fixture(t);

  const revealed = await handler({
    method: 'POST',
    path: '/admin/api/secrets/pg_db_url/reveal',
  });
  assert.deepEqual(revealed, { status: 200, body: { name: 'pg_db_url', value: 'postgres://secret-value' } });

  const missing = await handler({
    method: 'POST',
    path: '/admin/api/secrets/not_set/reveal',
  });
  assert.equal(missing?.status, 404);
  assert.equal((missing?.body as { error: { code: string } }).error.code, 'SECRET_NOT_FOUND');

  const invalid = await handler({
    method: 'POST',
    path: '/admin/api/secrets/__proto__/reveal',
  });
  assert.equal(invalid?.status, 400);
  assert.equal((invalid?.body as { error: { code: string } }).error.code, 'INVALID_FIELD');

  const listed = await getSecrets(handler);
  assert.equal(JSON.stringify(listed.body).includes('secret-value'), false);
});
