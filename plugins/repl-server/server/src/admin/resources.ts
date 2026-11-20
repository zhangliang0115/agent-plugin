/** Resource sampling for `/admin/api/overview` and the server log.
 *
 * One sample covers the process itself (`process.memoryUsage().rss` and the
 * `process.cpuUsage()` delta) plus every descendant reported by `ps`. Worker
 * threads live inside the process, so their memory and CPU are part of the
 * self values. Child CPU uses `ps` `%cpu`, which is not an interval-instantaneous
 * value; only the self percentage is measured over the sampling interval.
 * @module
 */

import { psResourceRows, type ResourceRow } from '@zhangliang0115/repl-server-core/src/process/tree.ts';

import type { LogFn } from '../log.ts';

export const RESOURCE_INTERVAL_MS = 10_000;
export const RESOURCE_HISTORY_MS = 30 * 60_000;
const LOG_INTERVAL_MS = 60_000;
const PS_WARN_INTERVAL_MS = 60_000;
const BYTES_PER_MB = 1024 * 1024;

export interface ResourceSample {
  ts: number;
  selfRssBytes: number;
  childRssBytes: number;
  childCount: number;
  totalRssBytes: number;
  /** Single-core percentage measured over the interval between samples. */
  selfCpuPercent: number;
  /** Sum of `ps` `%cpu` for descendants. */
  childCpuPercent: number;
  totalCpuPercent: number;
}

export interface ResourceSnapshot {
  current: ResourceSample | null;
  series: ResourceSample[];
  intervalMs: number;
}

export interface ResourceMonitorOptions {
  log: LogFn;
  /** Receives every sample after it enters the in-memory series (JSONL persistence). */
  onSample?: (sample: ResourceSample) => void;
  intervalMs?: number;
  historyMs?: number;
  /** Test seams; production uses the process APIs and a live `ps`. */
  now?: () => number;
  memoryUsage?: () => { rss: number };
  cpuUsage?: () => NodeJS.CpuUsage;
  readRows?: () => ResourceRow[];
}

export interface ResourceMonitor {
  start(): void;
  stop(): void;
  snapshot(): ResourceSnapshot;
}

interface ChildTotals {
  rssBytes: number;
  cpuPercent: number;
  count: number;
}

const EMPTY_CHILDREN: ChildTotals = { rssBytes: 0, cpuPercent: 0, count: 0 };

/** Descendants of `rootPid`, excluding the root; a corrupt ppid cycle is ignored. */
function descendantRows(rows: readonly ResourceRow[], rootPid: number): ResourceRow[] {
  const byParent = new Map<number, ResourceRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings === undefined) byParent.set(row.ppid, [row]);
    else siblings.push(row);
  }

  const seen = new Set<number>([rootPid]);
  const stack: number[] = [rootPid];
  const out: ResourceRow[] = [];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) break;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

function sumChildren(rows: readonly ResourceRow[], rootPid: number): ChildTotals {
  const totals: ChildTotals = { rssBytes: 0, cpuPercent: 0, count: 0 };
  for (const row of descendantRows(rows, rootPid)) {
    totals.rssBytes += row.rssBytes;
    totals.cpuPercent += row.cpuPercent;
    totals.count += 1;
  }
  return totals;
}

function megabytes(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

/** Periodic process-tree sampling; `start()` takes one sample immediately. */
export function createResourceMonitor(options: ResourceMonitorOptions): ResourceMonitor {
  const log = options.log;
  const intervalMs = options.intervalMs ?? RESOURCE_INTERVAL_MS;
  const historyMs = options.historyMs ?? RESOURCE_HISTORY_MS;
  const now = options.now ?? ((): number => Date.now());
  const memoryUsage = options.memoryUsage ?? ((): { rss: number } => process.memoryUsage());
  const cpuUsage = options.cpuUsage ?? ((): NodeJS.CpuUsage => process.cpuUsage());
  const readRows = options.readRows ?? psResourceRows;
  const maxSamples = Math.max(1, Math.ceil(historyMs / intervalMs));

  const series: ResourceSample[] = [];
  let current: ResourceSample | null = null;
  let timer: NodeJS.Timeout | null = null;
  let previousCpu: NodeJS.CpuUsage | null = null;
  let previousTs: number | null = null;
  let lastChildren: ChildTotals | null = null;
  let lastPsWarnAt = 0;
  let lastPersistWarnAt = 0;
  let lastLogAt = 0;

  function sample(): void {
    const ts = now();
    const usage = cpuUsage();
    let selfCpuPercent = 0;
    if (previousCpu !== null && previousTs !== null) {
      const elapsedMs = ts - previousTs;
      const deltaUs =
        usage.user - previousCpu.user + (usage.system - previousCpu.system);
      if (elapsedMs > 0) selfCpuPercent = (deltaUs / 1000 / elapsedMs) * 100;
    }
    previousCpu = usage;
    previousTs = ts;

    let children: ChildTotals;
    try {
      children = sumChildren(readRows(), process.pid);
      lastChildren = children;
    } catch (error) {
      children = lastChildren ?? EMPTY_CHILDREN;
      if (ts - lastPsWarnAt >= PS_WARN_INTERVAL_MS) {
        lastPsWarnAt = ts;
        log(`resources: ps snapshot failed, reusing previous child values: ${(error as Error).message}`, {
          level: 'warn',
          scope: 'resource',
        });
      }
    }

    const selfRssBytes = memoryUsage().rss;
    const next: ResourceSample = {
      ts,
      selfRssBytes,
      childRssBytes: children.rssBytes,
      childCount: children.count,
      totalRssBytes: selfRssBytes + children.rssBytes,
      selfCpuPercent,
      childCpuPercent: children.cpuPercent,
      totalCpuPercent: selfCpuPercent + children.cpuPercent,
    };
    current = next;
    series.push(next);
    if (series.length > maxSamples) series.shift();

    try {
      options.onSample?.(next);
    } catch (error) {
      if (ts - lastPersistWarnAt >= PS_WARN_INTERVAL_MS) {
        lastPersistWarnAt = ts;
        log(`resources: sample persistence failed: ${(error as Error).message}`, {
          level: 'warn',
          scope: 'resource',
        });
      }
    }

    if (ts - lastLogAt >= LOG_INTERVAL_MS) {
      lastLogAt = ts;
      log(
        `resources rss=${megabytes(next.totalRssBytes)}MB self=${megabytes(next.selfRssBytes)}MB ` +
          `children=${megabytes(next.childRssBytes)}MB processes=${next.childCount} ` +
          `cpu=${next.totalCpuPercent.toFixed(1)}% self=${next.selfCpuPercent.toFixed(1)}% ` +
          `children=${next.childCpuPercent.toFixed(1)}%`,
        { scope: 'resource' },
      );
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      sample();
      timer = setInterval(sample, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    snapshot(): ResourceSnapshot {
      return { current, series: [...series], intervalMs };
    },
  };
}
