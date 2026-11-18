/**
 * Eval-boundary residue detection and the per-exec-session process registry.
 *
 * Contract (learn-ai `claude-code/自建设计/02-执行体与进程治理.md` §2.4, §3.2, §4.1):
 * - A baseline is a snapshot of the serve tree plus boot-marked processes taken before an eval.
 *   The post-eval difference is the residue that eval left behind (`leftRunning`).
 * - Each residue gets a stable `p_` handle, a 30min lease and an `evalKey`; the 15s heartbeat
 *   refreshes leases and drops processes that died.
 * - Handles are session-scoped: a handle minted for one exec session is rejected by another.
 *   Every kill re-reads `ps` and compares `lstart`, so a recycled PID is never signalled.
 *
 * `ProcOps` is injected so tests can drive a fake process table; the default backend reuses
 * C10's `parsePsRows` and `safeKill`. Records are C11's `SurvivorRecord`, so `onFlush` feeds
 * `ProcessLedger.writeSurvivors` without a second shape.
 *
 * @module
 */
import { spawnSync } from 'node:child_process';

import { LIMITS } from '../constants.ts';
import { newId } from '../ids.ts';
import type { KillRecord, ProcRecord } from '../types.ts';
import { killTarget, safeKill } from './kill.ts';
import type { SurvivorRecord } from './ledger.ts';
import {
  BOOT_MARKER_ENV,
  normalizeLstart,
  parsePsRows,
  sameStartTime,
  snapshotTree,
  type ProcessRow,
} from './tree.ts';

/** Lease handed to a leftover process at eval end; every heartbeat extends it. */
export const RESIDUE_LEASE_MS = 30 * 60 * 1000;

/** Heartbeat cadence for lease refresh and the `survivors.json` flush. */
export const RESIDUE_HEARTBEAT_MS = 15 * 1000;

/** Environment variable naming the boot that spawned a process (02 §3.4 step 3). */
export const BOOT_MARKER = BOOT_MARKER_ENV;

/**
 * `ps` arguments used by the default backend; `-E` exposes boot markers and `-ww` stops the
 * command column from being truncated at the terminal width.
 */
export const PS_ARGS: readonly string[] = ['-E', '-ww', '-axo', 'pid=,ppid=,pgid=,lstart=,command='];

/** One parsed `ps` row (C10's `ProcessRow`). */
export type ProcRow = ProcessRow;

export const normalizeStart = normalizeLstart;
export const sameStart = sameStartTime;

/** Re-exported for callers (and tests) that hold raw `ps -axo` output. */
export { parsePsRows as parsePsOutput };

/** Injectable process backend. Negative PIDs address a process group. */
export interface ProcOps {
  snapshot(): ProcRow[];
  signal(pid: number, signal: NodeJS.Signals): void;
}

/** Default backend: `ps` snapshot and C10's `safeKill`, with `ESRCH` treated as already gone. */
export function defaultProcOps(): ProcOps {
  return {
    snapshot(): ProcRow[] {
      const result = spawnSync('ps', [...PS_ARGS], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        maxBuffer: 32 * 1024 * 1024,
      });
      if (result.error !== undefined) throw result.error;
      if (result.status !== 0) {
        // An empty snapshot must never be read as "no processes": callers use it to kill.
        const detail = (result.stderr ?? '').trim() || 'no stderr';
        throw new Error(`ps ${PS_ARGS.join(' ')} failed (status ${String(result.status)}): ${detail}`);
      }
      return parsePsRows(result.stdout ?? '');
    },
    signal(pid: number, signal: NodeJS.Signals): void {
      safeKill(pid, signal);
    },
  };
}

/** All descendants of `rootPid` from one snapshot, root excluded (C10's `snapshotTree`). */
export function descendantsOf(rows: readonly ProcRow[], rootPid: number): ProcRow[] {
  return snapshotTree(rootPid, [...rows]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extracts `NAME=value` from a `ps -E` command column, or `undefined` when absent. */
export function markerValue(cmd: string, marker: string = BOOT_MARKER): string | undefined {
  if (marker === '') return undefined;
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(marker)}=([^\\s]+)`);
  return pattern.exec(cmd)?.[1];
}

/** Blocks the calling thread, matching the synchronous startup-sweep flow in 02 §3.4. */
export function sleepSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A survivor record from `ledger/survivors.json` (C11 owns the persisted shape). */
export type ResidueRecord = SurvivorRecord;

/** Pre-eval snapshot. `seen` maps pid -> normalized `lstart` so PID reuse reads as new. */
export interface EvalBaseline {
  readonly evalKey: string;
  readonly rootPid: number;
  readonly startedAt: string;
  readonly seen: ReadonlyMap<number, string>;
}

export interface EndEvalResult {
  /** Processes newly attributed to this eval, with fresh handles and leases. */
  leftRunning: ResidueRecord[];
  /** Every record still active after the eval (this eval plus older survivors). */
  tracked: ResidueRecord[];
  /** Boot-marked processes belonging to another boot; reported, never killed here. */
  escaped: ProcRow[];
}

export type KillOutcome =
  | { status: 'killed'; handle: string; pid: number; signal: NodeJS.Signals; record: ResidueRecord }
  | { status: 'already_gone'; handle: string; pid: number }
  | { status: 'stale'; handle: string; pid: number; expected: string; actual: string }
  | { status: 'unknown_handle'; handle: string };

export interface ResidueTrackerOptions {
  /** Exec session id (`es_...`). Handles are only resolvable inside this tracker. */
  sessionId: string;
  /** Current boot id; enables boot-marker attribution for reparented processes. */
  bootId?: string;
  ops?: ProcOps;
  now?: () => Date;
  /** Defaults to {@link RESIDUE_LEASE_MS}. */
  leaseMs?: number;
  /** Defaults to {@link RESIDUE_HEARTBEAT_MS}. */
  heartbeatMs?: number;
  /** Environment marker name; defaults to {@link BOOT_MARKER}. */
  marker?: string;
  /** Called with the active record set on eval end, heartbeat and teardown (survivors.json). */
  onFlush?: (records: readonly ResidueRecord[]) => void;
  /** Receives errors thrown by a timer-driven heartbeat instead of crashing the process. */
  onError?: (error: unknown) => void;
}

export interface KillAllOptions {
  /** Wait between TERM and KILL. Defaults to `LIMITS.graceMs` (2s). */
  graceMs?: number;
  sleep?: (ms: number) => void;
}

export interface KillAllResult {
  killed: KillRecord[];
  /** Records proven alive *and* still matching their `lstart` after SIGKILL. */
  remaining: ProcRecord[];
}

function indexRows(rows: readonly ProcRow[]): Map<number, ProcRow> {
  const byPid = new Map<number, ProcRow>();
  for (const row of rows) byPid.set(row.pid, row);
  return byPid;
}

/**
 * Session-scoped registry of processes that outlived an eval.
 *
 * `beginEval` records what already existed; `endEval` registers only the difference. Leases are
 * extended by `heartbeat` (also the persistence hook) and checked by C14's reconcile loop.
 * `kill(handle)` never signals a PID whose `lstart` no longer matches the record, and a handle
 * from another session is `unknown_handle` — the registry is per exec session by construction.
 */
export class ResidueTracker {
  readonly sessionId: string;

  private readonly bootId: string | undefined;
  private readonly ops: ProcOps;
  private readonly nowFn: () => Date;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly marker: string;
  private readonly onFlush: ((records: readonly ResidueRecord[]) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly byHandle = new Map<string, ResidueRecord>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ResidueTrackerOptions) {
    if (options.sessionId === '') throw new RangeError('sessionId must not be empty');
    this.sessionId = options.sessionId;
    this.bootId = options.bootId;
    this.ops = options.ops ?? defaultProcOps();
    this.nowFn = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? RESIDUE_LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? RESIDUE_HEARTBEAT_MS;
    this.marker = options.marker ?? BOOT_MARKER;
    this.onFlush = options.onFlush;
    this.onError = options.onError;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0) {
      throw new RangeError('leaseMs must be positive');
    }
    if (!Number.isFinite(this.heartbeatMs) || this.heartbeatMs <= 0) {
      throw new RangeError('heartbeatMs must be positive');
    }
  }

  /**
   * Snapshots the serve tree and this boot's marked processes before an eval starts.
   * A baseline must be taken before the eval's first tool call; afterwards only new identities
   * (pid + `lstart`) are attributed to the eval.
   */
  beginEval(evalKey: string, rootPid: number): EvalBaseline {
    if (!Number.isInteger(rootPid) || rootPid <= 0) {
      throw new RangeError('rootPid must be a positive integer');
    }
    const rows = this.ops.snapshot();
    const seen = new Map<number, string>();
    for (const row of descendantsOf(rows, rootPid)) this.remember(seen, row);
    if (this.bootId !== undefined) {
      for (const row of rows) {
        if (row.pid === rootPid) continue;
        if (markerValue(row.command, this.marker) === this.bootId) this.remember(seen, row);
      }
    }
    return {
      evalKey,
      rootPid,
      startedAt: this.nowFn().toISOString(),
      seen,
    };
  }

  /** Diffs the current table against `baseline`, registers new processes and refreshes leases. */
  endEval(baseline: EvalBaseline): EndEvalResult {
    const rows = this.ops.snapshot();
    const after = new Map<number, ProcRow>();
    for (const row of descendantsOf(rows, baseline.rootPid)) {
      if (row.pid === baseline.rootPid) continue;
      after.set(row.pid, row);
    }

    const escaped: ProcRow[] = [];
    if (this.bootId !== undefined) {
      for (const row of rows) {
        if (row.pid === baseline.rootPid) continue;
        const boot = markerValue(row.command, this.marker);
        if (boot === undefined) continue;
        if (boot === this.bootId) after.set(row.pid, row);
        else escaped.push(row);
      }
    }

    const now = this.nowFn();
    const leftRunning: ResidueRecord[] = [];
    for (const row of after.values()) {
      if (!Number.isInteger(row.pid) || row.pid <= 1) continue;
      const lstart = normalizeStart(row.lstart);
      if (lstart === '') continue;
      if (baseline.seen.get(row.pid) === lstart) continue;

      const existing = this.takeExisting(row.pid, lstart);
      if (existing !== undefined) {
        existing.leaseUntil = this.leaseFrom(now);
        existing.state = 'running';
        leftRunning.push(existing);
        continue;
      }

      const record: ResidueRecord = {
        handle: newId('process'),
        sessionId: this.sessionId,
        evalKey: baseline.evalKey,
        pid: row.pid,
        ppid: row.ppid,
        pgid: row.pgid,
        cmd: row.command,
        startTime: row.lstart,
        firstSeen: now.toISOString(),
        leaseUntil: this.leaseFrom(now),
        state: 'running',
      };
      this.byHandle.set(record.handle, record);
      leftRunning.push(record);
    }

    const tracked = this.records();
    this.flush(tracked);
    return { leftRunning, tracked, escaped };
  }

  /**
   * 15s heartbeat: extends the lease of every still-matching record, drops dead or recycled
   * PIDs, flushes the active set and returns it.
   */
  heartbeat(): ResidueRecord[] {
    const present = indexRows(this.ops.snapshot());
    const now = this.nowFn();
    for (const record of [...this.byHandle.values()]) {
      const row = present.get(record.pid);
      if (row === undefined || !sameStart(row.lstart, record.startTime)) {
        record.state = 'gone';
        this.byHandle.delete(record.handle);
        continue;
      }
      record.leaseUntil = this.leaseFrom(now);
      record.state = 'running';
    }
    const active = this.records();
    this.flush(active);
    return active;
  }

  /** Starts the unref'd heartbeat interval; safe to call twice. */
  startHeartbeat(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      try {
        this.heartbeat();
      } catch (error) {
        this.onError?.(error);
      }
    }, this.heartbeatMs);
    this.timer.unref();
  }

  stopHeartbeat(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Active records, in insertion order. */
  records(): ResidueRecord[] {
    return [...this.byHandle.values()];
  }

  /** Handle lookup scoped to this exec session; unknown or foreign handles yield `undefined`. */
  find(handle: string): ResidueRecord | undefined {
    return this.byHandle.get(handle);
  }

  /** Records whose lease has expired at `at`; C14's reconcile owns the actual kill. */
  expired(at: Date = this.nowFn()): ResidueRecord[] {
    return this.records().filter((record) => {
      const until = Date.parse(record.leaseUntil);
      return Number.isFinite(until) && until <= at.getTime();
    });
  }

  /**
   * Kills one tracked process after re-validating identity. Group leaders are signalled through
   * `-pgid`; non-leaders are signalled directly so an unrelated group is never touched.
   */
  kill(handle: string, signal: NodeJS.Signals = 'SIGTERM'): KillOutcome {
    const record = this.byHandle.get(handle);
    if (record === undefined) return { status: 'unknown_handle', handle };

    const row = indexRows(this.ops.snapshot()).get(record.pid);
    if (row === undefined) {
      record.state = 'gone';
      this.byHandle.delete(handle);
      this.flush(this.records());
      return { status: 'already_gone', handle, pid: record.pid };
    }
    if (!sameStart(row.lstart, record.startTime)) {
      record.state = 'gone';
      this.byHandle.delete(handle);
      this.flush(this.records());
      return {
        status: 'stale',
        handle,
        pid: record.pid,
        expected: record.startTime,
        actual: row.lstart,
      };
    }

    this.signalRecord(record, signal);
    record.state = 'killed';
    this.byHandle.delete(handle);
    this.flush(this.records());
    return { status: 'killed', handle, pid: record.pid, signal, record };
  }

  /** Session teardown: TERM everything validated, wait `graceMs`, KILL what is still there. */
  killAll(options: KillAllOptions = {}): KillAllResult {
    const graceMs = options.graceMs ?? LIMITS.graceMs;
    const sleep = options.sleep ?? sleepSync;
    const present = indexRows(this.ops.snapshot());
    const valid: ResidueRecord[] = [];
    const killed: KillRecord[] = [];

    for (const record of [...this.byHandle.values()]) {
      const row = present.get(record.pid);
      if (row === undefined || !sameStart(row.lstart, record.startTime)) {
        record.state = 'gone';
        this.byHandle.delete(record.handle);
        continue;
      }
      valid.push(record);
    }

    for (const record of valid) {
      try {
        this.signalRecord(record, 'SIGTERM');
        killed.push({ pid: record.pid, pgid: record.pgid, signal: 'SIGTERM', reason: 'session_end' });
      } catch {
        // Delivery failed; the final snapshot reports the process as remaining.
      }
    }
    if (valid.length > 0 && graceMs > 0) sleep(graceMs);

    const after = indexRows(this.ops.snapshot());
    for (const record of valid) {
      const row = after.get(record.pid);
      if (row !== undefined && sameStart(row.lstart, record.startTime)) {
        try {
          this.signalRecord(record, 'SIGKILL');
          killed.push({ pid: record.pid, pgid: record.pgid, signal: 'SIGKILL', reason: 'session_end' });
        } catch {
          // Same as above: leave it to the post-kill snapshot.
        }
      }
    }

    const finalRows = indexRows(this.ops.snapshot());
    const remaining: ProcRecord[] = [];
    for (const record of valid) {
      const row = finalRows.get(record.pid);
      if (row !== undefined && sameStart(row.lstart, record.startTime)) {
        record.state = 'running';
        remaining.push({
          handle: record.handle,
          pid: record.pid,
          pgid: record.pgid,
          cmd: record.cmd,
          startTime: record.startTime,
        });
        continue;
      }
      record.state = 'killed';
      this.byHandle.delete(record.handle);
    }

    this.flush(this.records());
    return { killed, remaining };
  }

  private remember(seen: Map<number, string>, row: ProcRow): void {
    const lstart = normalizeStart(row.lstart);
    if (lstart !== '') seen.set(row.pid, lstart);
  }

  private leaseFrom(now: Date): string {
    return new Date(now.getTime() + this.leaseMs).toISOString();
  }

  /** Reuses a handle when the same identity is already tracked; a recycled PID is forgotten. */
  private takeExisting(pid: number, lstart: string): ResidueRecord | undefined {
    for (const record of this.byHandle.values()) {
      if (record.pid !== pid) continue;
      if (sameStart(record.startTime, lstart)) return record;
      record.state = 'gone';
      this.byHandle.delete(record.handle);
      return undefined;
    }
    return undefined;
  }

  private signalRecord(record: ResidueRecord, signal: NodeJS.Signals): void {
    this.ops.signal(killTarget(record.pid, record.pgid), signal);
  }

  private flush(records: readonly ResidueRecord[]): void {
    this.onFlush?.(records);
  }
}
