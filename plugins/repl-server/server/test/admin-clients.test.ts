/** Admin client-binding endpoints: one-time tokens, listing and binding-change cleanup. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createAdminClientsHandler,
  type BindingChange,
  type ClientBinding,
  type ClientBindingInput,
  type ClientBindingPatch,
  type ClientBindingStore,
  type McpSessionRecord,
} from '../src/admin/clients.ts';
import type {
  AdminHandler,
  AdminRequest,
  AdminResponse,
} from '../src/admin/servers.ts';

type StoredBinding = ClientBinding & { tokenHash: string };

class MemoryBindingStore implements ClientBindingStore {
  readonly rows = new Map<string, StoredBinding>();
  readonly tokenHashes: string[] = [];
  private counter = 0;

  async list(): Promise<ClientBinding[]> {
    return [...this.rows.values()];
  }

  async get(id: string): Promise<ClientBinding | null> {
    return this.rows.get(id) ?? null;
  }

  async create(input: ClientBindingInput & { token: string }): Promise<ClientBinding> {
    this.counter += 1;
    const tokenHash = sha256(input.token);
    this.tokenHashes.push(tokenHash);
    const row: StoredBinding = {
      id: `cb_${this.counter}`,
      label: input.label,
      defaultWorkspace: input.defaultWorkspace,
      allowedServers: input.allowedServers,
      allowedTags: input.allowedTags,
      quota: input.quota,
      createdAt: new Date(1_700_000_000_000).toISOString(),
      lastSeenAt: null,
      tokenHash,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async update(id: string, patch: ClientBindingPatch): Promise<ClientBinding> {
    const current = this.rows.get(id);
    assert.ok(current !== undefined, `missing binding ${id}`);
    const next: StoredBinding = { ...current, ...patch };
    this.rows.set(id, next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
): AdminRequest {
  const request: AdminRequest = { method, path };
  if (body !== undefined) request.body = body;
  return request;
}

async function call(handler: AdminHandler, request: AdminRequest): Promise<AdminResponse> {
  const response = await handler(request);
  assert.ok(response !== null, `expected ${request.method} ${request.path} to be handled`);
  return response;
}

function bodyOf(response: AdminResponse): Record<string, unknown> {
  assert.ok(typeof response.body === 'object' && response.body !== null);
  return response.body as Record<string, unknown>;
}

function errorCode(response: AdminResponse): string {
  const error = bodyOf(response)['error'];
  assert.ok(typeof error === 'object' && error !== null);
  return String((error as Record<string, unknown>)['code']);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function setup(options: { token?: string; callbackResult?: number } = {}): {
  handler: AdminHandler;
  store: MemoryBindingStore;
  changes: Array<[string, BindingChange]>;
  sessions: McpSessionRecord[];
  callbackState: { error: Error | null };
} {
  const store = new MemoryBindingStore();
  const changes: Array<[string, BindingChange]> = [];
  const callbackState: { error: Error | null } = { error: null };
  const sessions: McpSessionRecord[] = [
    {
      mcpSessionId: 'mcp_1',
      bindingId: 'cb_1',
      client: 'claude-code/2.1.327',
      lastRequestAt: '2026-11-18T00:00:00.000Z',
    },
    { mcpSessionId: 'mcp_2', bindingId: null, client: 'cursor/0.44' },
    {
      mcpSessionId: 'mcp_3',
      bindingId: 'cb_1',
      client: 'other/1.0',
      execSessionIds: ['es_1'],
    },
  ];

  const handler = createAdminClientsHandler({
    bindings: store,
    onBindingChanged: (bindingId, change) => {
      changes.push([bindingId, change]);
      if (callbackState.error !== null) throw callbackState.error;
      return options.callbackResult ?? 3;
    },
    sessions: { list: async () => sessions },
    tokenFactory: () => options.token ?? 'client-test-token-0123456789',
  });

  return { handler, store, changes, sessions, callbackState };
}

test('POST /clients returns the plaintext token once and stores only its hash', async () => {
  const token = 'client-test-token-0123456789';
  const { handler, store } = setup({ token });

  const response = await call(
    handler,
    makeRequest('POST', '/admin/api/clients', {
      label: 'claude-code-work',
      defaultWorkspace: '/repo/a',
      allowedServers: ['pg'],
      allowedTags: ['read', 'write'],
      quota: { maxExecSessionsPerBinding: 2 },
    }),
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers?.['cache-control'], 'no-store');
  const body = bodyOf(response);
  assert.equal(body['token'], token);

  const client = body['client'] as Record<string, unknown>;
  assert.equal(client['id'], 'cb_1');
  assert.equal(client['label'], 'claude-code-work');
  assert.deepEqual(client['allowedServers'], ['pg']);
  assert.equal('tokenHash' in client, false);
  assert.equal(store.tokenHashes.length, 1);
  assert.equal(store.tokenHashes[0], sha256(token));

  const listed = await call(handler, makeRequest('GET', '/clients'));
  const serialized = JSON.stringify(listed.body);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(sha256(token)), false);
  assert.equal(serialized.includes('tokenHash'), false);
});

test('POST /clients validates the binding shape', async () => {
  const { handler } = setup();

  const missingLabel = await call(handler, makeRequest('POST', '/clients', {}));
  assert.equal(missingLabel.status, 400);
  assert.equal(errorCode(missingLabel), 'INVALID_FIELD');

  const unknown = await call(
    handler,
    makeRequest('POST', '/clients', { label: 'x', token: 'nope' }),
  );
  assert.equal(unknown.status, 400);
  assert.equal(errorCode(unknown), 'UNKNOWN_FIELD');

  const relative = await call(
    handler,
    makeRequest('POST', '/clients', { label: 'x', defaultWorkspace: 'repo/a' }),
  );
  assert.equal(relative.status, 400);
  assert.equal(errorCode(relative), 'INVALID_FIELD');

  const badQuota = await call(
    handler,
    makeRequest('POST', '/clients', { label: 'x', quota: { maxClients: 1 } }),
  );
  assert.equal(badQuota.status, 422);
  assert.equal(errorCode(badQuota), 'UNKNOWN_QUOTA_KEY');

  const negativeQuota = await call(
    handler,
    makeRequest('POST', '/clients', { label: 'x', quota: { maxExecSessionsPerBinding: -1 } }),
  );
  assert.equal(negativeQuota.status, 400);

  const badServers = await call(
    handler,
    makeRequest('POST', '/clients', { label: 'x', allowedServers: 'pg' }),
  );
  assert.equal(badServers.status, 400);

  const invalidJson = await call(handler, makeRequest('POST', '/clients', '{"label":'));
  assert.equal(invalidJson.status, 400);
  assert.equal(errorCode(invalidJson), 'INVALID_JSON');
});

test('GET /clients returns bindings, active sessions and per-binding counts', async () => {
  const { handler } = setup();
  await call(handler, makeRequest('POST', '/clients', { label: 'work' }));

  const response = await call(handler, makeRequest('GET', '/admin/api/clients'));
  assert.equal(response.status, 200);
  const body = bodyOf(response);

  const clients = body['clients'] as Record<string, unknown>[];
  assert.equal(clients.length, 1);
  assert.equal(clients[0]!['activeSessions'], 2);

  const sessions = body['sessions'] as Record<string, unknown>[];
  assert.equal(sessions.length, 3);
  assert.deepEqual(
    sessions.map((session) => session['mcpSessionId']),
    ['mcp_1', 'mcp_2', 'mcp_3'],
  );
  assert.deepEqual(sessions[2]!['execSessionIds'], ['es_1']);
});

test('PUT /clients/:id updates the binding and destroys its execution sessions', async () => {
  const { handler, store, changes } = setup({ callbackResult: 2 });
  await call(handler, makeRequest('POST', '/clients', { label: 'work', allowedServers: ['pg'] }));

  const missing = await call(
    handler,
    makeRequest('PUT', '/clients/cb_404', { label: 'x' }),
  );
  assert.equal(missing.status, 404);
  assert.equal(errorCode(missing), 'CLIENT_NOT_FOUND');

  const empty = await call(handler, makeRequest('PUT', '/clients/cb_1', {}));
  assert.equal(empty.status, 422);
  assert.equal(errorCode(empty), 'EMPTY_PATCH');

  const response = await call(
    handler,
    makeRequest('PUT', '/admin/api/clients/cb_1', {
      label: 'work-laptop',
      allowedServers: null,
      allowedTags: ['read'],
      quota: null,
    }),
  );
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body['affectedSessions'], 2);
  const client = body['client'] as Record<string, unknown>;
  assert.equal(client['label'], 'work-laptop');
  assert.equal(client['allowedServers'], null);
  assert.deepEqual(client['allowedTags'], ['read']);
  assert.equal(client['quota'], null);
  assert.deepEqual(changes, [['cb_1', 'updated']]);
  assert.equal(store.rows.get('cb_1')?.label, 'work-laptop');
});

test('PUT still reports a callback failure instead of hiding it', async () => {
  const { handler, changes, callbackState } = setup();
  await call(handler, makeRequest('POST', '/clients', { label: 'work' }));
  callbackState.error = new Error('worker shutdown failed');

  const response = await call(
    handler,
    makeRequest('PUT', '/clients/cb_1', { label: 'renamed' }),
  );
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body['affectedSessions'], 0);
  assert.match(String(body['warning']), /worker shutdown failed/);
  assert.deepEqual(changes, [['cb_1', 'updated']]);
});

test('DELETE /clients/:id removes the binding and invalidates the token', async () => {
  const { handler, store, changes } = setup({ callbackResult: 1 });
  await call(handler, makeRequest('POST', '/clients', { label: 'work' }));

  const response = await call(handler, makeRequest('DELETE', '/admin/api/clients/cb_1'));
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body['deleted'], true);
  assert.equal(body['id'], 'cb_1');
  assert.equal(body['affectedSessions'], 1);
  assert.deepEqual(changes, [['cb_1', 'deleted']]);
  assert.equal(store.rows.has('cb_1'), false);

  const again = await call(handler, makeRequest('DELETE', '/clients/cb_1'));
  assert.equal(again.status, 404);
  assert.equal(errorCode(again), 'CLIENT_NOT_FOUND');

  assert.equal(await handler(makeRequest('PATCH', '/clients/cb_1')), null);
  assert.equal(await handler(makeRequest('GET', '/clients/cb_1')), null);
});
