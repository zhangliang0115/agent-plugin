/**
 * Per-exec-session supervisor for one keeper + `claude mcp serve` pair.
 *
 * The manager launches the keeper through an injected process starter, waits
 * for the keeper's `serve.json` record, mirrors pid/pgid/keeperPid/lstart into
 * the process ledger, and restarts the pair when either primary signal fires:
 * a transport `close` call or the keeper process `exit`. A ping probe is only
 * a fallback (10s interval, two consecutive failures); `-32601` disables it and
 * leaves exit/close as the only death signals.
 *
 * Both sides are injected so tests never spawn a real `claude mcp serve`.
 *
 * @module
 */

import { LIMITS } from '../constants.ts';
import { ReplError } from '../errors.ts';
import type { ProcessLedger, ServeRecord, StateFile } from './ledger.ts';

/** Variables copied from the host environment. Everything else is dropped. */
export const SERVE_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG'] as const;

/** Defaults from design 02 §2.5; inject smaller values in tests. */
export const SERVE_HEALTH_DEFAULTS = {
  readyTimeoutMs: 10_000,
  pingIntervalMs: 10_000,
  pingTimeoutMs: 1_000,
  pingFailureThreshold: 2,
  terminateGraceMs: LIMITS.graceMs,
  killWaitMs: 1_000,
} as const;

/** Why the current serve is considered dead. */
export type ServeDeathReason = 'transport_close' | 'serve_exit';

/** Why a restart was scheduled. */
export type ServeRestartReason = ServeDeathReason | 'ping_failed' | 'manual';

/** Command handed to the keeper after its `--` separator. */
export interface ServeCommand {
  readonly command: string;
  readonly args?: readonly string[];
}

/** Identity the keeper writes to `serve.json` before opening MCP traffic. */
export interface ServeIdentity {
  readonly pid: number;
  readonly pgid: number;
  readonly keeperPid: number;
  /** Raw `ps -o lstart=` value; the PID-reuse check (design 02 §3.6). */
  readonly lstart: string;
}

/** Everything the injected process starter needs for one launch. */
export interface ServeLaunchSpec {
  readonly sessionId: string;
  readonly bootId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Whitelisted host variables plus explicit injection; never `process.env`. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Handle returned by the injected process starter. The starter may spawn the
 * keeper directly or wrap it in an MCP stdio transport.
 */
export interface LaunchedServe {
  /**
   * Resolves once the keeper started by *this* launch wrote `serve.json` and
   * opened MCP traffic. A launcher must not resolve it from a stale record left
   * by a previous boot or launch.
   */
  readonly ready: Promise<ServeIdentity>;
  /** Resolves (never rejects) when the keeper and its serve group exited. */
  readonly exited: Promise<void>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

/** Injected process starter; production spawns `keeper.mjs`, tests use a fake. */
export type ServeLauncher = (spec: ServeLaunchSpec) => LaunchedServe | Promise<LaunchedServe>;

/** Injected liveness probe used by the ping fallback. */
export interface ServeProbe {
  ping(): Promise<void>;
}

/** Ledger subset the manager needs; `ProcessLedger` satisfies it structurally. */
export type ServeLedger = Pick<
  ProcessLedger,
  'writeServe' | 'removeServe' | 'readState' | 'writeState'
>;

/** Events for audit wiring (`serve_restart`) and tests. */
export type ServeManagerEvent =
  | {
      type: 'started';
      sessionId: string;
      record: ServeRecord;
      restarted: boolean;
      reason?: ServeRestartReason;
    }
  | { type: 'stopped'; sessionId: string; record: ServeRecord; reason: string }
  | { type: 'ping_unsupported'; sessionId: string; pid: number }
  | { type: 'error'; sessionId: string; error: unknown };

/** Constructor input. `sourceEnv` defaults to `process.env` but is always filtered. */
export interface ServeManagerOptions {
  readonly sessionId: string;
  readonly bootId: string;
  readonly ledger: ServeLedger;
  readonly launch: ServeLauncher;
  readonly probe: ServeProbe;
  readonly serve: ServeCommand;
  /** Workspace directory; the keeper inherits it and passes it on to serve. */
  readonly cwd: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  /** Explicit injection, applied after the allowlist; `undefined` unsets a key. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** repl-server pid recorded in `state.json` when the file is fresh. */
  readonly hostPid?: number;
  readonly now?: () => number;
  readonly readyTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly pingTimeoutMs?: number;
  readonly pingFailureThreshold?: number;
  readonly terminateGraceMs?: number;
  readonly killWaitMs?: number;
  readonly onEvent?: (event: ServeManagerEvent) => void;
}

interface NormalizedOptions {
  readonly launch: ServeLauncher;
  readonly probe: ServeProbe;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hostPid: number;
  readonly now: () => number;
  readonly readyTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly pingTimeoutMs: number;
  readonly pingFailureThreshold: number;
  readonly terminateGraceMs: number;
  readonly killWaitMs: number;
  readonly onEvent: ((event: ServeManagerEvent) => void) | undefined;
}

interface RunningServe {
  readonly generation: number;
  readonly child: LaunchedServe;
  readonly record: ServeRecord;
}

interface PendingDeath {
  readonly generation: number;
  readonly promise: Promise<void>;
}

/**
 * Builds the child environment from an explicit source object.
 *
 * Only {@link SERVE_ENV_ALLOWLIST} keys are copied. `extra` is the explicit
 * injection channel (binaries, config paths, test markers); an `undefined`
 * value removes that key. The source object itself is never handed to a child.
 */
export function buildServeEnv(
  source: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SERVE_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Owns one serve lifetime. Operations are serialized through an internal queue,
 * so concurrent stop/restart/death reports never overlap.
 */
export class ServeManager {
  readonly sessionId: string;
  readonly bootId: string;

  private readonly ledger: ServeLedger;
  private readonly options: NormalizedOptions;
  private queue: Promise<void> = Promise.resolve();
  private current: RunningServe | null = null;
  private pendingDeath: PendingDeath | null = null;
  /** Generation currently between "launch called" and "ready recorded". */
  private launching: number | null = null;
  /** Death signal seen while {@link launching} was in flight. */
  private deferredDeath: { generation: number; reason: ServeDeathReason } | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pingFailures = 0;
  private pingInFlight = false;
  private pingUnsupportedFlag = false;
  private generationCounter = 0;
  private restartCounter = 0;
  private disposedFlag = false;
  private stoppedFlag = true;
  private lastErrorValue: unknown;

  constructor(options: ServeManagerOptions) {
    requireNonEmpty(options.sessionId, 'sessionId');
    requireNonEmpty(options.bootId, 'bootId');
    requireNonEmpty(options.serve.command, 'serve.command');
    requireNonEmpty(options.cwd, 'cwd');
    if (options.ledger === undefined || options.launch === undefined || options.probe === undefined) {
      throw new TypeError('ledger, launch and probe are required');
    }

    this.sessionId = options.sessionId;
    this.bootId = options.bootId;
    this.ledger = options.ledger;
    const hostPid = options.hostPid ?? process.pid;
    if (!Number.isInteger(hostPid) || hostPid <= 0) {
      throw new RangeError('hostPid must be a positive integer');
    }
    const pingFailureThreshold = numericOption(
      options.pingFailureThreshold,
      SERVE_HEALTH_DEFAULTS.pingFailureThreshold,
      'pingFailureThreshold',
      false,
    );
    if (!Number.isInteger(pingFailureThreshold)) {
      throw new RangeError('pingFailureThreshold must be a positive integer');
    }
    this.options = {
      launch: options.launch,
      probe: options.probe,
      command: options.serve.command,
      args: [...(options.serve.args ?? [])],
      cwd: options.cwd,
      sourceEnv: options.sourceEnv ?? process.env,
      env: options.env ?? {},
      hostPid,
      now: options.now ?? Date.now,
      readyTimeoutMs: numericOption(
        options.readyTimeoutMs,
        SERVE_HEALTH_DEFAULTS.readyTimeoutMs,
        'readyTimeoutMs',
        false,
      ),
      pingIntervalMs: numericOption(
        options.pingIntervalMs,
        SERVE_HEALTH_DEFAULTS.pingIntervalMs,
        'pingIntervalMs',
        true,
      ),
      pingTimeoutMs: numericOption(
        options.pingTimeoutMs,
        SERVE_HEALTH_DEFAULTS.pingTimeoutMs,
        'pingTimeoutMs',
        false,
      ),
      pingFailureThreshold,
      terminateGraceMs: numericOption(
        options.terminateGraceMs,
        SERVE_HEALTH_DEFAULTS.terminateGraceMs,
        'terminateGraceMs',
        true,
      ),
      killWaitMs: numericOption(options.killWaitMs, SERVE_HEALTH_DEFAULTS.killWaitMs, 'killWaitMs', true),
      onEvent: options.onEvent,
    };
  }

  /** Current serve record, or `null` between restarts and after a stop. */
  get record(): ServeRecord | null {
    return this.current?.record ?? null;
  }

  get running(): boolean {
    return this.current !== null;
  }

  /**
   * Latest allocated generation. A transport callback may keep this value and
   * pass it to {@link markDead} so a late close from an old serve is ignored.
   */
  get generation(): number {
    return this.generationCounter;
  }

  get pingUnsupported(): boolean {
    return this.pingUnsupportedFlag;
  }

  get restartCount(): number {
    return this.restartCounter;
  }

  get lastError(): unknown {
    return this.lastErrorValue;
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  /**
   * Launches keeper + serve unless one is already running. Safe to call
   * repeatedly; the operation queue and the current record deduplicate it.
   */
  start(): Promise<ServeRecord> {
    if (this.disposedFlag) {
      return Promise.reject(
        new ReplError('SERVE_MANAGER_DISPOSED', `serve manager for ${this.sessionId} is disposed`),
      );
    }
    return this.enqueue(async () => {
      if (this.disposedFlag) {
        throw new ReplError(
          'SERVE_MANAGER_DISPOSED',
          `serve manager for ${this.sessionId} is disposed`,
        );
      }
      this.stoppedFlag = false;
      if (this.current !== null) return this.current.record;
      return this.launchServe(false, undefined);
    });
  }

  /**
   * Stops the keeper and clears its ledger entry. The manager stays usable:
   * a later `start()` launches a fresh pair (idle-stop semantics, 03 §2.3).
   */
  stop(reason = 'stop'): Promise<void> {
    return this.enqueue(async () => {
      this.stoppedFlag = true;
      await this.stopCurrent(reason, false);
    });
  }

  /**
   * Stops and permanently closes the manager. Idempotent. Pending and future
   * `start()` calls fail; the ledger session entry is removed.
   */
  dispose(reason = 'dispose'): Promise<void> {
    this.disposedFlag = true;
    return this.enqueue(async () => {
      this.stoppedFlag = true;
      await this.stopCurrent(reason, true);
    });
  }

  /**
   * Replaces a running serve. No-op when stopped or disposed; `start()` is the
   * only way to launch the first pair. The promise resolves with the new record.
   */
  restart(reason: ServeRestartReason = 'manual'): Promise<ServeRecord | null> {
    if (this.disposedFlag) return Promise.resolve(null);
    return this.enqueue(async () => {
      if (this.disposedFlag || this.stoppedFlag || this.current === null) return null;
      await this.stopCurrent(reason, false);
      const record = await this.launchServe(true, reason);
      this.restartCounter += 1;
      return record;
    });
  }

  /**
   * Reports a primary death signal. `generation` is optional; pass the value
   * captured for the transport that closed so a stale callback cannot restart
   * a newer serve. Concurrent reports for the same generation share one
   * restart.
   */
  markDead(reason: ServeDeathReason = 'transport_close', generation?: number): Promise<void> {
    if (this.disposedFlag || this.stoppedFlag) return Promise.resolve();
    const current = this.current;
    if (current === null) {
      // A transport may close while its serve is still becoming ready. Keep the
      // signal and restart once the launch has a record to replace.
      if (this.launching !== null && (generation === undefined || generation === this.launching)) {
        this.deferredDeath = { generation: this.launching, reason };
      }
      return Promise.resolve();
    }
    const expected = generation ?? current.generation;
    if (current.generation !== expected) return Promise.resolve();
    return this.restartGeneration(reason, expected);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Schedules a restart for exactly `expected`. The first caller owns the
   * queue entry; later signals for the same generation await the same promise.
   */
  private restartGeneration(reason: ServeRestartReason, expected: number): Promise<void> {
    if (this.pendingDeath !== null && this.pendingDeath.generation === expected) {
      return this.pendingDeath.promise;
    }

    const promise = this.enqueue(async () => {
      if (this.disposedFlag || this.stoppedFlag) return;
      const live = this.current;
      if (live === null || live.generation !== expected) return;
      await this.stopCurrent(reason, false);
      await this.launchServe(true, reason);
      this.restartCounter += 1;
    }).finally(() => {
      if (this.pendingDeath?.promise === promise) this.pendingDeath = null;
    });

    this.pendingDeath = { generation: expected, promise };
    return promise;
  }

  private async launchServe(
    restarted: boolean,
    reason: ServeRestartReason | undefined,
  ): Promise<ServeRecord> {
    this.stopPing();
    this.pingFailures = 0;
    this.pingUnsupportedFlag = false;

    const generation = ++this.generationCounter;
    this.launching = generation;
    try {
      const spec: ServeLaunchSpec = {
        sessionId: this.sessionId,
        bootId: this.bootId,
        command: this.options.command,
        args: [...this.options.args],
        cwd: this.options.cwd,
        env: buildServeEnv(this.options.sourceEnv, this.options.env),
      };

      let child: LaunchedServe;
      try {
        child = await this.options.launch(spec);
      } catch (error) {
        throw this.failure('SERVE_START_FAILED', `failed to launch keeper for ${this.sessionId}`, error);
      }

      let identity: ServeIdentity;
      try {
        identity = await this.awaitReady(child);
      } catch (error) {
        await this.terminate(child);
        throw this.failure(
          'SERVE_START_FAILED',
          `serve for ${this.sessionId} did not become ready`,
          error,
        );
      }

      const record: ServeRecord = {
        pid: identity.pid,
        pgid: identity.pgid,
        keeperPid: identity.keeperPid,
        sessionId: this.sessionId,
        bootId: this.bootId,
        lstart: identity.lstart,
        transport: 'stdio',
        startedAt: this.isoNow(),
      };

      this.current = { generation, child, record };
      try {
        // Start both writes in the same turn: the state read-modify-write must
        // not interleave with another manager's state write.
        const serveWrite = this.ledger.writeServe(record);
        const stateWrite = this.persistServe(record);
        await serveWrite;
        await stateWrite;
      } catch (error) {
        this.current = null;
        this.generationCounter += 1;
        await this.terminate(child);
        await this.clearLedger(false);
        throw this.failure('SERVE_LEDGER_FAILED', `failed to record serve for ${this.sessionId}`, error);
      }

      this.watchExit(child, generation);
      this.startPing(generation);
      const event: ServeManagerEvent = {
        type: 'started',
        sessionId: this.sessionId,
        record,
        restarted,
      };
      if (reason !== undefined) event.reason = reason;
      this.emit(event);

      // A transport close reported while this launch was still becoming ready
      // could not replace anything yet; do it now, behind the running queue.
      if (this.deferredDeath?.generation === generation) {
        const deferredReason = this.deferredDeath.reason;
        this.deferredDeath = null;
        void this.restartGeneration(deferredReason, generation).catch((error) => {
          this.reportError(error);
        });
      }

      return record;
    } catch (error) {
      if (this.deferredDeath?.generation === generation) this.deferredDeath = null;
      throw error;
    } finally {
      if (this.launching === generation) this.launching = null;
    }
  }

  private async awaitReady(child: LaunchedServe): Promise<ServeIdentity> {
    const exited = child.exited.then(
      () => {
        throw new ReplError(
          'SERVE_EXITED',
          `keeper for ${this.sessionId} exited before serve was ready`,
        );
      },
      () => {
        throw new ReplError(
          'SERVE_EXITED',
          `keeper for ${this.sessionId} exited before serve was ready`,
        );
      },
    );
    return withTimeout(
      Promise.race([child.ready, exited]),
      this.options.readyTimeoutMs,
      () =>
        new ReplError(
          'SERVE_READY_TIMEOUT',
          `serve for ${this.sessionId} was not ready within ${this.options.readyTimeoutMs}ms`,
        ),
    );
  }

  private watchExit(child: LaunchedServe, generation: number): void {
    const onExit = (): void => {
      if (this.disposedFlag || this.stoppedFlag) return;
      if (this.current?.generation !== generation) return;
      void this.restartGeneration('serve_exit', generation).catch((error) => {
        this.reportError(error);
      });
    };
    void child.exited.then(onExit, onExit);
  }

  private async stopCurrent(reason: string, removeSession: boolean): Promise<void> {
    const current = this.current;
    this.current = null;
    this.stopPing();
    this.pingFailures = 0;

    if (current !== null) {
      // Invalidate exit/transport callbacks that still hold the old generation.
      this.generationCounter += 1;
      await this.terminate(current.child);
    }

    await this.clearLedger(removeSession);

    if (current !== null) {
      this.emit({
        type: 'stopped',
        sessionId: this.sessionId,
        record: current.record,
        reason,
      });
    }
  }

  /** SIGTERM first, SIGKILL after the grace period; ESRCH is ignored. */
  private async terminate(child: LaunchedServe): Promise<void> {
    safeKill(child, 'SIGTERM');
    if (await settlesWithin(child.exited, this.options.terminateGraceMs)) return;
    safeKill(child, 'SIGKILL');
    await settlesWithin(child.exited, this.options.killWaitMs);
  }

  private startPing(generation: number): void {
    this.stopPing();
    if (this.options.pingIntervalMs <= 0) return;

    const timer = setInterval(() => {
      void this.pingTick(generation);
    }, this.options.pingIntervalMs);
    timer.unref();
    this.pingTimer = timer;
  }

  private stopPing(): void {
    if (this.pingTimer === null) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private async pingTick(generation: number): Promise<void> {
    if (this.pingInFlight || this.pingUnsupportedFlag) return;
    if (this.disposedFlag || this.stoppedFlag) return;
    if (this.current?.generation !== generation) return;

    this.pingInFlight = true;
    try {
      await withTimeout(
        this.options.probe.ping(),
        this.options.pingTimeoutMs,
        () =>
          new ReplError(
            'SERVE_PING_TIMEOUT',
            `ping to serve for ${this.sessionId} timed out after ${this.options.pingTimeoutMs}ms`,
          ),
      );
      if (this.current?.generation === generation) this.pingFailures = 0;
    } catch (error) {
      if (this.disposedFlag || this.stoppedFlag) return;
      if (this.current?.generation !== generation) return;

      if (isPingUnsupported(error)) {
        const pid = this.current.record.pid;
        this.pingUnsupportedFlag = true;
        this.stopPing();
        this.emit({ type: 'ping_unsupported', sessionId: this.sessionId, pid });
        return;
      }

      this.pingFailures += 1;
      if (this.pingFailures >= this.options.pingFailureThreshold) {
        this.pingFailures = 0;
        try {
          await this.restartGeneration('ping_failed', generation);
        } catch (restartError) {
          this.reportError(restartError);
        }
      }
    } finally {
      this.pingInFlight = false;
    }
  }

  private persistServe(record: ServeRecord): void | Promise<void> {
    const state = this.readStateForWrite();
    state.sessions[this.sessionId] = { serve: record, updatedAt: this.isoNow() };
    return this.ledger.writeState(state);
  }

  /** Removes the serve file and reflects the stop in `state.json`. */
  private async clearLedger(removeSession: boolean): Promise<void> {
    let serveWrite: void | Promise<void> = undefined;
    try {
      serveWrite = this.ledger.removeServe(this.sessionId);
    } catch (error) {
      this.reportError(error);
    }

    let stateWrite: void | Promise<void> | undefined;
    try {
      stateWrite = this.clearServeState(removeSession);
    } catch (error) {
      this.reportError(error);
    }

    try {
      await serveWrite;
    } catch (error) {
      this.reportError(error);
    }
    try {
      await stateWrite;
    } catch (error) {
      this.reportError(error);
    }
  }

  private clearServeState(removeSession: boolean): void | Promise<void> | undefined {
    const state = this.readStateForWrite();
    if (state.sessions[this.sessionId] === undefined) return undefined;
    if (removeSession) delete state.sessions[this.sessionId];
    else state.sessions[this.sessionId] = { serve: null, updatedAt: this.isoNow() };
    return this.ledger.writeState(state);
  }

  private readStateForWrite(): StateFile {
    const state = this.ledger.readState();
    if (state.bootId === '') state.bootId = this.bootId;
    else if (state.bootId !== this.bootId) {
      throw new ReplError(
        'SERVE_BOOT_MISMATCH',
        `state.json belongs to boot ${state.bootId}, not ${this.bootId}`,
      );
    }
    if (state.pid === 0) state.pid = this.options.hostPid;
    return state;
  }

  private isoNow(): string {
    return new Date(this.options.now()).toISOString();
  }

  private failure(code: string, message: string, cause: unknown): ReplError {
    this.lastErrorValue = cause;
    const detail = errorMessage(cause);
    return new ReplError(code, detail === '' ? message : `${message}: ${detail}`);
  }

  private reportError(error: unknown): void {
    this.lastErrorValue = error;
    this.emit({ type: 'error', sessionId: this.sessionId, error });
  }

  private emit(event: ServeManagerEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch (error) {
      this.lastErrorValue = error;
    }
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function numericOption(
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

function safeKill(child: LaunchedServe, signal: 'SIGTERM' | 'SIGKILL'): void {
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, makeError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const timer = setTimeout(() => {
      if (finish()) reject(makeError());
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

/** JSON-RPC `-32601` in its numeric and string spellings, plus SDK error names. */
function isPingUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const code = (error as { code?: unknown }).code;
  if (code === -32601 || code === '-32601') return true;
  if (
    code === 'METHOD_NOT_FOUND'
    || code === 'MethodNotFound'
    || code === 'MCP_METHOD_NOT_FOUND'
    || code === 'JSONRPC_METHOD_NOT_FOUND'
  ) {
    return true;
  }

  const name = (error as { name?: unknown }).name;
  return name === 'MethodNotFound' || name === 'MethodNotFoundError';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}
