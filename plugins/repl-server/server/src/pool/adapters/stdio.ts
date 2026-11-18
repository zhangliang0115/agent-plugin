/**
 * Stdio transport for the third-party MCP pool.
 *
 * One child process per connection attempt: `detached: true` puts it in its own
 * process group so a SIGKILLed parent cannot orphan it, `stderr: 'pipe'` is
 * drained continuously (a full pipe blocks the child), and the environment is
 * exactly what the caller built — `process.env` is never forwarded (design 03
 * §3.1). Frames are newline-delimited JSON; the child's `pid`, process group id
 * and raw `lstart` are exposed for the `pool.json` ledger so a startup sweep can
 * tell a live child from a reused PID.
 *
 * `close()` sends SIGTERM to the process group, waits the grace window and then
 * sends SIGKILL; `ESRCH` means the group is already gone and is ignored.
 *
 * @module
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { McpToolError } from '@zhangliang0115/repl-server-core/src/errors.ts';
import { psRow } from '@zhangliang0115/repl-server-core/src/process/tree.ts';

import type { PoolTransport, StdioTransportOptions } from '../pool.ts';
import type { RpcTransport } from './client.ts';

/** Time between SIGTERM and the SIGKILL escalation. */
export const STDIO_TERM_GRACE_MS = 2_000;

/** Upper bound on the wait after SIGKILL; the group is normally gone at once. */
const STDIO_KILL_GRACE_MS = 1_000;

/** A single JSON-RPC frame larger than this is treated as a protocol violation. */
const MAX_FRAME_CHARS = 16 * 1024 * 1024;

/** Process metadata for `pool.json`; `null` when `ps` could not be read. */
interface ProcessIdentity {
  pgid: number | undefined;
  lstart: string | undefined;
}

function readIdentity(pid: number): ProcessIdentity {
  try {
    const row = psRow(pid);
    return { pgid: row?.pgid, lstart: row?.lstart };
  } catch {
    // `ps` failing must not prevent the child from running; the ledger then
    // records the pid without a reusable start-time identity.
    return { pgid: undefined, lstart: undefined };
  }
}

function exitFailure(code: number | null, signal: NodeJS.Signals | null): Error | undefined {
  if (code === 0 && signal === null) return undefined;
  const reason = signal === null ? `code ${String(code)}` : `signal ${signal}`;
  return new Error(`stdio MCP child exited with ${reason}`);
}

/** Resolves `true` when (and only when) the promise settles within `ms`. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class StdioTransport implements RpcTransport {
  readonly kind = 'stdio' as const;
  readonly pid: number | undefined;
  readonly pgid: number | undefined;
  readonly lstart: string | undefined;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly termGraceMs: number;
  private readonly messageHandlers = new Set<(message: unknown) => void>();
  private readonly stderrHandlers = new Set<(chunk: string) => void>();
  private readonly closeHandlers = new Set<(error?: unknown) => void>();
  private readonly exited: Promise<void>;

  private markExited: () => void = () => {};
  private stdoutBuffer = '';
  private closed = false;
  private terminated = false;
  private exitedProcess = false;
  private terminationError: unknown;
  private closePromise: Promise<void> | null = null;

  constructor(options: StdioTransportOptions, termGraceMs = STDIO_TERM_GRACE_MS) {
    this.termGraceMs = termGraceMs;
    this.exited = new Promise<void>((resolve) => {
      this.markExited = resolve;
    });

    const child = spawn(options.command, [...options.args], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    const pid = child.pid;
    this.pid = pid;
    const identity = pid === undefined ? { pgid: undefined, lstart: undefined } : readIdentity(pid);
    // `detached: true` makes the child a process-group leader, so its pid is
    // the group id even when `ps` raced with the spawn.
    this.pgid = identity.pgid ?? pid;
    this.lstart = identity.lstart;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.emitStderr(chunk));
    // Draining errors keeps a broken pipe from becoming an unhandled event.
    child.stderr.on('error', () => {});
    // A stdin failure makes the connection unusable but does not prove the
    // child exited, so `close()` must still signal the process group.
    child.stdin.on('error', (error: Error) => this.notifyClosed(error));
    child.once('error', (error: Error) => this.complete(error));
    child.once('exit', (code, signal) => this.complete(exitFailure(code, signal)));
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.add(handler);
  }

  onStderr(handler: (chunk: string) => void): void {
    this.stderrHandlers.add(handler);
  }

  onClose(handler: (error?: unknown) => void): void {
    this.closeHandlers.add(handler);
    if (this.terminated) {
      const error = this.terminationError;
      queueMicrotask(() => handler(error));
    }
  }

  send(
    message: Readonly<Record<string, unknown>>,
    _options: { signal?: AbortSignal } = {},
  ): void {
    if (this.closed || this.terminated) {
      throw new McpToolError('stdio MCP child is not running', {
        code: 'MCP_SERVER_UNAVAILABLE',
        retryable: true,
      });
    }
    let line: string;
    try {
      line = JSON.stringify(message);
    } catch (error) {
      throw new McpToolError('MCP request is not JSON-serializable', {
        code: 'MCP_PROTOCOL_ERROR',
        retryable: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    this.child.stdin.write(`${line}\n`);
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.closePromise = this.terminate();
    return this.closePromise;
  }

  private async terminate(): Promise<void> {
    if (this.exitedProcess) {
      this.destroyStreams();
      return;
    }
    this.signalGroup('SIGTERM');
    if (!(await settlesWithin(this.exited, this.termGraceMs))) {
      this.signalGroup('SIGKILL');
      await settlesWithin(this.exited, STDIO_KILL_GRACE_MS);
    }
    this.destroyStreams();
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pgid = this.pgid ?? this.pid;
    if (pgid === undefined) return;
    try {
      process.kill(-pgid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
    try {
      this.child.kill(signal);
    } catch {
      // The process is gone; the exit event (if any) already fired.
    }
  }

  private destroyStreams(): void {
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      try {
        stream.destroy();
      } catch {
        // Streams may already be torn down by the exit path.
      }
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const index = this.stdoutBuffer.indexOf('\n');
      if (index < 0) break;
      const rawLine = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.trim() !== '') this.emitMessage(line);
    }
    if (this.stdoutBuffer.length > MAX_FRAME_CHARS) {
      this.stdoutBuffer = '';
      this.notifyClosed(
        new McpToolError('stdio MCP frame exceeded the size limit', {
          code: 'MCP_PROTOCOL_ERROR',
          retryable: true,
        }),
      );
      this.signalGroup('SIGKILL');
    }
  }

  private emitMessage(message: unknown): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch {
        // A subscriber error must not interrupt the stdout drain.
      }
    }
  }

  private emitStderr(chunk: string): void {
    if (this.stderrHandlers.size === 0) return; // still drained, just dropped
    for (const handler of this.stderrHandlers) {
      try {
        handler(chunk);
      } catch {
        // Keep draining even when the consumer throws.
      }
    }
  }

  /** The process is gone; resolves `close()` even when no exit signal arrived. */
  private complete(error?: unknown): void {
    if (!this.exitedProcess) {
      this.exitedProcess = true;
      this.markExited();
    }
    this.notifyClosed(error);
  }

  /** Reports the connection as unusable at most once. */
  private notifyClosed(error?: unknown): void {
    if (this.terminated) return;
    this.terminated = true;
    this.closed = true;
    this.terminationError = error;
    if (this.stdoutBuffer.trim() !== '') {
      const tail = this.stdoutBuffer;
      this.stdoutBuffer = '';
      this.emitMessage(tail);
    }
    for (const handler of this.closeHandlers) {
      try {
        handler(error);
      } catch {
        // The pool owns the failure path; a throwing listener changes nothing.
      }
    }
    // On a transport close the pool drops the object without calling `close()`
    // (it assumes the child is already gone), so a live child left behind by a
    // stdin failure has to be reaped here.
    if (!this.exitedProcess) this.reapAfterFailure();
  }

  private reapAfterFailure(): void {
    this.signalGroup('SIGTERM');
    const timer = setTimeout(() => {
      if (!this.exitedProcess) this.signalGroup('SIGKILL');
    }, this.termGraceMs);
    timer.unref?.();
  }
}

/** Creates one detached stdio child; the pool registers it in the ledger. */
export function createStdioTransport(
  options: StdioTransportOptions,
  termGraceMs?: number,
): StdioTransport {
  return new StdioTransport(options, termGraceMs);
}
