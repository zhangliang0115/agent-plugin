/**
 * Conservative cleanup of `run/sessions/` (`09 §六`).
 *
 * These directories are live state, not logs: `keeper.mjs` writes
 * `sessions/<id>/serve.json` before MCP traffic starts, and the sweep reads it
 * back to kill orphaned serve groups. So this module never deletes on a guess:
 * a directory goes away only when BOTH (a) no live pid is recorded in a valid
 * serve record and (b) nothing inside it has been touched for a full day.
 * A PID that merely *might* be alive is kept (false positives are harmless,
 * a false deletion would break a running serve).
 *
 * `process.kill(pid, 0)` needs no `ps`, which is blocked in some sandboxes;
 * the staleness gate is the second, independent safety net.
 */
import { readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import type { LogFn } from '../log.ts';

/** A session directory younger than this is never considered stale. */
export const SESSION_STALE_MS = 24 * 60 * 60 * 1000;
/** Keep it on the same cadence as the log retention sweep. */
export const SESSION_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface SessionPruneOptions {
  sessionsDir: string;
  log?: LogFn;
  now?: () => number;
  staleMs?: number;
  intervalMs?: number;
  /** Overridable for tests; the default asks the OS without spawning a process. */
  pidAlive?: (pid: number) => boolean;
  onPrune?: (info: SessionPruneStats) => void;
}

export interface SessionPruneStats {
  lastRunAt: number | null;
  error: string | null;
  removedDirs: number;
  keptDirs: number;
  /** Kept because a valid serve record named a live pid. */
  keptLivePid: number;
  /** Kept because it was touched within the staleness window. */
  keptFresh: number;
  /** Kept because the serve record exists but cannot be parsed. */
  keptUnreadable: number;
}

export interface SessionPruner {
  runOnce(): Promise<SessionPruneStats>;
  start(): void;
  stop(): void;
  stats(): SessionPruneStats;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user. Keep it.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const EMPTY: SessionPruneStats = {
  lastRunAt: null,
  error: null,
  removedDirs: 0,
  keptDirs: 0,
  keptLivePid: 0,
  keptFresh: 0,
  keptUnreadable: 0,
};

/** Newest mtime of a directory and everything directly inside it. */
async function latestTouch(dir: string): Promise<number> {
  let latest = (await stat(dir)).mtimeMs;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const info = await stat(join(dir, entry.name));
    if (info.mtimeMs > latest) latest = info.mtimeMs;
  }
  return latest;
}

/** `null` = no record; `undefined` = unreadable/corrupt; number = serve pid. */
async function servePid(dir: string): Promise<number | null | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, 'serve.json'), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
  try {
    const record = JSON.parse(text) as { pid?: unknown };
    return typeof record.pid === 'number' && record.pid > 0 ? record.pid : undefined;
  } catch {
    return undefined;
  }
}

export function createSessionPruner(options: SessionPruneOptions): SessionPruner {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? SESSION_STALE_MS;
  const intervalMs = options.intervalMs ?? SESSION_PRUNE_INTERVAL_MS;
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const log = options.log ?? (() => undefined);
  let state: SessionPruneStats = { ...EMPTY };
  let timer: ReturnType<typeof setInterval> | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function sweep(): Promise<SessionPruneStats> {
    const at = now();
    const next: SessionPruneStats = { ...EMPTY, lastRunAt: at };
    let entries;
    try {
      entries = await readdir(options.sessionsDir, { withFileTypes: true });
    } catch (error) {
      // A missing directory is the normal fresh-install case, not an error.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        next.error = (error as Error).message;
        log(`session prune: cannot list ${options.sessionsDir}: ${next.error}`, { level: 'warn', scope: 'serve' });
      }
      return next;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(options.sessionsDir, entry.name);
      try {
        const pid = await servePid(dir);
        if (pid === undefined) {
          next.keptUnreadable += 1;
          next.keptDirs += 1;
          continue;
        }
        if (pid !== null && pidAlive(pid)) {
          next.keptLivePid += 1;
          next.keptDirs += 1;
          continue;
        }
        if (at - (await latestTouch(dir)) < staleMs) {
          next.keptFresh += 1;
          next.keptDirs += 1;
          continue;
        }
        await rm(dir, { recursive: true, force: true });
        next.removedDirs += 1;
      } catch (error) {
        log(`session prune: cannot remove ${dir}: ${String(error)}`, { level: 'warn', scope: 'serve' });
        next.keptDirs += 1;
      }
    }
    if (next.removedDirs > 0) {
      log(`session prune: removed ${String(next.removedDirs)} stale dirs, kept ${String(next.keptDirs)}`, {
        scope: 'serve',
      });
    }
    try {
      options.onPrune?.(next);
    } catch (error) {
      log(`session prune: onPrune failed: ${String(error)}`, { level: 'warn', scope: 'serve' });
    }
    return next;
  }

  async function guardedSweep(): Promise<SessionPruneStats> {
    try {
      state = await sweep();
    } catch (error) {
      state = { ...state, lastRunAt: now(), error: (error as Error).message };
      log(`session prune: sweep failed: ${state.error}`, { level: 'warn', scope: 'serve' });
    }
    return state;
  }

  function runOnce(): Promise<SessionPruneStats> {
    // Runs are serialized: a timer tick must not race the boot sweep.
    const run = queue.then(guardedSweep, guardedSweep);
    queue = run.then(() => undefined);
    return run;
  }

  return {
    runOnce,
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    stats() {
      return state;
    },
  };
}

/** Test helper: backdate a directory (and its files) without waiting a day. */
export async function backdate(dir: string, at: number): Promise<void> {
  const when = new Date(at);
  await utimes(dir, when, when);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    await utimes(join(dir, entry.name), when, when);
  }
}
