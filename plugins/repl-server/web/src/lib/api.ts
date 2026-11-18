/** Typed fetch wrapper for the admin API (`/admin/api`, 03 §4.1–4.3).
 *
 * The admin token lives in `sessionStorage` (never `localStorage`) and is sent as
 * `Authorization: Bearer <token>`. Cookie-session writes additionally need `X-CSRF-Token`;
 * {@link ApiClient.setCsrfToken} is the placeholder for the `GET /admin/api/csrf` exchange
 * that the HTTP shell will expose later. Bearer writes do not need that header.
 *
 * Every response is parsed once: JSON bodies are returned as-is, non-JSON bodies (for
 * example the JSONL audit export) are returned as text, and failures become
 * {@link ApiError} with the server's unified `{ error: { code, message, details } }` shape.
 * @module
 */

/** Admin API root; the static UI is served from the same origin. */
export const API_BASE = '/admin/api';

/** Session-scoped key for the admin token. */
export const TOKEN_STORAGE_KEY = 'repl-server.admin-token';

const CSRF_HEADER = 'X-CSRF-Token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Unified admin error, mirroring `errorResponse` in `server/src/admin/servers.ts`. */
export class ApiError extends Error {
  /** HTTP status, or `0` when the request never reached the server. */
  readonly status: number;
  /** Server error code (`UNAUTHORIZED`, `REVISION_CONFLICT`, …) or a local fallback. */
  readonly code: string;
  /** Optional `error.details` payload. */
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Minimal `Storage` subset, so a blocked `sessionStorage` can be replaced by `null`. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type QueryInput =
  | Record<string, string | number | boolean | null | undefined>
  | URLSearchParams;

export interface ApiRequestOptions {
  method?: string;
  query?: QueryInput;
  /** Serialized as JSON when defined; `undefined` means no body. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Options for calls without a body (`get` / `delete`). */
export type BodylessOptions = Omit<ApiRequestOptions, 'method' | 'body'>;

export interface ApiClientOptions {
  /** Defaults to {@link API_BASE}. Relative bases stay on this origin. */
  baseUrl?: string;
  /** Initial token; when omitted it is read from `sessionStorage`. */
  token?: string | null;
  /** Defaults to `sessionStorage`, or `null` when storage is unavailable. */
  storage?: TokenStorage | null;
  /** Injection point for tests and non-browser hosts. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Initial CSRF token; memory-only. */
  csrfToken?: string | null;
  /** Called after a `401`, so the shell can fall back to the token gate. */
  onUnauthorized?: () => void;
}

export interface ApiClient {
  readonly baseUrl: string;
  getToken(): string | null;
  setToken(token: string | null): void;
  hasToken(): boolean;
  getCsrfToken(): string | null;
  setCsrfToken(token: string | null): void;
  request<T>(path: string, options?: ApiRequestOptions): Promise<T>;
  get<T>(path: string, options?: BodylessOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: BodylessOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: BodylessOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: BodylessOptions): Promise<T>;
  delete<T>(path: string, options?: BodylessOptions): Promise<T>;
}

interface ParsedError {
  code: string;
  message: string;
  details?: unknown;
}

/** Creates an isolated client; the shell owns exactly one instance. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const fetchImpl: typeof fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = normalizeBase(options.baseUrl ?? API_BASE);
  const trustedBase = isSameOriginBase(baseUrl);

  let token = options.token !== undefined ? normalizeToken(options.token) : readStoredToken(storage);
  let csrfToken = options.csrfToken !== undefined ? normalizeToken(options.csrfToken) : null;

  function getToken(): string | null {
    return token;
  }

  function setToken(next: string | null): void {
    token = normalizeToken(next);
    if (storage === null) return;
    try {
      if (token === null) storage.removeItem(TOKEN_STORAGE_KEY);
      else storage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // A blocked storage must not break requests; the in-memory token still works.
    }
  }

  function getCsrfToken(): string | null {
    return csrfToken;
  }

  function setCsrfToken(next: string | null): void {
    csrfToken = normalizeToken(next);
  }

  async function request<T>(path: string, requestOptions: ApiRequestOptions = {}): Promise<T> {
    const method = (requestOptions.method ?? 'GET').toUpperCase();
    const headers = new Headers({ accept: 'application/json' });

    let body: string | undefined;
    if (requestOptions.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(requestOptions.body);
    }
    if (trustedBase && token !== null) headers.set('authorization', `Bearer ${token}`);
    if (trustedBase && csrfToken !== null && !SAFE_METHODS.has(method)) {
      headers.set(CSRF_HEADER, csrfToken);
    }
    if (requestOptions.headers !== undefined) {
      for (const [name, value] of Object.entries(requestOptions.headers)) {
        headers.set(name, value);
      }
    }

    let response: Response;
    try {
      response = await fetchImpl(buildUrl(baseUrl, path, requestOptions.query), {
        method,
        headers,
        body,
        credentials: 'same-origin',
        signal: requestOptions.signal,
      });
    } catch (error) {
      if (isAbortError(error) || requestOptions.signal?.aborted === true) throw error;
      throw new ApiError(0, 'NETWORK_ERROR', '无法连接管理 API。', {
        cause: errorMessage(error),
      });
    }

    const text = await response.text();
    if (!response.ok) {
      const parsed = parseErrorPayload(response.status, response.statusText, text);
      if (response.status === 401) options.onUnauthorized?.();
      throw new ApiError(response.status, parsed.code, parsed.message, parsed.details);
    }

    if (text.length === 0) return undefined as T;
    // `application/x-ndjson` (audit export) is line-delimited and must stay text;
    // only `application/json` and `+json` media types are parsed as one document.
    const mediaType = (response.headers.get('content-type') ?? '')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType === 'application/json' || mediaType?.endsWith('+json') === true) {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ApiError(
          response.status,
          'INVALID_RESPONSE',
          '管理 API 返回了无法解析的 JSON。',
          { body: text.slice(0, 2000) },
        );
      }
    }
    return text as T;
  }

  function get<T>(path: string, requestOptions: BodylessOptions = {}): Promise<T> {
    return request<T>(path, { ...requestOptions, method: 'GET' });
  }

  function post<T>(path: string, body?: unknown, requestOptions: BodylessOptions = {}): Promise<T> {
    return request<T>(path, { ...requestOptions, method: 'POST', body });
  }

  function put<T>(path: string, body?: unknown, requestOptions: BodylessOptions = {}): Promise<T> {
    return request<T>(path, { ...requestOptions, method: 'PUT', body });
  }

  function patch<T>(path: string, body?: unknown, requestOptions: BodylessOptions = {}): Promise<T> {
    return request<T>(path, { ...requestOptions, method: 'PATCH', body });
  }

  function remove<T>(path: string, requestOptions: BodylessOptions = {}): Promise<T> {
    return request<T>(path, { ...requestOptions, method: 'DELETE' });
  }

  return {
    baseUrl,
    getToken,
    setToken,
    hasToken: () => token !== null,
    getCsrfToken,
    setCsrfToken,
    request,
    get,
    post,
    put,
    patch,
    delete: remove,
  };
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function endpoint(baseUrl: string, path: string): string {
  if (path === '') return baseUrl === '' ? '/' : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${suffix}`;
}

function buildUrl(baseUrl: string, path: string, query?: QueryInput): string {
  const params = new URLSearchParams();
  appendQuery(params, query);
  const search = params.toString();
  const address = endpoint(baseUrl, path);
  return search === '' ? address : `${address}?${search}`;
}

function appendQuery(params: URLSearchParams, query?: QueryInput): void {
  if (query === undefined) return;
  if (query instanceof URLSearchParams) {
    for (const [key, value] of query) params.append(key, value);
    return;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
}

/** Tokens are only attached to the page's own origin, even if a caller passes an absolute base. */
function isSameOriginBase(baseUrl: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(baseUrl)) return true;
  if (typeof window === 'undefined') return false;
  try {
    return new URL(baseUrl).origin === window.location.origin;
  } catch {
    return false;
  }
}

function normalizeToken(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function defaultStorage(): TokenStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    const storage = window.sessionStorage;
    const probe = '__repl_server_storage_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function readStoredToken(storage: TokenStorage | null): string | null {
  if (storage === null) return null;
  try {
    return normalizeToken(storage.getItem(TOKEN_STORAGE_KEY));
  } catch {
    return null;
  }
}

function parseErrorPayload(status: number, statusText: string, text: string): ParsedError {
  const fallbackMessage = statusText.trim() === '' ? `HTTP ${status}` : statusText.trim();
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        const error = parsed['error'];
        if (isRecord(error)) {
          const code =
            typeof error['code'] === 'string' && error['code'] !== ''
              ? error['code']
              : `HTTP_${status}`;
          const message =
            typeof error['message'] === 'string' && error['message'] !== ''
              ? error['message']
              : fallbackMessage;
          const details = error['details'];
          return details === undefined ? { code, message } : { code, message, details };
        }
      }
    } catch {
      // Not JSON; fall through to the status-based error.
    }
  }
  const details = text.length > 0 ? { body: text.slice(0, 2000) } : undefined;
  return details === undefined
    ? { code: `HTTP_${status}`, message: fallbackMessage }
    : { code: `HTTP_${status}`, message: fallbackMessage, details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
