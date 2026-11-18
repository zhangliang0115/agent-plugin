/**
 * Minimal Streamable HTTP MCP client for contract tests.
 *
 * Scope: POST JSON-RPC (single request, notification or batch), `Mcp-Session-Id`
 * propagation, bearer/raw `Authorization`, empty 202/204 replies, JSON and
 * `text/event-stream` responses, GET SSE streams, DELETE /mcp. It intentionally
 * keeps the JSON-RPC layer thin: protocol errors are returned to the caller,
 * transport/HTTP failures are thrown only by `request`.
 */
export type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponseMessage {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export interface JsonRpcRequestMessage {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotificationMessage {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcResponseMessage | JsonRpcRequestMessage | JsonRpcNotificationMessage;

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface PostOptions {
  timeoutMs?: number;
  id?: JsonRpcId;
  headers?: Record<string, string>;
}

export interface PostResult {
  status: number;
  headers: Headers;
  messages: JsonRpcMessage[];
  /** Present for non-SSE responses; raw response text. */
  text?: string;
  /** The first JSON-RPC response found, when the peer returned one. */
  response?: JsonRpcResponseMessage;
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}${body === '' ? '' : `: ${body.slice(0, 500)}`}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.body = body;
  }
}

export class HttpProtocolError extends Error {
  readonly result: PostResult;

  constructor(message: string, result: PostResult) {
    super(message);
    this.name = 'HttpProtocolError';
    this.result = result;
  }
}

export class HttpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpTimeoutError';
  }
}

export class McpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(`JSON-RPC error ${error.code}: ${error.message}`);
    this.name = 'McpRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

export interface HttpMcpClientOptions {
  /** Absolute MCP endpoint, e.g. `http://127.0.0.1:8787/mcp`. */
  url: string;
  /** Client token; sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Raw Authorization value; wins over `token`. */
  authorization?: string;
  headers?: Record<string, string>;
  sessionId?: string | null;
  /** When set, sent as `MCP-Protocol-Version` on every request. */
  protocolVersion?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponseMessage {
  return !('method' in message);
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return typeof value === 'object' && value !== null && (value as { jsonrpc?: unknown }).jsonrpc === '2.0';
}

function parseMessages(text: string): JsonRpcMessage[] {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) {
    return parsed.filter(isJsonRpcMessage);
  }
  return isJsonRpcMessage(parsed) ? [parsed] : [];
}

function messageKey(message: JsonRpcMessage): string | null {
  return 'id' in message && message.id !== null && message.id !== undefined ? String(message.id) : null;
}

function collectExpectedIds(body: unknown): Set<string> {
  const expected = new Set<string>();
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    if (!isJsonRpcMessage(entry)) {
      continue;
    }
    const key = messageKey(entry);
    if (key !== null) {
      expected.add(key);
    }
  }
  return expected;
}

function firstResponse(messages: readonly JsonRpcMessage[]): JsonRpcResponseMessage | undefined {
  return messages.find(isJsonRpcResponse);
}

function findBoundary(text: string): { index: number; length: number } | null {
  const lf = text.indexOf('\n\n');
  const crlf = text.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) {
    return null;
  }
  if (crlf === -1 || (lf !== -1 && lf < crlf)) {
    return { index: lf, length: 2 };
  }
  return { index: crlf, length: 4 };
}

function parseSseBlock(raw: string): SseEvent | null {
  const event: SseEvent = { event: 'message', data: '' };
  let hasData = false;
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'event') {
      event.event = value;
    } else if (field === 'data') {
      event.data += `${hasData ? '\n' : ''}${value}`;
      hasData = true;
    } else if (field === 'id') {
      event.id = value;
    } else if (field === 'retry') {
      const retry = Number(value);
      if (Number.isFinite(retry)) {
        event.retry = retry;
      }
    }
  }
  return hasData ? event : null;
}

/** Parses an SSE byte stream into events. Cancels the reader when the consumer stops early. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = findBoundary(buffer);
      while (boundary !== null) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseSseBlock(raw);
        if (event !== null) {
          yield event;
        }
        boundary = findBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    const tail = parseSseBlock(buffer);
    if (tail !== null) {
      yield tail;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be errored by an abort.
    }
    reader.releaseLock();
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HttpTimeoutError(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface OpenSseOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Overrides the client session for this stream; null removes the header. */
  sessionId?: string | null;
}

/** One open GET SSE stream. Call `close()` in an `after` hook. */
export class SseConnection {
  readonly status: number;
  readonly headers: Headers;
  readonly #events: AsyncGenerator<SseEvent>;
  readonly #controller: AbortController;
  #closed = false;

  constructor(status: number, headers: Headers, body: ReadableStream<Uint8Array>, controller: AbortController) {
    this.status = status;
    this.headers = headers;
    this.#events = parseSse(body);
    this.#controller = controller;
  }

  /** Returns the next JSON-RPC message, skipping heartbeats and non-JSON data. */
  async nextMessage(timeoutMs = 5000): Promise<JsonRpcMessage | null> {
    while (true) {
      const next = this.#events.next();
      const result = await withTimeout(next, timeoutMs, `SSE message timed out after ${timeoutMs}ms`);
      if (result.done === true) {
        return null;
      }
      let messages: JsonRpcMessage[];
      try {
        messages = parseMessages(result.value.data);
      } catch {
        continue;
      }
      const first = messages[0];
      if (first !== undefined) {
        return first;
      }
    }
  }

  async *messages(): AsyncGenerator<JsonRpcMessage> {
    while (true) {
      const message = await this.nextMessage();
      if (message === null) {
        return;
      }
      yield message;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#controller.abort();
    try {
      await this.#events.return(undefined);
    } catch {
      // Abort may surface as a stream error.
    }
  }
}

export class HttpMcpClient {
  readonly #url: string;
  readonly #token: string | undefined;
  readonly #authorization: string | undefined;
  readonly #baseHeaders: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #fetchImpl: typeof fetch;
  #nextId = 1;

  sessionId: string | null;
  protocolVersion: string | undefined;
  lastStatus = 0;
  lastHeaders: Headers | null = null;

  constructor(options: HttpMcpClientOptions) {
    this.#url = options.url;
    this.#token = options.token;
    this.#authorization = options.authorization;
    this.#baseHeaders = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.sessionId = options.sessionId ?? null;
    this.protocolVersion = options.protocolVersion;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  #headers(json: boolean, extra?: Record<string, string>): Headers {
    const headers = new Headers(this.#baseHeaders);
    if (json && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    if (!headers.has('accept')) {
      headers.set('accept', 'application/json, text/event-stream');
    }
    const authorization = this.#authorization ?? (this.#token === undefined ? undefined : `Bearer ${this.#token}`);
    if (authorization !== undefined && !headers.has('authorization')) {
      headers.set('authorization', authorization);
    }
    if (this.sessionId !== null && !headers.has('mcp-session-id')) {
      headers.set('mcp-session-id', this.sessionId);
    }
    if (this.protocolVersion !== undefined && !headers.has('mcp-protocol-version')) {
      headers.set('mcp-protocol-version', this.protocolVersion);
    }
    for (const [key, value] of Object.entries(extra ?? {})) {
      headers.set(key, value);
    }
    return headers;
  }

  /**
   * Sends one raw JSON-RPC body. HTTP failures are returned, not thrown, so
   * callers can assert 400/401/404 status codes and bodies.
   */
  async post(body: unknown, options: PostOptions = {}): Promise<PostResult> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new HttpTimeoutError(`POST ${this.#url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const expected = collectExpectedIds(body);
    try {
      const response = await this.#fetchImpl(this.#url, {
        method: 'POST',
        headers: this.#headers(true, options.headers),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      this.lastStatus = response.status;
      this.lastHeaders = response.headers;
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId !== null) {
        this.sessionId = sessionId;
      }
      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel();
        return { status: response.status, headers: response.headers, messages: [] };
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        const messages: JsonRpcMessage[] = [];
        if (response.body !== null) {
          for await (const event of parseSse(response.body)) {
            let parsed: JsonRpcMessage[] = [];
            try {
              parsed = parseMessages(event.data);
            } catch {
              continue;
            }
            messages.push(...parsed);
            if (expected.size === 0) {
              if (parsed.length > 0) {
                break;
              }
            } else {
              for (const message of parsed) {
                const key = messageKey(message);
                if (key !== null) {
                  expected.delete(key);
                }
              }
              if (expected.size === 0) {
                break;
              }
            }
          }
        }
        return {
          status: response.status,
          headers: response.headers,
          messages,
          response: firstResponse(messages),
        };
      }
      const text = await response.text();
      const messages = text.trim() === '' ? [] : parseMessages(text);
      return {
        status: response.status,
        headers: response.headers,
        messages,
        text,
        response: firstResponse(messages),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof Error) {
          throw reason;
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sends a request and returns its JSON-RPC response (including `error`). */
  async request(method: string, params?: unknown, options: PostOptions = {}): Promise<JsonRpcResponseMessage> {
    const id = options.id ?? this.#nextId++;
    const body: JsonRpcRequestMessage = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      body.params = params;
    }
    const result = await this.post(body, options);
    if (result.status < 200 || result.status >= 300) {
      throw new HttpStatusError(result.status, result.text ?? JSON.stringify(result.messages));
    }
    const response = result.messages.find(
      (message): message is JsonRpcResponseMessage => isJsonRpcResponse(message) && messageKey(message) === String(id),
    );
    if (response === undefined) {
      throw new HttpProtocolError(`no JSON-RPC response for id ${String(id)}`, result);
    }
    return response;
  }

  /** Like `request`, but throws `McpRpcError` when the peer returns a JSON-RPC error. */
  async requestOrThrow(method: string, params?: unknown, options: PostOptions = {}): Promise<JsonRpcResponseMessage> {
    const response = await this.request(method, params, options);
    if (response.error !== undefined) {
      throw new McpRpcError(response.error);
    }
    return response;
  }

  /** Sends a notification (no id). */
  async notify(method: string, params?: unknown, options: PostOptions = {}): Promise<PostResult> {
    const body: JsonRpcNotificationMessage = { jsonrpc: '2.0', method };
    if (params !== undefined) {
      body.params = params;
    }
    return this.post(body, options);
  }

  /** Opens the GET SSE channel. Close it before stopping the daemon. */
  async openSse(options: OpenSseOptions = {}): Promise<SseConnection> {
    const headers = this.#headers(false, options.headers);
    headers.set('accept', 'text/event-stream');
    if (options.sessionId !== undefined) {
      if (options.sessionId === null) {
        headers.delete('mcp-session-id');
      } else {
        headers.set('mcp-session-id', options.sessionId);
      }
    }
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const timer = setTimeout(() => {
      controller.abort(new HttpTimeoutError(`GET ${this.#url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      const response = await this.#fetchImpl(this.#url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      this.lastStatus = response.status;
      this.lastHeaders = response.headers;
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId !== null) {
        this.sessionId = sessionId;
      }
      if (!response.ok) {
        const text = await response.text();
        controller.abort();
        throw new HttpStatusError(response.status, text);
      }
      if (response.body === null) {
        controller.abort();
        throw new HttpProtocolError('SSE response has no body', {
          status: response.status,
          headers: response.headers,
          messages: [],
        });
      }
      return new SseConnection(response.status, response.headers, response.body, controller);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sends DELETE /mcp and forgets the session id. Returns the HTTP status. */
  async deleteSession(options: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<number> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const timer = setTimeout(() => {
      controller.abort(new HttpTimeoutError(`DELETE ${this.#url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      const response = await this.#fetchImpl(this.#url, {
        method: 'DELETE',
        headers: this.#headers(false, options.headers),
        signal: controller.signal,
      });
      this.lastStatus = response.status;
      this.lastHeaders = response.headers;
      await response.body?.cancel();
      this.sessionId = null;
      return response.status;
    } finally {
      clearTimeout(timer);
    }
  }
}
