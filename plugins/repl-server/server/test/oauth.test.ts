import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  authorizationServerMetadata,
  OAuthStore,
  protectedResourceMetadata,
  verifyPkce,
  type StoredAuthorization,
} from '../src/auth/oauth.ts';

const BASE = 'http://127.0.0.1:8787';
const REDIRECT = 'http://127.0.0.1:9999/callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = 'test-verifier-0123456789abcdef0123456789abcdef';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function registered(store: OAuthStore): string {
  return store.register({ clientName: 'test-client', redirectUris: [REDIRECT] }).clientId;
}

test('PRM advertises the MCP resource and the local authorization server', () => {
  const prm = protectedResourceMetadata(BASE);
  assert.equal(prm['resource'], `${BASE}/mcp`);
  assert.deepEqual(prm['authorization_servers'], [BASE]);
  assert.deepEqual(prm['bearer_methods_supported'], ['header']);
});

test('AS metadata points at the mounted endpoints and requires PKCE S256', () => {
  const meta = authorizationServerMetadata(BASE);
  assert.equal(meta['issuer'], BASE);
  assert.equal(meta['authorization_endpoint'], `${BASE}/authorize`);
  assert.equal(meta['token_endpoint'], `${BASE}/token`);
  assert.equal(meta['registration_endpoint'], `${BASE}/register`);
  assert.deepEqual(meta['code_challenge_methods_supported'], ['S256']);
});

test('verifyPkce accepts the matching verifier and rejects any other', () => {
  const { verifier, challenge } = pkce();
  assert.equal(verifyPkce(verifier, challenge), true);
  assert.equal(verifyPkce('wrong-verifier', challenge), false);
});

test('the authorization code is single-use and bound to client, redirect and PKCE', () => {
  const store = new OAuthStore();
  const clientId = registered(store);
  const { verifier, challenge } = pkce();
  const issue = (): string =>
    store.issueCode({ clientId, redirectUri: REDIRECT, codeChallenge: challenge, resource: `${BASE}/mcp` });

  assert.equal(store.takeCode({ code: issue(), clientId, redirectUri: REDIRECT, verifier: 'wrong' }), undefined);
  assert.equal(store.takeCode({ code: issue(), clientId: 'other', redirectUri: REDIRECT, verifier }), undefined);
  assert.equal(store.takeCode({ code: issue(), clientId, redirectUri: 'http://127.0.0.1:9/x', verifier }), undefined);

  const good = issue();
  assert.notEqual(store.takeCode({ code: good, clientId, redirectUri: REDIRECT, verifier }), undefined);
  assert.equal(store.takeCode({ code: good, clientId, redirectUri: REDIRECT, verifier }), undefined);
});

test('issued access tokens resolve until they expire', () => {
  const store = new OAuthStore();
  const clientId = registered(store);
  const tokens = store.issueTokens(clientId);
  assert.deepEqual(store.inspect(tokens.accessToken), { clientId, bindingId: null });
  assert.equal(store.inspect('not-a-token'), undefined);
});

test('refresh rotates the pair and rejects reuse of the old refresh token', () => {
  const store = new OAuthStore();
  const clientId = registered(store);
  const first = store.issueTokens(clientId);

  const second = store.refreshTokens(first.refreshToken);
  assert.notEqual(second, undefined);
  assert.notEqual(second?.accessToken, first.accessToken);
  assert.equal(store.inspect(first.accessToken), undefined);

  assert.equal(store.refreshTokens(first.refreshToken), undefined);
  assert.deepEqual(store.inspect(second?.accessToken ?? ''), { clientId, bindingId: null });
});

test('unknown refresh tokens are rejected', () => {
  const store = new OAuthStore();
  assert.equal(store.refreshTokens('rt_unknown'), undefined);
});

test('register keeps the redirect URIs the client declared', () => {
  const store = new OAuthStore();
  const client = store.register({ clientName: 'c', redirectUris: [REDIRECT, 'http://127.0.0.1:9998/cb'] });
  assert.deepEqual(store.client(client.clientId)?.redirectUris, [REDIRECT, 'http://127.0.0.1:9998/cb']);
  assert.equal(store.client('missing'), undefined);
});

test('authorizations survive a restart through persistence', () => {
  const rows: StoredAuthorization[] = [];
  const persistence = {
    list: () => rows,
    save: (row: StoredAuthorization) => {
      const index = rows.findIndex((entry) => entry.accessHash === row.accessHash);
      if (index === -1) rows.push(row);
      else rows[index] = row;
    },
    remove: (hash: string) => {
      const index = rows.findIndex((entry) => entry.accessHash === hash);
      if (index !== -1) rows.splice(index, 1);
    },
  };
  const store = new OAuthStore(persistence);
  const clientId = registered(store);
  const tokens = store.issueTokens(clientId, 'cb_bound');

  const restored = new OAuthStore(persistence);
  assert.deepEqual(restored.inspect(tokens.accessToken), { clientId, bindingId: 'cb_bound' });

  const rotated = restored.refreshTokens(tokens.refreshToken);
  assert.notEqual(rotated, undefined);
  assert.equal(rows.length, 1, 'the old row is replaced, not stacked');
  assert.deepEqual(new OAuthStore(persistence).inspect(rotated?.accessToken ?? ''), {
    clientId,
    bindingId: 'cb_bound',
  });
});

test('listAuthorizations reports live grants with their binding and deadlines', () => {
  const store = new OAuthStore();
  const clientId = registered(store);
  store.issueTokens(clientId, 'cb_bound');
  const [grant] = store.listAuthorizations();
  assert.equal(grant?.clientId, clientId);
  assert.equal(grant?.clientName, 'test-client');
  assert.equal(grant?.bindingId, 'cb_bound');
  assert.notEqual(grant?.refreshExpiresAt, null);
});

test('revokeClient drops the memory and persisted rows of one client', () => {
  const rows: StoredAuthorization[] = [];
  const persistence = {
    list: () => rows,
    save: (row: StoredAuthorization) => {
      rows.push(row);
    },
    remove: (hash: string) => {
      const index = rows.findIndex((entry) => entry.accessHash === hash);
      if (index !== -1) rows.splice(index, 1);
    },
  };
  const store = new OAuthStore(persistence);
  const clientId = registered(store);
  const tokens = store.issueTokens(clientId);
  assert.equal(store.revokeClient(clientId), 1);
  assert.equal(store.inspect(tokens.accessToken), undefined);
  assert.equal(rows.length, 0);
});

test('the client cap evicts the oldest registration', () => {
  const store = new OAuthStore();
  const ids: string[] = [];
  for (let index = 0; index < 65; index += 1) {
    ids.push(store.register({ redirectUris: [REDIRECT] }).clientId);
  }
  assert.equal(store.client(ids[0] ?? ''), undefined);
  assert.notEqual(store.client(ids[64] ?? ''), undefined);
});
