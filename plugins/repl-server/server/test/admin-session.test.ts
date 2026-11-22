// hook-allow: localhost-only test fetch, no external egress
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseCookieHeader, serializeCookie, type HostAllowlist } from '../src/auth/tokens.ts';
import { handleAdminHttp } from '../src/admin/http-adapter.ts';
import { createAdminOverviewHandler } from '../src/admin/overview.ts';
import {
  createAdminBootstrapHandler,
  createAdminSession,
  type AdminSession,
} from '../src/admin/session.ts';
import type { AdminHandler } from '../src/admin/servers.ts';

const ADMIN_TOKEN = 'admin-secret';
const COOKIE_NAME = 'repl_admin_session';

const echoHandler: AdminHandler = async (request) => {
  if (request.method !== 'POST' || request.path !== '/admin/api/echo') return null;
  return { status: 200, body: { ok: true, body: request.body ?? null } };
};

async function createStaticDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repl-admin-session-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>admin shell</body></html>');
  await writeFile(join(dir, 'main.js'), 'console.log("admin");');
  return dir;
}

interface Harness {
  base: string;
  close(): Promise<void>;
}

async function listen(options: {
  session?: AdminSession;
  staticDir?: string;
  handlers?: readonly AdminHandler[];
  adminAutoLogin?: boolean;
  allowedHosts?: HostAllowlist;
}): Promise<Harness> {
  const handlers: AdminHandler[] = [...(options.handlers ?? [])];
  if (options.staticDir !== undefined) {
    handlers.push(
      createAdminOverviewHandler({
        overview: () => ({
          capacity: {},
          pool: { total: 0, ready: 0, reconnecting: 0, failed: 0 },
          sessions: { transport: 0, exec: 0, inFlightEvals: 0 },
          servers: { total: 0, enabled: 0 },
        }),
        staticDir: options.staticDir,
      }),
    );
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const handled = await handleAdminHttp(req, res, url, {
        handlers,
        adminToken: ADMIN_TOKEN,
        ...(options.session === undefined ? {} : { session: options.session }),
        ...(options.adminAutoLogin === undefined ? {} : { adminAutoLogin: options.adminAutoLogin }),
        ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
        log: () => undefined,
      });
      if (!handled && !res.headersSent) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"error":{"code":"NOT_FOUND","message":"unknown admin route"}}');
      }
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(error));
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const base = `http://127.0.0.1:${(address as AddressInfo).port}`;

  return {
    base,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (options.staticDir !== undefined) {
        await rm(options.staticDir, { recursive: true, force: true });
      }
    },
  };
}

function bootstrap(base: string, token: string): Promise<Response> {
  return fetch(`${base}/admin?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
}

/** Extracts the `name=value` pair from the single Set-Cookie header. */
function sessionCookie(response: Response): string {
  const headers = response.headers.getSetCookie();
  assert.equal(headers.length, 1, 'expected exactly one Set-Cookie header');
  const raw = headers[0] ?? '';
  const pair = raw.split(';')[0] ?? '';
  assert.match(pair, new RegExp(`^${COOKIE_NAME}=[0-9a-f]{64}$`));
  return pair;
}

async function csrfTokenFor(base: string, cookie: string): Promise<string> {
  const response = await fetch(`${base}/admin/api/csrf`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { csrfToken: string | null };
  assert.match(body.csrfToken ?? '', /^[0-9a-f]{64}$/);
  return body.csrfToken ?? '';
}

function rawGet(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// --- cookie helpers ---------------------------------------------------------

test('cookie parsing keeps the first value, tolerates malformed pairs and strips quotes', () => {
  assert.deepEqual({ ...parseCookieHeader('a=1; b=two; a=3; broken; c="quoted"; d=') }, {
    a: '1',
    b: 'two',
    c: 'quoted',
    d: '',
  });
  assert.deepEqual({ ...parseCookieHeader(undefined) }, {});
  assert.deepEqual({ ...parseCookieHeader('') }, {});
  assert.deepEqual({ ...parseCookieHeader('__proto__=polluted') }, { ['__proto__']: 'polluted' });
});

test('session cookies serialize with HttpOnly, SameSite=Strict and a Max-Age', () => {
  assert.equal(
    serializeCookie({
      name: COOKIE_NAME,
      value: 'abc123',
      path: '/admin',
      maxAgeSeconds: 60,
      httpOnly: true,
      sameSite: 'Strict',
    }),
    `${COOKIE_NAME}=abc123; Path=/admin; Max-Age=60; HttpOnly; SameSite=Strict`,
  );

  assert.throws(
    () => serializeCookie({ name: 'bad name', value: 'x', maxAgeSeconds: 1 }),
    /invalid cookie name/,
  );
  assert.throws(
    () => serializeCookie({ name: COOKIE_NAME, value: 'a;b', maxAgeSeconds: 1 }),
    /cookie value/,
  );
});

// --- session table ----------------------------------------------------------

test('the one-time bootstrap token burns after a single exchange; the admin token still works', async () => {
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const bootstrapToken = session.bootstrapToken ?? '';
  assert.match(bootstrapToken, /^[0-9a-f]{64}$/);

  const first = session.exchange(bootstrapToken);
  assert.ok(first !== null);
  assert.equal(session.bootstrapToken, null);
  assert.equal(session.exchange(bootstrapToken), null);

  const second = session.exchange(ADMIN_TOKEN);
  assert.ok(second !== null);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.csrfToken, first.csrfToken);
  assert.equal(session.exchange('wrong-token'), null);
  assert.equal(session.exchange(''), null);
  assert.equal(session.size(), 2);
});

test('createAdminSession rejects unusable configuration', () => {
  assert.throws(() => createAdminSession({ adminToken: '' }), /adminToken/);
  assert.throws(() => createAdminSession({ adminToken: 'x', ttlMs: 0 }), /ttlMs/);
  assert.throws(
    () => createAdminSession({ adminToken: 'x', cookieName: 'bad name' }),
    /cookieName/,
  );
});

test('the bootstrap handler stays out of the way when there is no token', async () => {
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const handler = createAdminBootstrapHandler(session);
  assert.equal(await handler({ method: 'GET', path: '/admin' }), null);
  assert.equal(await handler({ method: 'GET', path: '/admin/', query: new URLSearchParams() }), null);
  assert.equal(
    await handler({
      method: 'POST',
      path: '/admin',
      query: new URLSearchParams('token=admin-secret'),
    }),
    null,
  );
  assert.equal(await handler({ method: 'GET', path: '/elsewhere', query: new URLSearchParams('token=admin-secret') }), null);
});

// --- HTTP flow --------------------------------------------------------------

test('bootstrap exchanges the token for a session cookie and the cookie drives CSRF writes', async (t) => {
  const staticDir = await createStaticDir();
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const harness = await listen({ session, staticDir, handlers: [echoHandler] });
  t.after(() => harness.close());

  const bootstrapToken = session.bootstrapToken ?? '';
  const response = await bootstrap(harness.base, bootstrapToken);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/');

  const raw = response.headers.getSetCookie()[0] ?? '';
  assert.match(raw, /; Path=\/admin/);
  assert.match(raw, /; Max-Age=\d+/);
  assert.match(raw, /; HttpOnly/);
  assert.match(raw, /; SameSite=Strict/);
  assert.doesNotMatch(raw, /; Secure/);
  const cookie = sessionCookie(response);

  // The URL token is single-use: after the exchange it is rejected.
  assert.equal(session.bootstrapToken, null);
  const replay = await bootstrap(harness.base, bootstrapToken);
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.getSetCookie().length, 0);

  // Reads with the cookie need no CSRF.
  const csrfToken = await csrfTokenFor(harness.base, cookie);
  const origin = harness.base;

  const write = await fetch(`${harness.base}/admin/api/echo`, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'x-csrf-token': csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ hello: 'admin' }),
  });
  assert.equal(write.status, 200);
  assert.deepEqual(await write.json(), { ok: true, body: { hello: 'admin' } });
});

test('the admin token itself can bootstrap a session', async (t) => {
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const harness = await listen({ session });
  t.after(() => harness.close());

  const response = await bootstrap(harness.base, ADMIN_TOKEN);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/');
  assert.match(response.headers.getSetCookie()[0] ?? '', /HttpOnly/);
});

test('a wrong bootstrap token is 401 and sets no cookie', async (t) => {
  const staticDir = await createStaticDir();
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const harness = await listen({ session, staticDir });
  t.after(() => harness.close());

  const response = await bootstrap(harness.base, 'not-the-token');
  assert.equal(response.status, 401);
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.deepEqual(await response.json(), {
    error: { code: 'UNAUTHORIZED', message: 'invalid admin token' },
  });

  const blank = await bootstrap(harness.base, '');
  assert.equal(blank.status, 401);
});

test('admin static assets load without credentials and mint a session on first load', async (t) => {
  const staticDir = await createStaticDir();
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const harness = await listen({ session, staticDir });
  t.after(() => harness.close());

  let cookie: string | undefined;
  for (const path of ['/admin', '/admin/', '/admin/overview']) {
    const response = await fetch(
      `${harness.base}${path}`,
      cookie === undefined ? {} : { headers: { cookie } },
    );
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /admin shell/);
    if (cookie === undefined) {
      const setCookie = response.headers.getSetCookie()[0] ?? '';
      assert.match(setCookie, /; HttpOnly/);
      assert.match(setCookie, /; SameSite=Strict/);
      cookie = setCookie.split(';')[0] ?? '';
    } else {
      assert.equal(response.headers.getSetCookie().length, 0, path);
    }
  }

  const script = await fetch(
    `${harness.base}/admin/main.js`,
    cookie === undefined ? {} : { headers: { cookie } },
  );
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /text\/javascript/);
  assert.equal(script.headers.getSetCookie().length, 0);
});

test('with auto-login disabled, static GETs set no cookie but the bootstrap token still works', async (t) => {
  const staticDir = await createStaticDir();
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const harness = await listen({ session, staticDir, adminAutoLogin: false });
  t.after(() => harness.close());

  const page = await fetch(`${harness.base}/admin`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.getSetCookie().length, 0);
  assert.equal(session.size(), 0);

  const response = await bootstrap(harness.base, session.bootstrapToken ?? '');
  assert.equal(response.status, 302);
  const cookie = sessionCookie(response);
  const api = await fetch(`${harness.base}/admin/api/csrf`, { headers: { cookie } });
  assert.equal(api.status, 200);
});

test('a custom Host allowlist admits a tailnet name and still rejects others', async (t) => {
  const staticDir = await createStaticDir();
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const harness = await listen({
    session,
    staticDir,
    allowedHosts: ['*.ts.net', '127.0.0.1', 'localhost'],
  });
  t.after(() => harness.close());

  const port = new URL(harness.base).port;
  const ok = await rawGet(harness.base, '/admin', { host: `sh-mac.tail27b036.ts.net:${port}` });
  assert.equal(ok.status, 200);

  const denied = await rawGet(harness.base, '/admin', { host: `evil.example:${port}` });
  assert.equal(denied.status, 403);
  assert.equal(
    (JSON.parse(denied.body) as { error: { code: string } }).error.code,
    'FORBIDDEN_HOST',
  );
});

test('admin API requests without a cookie or Bearer are 401', async (t) => {
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const harness = await listen({ session, handlers: [echoHandler] });
  t.after(() => harness.close());

  for (const [method, path] of [
    ['GET', '/admin/api/csrf'],
    ['GET', '/admin/api/overview'],
    ['POST', '/admin/api/echo'],
  ] as const) {
    const response = await fetch(`${harness.base}${path}`, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  }
});

test('cookie writes without a matching CSRF token are 403', async (t) => {
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const harness = await listen({ session, handlers: [echoHandler] });
  t.after(() => harness.close());

  const response = await bootstrap(harness.base, ADMIN_TOKEN);
  const cookie = sessionCookie(response);
  const csrfToken = await csrfTokenFor(harness.base, cookie);
  const origin = harness.base;

  const missing = await fetch(`${harness.base}/admin/api/echo`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(missing.status, 403);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'CSRF_FAILED');

  const wrong = await fetch(`${harness.base}/admin/api/echo`, {
    method: 'POST',
    headers: { cookie, origin, 'x-csrf-token': 'f'.repeat(64), 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(wrong.status, 403);
  assert.equal(((await wrong.json()) as { error: { code: string } }).error.code, 'CSRF_FAILED');

  const noOrigin = await fetch(`${harness.base}/admin/api/echo`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(noOrigin.status, 403);
  assert.equal(
    ((await noOrigin.json()) as { error: { code: string } }).error.code,
    'CROSS_ORIGIN',
  );

  const crossOrigin = await fetch(`${harness.base}/admin/api/echo`, {
    method: 'POST',
    headers: {
      cookie,
      origin: 'http://evil.example',
      'x-csrf-token': csrfToken,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(
    ((await crossOrigin.json()) as { error: { code: string } }).error.code,
    'CROSS_ORIGIN',
  );
});

test('Bearer admin-token keeps working for writes without Origin or CSRF', async (t) => {
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const harness = await listen({ session, handlers: [echoHandler] });
  t.after(() => harness.close());

  const write = await fetch(`${harness.base}/admin/api/echo`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ via: 'cli' }),
  });
  assert.equal(write.status, 200);
  assert.deepEqual(await write.json(), { ok: true, body: { via: 'cli' } });

  const csrf = await fetch(`${harness.base}/admin/api/csrf`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(csrf.status, 200);
  assert.deepEqual(await csrf.json(), { csrfToken: null });
});

test('expired sessions stop authenticating and are swept', async (t) => {
  let now = 1_700_000_000_000;
  const session = createAdminSession({
    adminToken: ADMIN_TOKEN,
    ttlMs: 60_000,
    now: () => now,
  });
  const harness = await listen({ session });
  t.after(() => harness.close());

  const response = await bootstrap(harness.base, ADMIN_TOKEN);
  const cookie = sessionCookie(response);
  assert.equal((await csrfTokenFor(harness.base, cookie)).length, 64);

  now += 60_001;
  const expired = await fetch(`${harness.base}/admin/api/csrf`, { headers: { cookie } });
  assert.equal(expired.status, 401);
  assert.equal(session.size(), 0);
  assert.equal(session.authenticate(cookie), null);
});

test('DELETE /admin/api/session revokes the session and clears the cookie', async (t) => {
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const harness = await listen({ session });
  t.after(() => harness.close());

  const response = await bootstrap(harness.base, ADMIN_TOKEN);
  const cookie = sessionCookie(response);
  const csrfToken = await csrfTokenFor(harness.base, cookie);

  const logout = await fetch(`${harness.base}/admin/api/session`, {
    method: 'DELETE',
    headers: { cookie, origin: harness.base, 'x-csrf-token': csrfToken },
  });
  assert.equal(logout.status, 204);
  const cleared = logout.headers.getSetCookie()[0] ?? '';
  assert.match(cleared, new RegExp(`^${COOKIE_NAME}=;`));
  assert.match(cleared, /; Max-Age=0/);
  assert.equal(session.size(), 0);

  const afterLogout = await fetch(`${harness.base}/admin/api/csrf`, { headers: { cookie } });
  assert.equal(afterLogout.status, 401);
});

test('non-loopback Host is rejected even for static assets', async (t) => {
  const staticDir = await createStaticDir();
  const harness = await listen({ staticDir });
  t.after(() => harness.close());

  const response = await rawGet(harness.base, '/admin/', { host: 'evil.example:8787' });
  assert.equal(response.status, 403);
  const body = JSON.parse(response.body) as { error: { code: string } };
  assert.equal(body.error.code, 'FORBIDDEN_HOST');
});
