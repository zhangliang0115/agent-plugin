/** Token hashing, constant-time comparison, bearer parsing and the admin request gate. @module */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** `client_bindings.token_hash`: SHA-256 of the plaintext token, lowercase hex. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison. Both sides are hashed first so `timingSafeEqual` always sees
 * equal-length buffers and the comparison leaks neither content nor length.
 */
export function timingSafeEqualString(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export type BearerHeader =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'token'; token: string };

/** RFC 6750 `b64token`; a header that does not match is "malformed" and must become a 401. */
const BEARER_PATTERN = /^Bearer[ \t]+([A-Za-z0-9\-._~+/]+=*)[ \t]*$/i;

/** Parses `Authorization`. Missing is `none`; a blank header, non-Bearer scheme or malformed token is `invalid`. */
export function parseBearer(header: string | null | undefined): BearerHeader {
  if (header === null || header === undefined) return { kind: 'none' };
  const value = header.trim();
  if (value.length === 0) return { kind: 'invalid' };
  const match = BEARER_PATTERN.exec(value);
  if (match === null) return { kind: 'invalid' };
  const token = match[1];
  if (token === undefined || token.length === 0) return { kind: 'invalid' };
  return { kind: 'token', token };
}

/** Lowercased host without its port; IPv6 literals keep their brackets but lose the port. */
export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.indexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/** Exact normalized hosts, `*.suffix` entries, or `*` for any host. */
export type HostAllowlist = readonly string[] | '*';

export const DEFAULT_HOST_ALLOWLIST: readonly string[] = ['127.0.0.1', 'localhost'];

/** Parses `--allowed-hosts` / `REPL_SERVER_ALLOWED_HOSTS`; empty falls back to the default. */
export function parseHostAllowlist(value: string | undefined): HostAllowlist {
  if (value === undefined) return DEFAULT_HOST_ALLOWLIST;
  const trimmed = value.trim();
  if (trimmed === '') return DEFAULT_HOST_ALLOWLIST;
  if (trimmed === '*') return '*';
  const entries = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries.length === 0 ? DEFAULT_HOST_ALLOWLIST : entries;
}

/**
 * DNS-rebinding guard from protocol.md §1. The default is loopback-only;
 * a non-loopback bind must pass an explicit allowlist (for example
 * `*.ts.net,127.0.0.1,localhost`). Ports are stripped before matching.
 */
export function isAllowedHost(
  host: string | null | undefined,
  allowedHosts: HostAllowlist = DEFAULT_HOST_ALLOWLIST,
): boolean {
  if (host === null || host === undefined) return false;
  const normalized = normalizeHost(host);
  if (normalized === '') return false;
  if (allowedHosts === '*') return true;
  return allowedHosts.some((entry) => {
    const allowed = normalizeHost(entry);
    if (allowed === '*') return true;
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1);
      return normalized === allowed.slice(2) || normalized.endsWith(suffix);
    }
    return normalized === allowed;
  });
}

/** True for bind addresses that only serve this machine. */
export function isLoopbackBindAddress(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]'
  );
}

/** True for a loopback TCP peer, including IPv4-mapped IPv6 (`::ffff:127.0.0.1`). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return isLoopbackBindAddress(normalized);
}

/** True when `Origin` names the same host:port as the request `Host` header. */
export function isSameOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
): boolean {
  if (origin === null || origin === undefined || origin.length === 0) return false;
  if (host === null || host === undefined || host.trim().length === 0) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.host.toLowerCase() === host.trim().toLowerCase();
}

export function createCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/** CSRF comparison for the `X-CSRF-Token` header; empty on either side fails closed. */
export function verifyCsrf(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (provided === null || provided === undefined || provided.length === 0) return false;
  if (expected === null || expected === undefined || expected.length === 0) return false;
  return timingSafeEqualString(provided, expected);
}

/** RFC 6265 token characters, narrowed to what the admin layer issues. */
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Parses a `Cookie` header into a name→value record. The first occurrence of a name wins,
 * pairs without `=` are ignored and one layer of double quotes is stripped. Missing headers
 * yield an empty record. The result has no prototype, so cookie names such as `__proto__`
 * cannot pollute it.
 */
export function parseCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const cookies = Object.create(null) as Record<string, string>;
  if (header === null || header === undefined) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name === '' || cookies[name] !== undefined) continue;
    let value = part.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    cookies[name] = value;
  }
  return cookies;
}

export interface SerializeCookieOptions {
  name: string;
  value: string;
  /** Seconds until the cookie expires; `0` deletes it. */
  maxAgeSeconds: number;
  /** Defaults to `/`. */
  path?: string;
  /** Defaults to `Strict`. */
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Defaults to `true`. */
  httpOnly?: boolean;
  /** Adds `Secure` when true; local `http://127.0.0.1` cookies must leave it off. */
  secure?: boolean;
}

/**
 * Serializes a `Set-Cookie` value. Session cookies always pass `httpOnly: true` and
 * `sameSite: 'Strict'`; values are restricted to characters that need no escaping.
 */
export function serializeCookie(options: SerializeCookieOptions): string {
  if (!COOKIE_NAME_PATTERN.test(options.name)) {
    throw new TypeError(`invalid cookie name: ${JSON.stringify(options.name)}`);
  }
  if (/[\s;,]/.test(options.value)) {
    throw new TypeError('cookie value must not contain whitespace, ";" or ","');
  }
  const maxAge = Math.trunc(options.maxAgeSeconds);
  if (!Number.isFinite(maxAge)) {
    throw new TypeError('maxAgeSeconds must be a finite number');
  }

  const parts = [`${options.name}=${options.value}`, `Path=${options.path ?? '/'}`];
  parts.push(`Max-Age=${maxAge}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Strict'}`);
  if (options.secure === true) parts.push('Secure');
  return parts.join('; ');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export type AdminAuthVia = 'bearer' | 'session';

export type AdminAuthErrorCode = 'FORBIDDEN_HOST' | 'UNAUTHORIZED' | 'CROSS_ORIGIN' | 'CSRF_FAILED';

export interface AdminAuthRequest {
  method: string;
  host?: string | null;
  origin?: string | null;
  authorization?: string | null;
  /** `X-CSRF-Token` header; required for cookie-session writes. */
  csrfToken?: string | null;
  /** The cookie layer validates the HttpOnly session cookie and sets this flag. */
  sessionAuthenticated?: boolean;
}

export interface AdminAuthConfig {
  /** Plaintext `admin-token` from the 0600 token file. */
  adminToken: string;
  /** CSRF token issued for the current cookie session. */
  csrfToken?: string | null;
  /** Host allowlist; defaults to loopback-only. */
  allowedHosts?: HostAllowlist;
}

export type AdminAuthResult =
  | { ok: true; via: AdminAuthVia }
  | {
      ok: false;
      status: 401 | 403;
      error: { code: AdminAuthErrorCode; message: string };
      wwwAuthenticate?: string;
    };

/**
 * Minimal admin gate shared by every `/admin/*` route: Host is checked for all requests, Bearer
 * `admin-token` (local CLI) skips CSRF because it carries no ambient credentials, and cookie-session
 * writes additionally need a same-origin `Origin` and a matching `X-CSRF-Token`.
 */
export function authorizeAdminRequest(
  request: AdminAuthRequest,
  config: AdminAuthConfig,
): AdminAuthResult {
  if (!isAllowedHost(request.host, config.allowedHosts)) {
    return {
      ok: false,
      status: 403,
      error: { code: 'FORBIDDEN_HOST', message: `host not allowed: ${request.host ?? '<missing>'}` },
    };
  }

  const bearer = parseBearer(request.authorization);
  let via: AdminAuthVia | null = null;
  if (bearer.kind === 'token' && timingSafeEqualString(bearer.token, config.adminToken)) {
    via = 'bearer';
  } else if (request.sessionAuthenticated === true) {
    via = 'session';
  }

  if (via === null) {
    const hadToken = bearer.kind === 'invalid' || bearer.kind === 'token';
    return {
      ok: false,
      status: 401,
      error: {
        code: 'UNAUTHORIZED',
        message: hadToken ? 'invalid admin token' : 'admin token required',
      },
      wwwAuthenticate: hadToken ? 'Bearer error="invalid_token"' : 'Bearer',
    };
  }

  if (via === 'session' && isUnsafeMethod(request.method)) {
    if (!isSameOrigin(request.origin, request.host)) {
      return {
        ok: false,
        status: 403,
        error: {
          code: 'CROSS_ORIGIN',
          message: 'admin write requests require a same-origin Origin header',
        },
      };
    }
    if (!verifyCsrf(request.csrfToken, config.csrfToken)) {
      return {
        ok: false,
        status: 403,
        error: { code: 'CSRF_FAILED', message: 'missing or invalid X-CSRF-Token' },
      };
    }
  }

  return { ok: true, via };
}
