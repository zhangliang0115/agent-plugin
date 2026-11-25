/**
 * One retention budget for the whole `log/` domain.
 *
 * The daily writers each prune their own prefix, but only when a stream is
 * opened or rolled over, so a long-lived process could hold a day open for
 * hours and never enforce the budget; the `payload/` tree was never pruned at
 * all. This service is the authority: it deletes whole UTC days (JSONL files
 * and their `payload/<date>/` directory together), then trims the oldest
 * remaining day until `log/` fits the byte budget. Today is never deleted.
 *
 * @module
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { LogFn } from '../log.ts';

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Files that carry one UTC day in their name. */
const DATED_FILE = /^(?:events|metrics)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Budget for the whole `log/` domain: 90 days or 2 GiB, whichever is reached
 * first. The byte cap trims the oldest in-window days when the days alone would
 * exceed it (`09 §一`).
 */
export const LOG_RETENTION_DAYS = 90;
export const LOG_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** Warn once a day at this share of the budget, before the sweep has to delete. */
export const LOG_HIGH_WATER_RATIO = 0.8;

/** Boot reports kept regardless of age; they are tiny but unbounded in count. */
export const BOOTS_KEEP = 50;

export interface RetentionOptions {
  /** The `log/` directory. Nothing outside it is ever touched. */
  logDir: string;
  log?: LogFn;
  /** Days kept; older days are deleted whole. Default 90. */
  retentionDays?: number;
  /** Budget for everything below `log/`. Default 2 GiB. */
  maxTotalBytes?: number;
  /** Background sweep interval. Default 6 hours. */
  intervalMs?: number;
  now?: () => number;
  /**
   * Called at most once per UTC day when `log/` crosses the high-water mark.
   * The sweep itself runs every 6 hours, so this fires *before* the budget
   * forces deletions rather than after.
   */
  onHighWater?: (info: { totalBytes: number; limitBytes: number; ratio: number }) => void;
}

export interface RetentionStats {
  /** Epoch ms of the last completed sweep, or null before the first one. */
  lastRunAt: number | null;
  /** Last error message; cleared by the next successful sweep. */
  error: string | null;
  /** Days removed by the last sweep. */
  removedDays: number;
  /** Files removed by the last sweep, payload blobs included. */
  removedFiles: number;
  /** Bytes freed by the last sweep. */
  freedBytes: number;
  /** `log/` size after the last sweep. */
  totalBytes: number;
}

export interface Retention {
  /** Sweeps now. Safe to call concurrently; runs are serialized. */
  runOnce(): Promise<RetentionStats>;
  /** Starts the background timer (idempotent). */
  start(): void;
  /** Stops the background timer. */
  stop(): void;
  stats(): RetentionStats;
}

function utcDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Sizes every entry below `dir`, tolerating entries that vanish mid-walk. */
async function treeSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      try {
        const info = await stat(path);
        bytes += info.size;
        files += 1;
      } catch {
        // Removed between readdir and stat.
      }
    }
  }
  return { bytes, files };
}

export function createRetention(options: RetentionOptions): Retention {
  const retentionDays = options.retentionDays ?? LOG_RETENTION_DAYS;
  const maxTotalBytes = options.maxTotalBytes ?? LOG_MAX_TOTAL_BYTES;
  const intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => undefined);

  let state: RetentionStats = {
    lastRunAt: null,
    error: null,
    removedDays: 0,
    removedFiles: 0,
    freedBytes: 0,
    totalBytes: 0,
  };
  let queue: Promise<RetentionStats> = Promise.resolve(state);
  let timer: NodeJS.Timeout | undefined;
  /** `payload_high_water` is a daily nudge, not a per-sweep drumbeat. */
  let warnedDay: string | null = null;

  /** UTC days present under `log/`, from file names and `payload/` folders. */
  async function days(): Promise<string[]> {
    const found = new Set<string>();
    let names;
    try {
      names = await readdir(options.logDir);
    } catch {
      return [];
    }
    for (const name of names) {
      const matched = DATED_FILE.exec(name);
      if (matched?.[1] !== undefined) found.add(matched[1]);
    }
    try {
      for (const name of await readdir(join(options.logDir, 'payload'))) {
        if (DATE.test(name)) found.add(name);
      }
    } catch {
      // No payload tree yet.
    }
    return [...found].sort();
  }

  async function dropDay(date: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    // Payload first: a day directory can be much larger than its JSONL.
    const payloadDay = join(options.logDir, 'payload', date);
    const payloadSize = await treeSize(payloadDay);
    try {
      await rm(payloadDay, { recursive: true, force: true });
      files += payloadSize.files;
      bytes += payloadSize.bytes;
    } catch (error) {
      log(`retention: cannot remove ${payloadDay}: ${String(error)}`, { level: 'warn', scope: 'audit' });
    }
    for (const prefix of ['events', 'metrics']) {
      const path = join(options.logDir, `${prefix}-${date}.jsonl`);
      try {
        const info = await stat(path);
        await rm(path, { force: true });
        files += 1;
        bytes += info.size;
      } catch {
        // Already gone, or never existed.
      }
    }
    return { files, bytes };
  }

  /**
   * Trims `boots/` reports. They carry no date in the name, so age comes from
   * `mtime`; a report survives only while it is within the newest `BOOTS_KEEP`
   * and not older than the retention cutoff.
   */
  async function pruneBoots(at: number): Promise<{ files: number; bytes: number }> {
    const dir = join(options.logDir, 'boots');
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return { files: 0, bytes: 0 };
    }
    const reports: Array<{ path: string; bytes: number; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      try {
        const info = await stat(path);
        reports.push({ path, bytes: info.size, mtime: info.mtimeMs });
      } catch {
        // Removed between readdir and stat.
      }
    }
    reports.sort((left, right) => right.mtime - left.mtime);
    const cutoff = at - retentionDays * DAY_MS;
    let files = 0;
    let bytes = 0;
    for (const [index, report] of reports.entries()) {
      if (index < BOOTS_KEEP && report.mtime >= cutoff) continue;
      try {
        await rm(report.path, { force: true });
        files += 1;
        bytes += report.bytes;
      } catch (error) {
        log(`retention: cannot remove ${report.path}: ${String(error)}`, { level: 'warn', scope: 'audit' });
      }
    }
    return { files, bytes };
  }

  async function sweep(): Promise<RetentionStats> {
    const at = now();
    const today = utcDate(at);
    const cutoff = utcDate(at - retentionDays * DAY_MS);
    const present = await days();
    let removedDays = 0;
    let removedFiles = 0;
    let freedBytes = 0;

    const boots = await pruneBoots(at);
    removedFiles += boots.files;
    freedBytes += boots.bytes;

    for (const date of present) {
      if (date >= cutoff || date === today) continue;
      const dropped = await dropDay(date);
      removedDays += 1;
      removedFiles += dropped.files;
      freedBytes += dropped.bytes;
    }

    let remaining = await treeSize(options.logDir);
    if (remaining.bytes > maxTotalBytes) {
      // The day cutoff is not enough: trim the oldest days it kept, never
      // today, until the budget fits or nothing older is left.
      const trimmable = present.filter((date) => date !== today && date >= cutoff && present.includes(date));
      for (const date of trimmable) {
        if (remaining.bytes <= maxTotalBytes) break;
        const dropped = await dropDay(date);
        removedDays += 1;
        removedFiles += dropped.files;
        freedBytes += dropped.bytes;
        remaining = await treeSize(options.logDir);
      }
    }

    const ratio = maxTotalBytes > 0 ? remaining.bytes / maxTotalBytes : 0;
    if (ratio >= LOG_HIGH_WATER_RATIO && warnedDay !== today) {
      warnedDay = today;
      const megabytes = Math.round(remaining.bytes / (1024 * 1024));
      const limit = Math.round(maxTotalBytes / (1024 * 1024));
      log(
        `log/ is at ${megabytes} MB of ${limit} MB (${Math.round(ratio * 100)}%): retention will start deleting days`,
        { level: 'warn', scope: 'audit' },
      );
      try {
        options.onHighWater?.({ totalBytes: remaining.bytes, limitBytes: maxTotalBytes, ratio });
      } catch (error) {
        log(`retention: high-water handler failed: ${String(error)}`, { level: 'warn', scope: 'audit' });
      }
    }

    state = {
      lastRunAt: at,
      error: null,
      removedDays,
      removedFiles,
      freedBytes,
      totalBytes: remaining.bytes,
    };
    return state;
  }

  return {
    runOnce() {
      queue = queue.then(
        () => sweep(),
        () => sweep(),
      ).catch((error: unknown) => {
        state = {
          ...state,
          lastRunAt: now(),
          error: error instanceof Error ? error.message : String(error),
        };
        log(`retention failed: ${state.error ?? 'unknown'}`, { level: 'error', scope: 'audit' });
        return state;
      });
      return queue;
    },
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void this.runOnce();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
    stats() {
      return state;
    },
  };
}
