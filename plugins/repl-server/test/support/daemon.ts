/**
 * Daemon lifecycle for contract tests.
 *
 * Spawns `server/src/index.ts` (or an explicit entry for self-tests) with
 * `--port 0`, parses the actual port from stderr as required by
 * `docs/protocol.md` §1.1, waits for `/health`, and owns the child's process
 * group. `stop()` sends SIGTERM to the whole group, then SIGKILL, so helpers
 * spawned by the daemon do not survive a test.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sleep } from './clock.ts';
import { createTempHome, type TempHome } from './temp.ts';

/** Default entry: the real daemon. */
export const DEFAULT_ENTRY = fileURLToPath(new URL('../../server/src/index.ts', import.meta.url));

const DEFAULT_CWD = fileURLToPath(new URL('../..', import.meta.url));

const PORT_PATTERNS: readonly RegExp[] = [
  /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/i,
  /\bport\s*[=:]\s*(\d+)\b/i,
  /\blistening\b[^\n]*:(\d+)\b/i,
];

export interface ProcessExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface DaemonStartErrorDetails {
  stderr?: string;
  stdout?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export class DaemonStartError extends Error {
  readonly stderr: string;
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(message: string, details: DaemonStartErrorDetails = {}) {
    super(message);
    this.name = 'DaemonStartError';
    this.stderr = details.stderr ?? '';
    this.stdout = details.stdout ?? '';
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
  }
}

export interface DaemonOptions {
  /** Defaults to `server/src/index.ts`; relative paths resolve from the current directory. */
  entry?: string;
  /** Extra arguments after `--port 0`. */
  args?: string[];
  /** Flags placed before the entry, e.g. `--experimental-strip-types`. */
  nodeArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Data root. When omitted a temporary home is created and removed by `stop()`. */
  agentsHome?: string;
  /** Path polled until a 2xx response; defaults to `/health`. Pass null for fixtures without one. */
  healthPath?: string | null;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** When provided, `stop` is registered as a test `after` hook. */
  t?: TestContext;
}

export interface Daemon {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly port: number;
  readonly baseUrl: string;
  readonly agentsHome: string;
  stderr(): string;
  stdout(): string;
  exitInfo(): ProcessExitInfo | null;
  waitForExit(timeoutMs?: number): Promise<ProcessExitInfo>;
  /** Idempotent; kills the whole process group. */
  stop(): Promise<ProcessExitInfo>;
}

function mergeEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

class DaemonProcess implements Daemon {
  readonly child: ChildProcess;
  readonly agentsHome: string;
  readonly healthPath: string | null;
  readonly startTimeoutMs: number;
  readonly stopTimeoutMs: number;
  port = 0;
  baseUrl = '';

  readonly #ownedHome: TempHome | null;
  readonly #exitPromise: Promise<ProcessExitInfo>;
  #stdout = '';
  #stderr = '';
  #stderrBuffer = '';
  #spawnError: Error | null = null;
  #exitInfo: ProcessExitInfo | null = null;
  #portWaiter: ((port: number) => void) | null = null;
  #portReject: ((error: DaemonStartError) => void) | null = null;
  #stopPromise: Promise<ProcessExitInfo> | null = null;

  constructor(options: DaemonOptions, ownedHome: TempHome | null) {
    this.#ownedHome = ownedHome;
    this.agentsHome = options.agentsHome ?? ownedHome?.path ?? '';
    if (this.agentsHome === '') {
      throw new TypeError('daemon requires an agentsHome');
    }
    this.healthPath = options.healthPath === undefined ? '/health' : options.healthPath;
    this.startTimeoutMs = options.startTimeoutMs ?? 10_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3000;

    const entry = options.entry === undefined ? DEFAULT_ENTRY : resolve(options.entry);
    const nodeArgs = options.nodeArgs ?? [];
    const args = [...nodeArgs, entry, '--port', '0', ...(options.args ?? [])];
    this.child = spawn(process.execPath, args, {
      cwd: options.cwd ?? DEFAULT_CWD,
      env: mergeEnv({ NODE_ENV: 'test', AGENTS_HOME: this.agentsHome, ...options.env }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.#stdout += chunk;
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.#stderr += chunk;
      this.#scanPort(chunk);
    });

    this.#exitPromise = new Promise<ProcessExitInfo>((resolveExit) => {
      this.child.once('exit', (code, signal) => {
        this.#exitInfo = { code, signal };
        resolveExit(this.#exitInfo);
      });
    });
    this.child.once('error', (error: Error) => {
      this.#spawnError = error;
      this.#portReject?.(new DaemonStartError(`failed to spawn daemon: ${error.message}`, this.#details()));
    });
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  stderr(): string {
    return this.#stderr;
  }

  stdout(): string {
    return this.#stdout;
  }

  exitInfo(): ProcessExitInfo | null {
    return this.#exitInfo;
  }

  async start(): Promise<void> {
    if (this.#spawnError !== null) {
      throw new DaemonStartError(`failed to spawn daemon: ${this.#spawnError.message}`, this.#details());
    }
    await this.#waitForPort();
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    if (this.healthPath !== null) {
      await this.#waitForHealth();
    }
  }

  waitForExit(timeoutMs?: number): Promise<ProcessExitInfo> {
    if (this.#exitInfo !== null) {
      return Promise.resolve(this.#exitInfo);
    }
    if (timeoutMs === undefined) {
      return this.#exitPromise;
    }
    return new Promise<ProcessExitInfo>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        reject(new DaemonStartError(`daemon did not exit within ${timeoutMs}ms`, this.#details()));
      }, timeoutMs);
      this.#exitPromise.then((info) => {
        clearTimeout(timer);
        resolveExit(info);
      });
    });
  }

  stop(): Promise<ProcessExitInfo> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<ProcessExitInfo> {
    if (this.#exitInfo === null && this.child.pid !== undefined) {
      this.#signal('SIGTERM');
      if (!(await this.#waitExit(this.stopTimeoutMs))) {
        this.#signal('SIGKILL');
        await this.#waitExit(2000);
      }
    }
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    if (this.#ownedHome !== null) {
      await this.#ownedHome.cleanup();
    }
    return this.#exitInfo ?? { code: null, signal: null };
  }

  #details(): DaemonStartErrorDetails {
    return {
      stderr: this.stderr(),
      stdout: this.stdout(),
      exitCode: this.#exitInfo?.code ?? null,
      signal: this.#exitInfo?.signal ?? null,
    };
  }

  #waitForPort(): Promise<number> {
    if (this.port > 0) {
      return Promise.resolve(this.port);
    }
    return new Promise<number>((resolvePort, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (error?: DaemonStartError, port?: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        this.#portWaiter = null;
        this.#portReject = null;
        if (error !== undefined) {
          reject(error);
        } else if (port !== undefined) {
          resolvePort(port);
        }
      };
      timer = setTimeout(() => {
        finish(new DaemonStartError(`daemon did not announce a port on stderr within ${this.startTimeoutMs}ms`, this.#details()));
      }, this.startTimeoutMs);
      this.#portWaiter = (port) => finish(undefined, port);
      this.#portReject = (error) => finish(error);
      this.#exitPromise.then(() => {
        finish(
          new DaemonStartError(
            `daemon exited before announcing a port (code ${String(this.#exitInfo?.code ?? null)} signal ${String(this.#exitInfo?.signal ?? null)})`,
            this.#details(),
          ),
        );
      });
    });
  }

  async #waitForHealth(): Promise<void> {
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError = 'no response';
    while (Date.now() < deadline) {
      if (this.#exitInfo !== null) {
        throw new DaemonStartError(
          `daemon exited before /health was ready (code ${String(this.#exitInfo.code)})`,
          this.#details(),
        );
      }
      if (this.#spawnError !== null) {
        throw new DaemonStartError(`failed to spawn daemon: ${this.#spawnError.message}`, this.#details());
      }
      try {
        const remaining = Math.max(1, Math.min(1000, deadline - Date.now()));
        const response = await fetch(`${this.baseUrl}${this.healthPath}`, {
          signal: AbortSignal.timeout(remaining),
        });
        if (response.ok) {
          await response.body?.cancel();
          return;
        }
        lastError = `HTTP ${response.status}`;
        await response.body?.cancel();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(25);
    }
    throw new DaemonStartError(
      `${this.healthPath} was not ready within ${this.startTimeoutMs}ms (${lastError})`,
      this.#details(),
    );
  }

  #scanPort(chunk: string): void {
    this.#stderrBuffer += chunk;
    let newline = this.#stderrBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#stderrBuffer.slice(0, newline).replace(/\r$/, '');
      this.#stderrBuffer = this.#stderrBuffer.slice(newline + 1);
      this.#matchPort(line);
      newline = this.#stderrBuffer.indexOf('\n');
    }
    this.#matchPort(this.#stderrBuffer);
  }

  #matchPort(line: string): void {
    if (this.port > 0) {
      return;
    }
    for (const pattern of PORT_PATTERNS) {
      const match = pattern.exec(line);
      const raw = match?.[1];
      if (raw === undefined) {
        continue;
      }
      const port = Number(raw);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        this.port = port;
        this.#portWaiter?.(port);
        return;
      }
    }
  }

  #waitExit(ms: number): Promise<boolean> {
    if (this.#exitInfo !== null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolveWait) => {
      const timer = setTimeout(() => resolveWait(false), ms);
      this.#exitPromise.then(() => {
        clearTimeout(timer);
        resolveWait(true);
      });
    });
  }

  #signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) {
      return;
    }
    try {
      if (process.platform === 'win32') {
        this.child.kill(signal);
      } else {
        process.kill(-pid, signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      try {
        this.child.kill(signal);
      } catch {
        // The process is already gone.
      }
    }
  }
}

/** Starts the daemon and waits for its port announcement and `/health`. */
export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const ownedHome = options.agentsHome === undefined ? await createTempHome({ prefix: 'repl-server-daemon-' }) : null;
  const daemon = new DaemonProcess(options, ownedHome);
  try {
    await daemon.start();
  } catch (error) {
    await daemon.stop();
    throw error;
  }
  options.t?.after(() => daemon.stop());
  return daemon;
}
