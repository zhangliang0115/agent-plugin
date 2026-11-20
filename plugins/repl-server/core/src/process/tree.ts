/**
 * Process inspection for the executor: `ps` snapshots, descendant trees, start-time identity
 * and boot markers. Kill ordering lives in `kill.ts`.
 * @module
 */

import { spawnSync } from 'node:child_process';

/** Environment variable carried by every process started during one repl-server boot. */
export const BOOT_MARKER_ENV = 'REPL_SERVER_BOOT';

/** One row of `ps -axo pid=,ppid=,pgid=,lstart=,command=`. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** `lstart` normalized to single spaces, e.g. `Mon Nov 17 14:31:58 2026`. */
  lstart: string;
  /** Command plus arguments; `ps -E` appends the environment to this same field. */
  command: string;
}

/** One row of `ps -axo pid=,ppid=,rss=,%cpu=`. */
export interface ResourceRow {
  pid: number;
  ppid: number;
  /** Resident set size in bytes (`ps` reports KB; converted here). */
  rssBytes: number;
  /** `ps` `%cpu`, not an interval-instantaneous value. */
  cpuPercent: number;
}

const PS_FIELDS = 'pid=,ppid=,pgid=,lstart=,command=';
const PS_RESOURCE_FIELDS = 'pid=,ppid=,rss=,%cpu=';
/** `ps` output is parsed, so force the C locale for stable weekday/month abbreviations. */
const PS_ENV: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' };
const WEEKDAYS = new Set(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const MONTHS = new Set(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/;
const RESOURCE_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s*$/;
const BYTES_PER_KB = 1024;

interface PsResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runPs(args: readonly string[]): PsResult {
  const result = spawnSync('ps', args, {
    encoding: 'utf8',
    env: PS_ENV,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function psSnapshot(args: readonly string[]): ProcessRow[] {
  const result = runPs(args);
  if (result.status !== 0) {
    // An empty snapshot must never be read as "no processes": callers use it to decide what to kill.
    const detail = result.stderr.trim() || 'no stderr';
    throw new Error(`ps ${args.join(' ')} failed (status ${result.status ?? 'signal'}): ${detail}`);
  }
  return parsePsRows(result.stdout);
}

/** Parse one `ps` line; returns `null` for headers, blanks and malformed rows. */
export function parsePsLine(line: string): ProcessRow | null {
  const match = ROW_RE.exec(line);
  if (match === null) return null;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const pgid = Number(match[3]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) return null;

  const parts = (match[4] ?? '').trim().split(/\s+/);
  const weekday = parts[0];
  const month = parts[1];
  const day = parts[2];
  const clock = parts[3];
  const year = parts[4];
  if (
    weekday === undefined ||
    month === undefined ||
    day === undefined ||
    clock === undefined ||
    year === undefined
  ) {
    return null;
  }
  if (!WEEKDAYS.has(weekday) || !MONTHS.has(month)) return null;
  if (!/^\d{1,2}$/.test(day) || !/^\d{2}:\d{2}:\d{2}$/.test(clock) || !/^\d{4}$/.test(year)) return null;

  return {
    pid,
    ppid,
    pgid,
    // Re-join to drop the padding `ps` puts in front of single-digit days.
    lstart: `${weekday} ${month} ${day} ${clock} ${year}`,
    command: parts.slice(5).join(' '),
  };
}

/** Parse the stdout of `ps -axo pid=,ppid=,pgid=,lstart=,command=`. */
export function parsePsRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const row = parsePsLine(line);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** Full process table snapshot. Throws when `ps` itself fails. */
export function psRows(): ProcessRow[] {
  return psSnapshot(['-axo', PS_FIELDS]);
}

/** Parse the stdout of `ps -axo pid=,ppid=,rss=,%cpu=`. */
export function parseResourceRows(stdout: string): ResourceRow[] {
  const rows: ResourceRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = RESOURCE_ROW_RE.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKb = Number(match[3]);
    const cpuPercent = Number(match[4]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    if (!Number.isSafeInteger(rssKb) || !Number.isFinite(cpuPercent)) continue;
    rows.push({ pid, ppid, rssBytes: rssKb * BYTES_PER_KB, cpuPercent });
  }
  return rows;
}

/** Process table with rss and `%cpu`. Throws when `ps` itself fails. */
export function psResourceRows(): ResourceRow[] {
  const args = ['-axo', PS_RESOURCE_FIELDS];
  const result = runPs(args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || 'no stderr';
    throw new Error(`ps ${args.join(' ')} failed (status ${result.status ?? 'signal'}): ${detail}`);
  }
  return parseResourceRows(result.stdout);
}

/** Like {@link psRows}, but with each process's environment appended to its command (`ps -E`). */
export function psRowsWithEnv(): ProcessRow[] {
  return psSnapshot(['-E', '-axo', PS_FIELDS]);
}

/** One process by pid, or `null` when it no longer exists. */
export function psRow(pid: number): ProcessRow | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = runPs(['-p', String(pid), '-o', PS_FIELDS]);
  for (const line of result.stdout.split('\n')) {
    const row = parsePsLine(line);
    if (row !== null) return row;
  }
  return null;
}

/** Collapse the padding `ps` puts around `lstart` fields. */
export function normalizeLstart(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Compare two `lstart` values; empty values never match anything, including each other. */
export function sameStartTime(a: string, b: string): boolean {
  const left = normalizeLstart(a);
  const right = normalizeLstart(b);
  if (left === '' || right === '') return false;
  return left === right;
}

/**
 * True when `pid` still exists **and** its start time matches `lstart`.
 * PID reuse shows up as a different `lstart` and must not be treated as the same process.
 */
export function aliveWithSameStart(pid: number, lstart: string): boolean {
  const row = psRow(pid);
  return row !== null && sameStartTime(row.lstart, lstart);
}

/**
 * Descendants of `rootPid` from one snapshot, excluding the root itself.
 * The snapshot must be taken before any signal is sent: once the root dies its children are
 * reparented to launchd and the ppid chain is gone.
 *
 * `rows` can be passed to reuse an existing snapshot (or in tests); it defaults to a live
 * {@link psRows} call.
 */
export function snapshotTree(rootPid: number, rows: ProcessRow[] = psRows()): ProcessRow[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];

  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings === undefined) byParent.set(row.ppid, [row]);
    else siblings.push(row);
  }

  const seen = new Set<number>([rootPid]);
  const stack: number[] = [rootPid];
  const out: ProcessRow[] = [];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) break;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue; // guards against a corrupt ppid cycle
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }

  out.sort((a, b) => a.pid - b.pid);
  return out;
}

function assertBootId(bootId: string): void {
  if (typeof bootId !== 'string' || bootId === '') throw new TypeError('bootId must be a non-empty string');
}

/**
 * Add (or replace) the boot marker in a child's environment.
 * Every process spawned through this env can be found later by {@link findByMarker}.
 */
export function withBootMarker(env: NodeJS.ProcessEnv, bootId: string): NodeJS.ProcessEnv {
  assertBootId(bootId);
  return { ...env, [BOOT_MARKER_ENV]: bootId };
}

function hasMarkerToken(text: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(token, from);
    if (index < 0) return false;
    const before = index === 0 ? '' : (text[index - 1] ?? '');
    const after = text[index + token.length] ?? '';
    const boundary = (char: string): boolean => char === '' || /\s/.test(char);
    if (boundary(before) && boundary(after)) return true;
    from = index + token.length;
  }
}

/**
 * Processes whose environment carries `BOOT_MARKER_ENV=<bootId>`.
 * This is the last-resort attribution channel for processes that escaped the ppid tree or
 * were reparented. On macOS `ps -E` only exposes environments it is allowed to read, so an
 * empty result is not proof that nothing survived; callers should report what they could not
 * attribute instead of treating the scan as exhaustive.
 */
export function findByMarker(bootId: string, rows: ProcessRow[] = psRowsWithEnv()): ProcessRow[] {
  assertBootId(bootId);
  const token = `${BOOT_MARKER_ENV}=${bootId}`;
  return rows.filter((row) => hasMarkerToken(row.command, token));
}
