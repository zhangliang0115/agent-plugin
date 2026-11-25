/**
 * Defensive reader for `POST /tools/:serverId/:name/test`.
 *
 * Success and tool-level failure both arrive as HTTP 200:
 * `{ ok: true, result, durationMs, testedAt, resultBytes, truncated? }` or
 * `{ ok: false, error: { code, message }, durationMs, testedAt }`.
 * Malformed payloads return `null` so the page shows an error instead of crashing.
 * @module
 */

export interface ToolTestFailure {
  code: string;
  message: string;
}

export interface ToolTestResult {
  ok: boolean;
  /** Tool output; absent on failure. */
  result: unknown;
  /** Text preview sent instead of `result` when the server truncated it. */
  resultPreview: string | null;
  error: ToolTestFailure | null;
  durationMs: number | null;
  testedAt: string | null;
  resultBytes: number | null;
  truncated: boolean;
}

export function toolTestResultFrom(payload: unknown): ToolTestResult | null {
  const row = asRecord(payload);
  if (row === null || typeof row['ok'] !== 'boolean') return null;
  const errorRow = asRecord(row['error']);
  return {
    ok: row['ok'],
    result: row['result'],
    resultPreview: asText(row['resultPreview']),
    error:
      errorRow === null
        ? null
        : {
            code: asText(errorRow['code']) ?? 'UNKNOWN',
            message: asText(errorRow['message']) ?? '工具执行失败',
          },
    durationMs: asCount(row['durationMs']),
    testedAt: asText(row['testedAt']),
    resultBytes: asCount(row['resultBytes']),
    truncated: row['truncated'] === true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
