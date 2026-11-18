/** Browser cookie sessions for the admin UI: bootstrap exchange, CSRF and expiry. @module */
import { randomBytes } from 'node:crypto';

import {
  createCsrfToken,
  parseCookieHeader,
  serializeCookie,
  timingSafeEqualString,
} from '../auth/tokens.ts';
import { adminJson, queryValue, type AdminHandler } from './servers.ts';

const DEFAULT_COOKIE_NAME = 'repl_admin_session';
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
/** The cookie is scoped to the admin surface so it never rides along on `/mcp` requests. */
const COOKIE_PATH = '/admin';

export const ADMIN_BOOTSTRAP_PATH = '/admin';
export const ADMIN_BOOTSTRAP_TARGET = '/admin/';

export interface AdminSessionOptions {
  /** Long-lived `admin-token` from the 0600 token file; also accepted by {@link AdminSession.exchange}. */
  adminToken: string;
  /** Cookie name; defaults to `repl_admin_session`. */
  cookieName?: string;
  /** Session lifetime in milliseconds; defaults to 12 hours. */
  ttlMs?: number;
  /** Clock seam for expiry tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface AdminSessionState {
  /** Opaque cookie value; never equals the admin token. */
  id: string;
  /** Per-session CSRF token handed out by `GET /admin/api/csrf`. */
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface AdminSession {
  readonly cookieName: string;
  readonly ttlMs: number;
  /**
   * Single-use token for the terminal bootstrap URL. {@link AdminSession.exchange} burns it
   * on success, so a URL copied from the terminal cannot mint a second session.
   */
  readonly bootstrapToken: string | null;
  /** Exchanges the one-time bootstrap token (or the admin token) for a new session. */
  exchange(token: string): AdminSessionState | null;
  /** Resolves the session cookie; expired sessions are dropped first. */
  authenticate(cookieHeader: string | null | undefined): AdminSessionState | null;
  /** CSRF token bound to the cookie session, or null without one. */
  csrfToken(cookieHeader: string | null | undefined): string | null;
  /** Removes the cookie session; true when a live session existed. */
  destroy(cookieHeader: string | null | undefined): boolean;
  /** Drops expired sessions and returns how many were removed. */
  cleanup(): number;
  /** `Set-Cookie` value that installs the session. */
  cookie(state: AdminSessionState): string;
  /** `Set-Cookie` value that clears the cookie. */
  clearCookie(): string;
  /** Live session count (tests and metrics); does not drop expired entries. */
  size(): number;
}

function validateOptions(options: AdminSessionOptions): {
  cookieName: string;
  ttlMs: number;
  now: () => number;
} {
  if (typeof options.adminToken !== 'string' || options.adminToken === '') {
    throw new TypeError('adminToken must be a non-empty string');
  }
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
  if (!/^[A-Za-z0-9_.-]+$/.test(cookieName)) {
    throw new TypeError(`invalid cookieName: ${JSON.stringify(cookieName)}`);
  }
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be a positive integer');
  }
  return { cookieName, ttlMs, now: options.now ?? Date.now };
}

/**
 * In-memory admin session table. The cookie carries only an opaque random id; the CSRF
 * token and expiry live server-side, so deleting an entry revokes the browser immediately
 * and a restart invalidates every session.
 */
export function createAdminSession(options: AdminSessionOptions): AdminSession {
  const { cookieName, ttlMs, now } = validateOptions(options);
  const sessions = new Map<string, AdminSessionState>();
  let bootstrapToken: string | null = randomBytes(32).toString('hex');

  function cleanup(): number {
    const current = now();
    let removed = 0;
    for (const [id, state] of sessions) {
      if (state.expiresAt <= current) {
        sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  function readSession(cookieHeader: string | null | undefined): AdminSessionState | null {
    cleanup();
    if (cookieHeader === null || cookieHeader === undefined) return null;
    const id = parseCookieHeader(cookieHeader)[cookieName];
    if (id === undefined || id === '') return null;
    return sessions.get(id) ?? null;
  }

  function sessionCookie(value: string, maxAgeSeconds: number): string {
    return serializeCookie({
      name: cookieName,
      value,
      path: COOKIE_PATH,
      maxAgeSeconds,
      httpOnly: true,
      sameSite: 'Strict',
    });
  }

  return {
    cookieName,
    ttlMs,
    get bootstrapToken() {
      return bootstrapToken;
    },
    exchange(token) {
      if (typeof token !== 'string' || token === '') return null;
      cleanup();
      if (bootstrapToken !== null && timingSafeEqualString(token, bootstrapToken)) {
        // Burn before issuing the session: a URL replayed after this point is rejected.
        bootstrapToken = null;
      } else if (!timingSafeEqualString(token, options.adminToken)) {
        return null;
      }

      const createdAt = now();
      const state: AdminSessionState = {
        id: randomBytes(32).toString('hex'),
        csrfToken: createCsrfToken(),
        createdAt,
        expiresAt: createdAt + ttlMs,
      };
      sessions.set(state.id, state);
      return state;
    },
    authenticate(cookieHeader) {
      return readSession(cookieHeader);
    },
    csrfToken(cookieHeader) {
      return readSession(cookieHeader)?.csrfToken ?? null;
    },
    destroy(cookieHeader) {
      const state = readSession(cookieHeader);
      if (state === null) return false;
      return sessions.delete(state.id);
    },
    cleanup,
    cookie(state) {
      return sessionCookie(
        state.id,
        Math.max(0, Math.ceil((state.expiresAt - now()) / 1000)),
      );
    },
    clearCookie() {
      return sessionCookie('', 0);
    },
    size() {
      return sessions.size;
    },
  };
}

/**
 * `GET /admin?token=<admin-token>` exchanges a valid token for a session cookie and
 * redirects to `/admin/`, so the credential never stays in the address bar or history.
 * Returns `null` when the request is not a bootstrap attempt (other path/method, no
 * `token` parameter), letting the static SPA handler serve the login page. Host validation
 * belongs to the HTTP shell, like every other {@link AdminHandler}.
 */
export function createAdminBootstrapHandler(session: AdminSession): AdminHandler {
  return async (request) => {
    if (request.method.toUpperCase() !== 'GET') return null;
    const path = request.path.split('?')[0] ?? '';
    if (path !== ADMIN_BOOTSTRAP_PATH && path !== ADMIN_BOOTSTRAP_TARGET) return null;

    const token = queryValue(request, 'token');
    if (token === null) return null;

    const state = session.exchange(token);
    if (state === null) {
      return adminJson(
        401,
        { error: { code: 'UNAUTHORIZED', message: 'invalid admin token' } },
        { 'cache-control': 'no-store' },
      );
    }

    return {
      status: 302,
      headers: {
        location: ADMIN_BOOTSTRAP_TARGET,
        'set-cookie': session.cookie(state),
        'cache-control': 'no-store',
      },
    };
  };
}
