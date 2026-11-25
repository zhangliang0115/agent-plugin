/** CSRF self-healing: a stale token gets one refresh and one retry, errors stay unchanged. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, createApiClient } from '../src/lib/api.ts';

interface Call {
  url: string;
  method: string;
  csrf: string | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function csrfFailure(): Response {
  return json(403, {
    error: { code: 'CSRF_FAILED', message: 'missing or invalid X-CSRF-Token' },
  });
}

/** Fetch double that records method, URL and the CSRF header of every call. */
function fakeFetch(handler: (call: Call) => Response | Promise<Response>): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: Call = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      csrf: headers.get('x-csrf-token'),
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const CSRF_PATH = '/admin/api/csrf';

function cookieClient(
  fetchImpl: typeof fetch,
  extra: { onUnauthorized?: () => void } = {},
): ReturnType<typeof createApiClient> {
  return createApiClient({
    baseUrl: '/admin/api',
    storage: null,
    fetch: fetchImpl,
    csrfToken: 'old',
    ...extra,
  });
}

test('refreshes the CSRF token once and retries a rejected write', async () => {
  let posts = 0;
  const { calls, fetchImpl } = fakeFetch((call) => {
    if (call.method === 'GET' && call.url === CSRF_PATH) return json(200, { csrfToken: 'new' });
    posts += 1;
    return posts === 1 ? csrfFailure() : json(200, { ok: true });
  });
  const api = cookieClient(fetchImpl);

  const result = await api.post('/items', { name: 'x' });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ['POST /admin/api/items', `GET ${CSRF_PATH}`, 'POST /admin/api/items'],
  );
  assert.equal(calls[0]?.csrf, 'old');
  assert.equal(calls[2]?.csrf, 'new');
  assert.equal(api.getCsrfToken(), 'new');
});

test('gives up after one retry when the refreshed token is also rejected', async () => {
  let posts = 0;
  let refreshes = 0;
  const { calls, fetchImpl } = fakeFetch((call) => {
    if (call.method === 'GET' && call.url === CSRF_PATH) {
      refreshes += 1;
      return json(200, { csrfToken: 'new' });
    }
    posts += 1;
    return csrfFailure();
  });
  const api = cookieClient(fetchImpl);

  await assert.rejects(api.post('/items', { name: 'x' }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'CSRF_FAILED');
    assert.equal(error.message, 'missing or invalid X-CSRF-Token');
    return true;
  });
  assert.equal(refreshes, 1);
  assert.equal(posts, 2);
  assert.equal(calls.length, 3);
});

test('shares one in-flight token exchange between concurrent rejected writes', async () => {
  let refreshCalls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstAttempts = new Set<string>();
  const { calls, fetchImpl } = fakeFetch(async (call) => {
    if (call.method === 'GET' && call.url === CSRF_PATH) {
      refreshCalls += 1;
      await gate;
      return json(200, { csrfToken: 'new' });
    }
    if (!firstAttempts.has(call.url)) {
      firstAttempts.add(call.url);
      return csrfFailure();
    }
    return json(200, { ok: true });
  });
  const api = cookieClient(fetchImpl);

  const first = api.post('/items/a', { n: 1 });
  const second = api.post('/items/b', { n: 2 });
  // Both writes are rejected with the stale token before the exchange resolves.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();

  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: true });
  assert.equal(refreshCalls, 1);
  const exchangeCalls = calls.filter((call) => call.method === 'GET' && call.url === CSRF_PATH);
  assert.equal(exchangeCalls.length, 1);
  const retries = calls.filter((call) => call.method === 'POST');
  assert.equal(retries.length, 4);
  assert.equal(retries[2]?.csrf, 'new');
  assert.equal(retries[3]?.csrf, 'new');
});

test('throws the original CSRF error when the token exchange fails', async () => {
  for (const failure of ['http-500', 'network'] as const) {
    let posts = 0;
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.method === 'GET' && call.url === CSRF_PATH) {
        if (failure === 'network') throw new TypeError('offline');
        return json(500, { error: { code: 'INTERNAL', message: 'boom' } });
      }
      posts += 1;
      return csrfFailure();
    });
    const api = cookieClient(fetchImpl);

    await assert.rejects(api.post('/items', { name: failure }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'CSRF_FAILED');
      assert.equal(error.message, 'missing or invalid X-CSRF-Token');
      return true;
    });
    assert.equal(posts, 1);
    assert.equal(calls.length, 2);
  }
});

test('treats a 401 from the token exchange as unauthorized and keeps the original error', async () => {
  let unauthorized = 0;
  const { fetchImpl } = fakeFetch((call) =>
    call.method === 'GET' && call.url === CSRF_PATH
      ? json(401, { error: { code: 'UNAUTHORIZED', message: 'admin token required' } })
      : csrfFailure(),
  );
  const api = cookieClient(fetchImpl, { onUnauthorized: () => (unauthorized += 1) });

  await assert.rejects(
    api.post('/items', { name: 'x' }),
    (error: unknown) => error instanceof ApiError && error.code === 'CSRF_FAILED',
  );
  assert.equal(unauthorized, 1);
});

test('does not refresh the CSRF token on 401', async () => {
  let unauthorized = 0;
  const { calls, fetchImpl } = fakeFetch(() =>
    json(401, { error: { code: 'UNAUTHORIZED', message: 'admin token required' } }),
  );
  const api = cookieClient(fetchImpl, { onUnauthorized: () => (unauthorized += 1) });

  await assert.rejects(
    api.post('/items', { name: 'x' }),
    (error: unknown) => error instanceof ApiError && error.code === 'UNAUTHORIZED',
  );
  assert.equal(unauthorized, 1);
  assert.deepEqual(calls, [{ url: '/admin/api/items', method: 'POST', csrf: 'old' }]);
});

test('does not refresh or retry in Bearer mode', async () => {
  const { calls, fetchImpl } = fakeFetch((call) =>
    call.method === 'GET' ? json(200, { csrfToken: 'new' }) : csrfFailure(),
  );
  const api = createApiClient({
    baseUrl: '/admin/api',
    storage: null,
    fetch: fetchImpl,
    token: 'bearer-token',
    csrfToken: 'old',
  });

  await assert.rejects(
    api.post('/items', { name: 'x' }),
    (error: unknown) => error instanceof ApiError && error.code === 'CSRF_FAILED',
  );
  assert.equal(calls.length, 1);
  assert.equal(api.getCsrfToken(), 'old');
});
