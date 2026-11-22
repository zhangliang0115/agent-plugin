import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { VERSION } from '@zhangliang0115/repl-server-core';

export interface ServeClientOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export interface ServeClientConnectOptions {
  requestTimeoutMs?: number;
}

/**
 * Minimal process surface the client drives. Production passes a child process
 * started by the keeper; tests pass a fake object with the same shape.
 */
export interface ServeClientProcess {
  readonly stdin: { write(chunk: string): unknown; end(): unknown };
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream | null;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: () => void): unknown;
  once(event: 'exit', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface ToolListEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Minimal newline-delimited JSON-RPC client for `claude mcp serve`. */
export class ServeClient {
  private readonly child: ServeClientProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly timeoutMs: number;
  private seq = 0;
  private closed = false;
  private exited = false;

  private constructor(child: ServeClientProcess, timeoutMs: number) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.onLine(line));
    child.on('exit', () => {
      this.exited = true;
      this.rejectAll(new Error('serve process exited'));
    });
    child.stderr?.on('data', () => undefined);
  }

  /**
   * Wraps an already-spawned process (the keeper in production, a fake in
   * tests) and completes the MCP handshake. The caller owns process cleanup
   * when this rejects.
   */
  static async connect(
    child: ServeClientProcess,
    options: ServeClientConnectOptions = {},
  ): Promise<ServeClient> {
    const client = new ServeClient(child, options.requestTimeoutMs ?? 60_000);
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'repl-server', version: VERSION },
    });
    client.notify('notifications/initialized', {});
    return client;
  }

  /** Spawns `command` directly (no keeper) and connects. */
  static async start(options: ServeClientOptions): Promise<ServeClient> {
    const child = spawn(options.command, [...(options.args ?? ['mcp', 'serve'])], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as ServeClientProcess;
    try {
      return await ServeClient.connect(child, { requestTimeoutMs: options.requestTimeoutMs });
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }
  }

  /** True after {@link close} or after the child process exited. */
  get isClosed(): boolean {
    return this.closed || this.exited;
  }

  async listTools(): Promise<ToolListEntry[]> {
    const result = (await this.request('tools/list', {})) as { tools?: ToolListEntry[] };
    return result.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (signal?.aborted === true) throw abortReason(signal);
    return await this.request('tools/call', { name, arguments: args }, signal, timeoutMs);
  }

  /**
   * Sends one JSON-RPC request. `signal` aborts the pending call, drops its
   * timer and tells the server with `notifications/cancelled`; `timeoutMs`
   * narrows the client-wide budget for this request only.
   */
  async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed) throw new Error('serve client is closed');
    if (this.exited) throw new Error('serve process exited');
    if (signal?.aborted === true) throw abortReason(signal);
    const id = ++this.seq;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const budget = timeoutMs ?? this.timeoutMs;
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        cleanup();
        this.notifyCancelled(id, signal?.reason);
        reject(abortReason(signal));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`serve request timed out: ${method}`));
      }, budget);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      this.child.stdin.write(`${payload}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed || this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Best-effort `notifications/cancelled` for a request the caller aborted. */
  private notifyCancelled(requestId: number, reason: unknown): void {
    const params: Record<string, unknown> = { requestId };
    if (reason !== undefined) params['reason'] = describeReason(reason);
    this.notify('notifications/cancelled', params);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error('serve client closed'));
    this.child.stdin.end();
    if (this.exited) return;
    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 2_000);
      timer.unref?.();
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onLine(line: string): void {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const record = message as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof record.id !== 'number') return;
    const pending = this.pending.get(record.id);
    if (pending === undefined) return;
    this.pending.delete(record.id);
    clearTimeout(pending.timer);
    if (record.error !== undefined) pending.reject(record.error);
    else pending.resolve(record.result);
  }

  private rejectAll(error: unknown): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

/** Rejection value for one aborted request: the signal's reason when it has one. */
function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error('request cancelled');
  error.name = 'AbortError';
  return error;
}

function describeReason(reason: unknown): unknown {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message };
  }
  return reason;
}
