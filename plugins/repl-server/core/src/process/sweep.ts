/**
 * Startup sweep, single-instance lock and periodic reconcile for repl-server.
 *
 * Contract (learn-ai `claude-code/自建设计/02-执行体与进程治理.md` §2.3, §3.1, §3.4, §3.5):
 * - `state.db.lock` is created with `O_EXCL` (`'wx'`) and holds `{pid, startedAt, bootId}`.
 *   A lock whose PID is dead, unparsable, or provably not a repl-server process is stale and
 *   replaced; an alive holder that merely cannot be inspected is treated as held (never steal).
 * - The sweep kills, in this order of evidence: `state.json` serve records, keeper-written
 *   `sessions/<id>/serve.json`, `pool.json` entries, `survivors.json` records, then processes
 *   carrying `REPL_SERVER_BOOT=<a previous boot of this root>` in `ps -E`. Every target is
 *   validated against a fresh `ps` snapshot (`lstart`) before TERM; after a 2s grace the
 *   survivors get SIGKILL.
 * - `orphans-<bootId>.json` in `ledger/` records what was killed, what was skipped because
 *   identity could not be confirmed, and what survived.
 * - Reconcile drops vanished records, kills records of dead sessions and expired leases.
 *
 * Ledger reads/writes and the `ps` primitives come from C11 (`ProcessLedger`) and C10
 * (`ProcessRow`, `snapshotTree`, `safeKill`). All OS effects go through `ProcOps`, so tests
 * inject a fake process table and a fake sleep and never signal a real process.
 *
 * @module
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { LIMITS } from '../constants.ts';
import type { KillRecord, UnattributedProcess } from '../types.ts';
import { killTarget } from './kill.ts';
import { ProcessLedger, writeJsonAtomic } from './ledger.ts';
import {
  BOOT_MARKER,
  defaultProcOps,
  descendantsOf,
  markerValue,
  sameStart,
  sleepSync,
  type ProcOps,
  type ProcRow,
  type ResidueRecord,
} from './residue.ts';

/** Reconcile cadence frozen by docs/plan.md C14 (15s). */
export const RECONCILE_INTERVAL_MS = 15_000;

export interface LockRecord {
  pid: number;
  startedAt: string;
  bootId?: string;
}

export type LockOutcome =
  | { acquired: true; path: string; record: LockRecord; replaced: LockRecord | null }
  | { acquired: false; path: string; holder: LockRecord | null };

export interface InstanceLockOptions {
  lockPath: string;
  /** Owner written into the lock; defaults to `process.pid`. */
  pid?: number;
  bootId?: string;
  startedAt?: string;
  /** `kill(pid, 0)` in production; injected in tests. */
  pidAlive?: (pid: number) => boolean;
  /**
   * `false` means provably not a repl-server (stale). `undefined` means the probe could not
   * inspect the process, which is treated as held so a live server is never displaced.
   */
  isReplServer?: (pid: number) => boolean | undefined;
  /** Extra `O_EXCL` attempts after removing a stale lock. Defaults to 2. */
  retries?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return errorCode(error) === 'EPERM';
  }
}

/** `undefined` when `ps` could not answer, so the caller stays conservative. */
function probeReplServer(pid: number): boolean | undefined {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  const command = (result.stdout ?? '').trim();
  if (command === '') return undefined;
  return command.includes('repl-server');
}

/** Reads and validates a lock file; `null` means absent, unparsable or not a lock record. */
function readLockRecord(lockPath: string): LockRecord | null {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw)) return null;
    const pid = numberField(raw, 'pid');
    if (pid === undefined || pid <= 0) return null;
    const startedAt = stringField(raw, 'startedAt') ?? '';
    const bootId = stringField(raw, 'bootId');
    return bootId === undefined ? { pid, startedAt } : { pid, startedAt, bootId };
  } catch {
    return null;
  }
}

/**
 * Acquires the single-instance lock. Creation is `open(..., 'wx')`, so exactly one concurrent
 * starter wins even when both observe the same stale lock. A live holder rejects the start.
 */
export function acquireInstanceLock(options: InstanceLockOptions): LockOutcome {
  const pid = options.pid ?? process.pid;
  const record: LockRecord = {
    pid,
    startedAt: options.startedAt ?? new Date().toISOString(),
    ...(options.bootId === undefined ? {} : { bootId: options.bootId }),
  };
  mkdirSync(dirname(options.lockPath), { recursive: true });

  const pidAlive = options.pidAlive ?? pidExists;
  const probe = options.isReplServer ?? probeReplServer;
  const retries = options.retries ?? 2;
  let replaced: LockRecord | null = null;
  let holder: LockRecord | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const fd = openSync(options.lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      return { acquired: true, path: options.lockPath, record, replaced };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;

      holder = readLockRecord(options.lockPath);
      if (holder === null && existsSync(options.lockPath)) {
        // `open(..., 'wx')` publishes the file before its content is written. Give a concurrent
        // winner a moment to finish; only a lock that stays unreadable is treated as stale.
        for (let wait = 0; wait < 5 && holder === null; wait += 1) {
          sleepSync(10);
          holder = readLockRecord(options.lockPath);
        }
      }
      if (holder !== null && pidAlive(holder.pid) && probe(holder.pid) !== false) {
        return { acquired: false, path: options.lockPath, holder };
      }

      // Stale: dead PID, unparsable content, or provably a different program.
      if (holder !== null) replaced = holder;
      try {
        rmSync(options.lockPath, { force: true });
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== 'ENOENT') throw unlinkError;
      }
    }
  }

  return { acquired: false, path: options.lockPath, holder };
}

/** Removes the lock only when it still belongs to `pid`; never deletes another owner's lock. */
export function releaseInstanceLock(lockPath: string, pid: number = process.pid): boolean {
  const holder = readLockRecord(lockPath);
  if (holder === null || holder.pid !== pid) return false;
  rmSync(lockPath, { force: true });
  return true;
}

export interface StartupSweepOptions {
  /** `$AGENTS_HOME/repl-server`. */
  root: string;
  bootId: string;
  /** Owner pid written to lock and state; defaults to `process.pid`. */
  pid?: number;
  now?: () => Date;
  /** TERM -> KILL grace. Defaults to `LIMITS.graceMs` (2s). */
  graceMs?: number;
  ops?: ProcOps;
  sleep?: (ms: number) => void;
  pidAlive?: (pid: number) => boolean;
  isReplServer?: (pid: number) => boolean | undefined;
  /** Extra boot ids known to belong to this data root (e.g. from an external registry). */
  staleBootIds?: readonly string[];
  marker?: string;
  /** Return early when `state.json` already names this boot. Defaults to true. */
  skipIfCurrentBoot?: boolean;
  /** Rewrite `state.json` for the new boot after the sweep. Defaults to true. */
  resetState?: boolean;
  lockRetries?: number;
  /**
   * Instance lock file. Defaults to `<root>/state.db.lock`; the server passes the
   * layout path so acquire and release can never disagree.
   */
  lockPath?: string;
  /** Directory for `orphans-<bootId>.json`. Defaults to `<root>/ledger`. */
  reportDir?: string;
}

export type SweepStatus = 'swept' | 'locked' | 'same-boot';

export interface SweepReport {
  status: SweepStatus;
  bootId: string;
  previousBootId: string | null;
  acquired: boolean;
  lockHolder: LockRecord | null;
  startedAt: string;
  killed: KillRecord[];
  /** Alive but deliberately not signalled: unconfirmed identity or another root's marker. */
  skipped: UnattributedProcess[];
  /** Validated targets that were still alive after SIGKILL. */
  remaining: UnattributedProcess[];
  /** Ledger PIDs that no longer existed at sweep time (PID reuse or clean exit). */
  alreadyGone: number[];
  /** AI run directories removed by this sweep (ledger records and 24h-old orphans). */
  cleanedAiRuns: string[];
  warnings: string[];
  reportPath: string | null;
}

interface SweepTarget {
  pid: number;
  pgid: number;
  lstart: string;
  cmd: string;
  reason: string;
}

function makeTarget(pid: number, pgid: number, lstart: string, cmd: string, reason: string): SweepTarget {
  return { pid, pgid: pgid > 0 ? pgid : pid, lstart, cmd, reason };
}

function addTarget(targets: Map<number, SweepTarget>, target: SweepTarget): void {
  // pid 1 cannot be a repl-server child; refusing it also keeps `-pgid` away from -1.
  if (!Number.isInteger(target.pid) || target.pid <= 1) return;
  const existing = targets.get(target.pid);
  if (existing === undefined) {
    targets.set(target.pid, target);
    return;
  }
  if (existing.lstart === '' && target.lstart !== '') existing.lstart = target.lstart;
  if (existing.cmd === '' && target.cmd !== '') existing.cmd = target.cmd;
}

function pushSkipped(report: SweepReport, pid: number, cmd: string, reason: string): void {
  if (report.skipped.some((entry) => entry.pid === pid && entry.reason === reason)) return;
  report.skipped.push({ pid, cmd, reason });
}

function signalTarget(
  ops: ProcOps,
  report: SweepReport,
  target: SweepTarget,
  signal: NodeJS.Signals,
): boolean {
  const isLeader = target.pgid === target.pid && target.pid > 1;
  try {
    ops.signal(isLeader ? -target.pid : target.pid, signal);
    return true;
  } catch (error) {
    report.warnings.push(`signal ${signal} pid ${target.pid}: ${errorMessage(error)}`);
    return false;
  }
}

function indexRows(rows: readonly ProcRow[]): Map<number, ProcRow> {
  const byPid = new Map<number, ProcRow>();
  for (const row of rows) byPid.set(row.pid, row);
  return byPid;
}

function fileSafe(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return safe === '' ? 'boot' : safe;
}

export function orphansReportPath(root: string, bootId: string, reportDir?: string): string {
  return join(reportDir ?? join(root, 'ledger'), `orphans-${fileSafe(bootId)}.json`);
}

/** AI run directories older than this are removed even without a ledger record. */
export const AI_RUN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Removes one `ai-run-*` directory below the data root. Anything outside the
 * root or not named like a run directory is refused, so a corrupt ledger can
 * never delete an unrelated path.
 */
function cleanAiRunDir(
  root: string,
  runDir: string,
  report: SweepReport,
  cleaned: Set<string>,
): void {
  const base = resolve(root);
  const target = resolve(runDir);
  if (target === base || !target.startsWith(`${base}/`)) return;
  if (!basename(target).startsWith('ai-run-')) return;
  if (cleaned.has(target)) return;
  try {
    rmSync(target, { recursive: true, force: true });
    cleaned.add(target);
    report.cleanedAiRuns.push(target);
  } catch (error) {
    report.warnings.push(`remove AI run dir ${target}: ${errorMessage(error)}`);
  }
}

/** Sweeps `ai-run-*` directories whose mtime is older than {@link AI_RUN_DIR_MAX_AGE_MS}. */
function cleanOldAiRunDirs(root: string, now: number, report: SweepReport, cleaned: Set<string>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      report.warnings.push(`readdir ${root}: ${errorMessage(error)}`);
    }
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('ai-run-')) continue;
    const target = join(root, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(target).mtimeMs;
    } catch (error) {
      report.warnings.push(`stat AI run dir ${target}: ${errorMessage(error)}`);
      continue;
    }
    if (now - mtimeMs < AI_RUN_DIR_MAX_AGE_MS) continue;
    cleanAiRunDir(root, target, report, cleaned);
  }
}

/** Writes `orphans-<bootId>.json` and returns its absolute path. */
export function writeOrphansReport(
  root: string,
  bootId: string,
  report: SweepReport,
  reportDir?: string,
): string {
  const path = orphansReportPath(root, bootId, reportDir);
  writeJsonAtomic(path, {
    bootId: report.bootId,
    previousBootId: report.previousBootId,
    startedAt: report.startedAt,
    killed: report.killed,
    skipped: report.skipped,
    remaining: report.remaining,
    alreadyGone: report.alreadyGone,
    cleanedAiRuns: report.cleanedAiRuns,
    warnings: report.warnings,
  });
  return path;
}

/**
 * One startup pass: acquire the instance lock, kill every process proven to belong to an older
 * boot, record the outcome, then reset `state.json` for the new boot.
 */
export function startupSweep(options: StartupSweepOptions): SweepReport {
  if (options.bootId === '') throw new RangeError('bootId must not be empty');
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const selfPid = options.pid ?? process.pid;
  const report: SweepReport = {
    status: 'swept',
    bootId: options.bootId,
    previousBootId: null,
    acquired: false,
    lockHolder: null,
    startedAt,
    killed: [],
    skipped: [],
    remaining: [],
    alreadyGone: [],
    cleanedAiRuns: [],
    warnings: [],
    reportPath: null,
  };

  const lock = acquireInstanceLock({
    lockPath: options.lockPath ?? join(options.root, 'state.db.lock'),
    pid: options.pid ?? process.pid,
    bootId: options.bootId,
    startedAt,
    pidAlive: options.pidAlive,
    isReplServer: options.isReplServer,
    retries: options.lockRetries,
  });
  report.acquired = lock.acquired;
  if (!lock.acquired) {
    report.status = 'locked';
    report.lockHolder = lock.holder;
    return report;
  }
  if (lock.replaced !== null) {
    report.warnings.push(`replaced stale lock held by pid ${lock.replaced.pid}`);
  }

  const ledger = new ProcessLedger({
    root: options.root,
    onCorrupt: (issue) => report.warnings.push(`${issue.path}: ${issue.reason}`),
  });
  const prev = ledger.readState();
  const prevBootId = prev.bootId === '' ? null : prev.bootId;
  report.previousBootId = prevBootId;
  if ((options.skipIfCurrentBoot ?? true) && prevBootId === options.bootId) {
    report.status = 'same-boot';
    return report;
  }

  const targets = new Map<number, SweepTarget>();
  // Boot ids this data root has actually written. A marker from any other boot may belong to a
  // second repl-server with a different AGENTS_HOME, so it is reported, never killed.
  const staleBoots = new Set<string>();
  if (prevBootId !== null) staleBoots.add(prevBootId);
  for (const bootId of options.staleBootIds ?? []) {
    if (bootId !== '' && bootId !== options.bootId) staleBoots.add(bootId);
  }

  // 1a. state.json: serve records the parent summarised before it died.
  for (const session of Object.values(prev.sessions)) {
    const record = session.serve;
    if (record === null) continue;
    if (record.bootId !== options.bootId) staleBoots.add(record.bootId);
    addTarget(targets, makeTarget(record.pid, record.pgid, record.lstart, '', 'state'));
  }

  // 1b. keeper-written serve.json: the only evidence in the "record written, traffic not yet
  // open, parent died before updating state.json" window. Anything not from the current boot.
  for (const record of ledger.listServeRecords()) {
    if (record.bootId === options.bootId) continue;
    staleBoots.add(record.bootId);
    addTarget(targets, makeTarget(record.pid, record.pgid, record.lstart, '', 'serve.json'));
  }

  // 1c. third-party stdio pool: detached, so it outlives the parent unless swept.
  const pool = ledger.readPool();
  if (pool.bootId !== options.bootId) {
    if (pool.bootId !== '') staleBoots.add(pool.bootId);
    for (const entry of pool.entries) {
      if (entry.pid === null) {
        report.warnings.push(`pool.json ${entry.serverId}: spawning entry without pid`);
        continue;
      }
      addTarget(
        targets,
        makeTarget(entry.pid, entry.pgid ?? entry.pid, entry.lstart ?? '', '', 'pool'),
      );
    }
  }

  // 1d. AI CLI runs: `claude -p` children are detached and write their own ledger.
  // A record from an older boot is killed only when its `lstart` still matches the
  // live process; its private work directory is removed either way.
  const aiRuns = ledger.readAiRuns();
  const aiRunDirs: string[] = [];
  if (aiRuns.bootId !== '' && aiRuns.bootId !== options.bootId) staleBoots.add(aiRuns.bootId);
  for (const entry of aiRuns.entries) {
    if (entry.bootId === options.bootId) continue;
    staleBoots.add(entry.bootId);
    aiRunDirs.push(entry.runDir);
    if (entry.pid === null) {
      report.warnings.push(`ai-runs.json ${entry.runId}: spawning entry without pid`);
      continue;
    }
    addTarget(
      targets,
      makeTarget(entry.pid, entry.pgid ?? entry.pid, entry.lstart ?? '', '', 'ai-run'),
    );
  }

  // 2. survivors ledger: script processes left running by earlier evals.
  for (const record of ledger.readSurvivors().records) {
    addTarget(targets, makeTarget(record.pid, record.pgid, record.startTime, record.cmd, 'survivors'));
  }

  // 3. boot marker: catches reparented or job-control-escaped processes. Only boots this data
  // root recorded are ours; a marker from another boot could be a second server instance.
  const ops = options.ops ?? defaultProcOps();
  const sleep = options.sleep ?? sleepSync;
  const marker = options.marker ?? BOOT_MARKER;
  const snapshot = ops.snapshot();
  for (const row of snapshot) {
    const boot = markerValue(row.command, marker);
    if (boot === undefined || boot === options.bootId) continue;
    if (row.pid === selfPid) {
      report.warnings.push(`refusing to signal own pid ${selfPid} (stale boot marker)`);
      continue;
    }
    if (!staleBoots.has(boot)) {
      pushSkipped(report, row.pid, row.command, 'unowned_boot_marker');
      continue;
    }
    addTarget(targets, makeTarget(row.pid, row.pgid, row.lstart, row.command, 'env_marker'));
  }

  // Validate every target against the same snapshot, then expand confirmed roots to descendants.
  const byPid = indexRows(snapshot);
  const confirmed = new Map<number, SweepTarget>();
  const blocked = new Set<number>();
  for (const target of targets.values()) {
    if (target.pid === selfPid) {
      report.warnings.push(`refusing to signal own pid ${selfPid}`);
      blocked.add(target.pid);
      continue;
    }
    const row = byPid.get(target.pid);
    if (row === undefined) {
      report.alreadyGone.push(target.pid);
      blocked.add(target.pid);
      continue;
    }
    if (target.lstart.trim() === '') {
      pushSkipped(report, target.pid, row.command || target.cmd, 'missing_lstart');
      blocked.add(target.pid);
      continue;
    }
    if (!sameStart(row.lstart, target.lstart)) {
      pushSkipped(report, target.pid, row.command, 'lstart_mismatch');
      blocked.add(target.pid);
      continue;
    }
    confirmed.set(
      target.pid,
      makeTarget(row.pid, row.pgid, row.lstart, row.command, target.reason),
    );
  }
  for (const root of [...confirmed.values()]) {
    for (const child of descendantsOf(snapshot, root.pid)) {
      if (confirmed.has(child.pid) || blocked.has(child.pid)) continue;
      confirmed.set(
        child.pid,
        makeTarget(child.pid, child.pgid, child.lstart, child.command, `${root.reason}:descendant`),
      );
    }
  }

  // TERM -> grace -> KILL, re-validating lstart after the grace so a recycled PID is spared.
  const order = [...confirmed.values()];
  if (order.length > 0) {
    for (const target of order) {
      if (signalTarget(ops, report, target, 'SIGTERM')) {
        report.killed.push({
          pid: target.pid,
          pgid: target.pgid,
          signal: 'SIGTERM',
          reason: target.reason,
        });
      }
    }

    sleep(options.graceMs ?? LIMITS.graceMs);
    const after = indexRows(ops.snapshot());
    for (const target of order) {
      const row = after.get(target.pid);
      if (row === undefined || !sameStart(row.lstart, target.lstart)) continue;
      const killTargetSpec = { ...target, pgid: row.pgid, lstart: row.lstart };
      if (signalTarget(ops, report, killTargetSpec, 'SIGKILL')) {
        report.killed.push({
          pid: target.pid,
          pgid: row.pgid,
          signal: 'SIGKILL',
          reason: target.reason,
        });
      }
    }

    const finalRows = indexRows(ops.snapshot());
    for (const target of order) {
      const row = finalRows.get(target.pid);
      if (row === undefined || !sameStart(row.lstart, target.lstart)) continue;
      report.remaining.push({ pid: target.pid, cmd: row.command, reason: 'survived_sigkill' });
    }
  }

  // AI run directories: records from previous boots plus any 24h-old leftovers.
  const cleanedAiRuns = new Set<string>();
  for (const runDir of aiRunDirs) cleanAiRunDir(options.root, runDir, report, cleanedAiRuns);
  cleanOldAiRunDirs(options.root, now().getTime(), report, cleanedAiRuns);

  report.reportPath = writeOrphansReport(options.root, options.bootId, report, options.reportDir);
  if (options.resetState ?? true) {
    ledger.writeState({
      bootId: options.bootId,
      pid: options.pid ?? process.pid,
      startedAt,
      sessions: {},
    });
  }
  return report;
}

export interface ReconcileOptions {
  records: readonly ResidueRecord[];
  liveSessionIds: ReadonlySet<string>;
  now?: Date;
  ops?: ProcOps;
  /** TERM -> KILL grace. Defaults to `LIMITS.graceMs`. */
  graceMs?: number;
  sleep?: (ms: number) => void;
}

export interface ReconcileResult {
  kept: ResidueRecord[];
  /** Ledger entries dropped because the process vanished or the PID was recycled. */
  removed: UnattributedProcess[];
  killed: KillRecord[];
  remaining: UnattributedProcess[];
}

/**
 * One reconcile pass (02 §3.5): drop vanished/recycled records, kill survivors of dead sessions,
 * kill expired leases, keep the rest. Identity is re-checked from one snapshot before any kill.
 */
export function reconcileSurvivors(options: ReconcileOptions): ReconcileResult {
  const ops = options.ops ?? defaultProcOps();
  const sleep = options.sleep ?? sleepSync;
  const graceMs = options.graceMs ?? LIMITS.graceMs;
  const now = options.now ?? new Date();
  const present = indexRows(ops.snapshot());

  const kept: ResidueRecord[] = [];
  const removed: UnattributedProcess[] = [];
  const toKill: Array<{ record: ResidueRecord; reason: string }> = [];

  for (const record of options.records) {
    if (!Number.isInteger(record.pid) || record.pid <= 1) {
      removed.push({ pid: record.pid, cmd: record.cmd, reason: 'invalid_pid' });
      continue;
    }
    if (record.state !== 'running') {
      removed.push({ pid: record.pid, cmd: record.cmd, reason: `state_${record.state}` });
      continue;
    }
    const row = present.get(record.pid);
    if (row === undefined) {
      removed.push({ pid: record.pid, cmd: record.cmd, reason: 'gone' });
      continue;
    }
    if (!sameStart(row.lstart, record.startTime)) {
      removed.push({ pid: record.pid, cmd: row.command, reason: 'lstart_mismatch' });
      continue;
    }
    if (!options.liveSessionIds.has(record.sessionId)) {
      toKill.push({ record, reason: 'session_gone' });
      continue;
    }
    const leaseUntil = Date.parse(record.leaseUntil);
    if (Number.isFinite(leaseUntil) && leaseUntil <= now.getTime()) {
      toKill.push({ record, reason: 'lease_expired' });
      continue;
    }
    kept.push(record);
  }

  const killed: KillRecord[] = [];
  for (const { record, reason } of toKill) {
    try {
      ops.signal(killTarget(record.pid, record.pgid), 'SIGTERM');
      killed.push({ pid: record.pid, pgid: record.pgid, signal: 'SIGTERM', reason });
    } catch {
      // Delivery failed; the final snapshot reports it as remaining.
    }
  }
  if (toKill.length > 0 && graceMs > 0) sleep(graceMs);

  const after = indexRows(ops.snapshot());
  for (const { record, reason } of toKill) {
    const row = after.get(record.pid);
    if (row === undefined || !sameStart(row.lstart, record.startTime)) continue;
    try {
      ops.signal(killTarget(record.pid, record.pgid), 'SIGKILL');
      killed.push({ pid: record.pid, pgid: record.pgid, signal: 'SIGKILL', reason });
    } catch {
      // Same as above.
    }
  }

  const finalRows = indexRows(ops.snapshot());
  const remaining: UnattributedProcess[] = [];
  for (const { record } of toKill) {
    const row = finalRows.get(record.pid);
    if (row === undefined || !sameStart(row.lstart, record.startTime)) continue;
    remaining.push({ pid: record.pid, cmd: record.cmd, reason: 'survived_sigkill' });
  }

  return { kept, removed, killed, remaining };
}

/** Starts the unref'd 15s reconcile interval and returns a stop function. */
export function startReconcileTimer(
  run: () => void,
  intervalMs: number = RECONCILE_INTERVAL_MS,
): () => void {
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
