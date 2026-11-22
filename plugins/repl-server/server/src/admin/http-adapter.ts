import type { LogFn } from '../log.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { authorizeAdminRequest, isAllowedHost, type HostAllowlist } from '../auth/tokens.ts';
import { errorResponse, type AdminHandler, type AdminRequest } from './servers.ts';
import { createAdminBootstrapHandler, type AdminSession } from './session.ts';
import type { EventHub } from './events.ts';

export interface AdminHttpOptions {
  handlers: readonly AdminHandler[];
  adminToken: string;
  /** Host allowlist; defaults to loopback-only. */
  allowedHosts?: HostAllowlist;
  /**
   * Local convenience: a static GET without a session exchanges the admin token
   * for one. Must be false when the admin surface is reachable from another
   * machine (non-loopback bind or a reverse proxy such as Tailscale Serve).
   */
  adminAutoLogin?: boolean;
  /**
   * Cookie-session layer for the browser UI. Without it, `/admin` static assets are still
   * served but every `/admin/api/*` request needs Bearer `admin-token`, exactly as before
   * sessions existed. With it, static GET requests that carry no live session cookie mint
   * one from `adminToken`, so the local admin UI opens without a password.
   */
  session?: AdminSession;
  /** SSE streams; authenticated by the same gate as `/admin/api/*`. */
  sse?: { events?: EventHub; audit?: EventHub };
  log?: LogFn;
}

const MAX_BODY_BYTES = 1 << 20;
const ADMIN_API_ROOT = '/admin/api';

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(', ');
  }
  return headers;
}

function isAdminApiPath(pathname: string): boolean {
  return pathname === ADMIN_API_ROOT || pathname.startsWith(`${ADMIN_API_ROOT}/`);
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (status < 200 || status === 204 || status === 304) {
    res.writeHead(status, { 'cache-control': 'no-store', ...headers });
    res.end();
    return;
  }
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { 'content-length': body.length, ...headers });
    res.end(body);
    return;
  }
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Runs the framework-free handlers after the gate; shared by static and API paths. */
async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: AdminHttpOptions,
  extraHeaders: Record<string, string> = {},
): Promise<boolean> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? (values[0] as string) : values;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    send(
      res,
      413,
      { error: { code: 'BODY_TOO_LARGE', message: (error as Error).message } },
      extraHeaders,
    );
    return true;
  }

  const request: AdminRequest = {
    method: req.method ?? 'GET',
    path: url.pathname,
    query,
    headers: headersOf(req),
    body,
  };

  for (const handler of options.handlers) {
    try {
      const response = await handler(request);
      if (response === null) continue;
      send(res, response.status, response.body, { ...extraHeaders, ...response.headers });
      return true;
    } catch (error) {
      options.log?.(`admin handler failed: ${(error as Error).message}`, { level: 'error', scope: 'admin' });
      const response = errorResponse(error);
      send(res, response.status, response.body, { ...extraHeaders, ...response.headers });
      return true;
    }
  }

  return false;
}

/** Bridges IncomingMessage to the framework-free admin handlers. */
export async function handleAdminHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: AdminHttpOptions,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const host = header(req, 'host');

  // DNS-rebinding guard for every admin surface, including static assets and bootstrap.
  if (!isAllowedHost(host, options.allowedHosts)) {
    send(res, 403, {
      error: { code: 'FORBIDDEN_HOST', message: `host not allowed: ${host ?? '<missing>'}` },
    });
    return true;
  }

  const cookie = header(req, 'cookie');

  if (!isAdminApiPath(url.pathname)) {
    // Static assets and the SPA shell load without credentials.
    let extraHeaders: Record<string, string> = {};
    if (options.session !== undefined && method === 'GET') {
      const bootstrap = createAdminBootstrapHandler(options.session);
      const response = await bootstrap({
        method,
        path: url.pathname,
        query: url.searchParams,
        headers: headersOf(req),
      });
      if (response !== null) {
        send(res, response.status, response.body, response.headers);
        return true;
      }
      // Local admin has no password: the first static GET without a live session cookie
      // trades the configured admin token for one, so the SPA enters directly. Remote
      // binds must require the bootstrap token instead.
      if (options.adminAutoLogin !== false && options.session.authenticate(cookie) === null) {
        const state = options.session.exchange(options.adminToken);
        if (state !== null) extraHeaders = { 'set-cookie': options.session.cookie(state) };
      }
    }
    return await dispatch(req, res, url, options, extraHeaders);
  }

  const state = options.session?.authenticate(cookie) ?? null;
  const auth = authorizeAdminRequest(
    {
      method,
      host,
      origin: header(req, 'origin'),
      authorization: header(req, 'authorization'),
      csrfToken: header(req, 'x-csrf-token'),
      sessionAuthenticated: state !== null,
    },
    {
      adminToken: options.adminToken,
      csrfToken: state?.csrfToken ?? null,
      allowedHosts: options.allowedHosts,
    },
  );

  if (!auth.ok) {
    send(
      res,
      auth.status,
      { error: auth.error },
      auth.wwwAuthenticate === undefined ? {} : { 'www-authenticate': auth.wwwAuthenticate },
    );
    return true;
  }

  if (options.session !== undefined) {
    // Cookie sessions fetch their CSRF token here; Bearer callers need none and get null.
    if (method === 'GET' && url.pathname === `${ADMIN_API_ROOT}/csrf`) {
      send(res, 200, { csrfToken: state?.csrfToken ?? null });
      return true;
    }
    // Logout: revoke the server-side session and clear the HttpOnly cookie.
    if (method === 'DELETE' && url.pathname === `${ADMIN_API_ROOT}/session`) {
      options.session.destroy(cookie);
      send(res, 204, undefined, {
        'set-cookie': options.session.clearCookie(),
        'cache-control': 'no-store',
      });
      return true;
    }
  }

  if (method === 'GET' && options.sse !== undefined) {
    if (url.pathname === `${ADMIN_API_ROOT}/events` && options.sse.events !== undefined) {
      options.sse.events.subscribe(req, res);
      return true;
    }
    if (url.pathname === `${ADMIN_API_ROOT}/audit/stream` && options.sse.audit !== undefined) {
      options.sse.audit.subscribe(req, res);
      return true;
    }
  }

  return await dispatch(req, res, url, options);
}
