// hook-allow: localhost-only test fetch, no external egress
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleAdminHttp } from '../src/admin/http-adapter.ts';
import { createAdminOverviewHandler } from '../src/admin/overview.ts';
import { createAdminSession, type AdminSession } from '../src/admin/session.ts';
import type { AdminHandler } from '../src/admin/servers.ts';

const ADMIN_TOKEN = 'admin-secret';
const COOKIE_NAME = 'repl_admin_session';

const echoHandler: AdminHandler = async (request) => {
  if (request.method !== 'POST' || request.path !== '/admin/api/echo') return null;
  return { status: 200, body: { ok: true } };
};

async function createStaticDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repl-admin-auto-session-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>admin shell</body></html>');
  await writeFile(join(dir, 'main.js'), 'console.log("admin");');
  return dir;
}

interface Harness {
  base: string;
  session: AdminSession;
  close(): Promise<void>;
}

async function listen(): Promise<Harness> {
  const staticDir = await createStaticDir();
  const session = createAdminSession({ adminToken: ADMIN_TOKEN });
  const handlers: AdminHandler[] = [
    createAdminOverviewHandler({
      overview: () => ({
        capacity: {},
        pool: { total: 0, ready: 0, reconnecting: 0, failed: 0 },
        sessions: { transport: 0, exec: 0, inFlightEvals: 0 },
        servers: { total: 0, enabled: 0 },
      }),
      staticDir,
    }),
    echoHandler,
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const handled = await handleAdminHttp(req, res, url, {
        handlers,
        adminToken: ADMIN_TOKEN,
        session,
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
    session,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(staticDir, { recursive: true, force: true });
    },
  };
}

/** Asserts the single Set-Cookie header and returns its `name=value` pair. */
function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1, 'expected exactly one Set-Cookie header');
  const raw = cookies[0] ?? '';
  assert.match(raw, /; Path=\/admin/);
  assert.match(raw, /; Max-Age=\d+/);
  assert.match(raw, /; HttpOnly/);
  assert.match(raw, /; SameSite=Strict/);
  assert.doesNotMatch(raw, /; Secure/);
  const pair = raw.split(';')[0] ?? '';
  assert.match(pair, new RegExp(`^${COOKIE_NAME}=[0-9a-f]{64}$`));
  return pair;
}

test('GET /admin/ without a session cookie mints one and the cookie unlocks the API', async (t) => {
  const harness = await listen();
  t.after(() => harness.close());

  const shell = await fetch(`${harness.base}/admin/`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await shell.text(), /admin shell/);
  const cookie = sessionCookie(shell);
  assert.equal(harness.session.size(), 1);

  const overview = await fetch(`${harness.base}/admin/api/overview`, { headers: { cookie } });
  assert.equal(overview.status, 200);
  assert.deepEqual(await overview.json(), {
    capacity: {},
    pool: { total: 0, ready: 0, reconnecting: 0, failed: 0 },
    sessions: { transport: 0, exec: 0, inFlightEvals: 0 },
    servers: { total: 0, enabled: 0 },
  });

  // A live cookie is reused instead of a fresh session on every static request.
  const again = await fetch(`${harness.base}/admin/`, { headers: { cookie } });
  assert.equal(again.status, 200);
  assert.equal(again.headers.getSetCookie().length, 0);
  assert.equal(harness.session.size(), 1);
});

test('GET /admin and static assets also enter without credentials', async (t) => {
  const harness = await listen();
  t.after(() => harness.close());

  const shell = await fetch(`${harness.base}/admin`);
  assert.equal(shell.status, 200);
  const cookie = sessionCookie(shell);

  const script = await fetch(`${harness.base}/admin/main.js`, { headers: { cookie } });
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /text\/javascript/);
  assert.equal(script.headers.getSetCookie().length, 0);
});

test('the admin API stays gated for requests without a cookie or Bearer token', async (t) => {
  const harness = await listen();
  t.after(() => harness.close());

  const response = await fetch(`${harness.base}/admin/api/overview`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  assert.equal(response.headers.getSetCookie().length, 0);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('cookie write requests still require CSRF, even when auto-session minted the cookie', async (t) => {
  const harness = await listen();
  t.after(() => harness.close());

  const shell = await fetch(`${harness.base}/admin/`);
  const cookie = sessionCookie(shell);

  const write = await fetch(`${harness.base}/admin/api/echo`, {
    method: 'POST',
    headers: { cookie, origin: harness.base, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(write.status, 403);
  assert.equal(((await write.json()) as { error: { code: string } }).error.code, 'CSRF_FAILED');
});

test('an invalid ?token= still fails with 401 instead of auto-entering', async (t) => {
  const harness = await listen();
  t.after(() => harness.close());

  const response = await fetch(`${harness.base}/admin/?token=wrong`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.equal(harness.session.size(), 0);
});
