/**
 * Newline-delimited JSON-RPC client over stdio.
 *
 * Used against the stdio bridge (`--stdio`) or any fixture that reads one JSON
 * object per stdin line and writes one JSON object per stdout line. stderr is
 * captured separately because the bridge must keep stdout protocol-clean.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { TestContext } from 'node:test';

import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotificationMessage,
  JsonRpcRequestMessage,
  JsonRpcResponseMessage,
} from './http-client.ts';
import type { ProcessExitInfo } from './daemon.ts';

export class StdioClientClosedError extends Error {
  constructor(message = 'stdio client is closed') {
    super(message);
    this.name = 'StdioClientClosedError';
  }
}

export class StdioTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StdioTimeoutError';
  }
}

export interface StdioClientOptions {
  /** Defaults to the current Node binary. */
  command?: string;
  /** Script/bridge arguments. Required: the client never guesses an entry. */
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** When provided, `close` is registered as a test `after` hook. */
  t?: TestContext;
}

export interface RequestOptions {
  id?: JsonRpcId;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve(response: JsonRpcResponseMessage): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface NotificationWaiter {
  predicate(message: JsonRpcNotificationMessage): boolean;
  resolve(message: JsonRpcNotificationMessage): void;
}

function mergeEnv(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class StdioRpcClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly badLines: string[] = [];
  readonly notifications: JsonRpcNotificationMessage[] = [];
  readonly serverRequests: JsonRpcRequestMessage[] = [];
  readonly orphanResponses: JsonRpcResponseMessage[] = [];

  readonly #requestTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #notificationWaiters: NotificationWaiter[] = [];
  readonly #exitPromise: Promise<ProcessExitInfo>;
  readonly #readyPromise: Promise<void>;
  #requestHandler: ((request: JsonRpcRequestMessage) => unknown | Promise<unknown>) | null = null;
  #nextId = 1;
  #stdoutText = '';
  #stderrText = '';
  #stdoutBuffer = '';
  #exitInfo: ProcessExitInfo | null = null;
  #closePromise: Promise<ProcessExitInfo> | null = null;

  constructor(options: StdioClientOptions) {
    if (options.args.length === 0) {
      throw new TypeError('stdio client requires args (bridge or fixture script)');
    }
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 2000;
    this.child = spawn(options.command ?? process.execPath, options.args, {
      cwd: options.cwd,
      env: mergeEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.#onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.#stderrText += chunk;
    });
    this.child.stdin.on('error', (error: Error) => {
      this.#failPending(new StdioClientClosedError(error.message));
    });

    this.#readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.child.once('spawn', () => resolveReady());
      this.child.once('error', (error: Error) => rejectReady(error));
    });
    this.#readyPromise.catch(() => {
      // `ready()` owns the surfaced error; keep the promise quiet otherwise.
    });

    this.#exitPromise = new Promise<ProcessExitInfo>((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.#exitInfo = { code, signal };
        this.#failPending(new StdioClientClosedError(`stdio process exited with code ${String(code)} signal ${String(signal)}`));
        resolve(this.#exitInfo);
      });
    });
    this.#exitPromise.catch(() => {
      // The exit promise never rejects; keep the chain quiet for future edits.
    });
    this.child.once('error', (error: Error) => {
      this.#failPending(error);
    });
  }

  /** Resolves once the child process has spawned. */
  async ready(): Promise<void> {
    if (this.#exitInfo !== null) {
      throw new StdioClientClosedError('stdio process exited before it was ready');
    }
    await this.#readyPromise;
  }

  /** Registers a handler for server-initiated requests (roots/list, elicitation). */
  setRequestHandler(handler: (request: JsonRpcRequestMessage) => unknown | Promise<unknown>): void {
    this.#requestHandler = handler;
  }

  async request(method: string, params?: unknown, options: RequestOptions = {}): Promise<JsonRpcResponseMessage> {
    const id = options.id ?? this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    const body: JsonRpcRequestMessage = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      body.params = params;
    }
    const key = String(id);
    const promise = new Promise<JsonRpcResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(new StdioTimeoutError(`stdio request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(key, { resolve, reject, timer });
    });
    try {
      this.#write(body);
    } catch (error) {
      const pending = this.#pending.get(key);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(key);
      }
      throw error;
    }
    return promise;
  }

  notify(method: string, params?: unknown): void {
    const body: JsonRpcNotificationMessage = { jsonrpc: '2.0', method };
    if (params !== undefined) {
      body.params = params;
    }
    this.#write(body);
  }

  /** Writes an arbitrary line, for malformed-input tests. Appends a newline when absent. */
  sendRaw(line: string): void {
    this.#writeRaw(line.endsWith('\n') ? line : `${line}\n`);
  }

  /** Waits for a notification matching `predicate`; consumes it from the queue. */
  async waitForNotification(
    predicate: (message: JsonRpcNotificationMessage) => boolean,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<JsonRpcNotificationMessage> {
    const index = this.notifications.findIndex(predicate);
    if (index >= 0) {
      const [found] = this.notifications.splice(index, 1);
      if (found !== undefined) {
        return found;
      }
    }
    return new Promise<JsonRpcNotificationMessage>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: NotificationWaiter = {
        predicate,
        resolve: (message) => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          resolve(message);
        },
      };
      timer = setTimeout(() => {
        const waiterIndex = this.#notificationWaiters.indexOf(waiter);
        if (waiterIndex >= 0) {
          this.#notificationWaiters.splice(waiterIndex, 1);
        }
        reject(new StdioTimeoutError(`stdio notification timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#notificationWaiters.push(waiter);
    });
  }

  stderr(): string {
    return this.#stderrText;
  }

  stdout(): string {
    return this.#stdoutText;
  }

  exitInfo(): ProcessExitInfo | null {
    return this.#exitInfo;
  }

  waitForExit(timeoutMs?: number): Promise<ProcessExitInfo> {
    if (timeoutMs === undefined) {
      return this.#exitPromise;
    }
    return new Promise<ProcessExitInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new StdioTimeoutError(`stdio process did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#exitPromise.then((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  /** Ends stdin, then escalates to SIGTERM/SIGKILL. Idempotent. */
  close(options: { timeoutMs?: number } = {}): Promise<ProcessExitInfo> {
    this.#closePromise ??= this.#close(options);
    return this.#closePromise;
  }

  async #close(options: { timeoutMs?: number }): Promise<ProcessExitInfo> {
    if (this.#exitInfo !== null) {
      return this.#exitInfo;
    }
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    if (await this.#waitExit(options.timeoutMs ?? this.#closeTimeoutMs)) {
      return this.#exitInfo ?? { code: null, signal: null };
    }
    this.#signal('SIGTERM');
    if (await this.#waitExit(1000)) {
      return this.#exitInfo ?? { code: null, signal: null };
    }
    this.#signal('SIGKILL');
    await this.#waitExit(1000);
    return this.#exitInfo ?? { code: null, signal: null };
  }

  #write(message: JsonRpcMessage): void {
    this.#writeRaw(`${JSON.stringify(message)}\n`);
  }

  #writeRaw(line: string): void {
    if (this.#exitInfo !== null) {
      throw new StdioClientClosedError(`stdio process already exited (code ${String(this.#exitInfo.code)})`);
    }
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new StdioClientClosedError('stdin is not writable');
    }
    this.child.stdin.write(line);
  }

  #onStdout(chunk: string): void {
    this.#stdoutText += chunk;
    this.#stdoutBuffer += chunk;
    let newline = this.#stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      let line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      this.#onLine(line);
      newline = this.#stdoutBuffer.indexOf('\n');
    }
  }

  #onLine(line: string): void {
    if (line.trim() === '') {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.badLines.push(line);
      return;
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') {
      this.badLines.push(line);
      return;
    }
    const message = parsed as unknown as JsonRpcMessage;
    if (typeof parsed.method === 'string') {
      if (parsed.id !== undefined && parsed.id !== null) {
        const request = message as JsonRpcRequestMessage;
        this.serverRequests.push(request);
        void this.#answer(request).catch(() => {
          // The process may exit while a server request is being answered.
        });
      } else {
        const notification = message as JsonRpcNotificationMessage;
        this.notifications.push(notification);
        this.#resolveNotificationWaiters(notification);
      }
      return;
    }
    const response = message as JsonRpcResponseMessage;
    if (response.id !== null && response.id !== undefined) {
      const key = String(response.id);
      const pending = this.#pending.get(key);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(key);
        pending.resolve(response);
        return;
      }
    }
    this.orphanResponses.push(response);
  }

  async #answer(request: JsonRpcRequestMessage): Promise<void> {
    const handler = this.#requestHandler;
    if (handler === null) {
      this.#write({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      });
      return;
    }
    try {
      const result = await handler(request);
      this.#write({ jsonrpc: '2.0', id: request.id, result: result === undefined ? {} : result });
    } catch (error) {
      this.#write({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  #resolveNotificationWaiters(message: JsonRpcNotificationMessage): void {
    for (const waiter of [...this.#notificationWaiters]) {
      if (waiter.predicate(message)) {
        const index = this.#notificationWaiters.indexOf(waiter);
        if (index >= 0) {
          this.#notificationWaiters.splice(index, 1);
        }
        waiter.resolve(message);
      }
    }
  }

  #failPending(error: Error): void {
    for (const [key, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(key);
      pending.reject(error);
    }
  }

  #waitExit(ms: number): Promise<boolean> {
    if (this.#exitInfo !== null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.#exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  #signal(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      // ESRCH: already gone.
    }
  }
}

/** Spawns a stdio peer and waits for the `spawn` event. */
export async function startStdioClient(options: StdioClientOptions): Promise<StdioRpcClient> {
  const client = new StdioRpcClient(options);
  await client.ready();
  options.t?.after(() => client.close());
  return client;
}
