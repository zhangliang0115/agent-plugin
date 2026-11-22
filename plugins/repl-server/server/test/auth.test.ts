import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveIdentity,
  toRequestIdentity,
  type ClientBinding,
  type ClientBindingLookup,
  type IdentityAllowed,
  type IdentityDenied,
  type IdentityOutcome,
} from '../src/auth/identity.ts';
import {
  authorizeAdminRequest,
  createCsrfToken,
  DEFAULT_HOST_ALLOWLIST,
  isAllowedHost,
  isLoopbackAddress,
  isLoopbackBindAddress,
  isSameOrigin,
  parseBearer,
  parseHostAllowlist,
  sha256Hex,
  timingSafeEqualString,
  verifyCsrf,
  type AdminAuthResult,
  type HostAllowlist,
} from '../src/auth/tokens.ts';

const CLIENT_TOKEN = 'client-token-abc';
const GLOBAL_TOKEN = 'global-test-token';
const ADMIN_TOKEN = 'admin-secret';
const HOST = '127.0.0.1:8787';
const ORIGIN = 'http://127.0.0.1:8787';

function createBindingStore(): {
  lookup: ClientBindingLookup;
  rows: ClientBinding[];
  calls: () => number;
} {
  let calls = 0;
  const rows: ClientBinding[] = [];
  const lookup: ClientBindingLookup = {
    async findByTokenHash(tokenHash) {
      calls += 1;
      return rows.find((row) => row.tokenHash === tokenHash) ?? null;
    },
  };
  return { lookup, rows, calls: () => calls };
}

function assertAllowed(outcome: IdentityOutcome): IdentityAllowed {
  if (!outcome.ok) throw new Error(`expected allow, got denial: ${outcome.error.reason}`);
  return outcome;
}

function assertIdentityDenied(outcome: IdentityOutcome): IdentityDenied {
  if (outcome.ok) throw new Error('expected a denial');
  return outcome;
}

function assertAdminDenied(result: AdminAuthResult): Extract<AdminAuthResult, { ok: false }> {
  if (result.ok) throw new Error('expected a denial');
  return result;
}

// --- token helpers ----------------------------------------------------------

test('sha256Hex matches a known vector and produces 64 lowercase hex chars', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.match(sha256Hex(''), /^[0-9a-f]{64}$/);
});

test('timingSafeEqualString compares content, including different lengths', () => {
  assert.equal(timingSafeEqualString('same', 'same'), true);
  assert.equal(timingSafeEqualString('same', 'diff'), false);
  assert.equal(timingSafeEqualString('a', 'a-longer-value'), false);
  assert.equal(timingSafeEqualString('', ''), true);
});

test('parseBearer distinguishes missing, malformed and valid headers', () => {
  assert.deepEqual(parseBearer(undefined), { kind: 'none' });
  assert.deepEqual(parseBearer(null), { kind: 'none' });
  assert.deepEqual(parseBearer(''), { kind: 'invalid' });
  assert.deepEqual(parseBearer('   '), { kind: 'invalid' });

  assert.deepEqual(parseBearer('Bearer abc.def-_~+/='), { kind: 'token', token: 'abc.def-_~+/=' });
  assert.deepEqual(parseBearer('bearer  abc'), { kind: 'token', token: 'abc' });

  assert.deepEqual(parseBearer('Basic abc'), { kind: 'invalid' });
  assert.deepEqual(parseBearer('Bearer'), { kind: 'invalid' });
  assert.deepEqual(parseBearer('Bearer '), { kind: 'invalid' });
  assert.deepEqual(parseBearer('Bearer abc def'), { kind: 'invalid' });
  assert.deepEqual(parseBearer('Bearer abc,def'), { kind: 'invalid' });
});

// --- MCP identity matrix ----------------------------------------------------

test('identity: a client token matching a binding is bound in both modes', async () => {
  for (const mode of ['loose', 'strict'] as const) {
    const store = createBindingStore();
    store.rows.push({ id: 'cb_1', label: 'work', tokenHash: sha256Hex(CLIENT_TOKEN) });

    const outcome = await resolveIdentity(
      { authorization: `Bearer ${CLIENT_TOKEN}`, client: 'claude-code/2.1.327' },
      { mode, bindings: store.lookup },
    );
    const allowed = assertAllowed(outcome);
    assert.equal(allowed.identity, 'bound');
    assert.equal(allowed.binding?.id, 'cb_1');
    assert.equal(allowed.reason, 'client_token');
    assert.equal(allowed.client, 'claude-code/2.1.327');
    assert.equal(store.calls(), 1);
  }
});

test('identity: the global mcp-token is unbound in loose mode and 401 in strict mode', async () => {
  const store = createBindingStore();
  const request = { authorization: `Bearer ${GLOBAL_TOKEN}` };

  const loose = assertAllowed(
    await resolveIdentity(request, { mode: 'loose', globalToken: GLOBAL_TOKEN, bindings: store.lookup }),
  );
  assert.equal(loose.identity, 'unbound');
  assert.equal(loose.binding, null);
  assert.equal(loose.reason, 'global_token');
  assert.equal(store.calls(), 0, 'the global token never reaches the binding store');

  const strict = assertIdentityDenied(
    await resolveIdentity(request, { mode: 'strict', globalToken: GLOBAL_TOKEN, bindings: store.lookup }),
  );
  assert.equal(strict.status, 401);
  assert.equal(strict.error.code, 'UNAUTHORIZED');
  assert.equal(strict.error.reason, 'global_token_disabled');
});

test('identity: no authorization is unbound in loose mode and 401 in strict mode', async () => {
  const store = createBindingStore();

  const loose = assertAllowed(await resolveIdentity({}, { mode: 'loose', bindings: store.lookup }));
  assert.equal(loose.identity, 'unbound');
  assert.equal(loose.binding, null);
  assert.equal(loose.reason, 'no_token');

  const strict = assertIdentityDenied(await resolveIdentity({}, { mode: 'strict', bindings: store.lookup }));
  assert.equal(strict.status, 401);
  assert.equal(strict.error.reason, 'missing_token');
  assert.equal(strict.wwwAuthenticate, 'Bearer');
});

test('identity: an unknown but well-formed token is always 401', async () => {
  const store = createBindingStore();
  for (const mode of ['loose', 'strict'] as const) {
    const denied = assertIdentityDenied(
      await resolveIdentity({ authorization: 'Bearer not-registered' }, { mode, bindings: store.lookup }),
    );
    assert.equal(denied.status, 401);
    assert.equal(denied.error.reason, 'unknown_token');
    assert.equal(denied.wwwAuthenticate, 'Bearer error="invalid_token"');
  }
});

test('identity: a malformed Authorization header is always 401, even in loose mode', async () => {
  const store = createBindingStore();
  for (const header of ['Basic abc', 'Bearer', 'Bearer two words']) {
    const denied = assertIdentityDenied(
      await resolveIdentity({ authorization: header }, { mode: 'loose', bindings: store.lookup }),
    );
    assert.equal(denied.status, 401);
    assert.equal(denied.error.reason, 'malformed_token');
  }
});

test('identity: a binding row without a usable id counts as unknown', async () => {
  const store = createBindingStore();
  store.rows.push({ id: '', tokenHash: sha256Hex(CLIENT_TOKEN) });

  const denied = assertIdentityDenied(
    await resolveIdentity({ authorization: `Bearer ${CLIENT_TOKEN}` }, { mode: 'loose', bindings: store.lookup }),
  );
  assert.equal(denied.error.reason, 'unknown_token');
});

test('identity: a row whose stored hash does not match is rejected', async () => {
  const lookup: ClientBindingLookup = {
    findByTokenHash: () => ({ id: 'cb_1', tokenHash: sha256Hex('a-different-token') }),
  };

  const denied = assertIdentityDenied(
    await resolveIdentity({ authorization: `Bearer ${CLIENT_TOKEN}` }, { mode: 'loose', bindings: lookup }),
  );
  assert.equal(denied.error.reason, 'unknown_token');
});

test('identity: a plaintext-token lookup (repository style) is also supported', async () => {
  const lookup: ClientBindingLookup = {
    findByToken: (candidate) =>
      candidate === CLIENT_TOKEN ? { id: 'cb_1', tokenHash: sha256Hex(CLIENT_TOKEN) } : null,
  };

  const allowed = assertAllowed(
    await resolveIdentity({ authorization: `Bearer ${CLIENT_TOKEN}` }, { bindings: lookup }),
  );
  assert.equal(allowed.binding?.id, 'cb_1');
});

test('identity: every request re-queries the binding store, so revocation is immediate', async () => {
  const store = createBindingStore();
  store.rows.push({ id: 'cb_1', tokenHash: sha256Hex(CLIENT_TOKEN) });
  const config = { mode: 'loose' as const, bindings: store.lookup };
  const request = { authorization: `Bearer ${CLIENT_TOKEN}` };

  assert.equal(assertAllowed(await resolveIdentity(request, config)).binding?.id, 'cb_1');
  assert.equal(store.calls(), 1);

  store.rows.length = 0;
  assertIdentityDenied(await resolveIdentity(request, config));
  assert.equal(store.calls(), 2);
});

test('identity: toRequestIdentity projects the binding id and session ids', async () => {
  const store = createBindingStore();
  store.rows.push({ id: 'cb_1', tokenHash: sha256Hex(CLIENT_TOKEN) });
  const allowed = assertAllowed(
    await resolveIdentity(
      {
        authorization: `Bearer ${CLIENT_TOKEN}`,
        client: 'claude-code/2.1.327',
        clientName: 'claude-code',
        clientVersion: '2.1.327',
      },
      { mode: 'strict', bindings: store.lookup },
    ),
  );

  assert.deepEqual(toRequestIdentity(allowed, { mcp: 'mcp_1', exec: 'es_1' }), {
    identity: 'bound',
    binding: 'cb_1',
    client: 'claude-code/2.1.327',
    clientName: 'claude-code',
    clientVersion: '2.1.327',
    mcp: 'mcp_1',
    exec: 'es_1',
  });

  const unbound = toRequestIdentity(
    {
      ok: true,
      identity: 'unbound',
      binding: null,
      reason: 'no_token',
      client: '',
      clientName: '',
      clientVersion: '',
    },
    { mcp: 'mcp_2' },
  );
  assert.deepEqual(unbound, {
    identity: 'unbound',
    binding: null,
    client: '',
    clientName: '',
    clientVersion: '',
    mcp: 'mcp_2',
  });
});

// --- admin gate -------------------------------------------------------------

test('admin: host check strips the port and rejects rebinding-style hosts', () => {
  assert.equal(isAllowedHost('127.0.0.1'), true);
  assert.equal(isAllowedHost('127.0.0.1:8787'), true);
  assert.equal(isAllowedHost('localhost:8787'), true);
  assert.equal(isAllowedHost('LOCALHOST'), true);

  assert.equal(isAllowedHost('evil.example:8787'), false);
  assert.equal(isAllowedHost('127.0.0.1.evil.example'), false);
  assert.equal(isAllowedHost('evil.example:127.0.0.1:8787'), false);
  assert.equal(isAllowedHost('[::1]:8787'), false);
  assert.equal(isAllowedHost(undefined), false);
  assert.equal(isAllowedHost(''), false);
});

test('admin: custom host allowlists accept a tailnet suffix without opening other names', () => {
  const tailnet: HostAllowlist = ['*.ts.net', '127.0.0.1', 'localhost'];
  assert.equal(isAllowedHost('sh-mac.tail27b036.ts.net:8787', tailnet), true);
  assert.equal(isAllowedHost('SH-MAC.TAIL27B036.TS.NET', tailnet), true);
  assert.equal(isAllowedHost('ts.net', tailnet), true);
  assert.equal(isAllowedHost('evil.example:8787', tailnet), false);
  assert.equal(isAllowedHost('evilts.net', tailnet), false);
  assert.equal(isAllowedHost('sh-mac.tail27b036.ts.net', '*'), true);
  assert.equal(isAllowedHost('evil.example', ['*']), true);
  assert.equal(isAllowedHost('[::1]:8787', ['[::1]']), true);
});

test('admin: parseHostAllowlist keeps the default for empty input and supports wildcards', () => {
  assert.deepEqual(parseHostAllowlist(undefined), DEFAULT_HOST_ALLOWLIST);
  assert.deepEqual(parseHostAllowlist('  '), DEFAULT_HOST_ALLOWLIST);
  assert.deepEqual(parseHostAllowlist(' , '), DEFAULT_HOST_ALLOWLIST);
  assert.equal(parseHostAllowlist('*'), '*');
  assert.deepEqual(parseHostAllowlist('127.0.0.1, localhost ,*.ts.net'), [
    '127.0.0.1',
    'localhost',
    '*.ts.net',
  ]);
});

test('admin: loopback bind detection covers IPv4, names and IPv6', () => {
  assert.equal(isLoopbackBindAddress('127.0.0.1'), true);
  assert.equal(isLoopbackBindAddress('localhost'), true);
  assert.equal(isLoopbackBindAddress('::1'), true);
  assert.equal(isLoopbackBindAddress('[::1]'), true);
  assert.equal(isLoopbackBindAddress('0.0.0.0'), false);
  assert.equal(isLoopbackBindAddress('100.87.103.111'), false);
  assert.equal(isLoopbackBindAddress('sh-mac.tail27b036.ts.net'), false);
});

test('admin: only loopback TCP peers qualify for auto-login', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.50'), false);
  assert.equal(isLoopbackAddress('100.87.103.111'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('admin: same-origin comparison uses the host header, including the port', () => {
  assert.equal(isSameOrigin(ORIGIN, HOST), true);
  assert.equal(isSameOrigin('http://localhost:8787', 'localhost:8787'), true);
  assert.equal(isSameOrigin('http://localhost:8787', HOST), false);
  assert.equal(isSameOrigin('http://127.0.0.1:9999', HOST), false);
  assert.equal(isSameOrigin('https://127.0.0.1:8787', HOST), true);
  assert.equal(isSameOrigin('null', HOST), false);
  assert.equal(isSameOrigin(undefined, HOST), false);
  assert.equal(isSameOrigin(ORIGIN, undefined), false);
});

test('admin: csrf tokens are random hex and compared exactly', () => {
  const first = createCsrfToken();
  const second = createCsrfToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.equal(verifyCsrf(first, first), true);
  assert.equal(verifyCsrf(first, second), false);
  assert.equal(verifyCsrf(undefined, first), false);
  assert.equal(verifyCsrf(first, undefined), false);
  assert.equal(verifyCsrf('', ''), false);
});

test('admin: bearer admin-token authorizes reads and writes without Origin/CSRF', () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const result = authorizeAdminRequest(
      { method, host: HOST, authorization: `Bearer ${ADMIN_TOKEN}` },
      { adminToken: ADMIN_TOKEN },
    );
    assert.deepEqual(result, { ok: true, via: 'bearer' });
  }
});

test('admin: a missing or wrong token is 401', () => {
  const missing = assertAdminDenied(
    authorizeAdminRequest({ method: 'GET', host: HOST }, { adminToken: ADMIN_TOKEN }),
  );
  assert.equal(missing.status, 401);
  assert.equal(missing.error.code, 'UNAUTHORIZED');
  assert.equal(missing.wwwAuthenticate, 'Bearer');

  const wrong = assertAdminDenied(
    authorizeAdminRequest(
      { method: 'GET', host: HOST, authorization: 'Bearer nope' },
      { adminToken: ADMIN_TOKEN },
    ),
  );
  assert.equal(wrong.status, 401);
  assert.equal(wrong.error.code, 'UNAUTHORIZED');
  assert.equal(wrong.wwwAuthenticate, 'Bearer error="invalid_token"');
});

test('admin: an unacceptable Host is 403 even with the right token', () => {
  const result = assertAdminDenied(
    authorizeAdminRequest(
      { method: 'GET', host: 'evil.example:8787', authorization: `Bearer ${ADMIN_TOKEN}` },
      { adminToken: ADMIN_TOKEN },
    ),
  );
  assert.equal(result.status, 403);
  assert.equal(result.error.code, 'FORBIDDEN_HOST');
});

test('admin: a cookie session can read without CSRF but writes need same-origin and CSRF', () => {
  const csrfToken = createCsrfToken();
  const config = { adminToken: ADMIN_TOKEN, csrfToken };

  const read = authorizeAdminRequest(
    { method: 'GET', host: HOST, sessionAuthenticated: true },
    config,
  );
  assert.deepEqual(read, { ok: true, via: 'session' });

  const write = authorizeAdminRequest(
    {
      method: 'POST',
      host: HOST,
      origin: ORIGIN,
      csrfToken,
      sessionAuthenticated: true,
    },
    config,
  );
  assert.deepEqual(write, { ok: true, via: 'session' });

  const crossOrigin = assertAdminDenied(
    authorizeAdminRequest(
      {
        method: 'POST',
        host: HOST,
        origin: 'http://evil.example:8787',
        csrfToken,
        sessionAuthenticated: true,
      },
      config,
    ),
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.error.code, 'CROSS_ORIGIN');

  const noOrigin = assertAdminDenied(
    authorizeAdminRequest(
      { method: 'DELETE', host: HOST, csrfToken, sessionAuthenticated: true },
      config,
    ),
  );
  assert.equal(noOrigin.error.code, 'CROSS_ORIGIN');

  const missingCsrf = assertAdminDenied(
    authorizeAdminRequest(
      { method: 'POST', host: HOST, origin: ORIGIN, sessionAuthenticated: true },
      config,
    ),
  );
  assert.equal(missingCsrf.status, 403);
  assert.equal(missingCsrf.error.code, 'CSRF_FAILED');

  const wrongCsrf = assertAdminDenied(
    authorizeAdminRequest(
      {
        method: 'POST',
        host: HOST,
        origin: ORIGIN,
        csrfToken: createCsrfToken(),
        sessionAuthenticated: true,
      },
      config,
    ),
  );
  assert.equal(wrongCsrf.error.code, 'CSRF_FAILED');

  const noIssuedCsrf = assertAdminDenied(
    authorizeAdminRequest(
      { method: 'POST', host: HOST, origin: ORIGIN, csrfToken, sessionAuthenticated: true },
      { adminToken: ADMIN_TOKEN },
    ),
  );
  assert.equal(noIssuedCsrf.error.code, 'CSRF_FAILED');
});

test('admin: an unauthenticated request never reaches the CSRF checks', () => {
  const result = assertAdminDenied(
    authorizeAdminRequest(
      { method: 'POST', host: HOST, origin: ORIGIN, csrfToken: createCsrfToken() },
      { adminToken: ADMIN_TOKEN },
    ),
  );
  assert.equal(result.status, 401);
  assert.equal(result.error.code, 'UNAUTHORIZED');
});
