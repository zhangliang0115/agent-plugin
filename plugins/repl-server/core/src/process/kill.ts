/**
 * Process-tree termination. The order is fixed by the design:
 * snapshot descendants → SIGTERM group leaders → SIGTERM the rest → wait → SIGKILL →
 * the root last. The snapshot must happen before any signal, or the ppid chain breaks.
 * @module
 */

import { LIMITS } from '../constants.ts';
import type { KillRecord } from '../types.ts';
import { aliveWithSameStart, psRows, sameStartTime, snapshotTree, type ProcessRow } from './tree.ts';

export interface KillTreeOptions {
  /** How long to wait after SIGTERM before escalating. Defaults to `LIMITS.graceMs`. */
  graceMs?: number;
  /** Poll interval while waiting for processes to exit. Defaults to 50ms. */
  pollMs?: number;
  /** Stored in each `KillRecord.reason`. Defaults to `kill_tree`. */
  reason?: string;
}

/** A signal that could not be delivered for a reason other than `ESRCH`. */
export interface KillFailure {
  /** Pid, or negative pgid for a group signal. */
  target: number;
  signal: NodeJS.Signals;
  message: string;
}

export interface KillTreeResult {
  rootPid: number;
  /** Descendants captured before any signal was sent; excludes the root. */
  descendants: ProcessRow[];
  /** Delivered signals in order. Processes already gone are not recorded. */
  signalled: KillRecord[];
  /** True when SIGTERM did not clear the tree and SIGKILL was delivered. */
  escalated: boolean;
  /** Processes whose pid still exists with the same start time when the call returns. */
  remaining: ProcessRow[];
  /** Non-ESRCH delivery errors (e.g. EPERM); the rest of the tree is still attempted. */
  failures: KillFailure[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Send a signal, returning `false` when the process is already gone.
 * `ESRCH` is the only error that is ignored: the target exited between snapshot and signal.
 * `0` and `-1` are rejected because signalling them affects the caller's own process group
 * or every process the user may signal.
 */
export function safeKill(target: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(target) || target === 0 || target === -1) {
    throw new RangeError(`refusing to signal ${target}: expected a pid or a negative pgid other than -1`);
  }
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    throw error;
  }
}

/** Negative pid for a process-group leader, the plain pid otherwise. */
export function killTarget(pid: number, pgid: number): number {
  if (!Number.isInteger(pid) || pid <= 0) throw new RangeError(`pid must be a positive integer, got ${pid}`);
  return pgid === pid ? -pid : pid;
}

function aliveIn(records: ProcessRow[], rows: ProcessRow[]): ProcessRow[] {
  if (records.length === 0) return [];
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return records.filter((record) => {
    const current = byPid.get(record.pid);
    return current !== undefined && sameStartTime(current.lstart, record.lstart);
  });
}

async function waitUntilGone(records: ProcessRow[], timeoutMs: number, pollMs: number): Promise<ProcessRow[]> {
  let pending = records;
  const deadline = Date.now() + timeoutMs;
  while (pending.length > 0) {
    try {
      pending = aliveIn(pending, psRows());
    } catch {
      // `ps` is unavailable; keep the grace timer running and let the caller escalate.
    }
    if (pending.length === 0) return [];
    if (Date.now() >= deadline) return pending;
    await sleep(pollMs);
  }
  return [];
}

async function waitForGone(pid: number, lstart: string, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let alive: boolean;
    try {
      alive = aliveWithSameStart(pid, lstart);
    } catch {
      alive = true;
    }
    if (!alive) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/** Live members of a process group; `null` when `ps` could not answer. */
function groupSurvivors(pgid: number): ProcessRow[] | null {
  try {
    return psRows().filter((row) => row.pgid === pgid);
  } catch {
    return null;
  }
}

function remainingRows(records: ProcessRow[]): ProcessRow[] {
  if (records.length === 0) return [];
  try {
    return aliveIn(records, psRows());
  } catch {
    // Cannot verify: report conservatively instead of claiming the tree is gone.
    return records;
  }
}

/**
 * Terminate `rootPid` and every descendant captured before the first signal.
 *
 * - Group leaders are signalled with `kill(-pid)`; other members with `kill(pid)`.
 * - After `graceMs` (default 2s) survivors get SIGKILL.
 * - The root is signalled last, so its children stay attached to the tree while it is walked.
 * - `ESRCH` is ignored everywhere; other errors are collected in `failures` and do not stop
 *   the remaining signals.
 *
 * Callers that read `rootPid` from a ledger must verify `aliveWithSameStart(rootPid, lstart)`
 * first: this function trusts the pid it is given.
 */
export async function killTree(rootPid: number, options: KillTreeOptions = {}): Promise<KillTreeResult> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    throw new RangeError(`rootPid must be a positive integer, got ${rootPid}`);
  }
  const graceMs = Math.max(0, options.graceMs ?? LIMITS.graceMs);
  const pollMs = Math.max(1, options.pollMs ?? 50);
  const reason = options.reason ?? 'kill_tree';

  // One snapshot feeds both the descendant walk and the root's identity/leader flag.
  const rows = psRows();
  const rootRow = rows.find((row) => row.pid === rootPid) ?? null;
  const descendants = snapshotTree(rootPid, rows);

  const signalled: KillRecord[] = [];
  const failures: KillFailure[] = [];
  const emitOne = (pid: number, pgid: number, signal: NodeJS.Signals): boolean => {
    try {
      if (!safeKill(pid, signal)) return false;
    } catch (error) {
      failures.push({ target: pid, signal, message: describeError(error) });
      return false;
    }
    signalled.push({ pid, pgid, signal, reason });
    return true;
  };
  const emit = (row: ProcessRow, target: number, signal: NodeJS.Signals): boolean => {
    if (target >= 0) return emitOne(row.pid, row.pgid, signal);
    try {
      if (safeKill(target, signal)) {
        signalled.push({ pid: row.pid, pgid: row.pgid, signal, reason });
        return true;
      }
      return false;
    } catch (error) {
      // macOS reports EPERM for a group whose leader is already a zombie. Fall back to
      // signalling the remaining members one by one instead of leaving them behind.
      if (!isErrno(error, 'EPERM')) {
        failures.push({ target, signal, message: describeError(error) });
        return false;
      }
      const survivors = groupSurvivors(row.pid);
      if (survivors === null) {
        failures.push({ target, signal, message: describeError(error) });
        return false;
      }
      let delivered = false;
      for (const survivor of survivors) {
        if (emitOne(survivor.pid, survivor.pgid, signal)) delivered = true;
      }
      return delivered;
    }
  };

  const leaders = descendants.filter((row) => row.pgid === row.pid);
  const followers = descendants.filter((row) => row.pgid !== row.pid);

  for (const row of leaders) emit(row, -row.pid, 'SIGTERM');
  for (const row of followers) emit(row, row.pid, 'SIGTERM');

  let escalated = false;
  const alive = await waitUntilGone(descendants, graceMs, pollMs);
  if (alive.length > 0) {
    escalated = true;
    // Kill whole leader groups, not just the leader records: members that appeared after the
    // snapshot still belong to the group. Non-leaders are signalled individually.
    for (const row of leaders) emit(row, -row.pid, 'SIGKILL');
    for (const row of alive) {
      if (row.pgid !== row.pid) emit(row, row.pid, 'SIGKILL');
    }
    await waitUntilGone(alive, Math.min(graceMs, 1_000), pollMs);
  }

  // The root goes last. If it leads a group, a final SIGKILL after the grace window also
  // catches children that joined the group after the snapshot.
  if (rootRow !== null) {
    const isLeader = rootRow.pgid === rootPid;
    const target = killTarget(rootPid, rootRow.pgid);
    emit(rootRow, target, 'SIGTERM');

    const termAt = Date.now();
    const rootGone = await waitForGone(rootPid, rootRow.lstart, graceMs, pollMs);
    const survivors = isLeader ? groupSurvivors(rootPid) : [];
    if (!rootGone || survivors === null || survivors.length > 0) {
      const left = graceMs - (Date.now() - termAt);
      if (left > 0) await sleep(left);
      if (emit(rootRow, target, 'SIGKILL')) escalated = true;
      await waitForGone(rootPid, rootRow.lstart, Math.min(graceMs, 1_000), pollMs);
    }
  }

  const remaining = remainingRows(rootRow === null ? descendants : [...descendants, rootRow]);
  return { rootPid, descendants, signalled, escalated, remaining, failures };
}
