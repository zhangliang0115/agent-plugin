/**
 * Hand-written MCP client for the third-party connection pool.
 *
 * Implements {@link PoolClient} over a transport that carries newline-delimited
 * or HTTP-framed JSON-RPC: request ids are allocated locally and paired by id,
 * every request honors the caller's `AbortSignal`, initialization negotiates a
 * protocol version (the server may answer a different one), and failures are
 * normalized to `McpToolError` (design 01 §6.5, design 03 §3.6).
 *
 * Server-initiated requests (sampling, roots) are not supported: frames with a
 * `method` are treated as notifications and ignored.
 *
 * @module
 */

import { VERSION } from '@zhangliang0115/repl-server-core';
import { mcpToolErrorFromResult } from '@zhangliang0115/repl-server-core/src/bridge/mcp-error.ts';
import { isRecord } from '@zhangliang0115/repl-server-core/src/bridge/normalize-result.ts';
import type { ServeToolResult } from '@zhangliang0115/repl-server-core/src/bridge/normalize-result.ts';
import { McpToolError } from '@zhangliang0115/repl-server-core/src/errors.ts';

import type {
  PoolClient,
  PoolClientFactory,
  PoolServerSpec,
  PoolToolInfo,
  PoolTransport,
  PoolTransportFactory,
} from '../pool.ts';
import { createHttpTransport } from './http.ts';
import { createStdioTransport } from './stdio.ts';

/** First version attempted; a server that prefers another one may answer it. */
export const INITIAL_PROTOCOL_VERSION = '2025-11-25';

/** `clientInfo` advertised in `initialize`; any non-empty value is protocol-valid. */
const CLIENT_INFO = { name: 'repl-server', version: VERSION } as const;

const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * The framing contract shared by the stdio and HTTP transports. The pool only
 * knows {@link PoolTransport}; the client narrows to this richer shape because
 * it is the owner of the JSON-RPC payloads.
 *
 * A transport emits parsed objects when it already has them (HTTP JSON) and raw
 * text for streamed frames (stdio lines, SSE `data:`), so invalid JSON is
 * detected in one place: {@link McpClient.handleMessage}.
 */
export interface RpcTransport extends PoolTransport {
  send(
    message: Readonly<Record<string, unknown>>,
    options?: { signal?: AbortSignal },
  ): void | Promise<void>;
  onMessage(handler: (message: unknown) => void): void;
}

interface PendingRequest {
  readonly method: string;
  readonly tool: string | undefined;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
  settled: boolean;
}

/** Pairs JSON-RPC responses with requests by id, including the string form. */
function idKey(id: unknown): string {
  return `${typeof id}:${String(id)}`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return error === undefined ? 'unknown error' : String(error);
}

function describeError(error: unknown): unknown {
  if (!isRecord(error)) return error;
  const detail: Record<string, unknown> = {};
  if (typeof error.name === 'string') detail.name = error.name;
  if (typeof error.message === 'string') detail.message = error.message;
  if (typeof error.code === 'string') detail.code = error.code;
  return detail;
}

function toRpcTransport(transport: PoolTransport): RpcTransport {
  const candidate = transport as Partial<RpcTransport>;
  if (typeof candidate.send !== 'function' || typeof candidate.onMessage !== 'function') {
    throw new McpToolError('MCP transport does not carry JSON-RPC frames', {
      code: 'MCP_PROTOCOL_ERROR',
      retryable: true,
    });
  }
  return candidate as RpcTransport;
}

/**
 * A server error carries its own code inside `error.data.code` on most
 * implementations; otherwise a string `error.code` is used verbatim. Standard
 * numeric codes only keep their meaning for `-32601`, because the pool maps
 * that one to `pingUnsupported`.
 */
function reportedCode(error: Record<string, unknown>): string {
  const data = isRecord(error.data) ? error.data : undefined;
  if (data !== undefined && typeof data.code === 'string' && data.code !== '') return data.code;
  if (typeof error.code === 'string' && error.code !== '') return error.code;
  if (error.code === JSON_RPC_METHOD_NOT_FOUND) return 'METHOD_NOT_FOUND';
  return 'MCP_TOOL_ERROR';
}

/** One MCP connection: initialize, discovery, calls and the health ping. */
export class McpClient implements PoolClient {
  readonly spec: PoolServerSpec;

  private transport: RpcTransport | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private closed = false;
  private connected = false;
  private protocolFailure: McpToolError | null = null;
  private negotiatedVersion: string | null = null;

  constructor(spec: PoolServerSpec, transport: PoolTransport) {
    this.spec = spec;
    this.bind(transport);
  }

  /** Version the server answered to `initialize`; `null` before the handshake. */
  get protocolVersion(): string | null {
    return this.negotiatedVersion;
  }

  async connect(transport: PoolTransport, options: { signal: AbortSignal }): Promise<void> {
    this.bind(transport);
    if (this.connected) return;

    const result = await this.request(
      'initialize',
      {
        protocolVersion: INITIAL_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { ...CLIENT_INFO },
      },
      options,
    );
    if (!isRecord(result) || typeof result.protocolVersion !== 'string' || result.protocolVersion === '') {
      throw this.protocolError('initialize did not return a protocolVersion', result);
    }
    // The server chooses the version; accepting it is the compatibility path
    // for servers that only speak a newer revision (design 03 §3.1).
    this.negotiatedVersion = result.protocolVersion;

    await this.notify('notifications/initialized', {}, options);
    this.connected = true;
  }

  async listTools(options: { signal: AbortSignal }): Promise<readonly PoolToolInfo[]> {
    const result = await this.request('tools/list', {}, options);
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw this.protocolError('tools/list did not return a tools array', result);
    }

    const tools: PoolToolInfo[] = [];
    for (const entry of result.tools) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') {
        throw this.protocolError('tools/list returned a tool without a name', entry);
      }
      const tool: PoolToolInfo = { name: entry.name };
      if (typeof entry.description === 'string') tool.description = entry.description;
      if (entry.inputSchema !== undefined) tool.inputSchema = entry.inputSchema;
      tools.push(tool);
    }
    return tools;
  }

  async callTool(name: string, args: unknown, options: { signal: AbortSignal }): Promise<unknown> {
    const result = await this.request(
      'tools/call',
      { name, arguments: args ?? {} },
      options,
      name,
    );
    // A tool that reports its own failure stays connected; the script sees an
    // exception (design 03 §3.5). The body becomes `detail`.
    if (isRecord(result) && result.isError === true) {
      throw mcpToolErrorFromResult(
        { server: this.spec.id, tool: name },
        result as unknown as ServeToolResult,
      );
    }
    return result;
  }

  async ping(options: { signal: AbortSignal }): Promise<void> {
    await this.request('ping', {}, options);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(
      new McpToolError(`MCP client for ${this.spec.id} was closed`, {
        code: 'MCP_SERVER_UNAVAILABLE',
        server: this.spec.id,
        retryable: true,
      }),
    );
  }

  private bind(transport: PoolTransport): void {
    const link = toRpcTransport(transport);
    if (this.transport === link) return;
    this.transport = link;
    link.onMessage((message) => this.handleMessage(message));
    link.onClose((error) => this.handleTransportClose(error));
  }

  private request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: { signal: AbortSignal },
    tool?: string,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new McpToolError(`MCP client for ${this.spec.id} is closed`, {
          code: 'MCP_SERVER_UNAVAILABLE',
          server: this.spec.id,
          retryable: true,
        }),
      );
    }
    if (this.protocolFailure !== null) return Promise.reject(this.protocolFailure);
    const link = this.transport;
    if (link === null) {
      return Promise.reject(
        new McpToolError(`MCP client for ${this.spec.id} has no transport`, {
          code: 'MCP_PROTOCOL_ERROR',
          server: this.spec.id,
          retryable: true,
        }),
      );
    }

    const id = ++this.nextId;
    const key = idKey(id);
    const frame: Record<string, unknown> = { jsonrpc: '2.0', id, method, params };
    const signal = options.signal;

    return new Promise<unknown>((resolve, reject) => {
      if (signal.aborted) {
        reject(this.abortError(method, tool, signal.reason));
        return;
      }

      const pending: PendingRequest = {
        method,
        tool,
        settled: false,
        resolve,
        reject,
        cleanup: () => {
          signal.removeEventListener('abort', onAbort);
        },
      };
      const onAbort = (): void => {
        this.rejectPending(key, this.abortError(method, tool, signal.reason));
      };
      this.pending.set(key, pending);
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        const sent = link.send(frame, { signal });
        void Promise.resolve(sent).catch((error: unknown) => {
          this.rejectPending(key, this.sendError(method, tool, error));
        });
      } catch (error) {
        this.rejectPending(key, this.sendError(method, tool, error));
      }
    });
  }

  private async notify(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: { signal: AbortSignal },
  ): Promise<void> {
    if (this.closed) throw this.closedError();
    if (this.protocolFailure !== null) throw this.protocolFailure;
    const link = this.transport;
    if (link === null) throw this.protocolError('the MCP transport is missing');
    const frame: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    try {
      await link.send(frame, { signal: options.signal });
    } catch (error) {
      throw this.sendError(method, undefined, error);
    }
  }

  private handleMessage(raw: unknown): void {
    let frame: unknown = raw;
    if (typeof raw === 'string') {
      try {
        frame = JSON.parse(raw);
      } catch {
        this.failProtocol('MCP server sent a frame that is not JSON', raw.slice(0, 512));
        return;
      }
    }
    if (Array.isArray(frame)) {
      this.failProtocol('MCP server sent a batch frame, which is not supported', frame.length);
      return;
    }
    if (!isRecord(frame) || frame.jsonrpc !== '2.0') {
      this.failProtocol('MCP server sent a malformed JSON-RPC frame', frame);
      return;
    }
    // Notifications and server-initiated requests: this adapter has no handler.
    if (typeof frame.method === 'string') return;
    if (!Object.hasOwn(frame, 'id')) {
      this.failProtocol('MCP server sent a response without an id', frame);
      return;
    }

    const key = idKey(frame.id);
    const pending = this.pending.get(key);
    // A late response after abort/close is not an error: the request was abandoned.
    if (pending === undefined) return;

    if (isRecord(frame.error)) {
      this.rejectPending(key, this.rpcError(frame.error, pending.method, pending.tool));
      return;
    }
    if (!Object.hasOwn(frame, 'result')) {
      this.failProtocol('MCP server sent a response without result or error', frame);
      return;
    }
    this.resolvePending(key, frame.result);
  }

  private handleTransportClose(error?: unknown): void {
    this.connected = false;
    this.rejectAll(
      new McpToolError(`MCP server ${this.spec.id} disconnected`, {
        code: 'MCP_SERVER_UNAVAILABLE',
        server: this.spec.id,
        retryable: true,
        ...(error === undefined ? {} : { detail: describeError(error) }),
      }),
    );
  }

  private resolvePending(key: string, value: unknown): void {
    const pending = this.pending.get(key);
    if (pending === undefined || pending.settled) return;
    pending.settled = true;
    pending.cleanup();
    this.pending.delete(key);
    pending.resolve(value);
  }

  private rejectPending(key: string, error: unknown): void {
    const pending = this.pending.get(key);
    if (pending === undefined || pending.settled) return;
    pending.settled = true;
    pending.cleanup();
    this.pending.delete(key);
    pending.reject(error);
  }

  private rejectAll(error: unknown): void {
    for (const key of [...this.pending.keys()]) this.rejectPending(key, error);
  }

  private failProtocol(message: string, detail?: unknown): void {
    if (this.protocolFailure !== null) return;
    const error = this.protocolError(message, detail);
    this.protocolFailure = error;
    this.rejectAll(error);
    // A protocol violation poisons the framing, so the connection is torn down
    // and the pool reconnects on a fresh transport.
    const link = this.transport;
    if (link !== null) void Promise.resolve(link.close()).catch(() => {});
  }

  private protocolError(message: string, detail?: unknown): McpToolError {
    return new McpToolError(message, {
      code: 'MCP_PROTOCOL_ERROR',
      server: this.spec.id,
      retryable: true,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  private closedError(): McpToolError {
    return new McpToolError(`MCP client for ${this.spec.id} is closed`, {
      code: 'MCP_SERVER_UNAVAILABLE',
      server: this.spec.id,
      retryable: true,
    });
  }

  private abortError(method: string, tool: string | undefined, reason: unknown): McpToolError {
    return new McpToolError(`MCP request ${method} was aborted`, {
      code: 'MCP_CALL_TIMEOUT',
      server: this.spec.id,
      ...(tool === undefined ? {} : { tool }),
      retryable: true,
      ...(reason === undefined ? {} : { detail: describeError(reason) }),
    });
  }

  private sendError(method: string, tool: string | undefined, error: unknown): McpToolError {
    if (error instanceof McpToolError) return error;
    const code =
      isRecord(error) && typeof error.code === 'string' && error.code !== ''
        ? error.code
        : 'MCP_SERVER_UNAVAILABLE';
    return new McpToolError(`MCP ${method} failed: ${messageOf(error)}`, {
      code,
      server: this.spec.id,
      ...(tool === undefined ? {} : { tool }),
      retryable: true,
      detail: describeError(error),
    });
  }

  private rpcError(
    error: Record<string, unknown>,
    method: string,
    tool: string | undefined,
  ): McpToolError {
    const message =
      typeof error.message === 'string' && error.message !== ''
        ? error.message
        : `MCP server ${this.spec.id} rejected ${method}`;
    return new McpToolError(message, {
      code: reportedCode(error),
      server: this.spec.id,
      ...(tool === undefined ? {} : { tool }),
      retryable: false,
      // The parsed error body: `data` when the server sent one, otherwise the
      // JSON-RPC error object itself.
      detail: error.data ?? error,
    });
  }
}

/** Stdio + HTTP transports for {@link PoolTransportFactory}. */
export const mcpTransportFactory: PoolTransportFactory = {
  stdio: (options) => createStdioTransport(options),
  http: (options) => createHttpTransport(options),
};

/** One {@link McpClient} per connection attempt, as the pool requires. */
export const mcpClientFactory: PoolClientFactory = {
  create: (spec, transport) => new McpClient(spec, transport),
};
