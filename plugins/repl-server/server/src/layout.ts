/**
 * Single source of truth for every path below the repl-server data root.
 *
 * The root is split into four domains by "what happens if I delete it":
 * `run/` cannot be deleted (state, secrets, sessions), `log/` is deleted whole
 * UTC days at a time, `cache/` is rebuildable, `backup/` keeps the last two
 * migration archives. Nothing outside this module may join a data path by hand.
 *
 * @module
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveLogRef } from '@zhangliang0115/repl-server-core';

export interface DataLayout {
  /** `<AGENTS_HOME>/repl-server`. */
  root: string;
  /** Runtime state: deleting it loses bindings, tokens and recovery data. */
  run: string;
  /** Append-only history: events, metrics, boot ledgers and payload blobs. */
  log: string;
  /** Rebuildable artifacts. */
  cache: string;
  /** Migration archives, at most two kept. */
  backup: string;
  stateDb: string;
  /** Instance lock; the same file must be acquired and released. */
  lockPath: string;
  pidFile: string;
  sessions: string;
  /** Boot sweep ledgers (`orphans-*.json`, `survivors.json`). */
  boots: string;
  payloadRoot: string;
  eventsFile(date: string): string;
  metricsFile(date: string): string;
  payloadDay(date: string): string;
  payloadFrames(date: string): string;
  payloadExec(date: string, execId: string): string;
}

/** Daily stream prefixes. `AuditWriter` and the `*File` helpers must agree. */
export const EVENTS_PREFIX = 'events';
export const METRICS_PREFIX = 'metrics';

/**
 * Builds the layout for `$AGENTS_HOME` (default `~/.agents`). The optional
 * argument lets tests point at a temp home without touching `process.env`.
 */
export function createLayout(agentsHome?: string): DataLayout {
  const home = agentsHome !== undefined && agentsHome.trim() !== ''
    ? agentsHome
    : process.env['AGENTS_HOME'] !== undefined && process.env['AGENTS_HOME']?.trim() !== ''
      ? (process.env['AGENTS_HOME'] as string)
      : join(homedir(), '.agents');
  const root = join(resolve(home), 'repl-server');
  const run = join(root, 'run');
  const log = join(root, 'log');
  const cache = join(root, 'cache');
  const backup = join(root, 'backup');
  const payloadRoot = join(log, 'payload');

  return {
    root,
    run,
    log,
    cache,
    backup,
    stateDb: join(run, 'state.db'),
    lockPath: join(run, 'state.db.lock'),
    pidFile: join(run, 'server.pid'),
    sessions: join(run, 'sessions'),
    boots: join(log, 'boots'),
    payloadRoot,
    eventsFile: (date) => join(log, `${EVENTS_PREFIX}-${date}.jsonl`),
    metricsFile: (date) => join(log, `${METRICS_PREFIX}-${date}.jsonl`),
    payloadDay: (date) => join(payloadRoot, date),
    payloadFrames: (date) => join(payloadRoot, date, 'frames'),
    payloadExec: (date, execId) => join(payloadRoot, date, execId),
  };
}

/** Directory names written by versions before the four-domain layout. */
export const LEGACY_ENTRIES = ['audit', 'metrics', 'ledger', 'repl.db'] as const;

/**
 * Runtime state that pre-layout builds kept at the root. Unlike the legacy
 * history entries, these are *live*: starting with them still sitting at the
 * root would silently create an empty `run/state.db` and lose every binding,
 * token and secret. Must stay in sync with `RUNTIME_ENTRIES` in
 * `server/scripts/layout-switch.mjs`.
 */
export const LEGACY_RUNTIME_ENTRIES = [
  'state.json',
  'pool.json',
  'ai-runs.json',
  'state.db',
  'state.db-wal',
  'state.db-shm',
  'state.db.lock',
  'mcp-token',
  'admin-token',
  'secrets.json',
  'sessions',
  'official-workspace',
] as const;

/**
 * Legacy siblings still sitting in the data root. The server refuses to start
 * while any remain: writing to `log/` while readers might still look at
 * `audit/` is the one failure that produces silent empty results.
 */
export function legacyLeftovers(
  layout: DataLayout,
  exists: (path: string) => boolean = existsSync,
): string[] {
  return LEGACY_ENTRIES.filter((name) => exists(join(layout.root, name)));
}

/**
 * Runtime state still at the root before the switch. Returns `[]` once
 * `run/state.db` exists, because at that point a root-level stray is cosmetic
 * (an old build rewriting `pool.json`, say) rather than a data-loss risk.
 */
export function legacyRuntimeLeftovers(
  layout: DataLayout,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (exists(layout.stateDb)) return [];
  return LEGACY_RUNTIME_ENTRIES.filter((name) => exists(join(layout.root, name)));
}

/** Re-exported so callers keep one import for "where does this data live". */
export { resolveLogRef };

