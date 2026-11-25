/**
 * Backfills `__builtin__` lifetime usage from the protocol event log.
 *
 * The builtin `onUsage` hook was added after the first calls were served, so
 * `tool_usage` only covers calls made since the last restart. This script
 * replays historical `tools/call` events and merges the totals with "take the
 * larger value" semantics: the log holds an absolute total, not an increment,
 * so re-running never double-counts calls the live hook already recorded.
 *
 * Dry-run by default; `--apply` writes a `VACUUM INTO` backup next to
 * `state.db` before touching it.
 *
 * Usage:
 *   node server/scripts/backfill-tool-usage.ts [--root <AGENTS_HOME>] [--apply]
 * @module
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { withTransaction } from '../src/db/migrate.ts';
import { BUILTIN_SERVER_ID } from '../src/db/servers.ts';
import { createLayout } from '../src/layout.ts';

export interface UsageTotals {
  callCount: number;
  successCount: number;
  lastCalledAt: string | null;
}

export interface MergeResult {
  name: string;
  history: UsageTotals;
  current: UsageTotals;
  /** The row to write, or null when the current DB already covers the log. */
  wouldWrite: UsageTotals | null;
}

export interface ScanStats {
  /** Non-empty lines read across all event files. */
  lines: number;
  invalidJson: number;
  /** Every `proto_in` with `method: 'tools/call'`. */
  toolCallEvents: number;
  /** Calls whose name is not a stored `__builtin__` tool; left untouched. */
  ignoredCalls: number;
  unattributedCalls: number;
  /** Calls without a usable `mcp`/`id`; counted but never credited a success. */
  keylessCalls: number;
  matchedCalls: number;
  /** Calls with no matching `proto_out`; counted as failures (conservative). */
  unmatchedCalls: number;
  orphanOutputs: number;
}

export interface ScanResult {
  totals: Map<string, UsageTotals>;
  stats: ScanStats;
}

export interface BackfillOptions {
  /** `AGENTS_HOME` equivalent; defaults to `$AGENTS_HOME` or `~/.agents`. */
  root?: string;
  apply?: boolean;
}

export interface BackfillReport {
  mode: 'dry-run' | 'apply';
  serverId: string;
  root: string;
  logDir: string;
  db: string;
  eventFiles: string[];
  scan: ScanStats;
  builtinTools: MergeResult[];
  changed: number;
  backup: string | null;
}

const EMPTY_USAGE: UsageTotals = { callCount: 0, successCount: 0, lastCalledAt: null };
const EVENTS_FILE = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/u;
const EPOCH = '1970-01-01T00:00:00.000Z';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `params.name`, falling back to a (possibly truncated) `paramsPreview`. */
export function eventToolName(event: Record<string, unknown>): string | null {
  const params = event['params'];
  if (isRecord(params)) {
    const name = params['name'];
    if (typeof name === 'string' && name !== '') return name;
  }
  const preview = event['paramsPreview'];
  if (typeof preview === 'string') {
    const parsed = tryJson(preview);
    if (isRecord(parsed) && typeof parsed['name'] === 'string' && parsed['name'] !== '') {
      return parsed['name'];
    }
    // Previews are cut at a byte cap; the leading object keys survive intact
    // and the writer always puts `name` first.
    const match = /^\{"name":"([^"\\]+)"/u.exec(preview);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * Tool failure by the audit log's rules: protocol `ok:false`, or the tool
 * result's own `isError:true`. `ok` is protocol-level and stays true for a
 * failed tool, so it cannot be used alone.
 */
export function isToolFailure(event: Record<string, unknown>): boolean {
  if (event['ok'] === false) return true;
  const result = event['result'];
  if (isRecord(result) && result['isError'] === true) return true;
  const preview = event['resultPreview'];
  if (result === undefined && typeof preview === 'string') {
    const parsed = tryJson(preview);
    if (isRecord(parsed) && parsed['isError'] === true) return true;
  }
  return false;
}

export function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return a >= b ? a : b;
  return right > left ? b : a;
}

function eventKey(event: Record<string, unknown>): string | null {
  const mcp = event['mcp'];
  const id = event['id'];
  if (typeof mcp !== 'string' || mcp === '' || id === undefined) return null;
  // `${typeof id}:${String(id)}` keeps numeric 1 and string "1" apart.
  return `${mcp}\u0000${typeof id}:${String(id)}`;
}

/**
 * Replays lines in file order. A session may reuse one JSON-RPC id for several
 * sequential calls, so pending calls are queued per `(mcp, id)` and outputs
 * are paired in occurrence order.
 */
export function scanEventLines(
  lines: Iterable<string>,
  allowedNames: ReadonlySet<string>,
): ScanResult {
  const totals = new Map<string, UsageTotals>();
  const pending = new Map<string, string[]>();
  const stats: ScanStats = {
    lines: 0,
    invalidJson: 0,
    toolCallEvents: 0,
    ignoredCalls: 0,
    unattributedCalls: 0,
    keylessCalls: 0,
    matchedCalls: 0,
    unmatchedCalls: 0,
    orphanOutputs: 0,
  };

  const ensure = (name: string): UsageTotals => {
    let usage = totals.get(name);
    if (usage === undefined) {
      usage = { callCount: 0, successCount: 0, lastCalledAt: null };
      totals.set(name, usage);
    }
    return usage;
  };

  for (const line of lines) {
    if (line.trim() === '') continue;
    stats.lines += 1;
    const event = tryJson(line);
    if (!isRecord(event)) {
      stats.invalidJson += 1;
      continue;
    }
    const kind = event['event'];
    if ((kind !== 'proto_in' && kind !== 'proto_out') || event['method'] !== 'tools/call') {
      continue;
    }

    if (kind === 'proto_in') {
      stats.toolCallEvents += 1;
      const name = eventToolName(event);
      if (name === null) {
        stats.unattributedCalls += 1;
        continue;
      }
      if (!allowedNames.has(name)) {
        stats.ignoredCalls += 1;
        continue;
      }
      const usage = ensure(name);
      usage.callCount += 1;
      const ts = event['ts'];
      usage.lastCalledAt = laterIso(
        usage.lastCalledAt,
        typeof ts === 'string' ? ts : null,
      );
      const key = eventKey(event);
      if (key === null) {
        stats.keylessCalls += 1;
        stats.unmatchedCalls += 1;
      } else {
        const queue = pending.get(key);
        if (queue === undefined) pending.set(key, [name]);
        else queue.push(name);
      }
      continue;
    }

    const key = eventKey(event);
    const queue = key === null ? undefined : pending.get(key);
    const name = queue?.shift();
    if (key !== null && queue !== undefined && queue.length === 0) pending.delete(key);
    if (name === undefined) {
      stats.orphanOutputs += 1;
      continue;
    }
    stats.matchedCalls += 1;
    if (!isToolFailure(event)) ensure(name).successCount += 1;
  }

  for (const queue of pending.values()) stats.unmatchedCalls += queue.length;
  return { totals, stats };
}

/** Absolute merge: history only wins when it has more calls than the DB. */
export function mergeUsage(
  name: string,
  history: UsageTotals,
  current: UsageTotals,
): MergeResult {
  const historyWins = history.callCount > current.callCount;
  const lastCalledAt = laterIso(history.lastCalledAt, current.lastCalledAt);
  const changed =
    history.callCount > 0 &&
    (historyWins || lastCalledAt !== current.lastCalledAt);
  return {
    name,
    history,
    current,
    wouldWrite: changed
      ? {
          callCount: historyWins ? history.callCount : current.callCount,
          successCount: historyWins ? history.successCount : current.successCount,
          // `last_called_at` is NOT NULL; real proto events always carry `ts`.
          lastCalledAt: lastCalledAt ?? EPOCH,
        }
      : null,
  };
}

function listEventFiles(logDir: string): string[] {
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((name) => EVENTS_FILE.test(name))
    .sort()
    .map((name) => join(logDir, name));
}

function* eventLines(files: readonly string[]): Generator<string> {
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) yield line;
  }
}

function readBuiltinNames(db: DatabaseSync): string[] {
  const toolsTable = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'tools'")
    .get();
  if (toolsTable === undefined) throw new Error('tools table is missing from state.db');
  return db
    .prepare('SELECT name FROM tools WHERE server_id = ? ORDER BY name')
    .all(BUILTIN_SERVER_ID)
    .map((row) => String((row as Record<string, unknown>)['name']));
}

function readCurrentUsage(db: DatabaseSync): Map<string, UsageTotals> {
  const usageTable = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'tool_usage'")
    .get();
  if (usageTable === undefined) {
    throw new Error('tool_usage table is missing; start the server once so migrations run');
  }
  const rows = db
    .prepare(
      'SELECT name, call_count, success_count, last_called_at FROM tool_usage WHERE server_id = ?',
    )
    .all(BUILTIN_SERVER_ID);
  const usage = new Map<string, UsageTotals>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const last = row['last_called_at'];
    usage.set(String(row['name']), {
      callCount: Number(row['call_count']),
      successCount: Number(row['success_count']),
      lastCalledAt: last === null || last === undefined ? null : String(last),
    });
  }
  return usage;
}

function backupDatabase(db: DatabaseSync, dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const path = `${dbPath}.bak-${stamp}`;
  db.exec(`VACUUM INTO '${path.replace(/'/gu, "''")}'`);
  return path;
}

function writeUsage(db: DatabaseSync, rows: readonly MergeResult[]): void {
  const statement = db.prepare(`
    INSERT INTO tool_usage (server_id, name, call_count, success_count, last_called_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (server_id, name) DO UPDATE SET
      call_count = excluded.call_count,
      success_count = excluded.success_count,
      last_called_at = excluded.last_called_at
  `);
  withTransaction(db, () => {
    for (const row of rows) {
      const next = row.wouldWrite;
      if (next === null) continue;
      statement.run(
        BUILTIN_SERVER_ID,
        row.name,
        next.callCount,
        next.successCount,
        next.lastCalledAt ?? EPOCH,
      );
    }
  });
}

export function backfill(options: BackfillOptions = {}): BackfillReport {
  const layout = createLayout(options.root);
  if (!existsSync(layout.stateDb)) throw new Error(`state.db not found: ${layout.stateDb}`);
  const eventFiles = listEventFiles(layout.log);
  const apply = options.apply === true;
  // Read-only for dry-run so a review never touches WAL state.
  const db = new DatabaseSync(layout.stateDb, apply ? {} : { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const names = readBuiltinNames(db);
    const current = readCurrentUsage(db);
    const scan = scanEventLines(eventLines(eventFiles), new Set(names));
    const builtinTools = names.map((name) =>
      mergeUsage(name, scan.totals.get(name) ?? EMPTY_USAGE, current.get(name) ?? EMPTY_USAGE),
    );
    const changed = builtinTools.filter((row) => row.wouldWrite !== null).length;
    let backup: string | null = null;
    if (apply && changed > 0) {
      backup = backupDatabase(db, layout.stateDb);
      writeUsage(db, builtinTools);
    }
    return {
      mode: apply ? 'apply' : 'dry-run',
      serverId: BUILTIN_SERVER_ID,
      root: layout.root,
      logDir: layout.log,
      db: layout.stateDb,
      eventFiles,
      scan: scan.stats,
      builtinTools,
      changed,
      backup,
    };
  } finally {
    db.close();
  }
}

function usage(): string {
  return [
    'usage: node server/scripts/backfill-tool-usage.ts [--root <AGENTS_HOME>] [--apply]',
    '',
    'Replays historical tools/call events for __builtin__ and merges them into tool_usage.',
    'Dry-run by default; --apply writes a VACUUM INTO backup next to state.db first.',
    '--root defaults to $AGENTS_HOME or ~/.agents; repl-server paths resolve below it.',
  ].join('\n');
}

/** CLI entry; returns the process exit code so tests can call it directly. */
export function main(argv: readonly string[]): number {
  let root: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--root') {
      const next = argv[index + 1];
      if (next === undefined || next === '') {
        process.stderr.write(`${usage()}\n`);
        return 2;
      }
      root = next;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      return 0;
    } else {
      process.stderr.write(`unknown argument: ${arg}\n${usage()}\n`);
      return 2;
    }
  }
  const report = backfill({ root, apply });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
