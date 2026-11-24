/**
 * Tool usage aggregates and model-payload sizes shown on the admin Tools page.
 *
 * `GET /servers/:id/tools` returns `callCount` / `successCount` / `successRate` /
 * `lastCalledAt` / `modelBytes`; older backends omit them, so every reader falls
 * back to `0` / `null` instead of throwing.
 * @module
 */

import { formatNumber, formatPercent } from './format.ts';
import { successRateFraction } from './script-api.ts';

/** UTF-8 JSON byte sizes of what the model can see for one tool (not token counts). */
export interface ToolModelBytes {
  definition: number;
  searchItem: number;
  schema: number;
  description: number;
}

export interface ToolStats {
  callCount: number;
  successCount: number;
  successRate: number | null;
  lastCalledAt: string | null;
  modelBytes: ToolModelBytes;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Reads the usage fields with zero/null defaults, safe on older backend payloads. */
export function toolStatsFrom(value: unknown): ToolStats {
  const row = asRecord(value) ?? {};
  const bytes = asRecord(row['modelBytes']) ?? {};
  const rate = row['successRate'];
  return {
    callCount: asCount(row['callCount']),
    successCount: asCount(row['successCount']),
    successRate: typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : null,
    lastCalledAt: asText(row['lastCalledAt']),
    modelBytes: {
      definition: asCount(bytes['definition']),
      searchItem: asCount(bytes['searchItem']),
      schema: asCount(bytes['schema']),
      description: asCount(bytes['description']),
    },
  };
}

/** Success rate as a `0..1` fraction; falls back to `successCount / callCount`. */
export function toolSuccessRate(
  stats: Pick<ToolStats, 'callCount' | 'successCount' | 'successRate'>,
): number | null {
  const rate = successRateFraction(stats.successRate);
  if (rate !== null) return rate;
  return stats.callCount > 0 ? stats.successCount / stats.callCount : null;
}

/** Failed calls (`callCount - successCount`), clamped so bad input stays readable. */
function toolFailedCount(stats: Pick<ToolStats, 'callCount' | 'successCount'>): number {
  return Math.max(0, stats.callCount - stats.successCount);
}

/** `N 次 · 成功 x% · 失败 n`; `—` when the tool has never been called. */
export function toolUsageText(
  stats: Pick<ToolStats, 'callCount' | 'successCount' | 'successRate'>,
): string {
  if (stats.callCount <= 0) return '—';
  const rate = toolSuccessRate(stats);
  return `${formatNumber(stats.callCount)} 次 · 成功 ${
    rate === null ? '—' : formatPercent(rate)
  } · 失败 ${formatNumber(toolFailedCount(stats))}`;
}
