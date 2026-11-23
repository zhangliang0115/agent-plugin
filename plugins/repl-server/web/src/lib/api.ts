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
 *
 * Long-lived views use {@link ApiClient.stream}: a same-origin `EventSource` wrapper that
 * keeps the Cookie session, remembers the last event id, reports `gap` frames, reconnects
 * with backoff and degrades to callback-driven polling when the stream stays down.
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

/** Abort signal that fires after `ms`; `undefined` where `AbortSignal.timeout` is missing. */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** True for the `TimeoutError` raised by {@link timeoutSignal}. */
export function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'TimeoutError'
  );
}

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
  /** Injection point for SSE; `null` forces the polling fallback. */
  eventSource?: EventSourceFactory | null;
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
  /** Opens one same-origin SSE subscription; see {@link createEventStream}. */
  stream(path: string, options?: EventStreamOptions): EventStream;
}

/** One parsed server-sent event. `data` stays generic because audit rows grow per type. */
export interface StreamEvent {
  /** SSE event name; unnamed frames arrive as `message`. */
  type: string;
  /** `JSON.parse`d body, or the raw string when the body is not JSON. */
  data: unknown;
  /** Unparsed `data:` text, kept for tolerant consumers. */
  raw: string;
  /** `id:` of this frame, or `null` when the server omitted one. */
  id: string | null;
  /** Latest position for a manual resume. */
  lastEventId: string | null;
}

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'fallback' | 'closed';

/** Payload of `event: gap` (`docs/03 §4.5`): the replay window lost frames. */
export interface StreamGap {
  oldestEventId: string | null;
}

/**
 * Payload of `GET /logs/frames`. `truncated` means the scan stopped at its row
 * ceiling, so older frames in the window were never inspected.
 */
export interface FramesResponse<Frame = unknown> {
  detail: string;
  frames: Frame[];
  hasMore?: boolean;
  droppedFrames?: number;
  truncated?: boolean;
}

/** Frame-drawer warning when the backend scan stopped early; `null` when complete. */
export function framesTruncatedNotice(
  response: Pick<FramesResponse, 'truncated'> | null | undefined,
): string | null {
  return response?.truncated === true
    ? '扫描已截断（仅覆盖最早 100k 行），请缩小时间范围'
    : null;
}

export interface EventStreamOptions {
  /** Event names to listen for; defaults to `['message']`. */
  eventTypes?: readonly string[];
  /** Initial position, appended as `?lastEventId=` and reused by later reconnects. */
  lastEventId?: string | null;
  onEvent?: (event: StreamEvent) => void;
  /** `gap` means a full refresh is required; the stream is not continuous. */
  onGap?: (gap: StreamGap) => void;
  onStateChange?: (state: StreamState) => void;
  /** Poll tick while the stream is `fallback`/`reconnecting`; also runs once on resume. */
  onFallbackPoll?: () => void;
  /** Fallback cadence in milliseconds; `0` disables polling. Defaults to 5000. */
  fallbackPollMs?: number;
  /** Consecutive failures before the polling fallback takes over. Defaults to 3. */
  fallbackAfter?: number;
  /** Close while hidden and reconnect on return; defaults to `true`. */
  pauseWhenHidden?: boolean;
  /** Injection point for tests/non-browser hosts. `null` disables SSE outright. */
  createEventSource?: EventSourceFactory | null;
}

export interface EventStream {
  readonly state: StreamState;
  readonly lastEventId: string | null;
  close(): void;
}

/** Minimal `EventSource` surface so tests and non-browser hosts can supply their own. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export type EventSourceFactory = (
  url: string,
  init?: { withCredentials?: boolean },
) => EventSourceLike;

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
  const eventSourceFactory = options.eventSource;

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

  function stream(path: string, streamOptions: EventStreamOptions = {}): EventStream {
    const address = endpoint(baseUrl, path);
    const createEventSource =
      streamOptions.createEventSource === undefined
        ? eventSourceFactory
        : streamOptions.createEventSource;
    return createEventStream(address, { ...streamOptions, createEventSource });
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
    stream,
  };
}

const EVENT_SOURCE_CLOSED = 2;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const;
const DEFAULT_FALLBACK_POLL_MS = 5_000;
const DEFAULT_FALLBACK_AFTER = 3;

/**
 * Same-origin SSE subscription with a polling fallback.
 *
 * The browser's `EventSource` reconnects on its own and sends `Last-Event-ID` for the
 * frames it already saw; this wrapper adds what a plain `EventSource` does not give the
 * page: a `gap` callback (replay window overflow), a manual position for reconnects after
 * a visibility pause, bounded backoff after a fatal error, and an `onFallbackPoll` tick
 * when the stream stays down. Tokens cannot be attached to `EventSource`; the static
 * admin page relies on its same-origin Cookie session, and Bearer-only deployments fall
 * back to the polling path.
 */
export function createEventStream(url: string, options: EventStreamOptions = {}): EventStream {
  const factory = resolveEventSourceFactory(options.createEventSource);
  const eventTypes = normalizeEventTypes(options.eventTypes);
  const fallbackPollMs = options.fallbackPollMs ?? DEFAULT_FALLBACK_POLL_MS;
  const fallbackAfter = Math.max(1, options.fallbackAfter ?? DEFAULT_FALLBACK_AFTER);
  const pauseWhenHidden = options.pauseWhenHidden !== false;

  let state: StreamState = 'closed';
  let lastEventId = options.lastEventId ?? null;
  let source: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let failures = 0;
  let attempt = 0;
  let closed = false;

  function setState(next: StreamState): void {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  }

  function closeSource(): void {
    if (source === null) return;
    const current = source;
    source = null;
    current.close();
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function clearPollTimer(): void {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null || isDocumentHidden()) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 15_000;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attempt += 1;
      connect();
    }, delay);
  }

  function startFallback(): void {
    setState('fallback');
    if (fallbackPollMs > 0 && pollTimer === null) {
      pollTimer = setInterval(() => {
        if (!closed && !isDocumentHidden()) options.onFallbackPoll?.();
      }, fallbackPollMs);
    }
    scheduleReconnect();
  }

  function handleFrame(type: string, event: Event): void {
    if (closed) return;
    const frame = event as MessageEvent<unknown>;
    const id =
      typeof frame.lastEventId === 'string' && frame.lastEventId !== '' ? frame.lastEventId : null;
    if (id !== null) lastEventId = id;
    const raw = typeof frame.data === 'string' ? frame.data : '';
    if (type === 'gap') {
      options.onGap?.({ oldestEventId: readOldestEventId(parseStreamData(raw)) });
      return;
    }
    options.onEvent?.({ type, data: parseStreamData(raw), raw, id, lastEventId });
  }

  function handleOpen(): void {
    if (closed) return;
    const reconnected = failures > 0 || attempt > 0;
    failures = 0;
    attempt = 0;
    clearPollTimer();
    // The server only replays from an `Last-Event-ID` header that a recreated
    // EventSource cannot set, so let the caller catch up through its poll once.
    if (reconnected) options.onFallbackPoll?.();
    setState('open');
  }

  function handleError(): void {
    if (closed) return;
    failures += 1;
    if (failures >= fallbackAfter) {
      closeSource();
      startFallback();
      return;
    }
    // While the browser is retrying (`readyState === CONNECTING`) it owns the backoff.
    if (source !== null && source.readyState !== EVENT_SOURCE_CLOSED) {
      setState('reconnecting');
      return;
    }
    closeSource();
    setState('reconnecting');
    scheduleReconnect();
  }

  function connect(): void {
    if (closed || isDocumentHidden()) return;
    clearReconnectTimer();
    closeSource();
    if (factory === null) {
      startFallback();
      return;
    }
    setState(failures === 0 && attempt === 0 ? 'connecting' : 'reconnecting');
    let created: EventSourceLike;
    try {
      created = factory(withLastEventId(url, lastEventId), { withCredentials: true });
    } catch {
      failures += 1;
      if (failures >= fallbackAfter) startFallback();
      else scheduleReconnect();
      return;
    }
    source = created;
    for (const type of eventTypes) {
      if (type === 'gap') continue;
      created.addEventListener(type, (event) => handleFrame(type, event));
    }
    // `gap` is always delivered regardless of the requested event types.
    created.addEventListener('gap', (event) => handleFrame('gap', event));
    created.addEventListener('open', handleOpen);
    created.addEventListener('error', handleError);
  }

  const onVisibility = (): void => {
    if (closed || !pauseWhenHidden) return;
    if (isDocumentHidden()) {
      closeSource();
      clearReconnectTimer();
      clearPollTimer();
      setState('reconnecting');
      return;
    }
    failures = 0;
    attempt = 0;
    // The new EventSource cannot set the `Last-Event-ID` header by hand, so the caller
    // catches up through a poll while the server replays from the query parameter.
    options.onFallbackPoll?.();
    connect();
  };

  if (pauseWhenHidden && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  if (factory === null) startFallback();
  else connect();

  return {
    get state(): StreamState {
      return state;
    },
    get lastEventId(): string | null {
      return lastEventId;
    },
    close(): void {
      if (closed) return;
      closed = true;
      closeSource();
      clearReconnectTimer();
      clearPollTimer();
      if (pauseWhenHidden && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      setState('closed');
    },
  };
}

function resolveEventSourceFactory(
  factory: EventSourceFactory | null | undefined,
): EventSourceFactory | null {
  if (factory === null) return null;
  if (factory !== undefined) return factory;
  if (typeof EventSource === 'undefined') return null;
  return (url, init) => new EventSource(url, init) as unknown as EventSourceLike;
}

function normalizeEventTypes(types: readonly string[] | undefined): readonly string[] {
  if (types === undefined) return ['message'];
  const unique: string[] = [];
  for (const type of types) {
    const trimmed = typeof type === 'string' ? type.trim() : '';
    if (trimmed !== '' && !unique.includes(trimmed)) unique.push(trimmed);
  }
  return unique.length === 0 ? ['message'] : unique;
}

function withLastEventId(url: string, lastEventId: string | null): string {
  if (lastEventId === null || lastEventId === '') return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}lastEventId=${encodeURIComponent(lastEventId)}`;
}

function parseStreamData(raw: string): unknown {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function readOldestEventId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>)['oldestEventId'];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
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
