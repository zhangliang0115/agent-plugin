/**
 * Streamable HTTP transport for the third-party MCP pool.
 *
 * Each JSON-RPC message is one POST with
 * `Accept: application/json, text/event-stream`. A whole JSON body and an SSE
 * stream are both accepted: SSE `data:` lines are emitted one frame at a time,
 * and a request's POST finishes as soon as the response with its id arrives
 * (the server may keep the stream open afterwards).
 *
 * The `Mcp-Session-Id` response header is recorded and sent on every later
 * request. A 404 means the session is gone (`MCP_SESSION_EXPIRED_RETRY`, never
 * replayed by the pool); `close()` best-effort DELETEs the session and ignores
 * a 404 from an already expired one.
 *
 * @module
 */

import { isRecord } from '@zhangliang0115/repl-server-core/src/bridge/normalize-result.ts';
import { McpToolError } from '@zhangliang0115/repl-server-core/src/errors.ts';

import type { HttpTransportOptions } from '../pool.ts';
import type { RpcTransport } from './client.ts';

/** Timeout for the best-effort DELETE issued by `close()`. */
const DELETE_TIMEOUT_MS = 2_000;

/** How much of a non-2xx body is kept in `detail`. */
const ERROR_BODY_CHARS = 2_048;

/** Upper bound on one response body, matching the stdio frame cap. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return error === undefined ? 'unknown error' : String(error);
}

/** Fetch wraps socket failures in `cause`; the pool keys off those codes. */
function networkCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.code === 'string' && error.code !== '') return error.code;
  const cause = error.cause;
  if (isRecord(cause) && typeof cause.code === 'string' && cause.code !== '') return cause.code;
  return undefined;
}

function describeError(error: unknown): unknown {
  if (!isRecord(error)) return error;
  const detail: Record<string, unknown> = {};
  if (typeof error.name === 'string') detail.name = error.name;
  if (typeof error.message === 'string') detail.message = error.message;
  const code = networkCode(error);
  if (code !== undefined) detail.code = code;
  return detail;
}

function parseJsonFrame(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new McpToolError('MCP HTTP response body is not JSON', {
      code: 'MCP_PROTOCOL_ERROR',
      retryable: true,
      detail: text.slice(0, ERROR_BODY_CHARS),
    });
  }
}

function matchesResponseId(data: string, requestId: unknown): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  return isRecord(parsed) && Object.hasOwn(parsed, 'id') && parsed.id === requestId;
}

export class HttpTransport implements RpcTransport {
  readonly kind = 'http' as const;
  readonly url: string;

  private readonly baseHeaders: Record<string, string>;
  private readonly messageHandlers = new Set<(message: unknown) => void>();
  private readonly closeHandlers = new Set<(error?: unknown) => void>();
  private readonly inflight = new Set<AbortController>();
  private session: string | null = null;
  private closed = false;
  private terminated = false;
  private terminationError: unknown;
  private closePromise: Promise<void> | null = null;

  constructor(options: HttpTransportOptions) {
    this.url = options.url;
    this.baseHeaders = { ...options.headers };
  }

  /** Session id issued by the server; `null` before the first response. */
  get sessionId(): string | null {
    return this.session;
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.add(handler);
  }

  onStderr(_handler: (chunk: string) => void): void {
    // HTTP has no stderr channel; the method exists for the shared interface.
  }

  onClose(handler: (error?: unknown) => void): void {
    this.closeHandlers.add(handler);
    if (this.terminated) {
      const error = this.terminationError;
      queueMicrotask(() => handler(error));
    }
  }

  async send(
    message: Readonly<Record<string, unknown>>,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.closed) throw this.unavailable('the HTTP MCP transport is closed');
    const signal = options.signal;
    if (signal?.aborted === true) throw this.abortError(signal.reason);

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.inflight.add(controller);

    try {
      const headers: Record<string, string> = {
        ...this.baseHeaders,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      if (this.session !== null) headers['mcp-session-id'] = this.session;

      let body: string;
      try {
        body = JSON.stringify(message);
      } catch (error) {
        throw new McpToolError('MCP request is not JSON-serializable', {
          code: 'MCP_PROTOCOL_ERROR',
          retryable: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      const nextSession = response.headers.get('mcp-session-id');
      if (nextSession !== null && nextSession !== '') this.session = nextSession;

      if (response.status === 404) {
        // Expired session: a reconnect event, not a business failure.
        this.session = null;
        await response.body?.cancel().catch(() => {});
        throw new McpToolError('MCP HTTP session expired (404)', {
          code: 'MCP_SESSION_EXPIRED_RETRY',
          retryable: true,
          detail: { status: response.status },
        });
      }
      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok) {
        let body = '';
        try {
          body = await this.readBody(response);
        } catch (error) {
          if (error instanceof McpToolError) throw error;
          body = '';
        }
        throw new McpToolError(`MCP HTTP server answered ${response.status}`, {
          code: 'MCP_SERVER_UNAVAILABLE',
          retryable: true,
          detail: { status: response.status, body: body.slice(0, ERROR_BODY_CHARS) },
        });
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        const requestId = Object.hasOwn(message, 'id') ? message.id : undefined;
        await this.consumeSse(response, requestId);
        return;
      }

      const text = await this.readBody(response);
      if (text.trim() === '') return;
      this.emitMessage(parseJsonFrame(text));
    } catch (error) {
      throw this.mapError(error, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.inflight.delete(controller);
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeSession();
    return this.closePromise;
  }

  private async closeSession(): Promise<void> {
    for (const controller of this.inflight) controller.abort(new Error('transport closed'));
    this.inflight.clear();

    const session = this.session;
    this.session = null;
    if (session !== null) {
      try {
        const response = await fetch(this.url, {
          method: 'DELETE',
          headers: { ...this.baseHeaders, 'mcp-session-id': session },
          signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
        });
        // 404 is the normal answer for an already-expired session; every other
        // failure is equally harmless because close is best effort.
        await response.body?.cancel().catch(() => {});
      } catch {
        // The session is gone from the server's point of view either way.
      }
    }
    this.terminate();
  }

  /**
   * Reads a whole response body under the byte cap. The length header is a
   * cheap early rejection; the streamed count is authoritative.
   */
  private async readBody(response: Response): Promise<string> {
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw this.responseTooLarge();
    }
    const body = response.body;
    if (body === null) return '';
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          text += decoder.decode();
          return text;
        }
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw this.responseTooLarge();
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private responseTooLarge(): McpToolError {
    return new McpToolError('MCP HTTP response exceeded the size limit', {
      code: 'MCP_PROTOCOL_ERROR',
      retryable: true,
    });
  }

  /**
   * Reads one SSE body. Data lines are joined per the SSE specification; the
   * POST is released as soon as the response frame with `requestId` is seen, so
   * a server that leaves the stream open cannot hold the caller.
   */
  private async consumeSse(response: Response, requestId: unknown): Promise<void> {
    const body = response.body;
    if (body === null) {
      throw new McpToolError('MCP SSE response has no body', {
        code: 'MCP_PROTOCOL_ERROR',
        retryable: true,
      });
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
      await body.cancel().catch(() => {});
      throw this.responseTooLarge();
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines: string[] = [];
    let total = 0;
    let stop = false;

    const dispatch = (): void => {
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n');
      dataLines = [];
      if (data.trim() === '') return;
      this.emitMessage(data);
      if (requestId !== undefined && matchesResponseId(data, requestId)) stop = true;
    };

    const processLine = (rawLine: string): void => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '') {
        dispatch();
        return;
      }
      if (line.startsWith(':')) return; // SSE comment / keep-alive
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw this.responseTooLarge();
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index < 0) break;
          processLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (stop) return;
        }
      }
      if (buffer !== '') processLine(buffer);
      dispatch();
    } finally {
      // Cancel on the stop path (the server may keep the stream open) and after
      // a size violation; cancelling an already-finished stream is a no-op.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private emitMessage(message: unknown): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch {
        // A subscriber error must not interrupt the response body drain.
      }
    }
  }

  private terminate(error?: unknown): void {
    if (this.terminated) return;
    this.terminated = true;
    this.terminationError = error;
    for (const handler of this.closeHandlers) {
      try {
        handler(error);
      } catch {
        // The pool owns the failure path.
      }
    }
  }

  private mapError(error: unknown, signal: AbortSignal | undefined): unknown {
    if (error instanceof McpToolError) return error;
    if (signal?.aborted === true) return this.abortError(signal.reason);
    if (isRecord(error) && error.name === 'AbortError') {
      // `close()` aborts in-flight fetches too; that is a dead transport, not a
      // caller timeout.
      return this.closed
        ? this.unavailable('the HTTP MCP transport was closed')
        : this.abortError(error);
    }
    const code = networkCode(error) ?? 'MCP_SERVER_UNAVAILABLE';
    return new McpToolError(`MCP HTTP request failed: ${messageOf(error)}`, {
      code,
      retryable: true,
      detail: describeError(error),
    });
  }

  private unavailable(message: string): McpToolError {
    return new McpToolError(message, {
      code: 'MCP_SERVER_UNAVAILABLE',
      retryable: true,
    });
  }

  private abortError(reason: unknown): McpToolError {
    return new McpToolError('MCP HTTP request was aborted', {
      code: 'MCP_CALL_TIMEOUT',
      retryable: true,
      ...(reason === undefined ? {} : { detail: describeError(reason) }),
    });
  }
}

/** Creates a stateless Streamable HTTP transport for one configured server. */
export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  return new HttpTransport(options);
}
