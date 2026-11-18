/**
 * Durable process ledger: current-boot state, per-session serve records, the
 * third-party MCP stdio pool and the survivor list.
 *
 * Every write is `tmp + rename` with mode 0600, so a crash leaves either the
 * previous file or the new one, never a partial record. Reads treat a missing
 * file as empty and a corrupt file as empty plus one recorded issue; recovery
 * must never kill a process based on half-parsed data.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { ProcRecord } from '../types.ts';

/** A `claude mcp serve` process group launched by a keeper (design 02 §3.2). */
export interface ServeRecord {
  pid: number;
  pgid: number;
  keeperPid: number;
  sessionId: string;
  bootId: string;
  /**
   * Raw `ps -o lstart=` value; the only reliable PID-reuse check. Empty means
   * `ps` failed while the keeper was writing, so the record must not be killed
   * on until a later scan proves the process is still the same one.
   */
  lstart: string;
  transport?: 'stdio';
  serverId?: string;
  cfgVersion?: number;
  startedAt?: string;
}

/** One session entry inside `state.json`; the key is the session id. */
export interface StateSession {
  serve: ServeRecord | null;
  updatedAt?: string;
}

/** `state.json`: the current boot and its session → serve/keeper mapping. */
export interface StateFile {
  bootId: string;
  /** PID of the repl-server that owns this boot. */
  pid: number;
  sessions: Record<string, StateSession>;
  startedAt?: string;
}

export type PoolEntryState = 'spawning' | 'running' | 'stopped' | 'crashed';

/**
 * One third-party MCP stdio server in `pool.json`. The record is written as
 * `spawning` (pid/pgid/lstart null) before spawn, then filled in after
 * `initialize` (design 02 §3.3).
 */
export interface PoolEntry {
  serverId: string;
  cfgVersion: number;
  pid: number | null;
  pgid: number | null;
  lstart: string | null;
  state: PoolEntryState;
  /** Boot that spawned the entry; the sweep compares it against the current boot. */
  bootId?: string;
  startedAt?: string;
}

/** `pool.json`: third-party servers are shared across exec sessions. */
export interface PoolFile {
  bootId: string;
  entries: PoolEntry[];
}

export type SurvivorState = 'running' | 'exited' | 'killed' | 'gone';

/**
 * A process left behind by an eval (design 02 §3.2). `evalKey` is
 * `<execSessionId>:<evalId>` because `evalId` is only unique per exec session.
 * `killed` and `gone` come from the residue tracker; `exited` marks a process
 * that disappeared between detection and reporting.
 */
export interface SurvivorRecord extends ProcRecord {
  sessionId: string;
  evalKey: string;
  ppid: number;
  firstSeen: string;
  leaseUntil: string;
  state: SurvivorState;
}

/** `ledger/survivors.json`. */
export interface SurvivorsFile {
  records: SurvivorRecord[];
}

/** A file that could not be used; recovery keeps going with an empty value. */
export interface LedgerCorruption {
  path: string;
  reason: string;
}

export interface LedgerOptions {
  /** repl-server data directory; defaults to `$AGENTS_HOME/repl-server`. */
  root?: string;
  /** Invoked for every corrupt file, in addition to `corruptions`. */
  onCorrupt?: (issue: LedgerCorruption) => void;
}

type ReadResult =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'corrupt' };

const STATE_FILE = 'state.json';
const POOL_FILE = 'pool.json';
const SURVIVORS_FILE = join('ledger', 'survivors.json');
const SESSIONS_DIR = 'sessions';
const SERVE_FILE = 'serve.json';

const POOL_STATES: readonly PoolEntryState[] = ['spawning', 'running', 'stopped', 'crashed'];
const SURVIVOR_STATES: readonly SurvivorState[] = ['running', 'exited', 'killed', 'gone'];

/**
 * Default data root: `$AGENTS_HOME/repl-server`, with `AGENTS_HOME` defaulting
 * to `~/.agents` (protocol.md §1.1).
 */
export function defaultLedgerRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.AGENTS_HOME !== undefined && env.AGENTS_HOME.trim() !== ''
    ? env.AGENTS_HOME
    : join(homedir(), '.agents');
  return join(resolve(home), 'repl-server');
}

/**
 * Builds the composite ledger key. `evalId` restarts per exec session, so a
 * bare number cannot identify a survivor across sessions.
 */
export function evalKeyOf(execSessionId: string, evalId: number): string {
  if (execSessionId === '' || execSessionId.includes(':')) {
    throw new TypeError(`invalid exec session id for an eval key: ${JSON.stringify(execSessionId)}`);
  }
  if (!Number.isInteger(evalId) || evalId < 1) {
    throw new RangeError('evalId must be a positive integer');
  }
  return `${execSessionId}:${evalId}`;
}

/** Creates parent directories and replaces `path` atomically with mode 0600. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor was already closed; nothing to recover.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file was never created or the rename already consumed it.
    }
    throw error;
  }
}

/** Reads and writes the four recovery files. All reads and writes are synchronous. */
export class ProcessLedger {
  readonly root: string;
  private readonly issues: LedgerCorruption[] = [];
  private readonly onCorrupt: ((issue: LedgerCorruption) => void) | undefined;

  constructor(options: LedgerOptions = {}) {
    this.root = resolve(options.root ?? defaultLedgerRoot());
    this.onCorrupt = options.onCorrupt;
  }

  /** Every corruption seen by this instance, oldest first. */
  get corruptions(): readonly LedgerCorruption[] {
    return [...this.issues];
  }

  get statePath(): string {
    return join(this.root, STATE_FILE);
  }

  get poolPath(): string {
    return join(this.root, POOL_FILE);
  }

  get survivorsPath(): string {
    return join(this.root, SURVIVORS_FILE);
  }

  servePath(sessionId: string): string {
    return join(this.root, SESSIONS_DIR, pathSegment(sessionId), SERVE_FILE);
  }

  readState(): StateFile {
    const result = this.readJson(this.statePath);
    if (result.status !== 'ok') return emptyState();

    const state = parseState(result.value);
    if (state === null) {
      this.record(this.statePath, 'invalid state.json shape');
      return emptyState();
    }
    return state;
  }

  writeState(state: StateFile): void {
    const normalized = parseState(state);
    if (normalized === null) throw new TypeError('invalid state ledger record');
    writeJsonAtomic(this.statePath, normalized);
  }

  readServe(sessionId: string): ServeRecord | null {
    const id = pathSegment(sessionId);
    const path = this.servePath(id);
    const result = this.readJson(path);
    if (result.status !== 'ok') return null;

    const record = parseServeRecord(result.value);
    if (record === null || record.sessionId !== id) {
      this.record(path, 'invalid serve record');
      return null;
    }
    return record;
  }

  writeServe(record: ServeRecord): void {
    const normalized = parseServeRecord(record);
    if (normalized === null) throw new TypeError('invalid serve record');
    writeJsonAtomic(this.servePath(normalized.sessionId), normalized);
  }

  /** Startup sweep reads every keeper-written record, not just `state.json`. */
  listServeRecords(): ServeRecord[] {
    const dir = join(this.root, SESSIONS_DIR);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      this.record(dir, `readdir failed: ${errorMessage(error)}`);
      return [];
    }

    const records: ServeRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = this.readServe(entry.name);
      if (record !== null) records.push(record);
    }
    records.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return records;
  }

  /** Removes a serve record after a clean shutdown; a missing file is fine. */
  removeServe(sessionId: string): void {
    const path = this.servePath(sessionId);
    try {
      unlinkSync(path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  readPool(): PoolFile {
    const result = this.readJson(this.poolPath);
    if (result.status !== 'ok') return emptyPool();

    const pool = parsePool(result.value);
    if (pool === null) {
      this.record(this.poolPath, 'invalid pool.json shape');
      return emptyPool();
    }
    return pool;
  }

  writePool(pool: PoolFile): void {
    const normalized = parsePool(pool);
    if (normalized === null) throw new TypeError('invalid pool ledger record');
    writeJsonAtomic(this.poolPath, normalized);
  }

  readSurvivors(): SurvivorsFile {
    const result = this.readJson(this.survivorsPath);
    if (result.status !== 'ok') return emptySurvivors();

    const survivors = parseSurvivors(result.value);
    if (survivors === null) {
      this.record(this.survivorsPath, 'invalid survivors.json shape');
      return emptySurvivors();
    }
    return survivors;
  }

  writeSurvivors(survivors: SurvivorsFile): void {
    const normalized = parseSurvivors(survivors);
    if (normalized === null) throw new TypeError('invalid survivors ledger record');
    writeJsonAtomic(this.survivorsPath, normalized);
  }

  private readJson(path: string): ReadResult {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { status: 'missing' };
      this.record(path, `read failed: ${errorMessage(error)}`);
      return { status: 'corrupt' };
    }

    try {
      return { status: 'ok', value: JSON.parse(text) as unknown };
    } catch (error) {
      this.record(path, `invalid JSON: ${errorMessage(error)}`);
      return { status: 'corrupt' };
    }
  }

  private record(path: string, reason: string): void {
    const issue: LedgerCorruption = { path, reason };
    this.issues.push(issue);
    this.onCorrupt?.(issue);
  }
}

function emptyState(): StateFile {
  return { bootId: '', pid: 0, sessions: {} };
}

function emptyPool(): PoolFile {
  return { bootId: '', entries: [] };
}

function emptySurvivors(): SurvivorsFile {
  return { records: [] };
}

function parseState(value: unknown): StateFile | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.bootId) || !isPositiveInteger(value.pid)) return null;
  if (!isRecord(value.sessions)) return null;

  const sessions: Record<string, StateSession> = {};
  for (const [sessionId, raw] of Object.entries(value.sessions)) {
    if (!isNonEmptyString(sessionId) || !isRecord(raw)) return null;

    const serveRaw = raw.serve;
    let serve: ServeRecord | null = null;
    if (serveRaw !== null && serveRaw !== undefined) {
      serve = parseServeRecord(serveRaw);
      if (serve === null || serve.sessionId !== sessionId) return null;
    }

    const entry: StateSession = { serve };
    if (isNonEmptyString(raw.updatedAt)) entry.updatedAt = raw.updatedAt;
    sessions[sessionId] = entry;
  }

  const state: StateFile = { bootId: value.bootId, pid: value.pid, sessions };
  if (isNonEmptyString(value.startedAt)) state.startedAt = value.startedAt;
  return state;
}

function parseServeRecord(value: unknown): ServeRecord | null {
  if (!isRecord(value)) return null;
  const { pid, pgid, keeperPid, sessionId, bootId, lstart } = value;
  if (!isPositiveInteger(pid) || !isPositiveInteger(pgid) || !isPositiveInteger(keeperPid)) return null;
  if (!isNonEmptyString(sessionId) || !isNonEmptyString(bootId)) return null;
  if (typeof lstart !== 'string') return null;

  const record: ServeRecord = { pid, pgid, keeperPid, sessionId, bootId, lstart };
  if (value.transport === 'stdio') record.transport = 'stdio';
  if (isNonEmptyString(value.serverId)) record.serverId = value.serverId;
  if (isPositiveInteger(value.cfgVersion)) record.cfgVersion = value.cfgVersion;
  if (isNonEmptyString(value.startedAt)) record.startedAt = value.startedAt;
  return record;
}

function parsePool(value: unknown): PoolFile | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.bootId) || !Array.isArray(value.entries)) return null;

  const entries: PoolEntry[] = [];
  for (const raw of value.entries) {
    const entry = parsePoolEntry(raw);
    if (entry === null) return null;
    entries.push(entry);
  }
  return { bootId: value.bootId, entries };
}

function parsePoolEntry(value: unknown): PoolEntry | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.serverId)) return null;
  if (!isPositiveInteger(value.cfgVersion)) return null;
  if (!POOL_STATES.includes(value.state as PoolEntryState)) return null;

  const pid = value.pid ?? null;
  const pgid = value.pgid ?? null;
  const lstart = value.lstart ?? null;
  if (pid === null) {
    if (pgid !== null || lstart !== null) return null;
  } else if (!isPositiveInteger(pid) || !isPositiveInteger(pgid) || typeof lstart !== 'string') {
    return null;
  }

  const entry: PoolEntry = {
    serverId: value.serverId,
    cfgVersion: value.cfgVersion,
    pid,
    pgid,
    lstart,
    state: value.state as PoolEntryState,
  };
  if (isNonEmptyString(value.bootId)) entry.bootId = value.bootId;
  if (isNonEmptyString(value.startedAt)) entry.startedAt = value.startedAt;
  return entry;
}

function parseSurvivors(value: unknown): SurvivorsFile | null {
  if (!isRecord(value) || !Array.isArray(value.records)) return null;

  const records: SurvivorRecord[] = [];
  for (const raw of value.records) {
    const record = parseSurvivor(raw);
    if (record === null) return null;
    records.push(record);
  }
  return { records };
}

function parseSurvivor(value: unknown): SurvivorRecord | null {
  if (!isRecord(value)) return null;
  const { handle, sessionId, evalKey, pid, ppid, pgid, startTime, cmd, firstSeen, leaseUntil, state } = value;
  if (
    !isNonEmptyString(handle)
    || !isNonEmptyString(sessionId)
    || !isEvalKey(evalKey)
    || !isPositiveInteger(pid)
    || !isPositiveInteger(ppid)
    || !isPositiveInteger(pgid)
    || !isNonEmptyString(startTime)
    || !isNonEmptyString(firstSeen)
    || !isNonEmptyString(leaseUntil)
    || !SURVIVOR_STATES.includes(state as SurvivorState)
  ) {
    return null;
  }

  return {
    handle,
    sessionId,
    evalKey,
    pid,
    ppid,
    pgid,
    startTime,
    cmd: typeof cmd === 'string' ? cmd : '',
    firstSeen,
    leaseUntil,
    state: state as SurvivorState,
  };
}

function isEvalKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const separator = value.lastIndexOf(':');
  if (separator < 1 || separator === value.length - 1) return false;
  if (value.slice(0, separator).includes(':')) return false;
  const evalId = Number(value.slice(separator + 1));
  return Number.isInteger(evalId) && evalId > 0;
}

function pathSegment(id: string): string {
  if (id === '' || id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new TypeError(`invalid session id for a ledger path: ${JSON.stringify(id)}`);
  }
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
