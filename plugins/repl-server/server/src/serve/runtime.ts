/**
 * Per-execution-session `claude mcp serve` runtime.
 *
 * One workspace owns one keeper + serve pair. `ServeManager` owns launch,
 * readiness, ledger mirroring, death detection and restart (design 02 §2.2,
 * §3.3); this module only keys managers by workspace and publishes the
 * connected {@link ServeClient}. The keeper writes `serve.json` before it opens
 * MCP traffic, so a completed handshake also proves the ledger record exists.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import {
  McpToolError,
  newId,
  ProcessLedger,
  SERVE_HEALTH_DEFAULTS,
  ServeManager,
  type LaunchedServe,
  type ServeIdentity,
  type ServeLaunchSpec,
  type ServeManagerEvent,
  type ServeProbe,
} from '@zhangliang0115/repl-server-core';
import { keeperLaunch } from '@zhangliang0115/repl-server-core/src/process/keeper.ts';

import { ServeClient, type ServeClientProcess } from './client.ts';

/** Options handed to the injected spawn; mirrors the subset the keeper needs. */
export interface ServeSpawnOptions {
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
}

/** Test seam: replaces `node:child_process.spawn` for the keeper. */
export type ServeSpawn = (
  command: string,
  args: readonly string[],
  options: ServeSpawnOptions,
) => ServeClientProcess;

export interface ServeRuntimeOptions {
  /** repl-server data directory; serve records live in `<dataDir>/sessions/...`. */
  readonly dataDir: string;
  /** Serve executable; defaults to `REPL_CLAUDE_BIN`, then `claude`. */
  readonly bin?: string;
  /** Diagnostics sink; MCP traffic never goes here. Defaults to silence. */
  readonly log?: (line: string) => void;
  /** Test seam; defaults to `node:child_process.spawn`. */
  readonly spawn?: ServeSpawn;
  /**
   * Boot id shared with `state.json` and the startup sweep. Integration must
   * pass the process boot; the default is a fresh id (correct for a process
   * that never ran a sweep yet).
   */
  readonly bootId?: string;
  /** Keeper readiness budget; defaults to 10s. */
  readonly readyTimeoutMs?: number;
  /** Per-request JSON-RPC timeout; defaults to the ServeClient default (60s). */
  readonly requestTimeoutMs?: number;
  /** Ping fallback interval; 0 disables it, as in ServeManager. */
  readonly pingIntervalMs?: number;
  readonly terminateGraceMs?: number;
  readonly killWaitMs?: number;
  readonly now?: () => number;
}

export interface ServeRuntime {
  /**
   * Returns the serve client for `workspace`, starting keeper + serve on first
   * use. Concurrent calls for the same workspace share one startup.
   */
  acquire(workspace: string): Promise<ServeClient>;
  /** Stops the keeper group for `workspace` and closes the transport. No-op when absent. */
  release(workspace: string): Promise<void>;
  /** Stops every workspace. The runtime rejects further acquisitions afterwards. */
  disposeAll(): Promise<void>;
}

interface RuntimeEntry {
  readonly workspace: string;
  readonly sessionId: string;
  manager: ServeManager;
  client: ServeClient | null;
  starting: Promise<ServeClient> | null;
}

const defaultSpawn: ServeSpawn = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as ServeClientProcess;

class ServeRuntimeImpl implements ServeRuntime {
  readonly dataDir: string;
  private readonly command: string;
  private readonly log: (line: string) => void;
  private readonly spawnProcess: ServeSpawn;
  private readonly bootId: string;
  private readonly readyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly terminateGraceMs: number;
  private readonly killWaitMs: number;
  private readonly now: (() => number) | undefined;
  private readonly ledger: ProcessLedger;
  private readonly entries = new Map<string, RuntimeEntry>();
  private sessionCounter = 0;
  private disposed = false;

  constructor(options: ServeRuntimeOptions) {
    if (typeof options.dataDir !== 'string' || options.dataDir === '') {
      throw new TypeError('dataDir must be a non-empty string');
    }
    this.dataDir = resolve(options.dataDir);
    const configuredBin = options.bin ?? process.env['REPL_CLAUDE_BIN'];
    this.command = configuredBin === undefined || configuredBin === '' ? 'claude' : configuredBin;
    this.log = options.log ?? (() => undefined);
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.ledger = new ProcessLedger({
      root: this.dataDir,
      onCorrupt: (issue) => this.log(`[serve] ledger ${issue.path}: ${issue.reason}`),
    });
    // Adopt the boot already recorded in state.json so a manager never trips
    // ServeManager's SERVE_BOOT_MISMATCH. A fresh id is only for the first
    // process that has not run a sweep yet.
    this.bootId = options.bootId ?? stateBootId(this.ledger) ?? newId('boot');
    this.readyTimeoutMs = positiveOption(
      options.readyTimeoutMs,
      SERVE_HEALTH_DEFAULTS.readyTimeoutMs,
      'readyTimeoutMs',
      false,
    );
    this.requestTimeoutMs = positiveOption(options.requestTimeoutMs, 60_000, 'requestTimeoutMs', false);
    this.pingIntervalMs = positiveOption(
      options.pingIntervalMs,
      SERVE_HEALTH_DEFAULTS.pingIntervalMs,
      'pingIntervalMs',
      true,
    );
    this.terminateGraceMs = positiveOption(
      options.terminateGraceMs,
      SERVE_HEALTH_DEFAULTS.terminateGraceMs,
      'terminateGraceMs',
      true,
    );
    this.killWaitMs = positiveOption(options.killWaitMs, SERVE_HEALTH_DEFAULTS.killWaitMs, 'killWaitMs', true);
    this.now = options.now;
  }

  async acquire(workspace: string): Promise<ServeClient> {
    assertWorkspace(workspace);
    if (this.disposed) throw unavailable(workspace, new Error('serve runtime is disposed'));

    const existing = this.entries.get(workspace);
    if (existing !== undefined) return await this.clientOf(existing);

    let entry: RuntimeEntry;
    try {
      entry = this.makeEntry(workspace);
    } catch (error) {
      throw unavailable(workspace, error);
    }
    this.entries.set(workspace, entry);
    const starting = this.startEntry(entry);
    entry.starting = starting;
    void starting.then(
      () => {
        if (entry.starting === starting) entry.starting = null;
      },
      () => {
        // The rejection is delivered through `starting`; the map cleanup is below.
      },
    );
    try {
      return await starting;
    } catch (error) {
      if (this.entries.get(workspace) === entry) this.entries.delete(workspace);
      throw error;
    }
  }

  async release(workspace: string): Promise<void> {
    assertWorkspace(workspace);
    const entry = this.entries.get(workspace);
    if (entry === undefined) return;
    this.entries.delete(workspace);
    await this.stopEntry(entry, 'release');
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(async (entry) => await this.stopEntry(entry, 'shutdown')));
  }

  private async clientOf(entry: RuntimeEntry): Promise<ServeClient> {
    if (entry.starting !== null) return await entry.starting;
    const client = entry.client;
    if (client !== null && !client.isClosed) return client;
    throw unavailable(entry.workspace, new Error('serve process is not running'));
  }

  private makeEntry(workspace: string): RuntimeEntry {
    this.sessionCounter += 1;
    const hash = createHash('sha256').update(workspace).digest('hex').slice(0, 12);
    const sessionId = `es_${hash}_${this.sessionCounter}`;
    const entry: RuntimeEntry = {
      workspace,
      sessionId,
      manager: null as unknown as ServeManager,
      client: null,
      starting: null,
    };
    const probe: ServeProbe = {
      ping: async () => {
        const client = entry.client;
        if (client === null || client.isClosed) throw new Error('serve client is not ready');
        await client.request('ping', {});
      },
    };
    entry.manager = new ServeManager({
      sessionId,
      bootId: this.bootId,
      ledger: this.ledger,
      launch: (spec) => this.launchEntry(entry, spec),
      probe,
      serve: { command: this.command, args: ['mcp', 'serve'] },
      cwd: workspace,
      now: this.now,
      readyTimeoutMs: this.readyTimeoutMs,
      pingIntervalMs: this.pingIntervalMs,
      terminateGraceMs: this.terminateGraceMs,
      killWaitMs: this.killWaitMs,
      onEvent: (event) => this.onManagerEvent(entry, event),
    });
    return entry;
  }

  private async startEntry(entry: RuntimeEntry): Promise<ServeClient> {
    try {
      await entry.manager.start();
    } catch (error) {
      const client = entry.client;
      entry.client = null;
      if (client !== null) await client.close().catch(() => undefined);
      throw unavailable(entry.workspace, error);
    }
    const client = entry.client;
    if (client === null) {
      throw unavailable(entry.workspace, new Error('serve manager started without a client'));
    }
    return client;
  }

  private async stopEntry(entry: RuntimeEntry, reason: 'release' | 'shutdown'): Promise<void> {
    if (entry.starting !== null) await entry.starting.catch(() => undefined);
    const client = entry.client;
    entry.client = null;
    try {
      // Dispose also drops the ledger session entry; the serve generation is
      // over, so a `{serve:null}` tombstone would only accumulate.
      await entry.manager.dispose(reason);
    } catch (error) {
      this.log(`[serve] ${entry.sessionId} stop failed: ${describe(error)}`);
    }
    if (client !== null) {
      try {
        await client.close();
      } catch (error) {
        this.log(`[serve] ${entry.sessionId} close failed: ${describe(error)}`);
      }
    }
  }

  /**
   * Wraps the keeper so ServeManager can supervise it. Readiness means: the
   * keeper wrote `serve.json` for this launch and the MCP handshake completed.
   */
  private async launchEntry(entry: RuntimeEntry, spec: ServeLaunchSpec): Promise<LaunchedServe> {
    const keeper = keeperLaunch({
      sessionId: spec.sessionId,
      bootId: spec.bootId,
      stateDir: this.dataDir,
      serve: { command: spec.command, args: spec.args },
    });

    let child: ServeClientProcess;
    try {
      child = this.spawnProcess(keeper.command, keeper.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`failed to spawn keeper: ${describe(error)}`);
    }

    let hasExited = false;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const markExited = (): void => {
      if (hasExited) return;
      hasExited = true;
      resolveExit();
    };
    child.once('exit', markExited);
    child.once('error', markExited);

    try {
      const ready = await withTimeout(
        this.connectKeeper(spec, child),
        this.readyTimeoutMs,
        () => new Error(`serve for ${spec.cwd} was not ready within ${this.readyTimeoutMs}ms`),
      );
      entry.client = ready.client;
      return {
        ready: Promise.resolve(ready.identity),
        exited,
        kill: (signal) => {
          try {
            child.kill(signal);
          } catch {
            // ESRCH: the keeper is already gone.
          }
        },
      };
    } catch (error) {
      safeKill(child, 'SIGTERM');
      await settlesWithin(exited, this.terminateGraceMs);
      safeKill(child, 'SIGKILL');
      await settlesWithin(exited, this.killWaitMs);
      try {
        this.ledger.removeServe(spec.sessionId);
      } catch (removeError) {
        this.log(`[serve] ${spec.sessionId} ledger cleanup failed: ${describe(removeError)}`);
      }
      throw error;
    }
  }

  private async connectKeeper(
    spec: ServeLaunchSpec,
    child: ServeClientProcess,
  ): Promise<{ identity: ServeIdentity; client: ServeClient }> {
    const client = await ServeClient.connect(child, { requestTimeoutMs: this.requestTimeoutMs });

    // The keeper writes serve.json before it pipes any MCP byte, so the file
    // must exist now. Reject a record left by another boot or another keeper.
    const record = this.ledger.readServe(spec.sessionId);
    if (record === null) throw new Error('keeper did not write serve.json');
    if (record.bootId !== spec.bootId) {
      throw new Error(`serve.json belongs to boot ${record.bootId}, not ${spec.bootId}`);
    }
    if (typeof child.pid === 'number' && record.keeperPid !== child.pid) {
      throw new Error(`serve.json belongs to keeper ${record.keeperPid}, not ${child.pid}`);
    }

    return {
      identity: {
        pid: record.pid,
        pgid: record.pgid,
        keeperPid: record.keeperPid,
        lstart: record.lstart,
      },
      client,
    };
  }

  private onManagerEvent(entry: RuntimeEntry, event: ServeManagerEvent): void {
    switch (event.type) {
      case 'started':
        this.log(
          `[serve] started ${entry.sessionId} workspace=${entry.workspace} pid=${event.record.pid}`
            + ` keeper=${event.record.keeperPid}${event.restarted ? ` (${event.reason ?? 'restart'})` : ''}`,
        );
        break;
      case 'stopped':
        // Covers release/shutdown and the stop half of a restart: the old
        // client's process is gone, so acquire must wait for a fresh one.
        entry.client = null;
        this.log(`[serve] stopped ${entry.sessionId} workspace=${entry.workspace} reason=${event.reason}`);
        break;
      case 'ping_unsupported':
        this.log(`[serve] ${entry.sessionId} ping unsupported; relying on exit/close`);
        break;
      case 'error':
        this.log(`[serve] ${entry.sessionId} error: ${describe(event.error)}`);
        break;
    }
  }
}

/** Builds the per-exec-session serve runtime (design 03 §2.2: no serve sharing). */
export function createServeRuntime(options: ServeRuntimeOptions): ServeRuntime {
  return new ServeRuntimeImpl(options);
}

function assertWorkspace(workspace: string): void {
  if (typeof workspace !== 'string' || workspace === '') {
    throw new TypeError('workspace must be a non-empty string');
  }
}

/** Boot id already persisted by the startup sweep, or null when state is empty. */
function stateBootId(ledger: ProcessLedger): string | null {
  const bootId = ledger.readState().bootId;
  return bootId === '' ? null : bootId;
}

function unavailable(workspace: string, error: unknown): McpToolError {
  return new McpToolError(`cannot start claude mcp serve for ${workspace}: ${describe(error)}`, {
    code: 'MCP_SERVER_UNAVAILABLE',
    retryable: true,
    detail: { workspace },
  });
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  return 'unknown error';
}

function positiveOption(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero: boolean,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new RangeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} finite number`);
  }
  return value;
}

function safeKill(child: ServeClientProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    child.kill(signal);
  } catch {
    // ESRCH: the keeper is already gone.
  }
}

/** Resolves `true` when `promise` settles within `timeoutMs`, never rejects. */
function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const timer = setTimeout(() => {
      if (finish()) reject(onTimeout());
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        if (finish()) resolve(value);
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
  });
}
