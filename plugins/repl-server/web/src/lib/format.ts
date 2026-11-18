/** Pure formatting helpers shared by the admin pages (no DOM access).
 *
 * Times are stored as UTC and rendered in the browser's local timezone; callers that
 * show a hover title should use the raw value. Durations use the compact forms from the
 * audit tables (`12ms`, `1.4s`, `3m 5s`). Tones map to the fixed semantic colors in
 * `styles.css`: success green, failure red, queue yellow, slow orange.
 * @module
 */

export type Tone = 'ok' | 'error' | 'queue' | 'slow' | 'info' | 'neutral';

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const numberFormat = new Intl.NumberFormat();

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** Parses ISO timestamps and epoch milliseconds; invalid input yields `null`. */
export function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Local date and time, with seconds; `—` for missing/invalid values. */
export function formatTimestamp(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = toDate(value);
  return date === null ? '—' : dateTimeFormat.format(date);
}

/** Local time of day, with seconds. */
export function formatTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = toDate(value);
  return date === null ? '—' : timeFormat.format(date);
}

/** Relative time for recent events; older values fall back to {@link formatTimestamp}. */
export function formatRelativeTime(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  if (value === null || value === undefined) return '—';
  const date = toDate(value);
  if (date === null) return '—';
  const delta = now - date.getTime();
  if (delta < 0) return formatTimestamp(date);
  if (delta < 10_000) return '刚刚';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s 前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m 前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h 前`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d 前`;
  return formatTimestamp(date);
}

/** Compact duration: `12ms`, `1.4s`, `3m 5s`, `2h 10m`; `—` for invalid input. */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Byte size with one decimal below 100 units: `512 B`, `4.2 KB`, `12 MB`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex] ?? 'TB';
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

/** Grouped integer or decimal; `—` for missing values. */
export function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return numberFormat.format(value);
}

/** Ratio in `0..1` rendered as a percentage; `—` for missing values. */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** Shortens long ids in dense tables; callers keep the full value in a title or copy action. */
export function formatId(id: string | null | undefined, maxLength = 14): string {
  if (id === null || id === undefined || id === '') return '—';
  if (maxLength <= 1 || id.length <= maxLength) return id;
  return `${id.slice(0, maxLength - 1)}…`;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text before it is placed into an HTML string; prefer `textContent` when possible. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** Pretty JSON with a string fallback for cyclic values. */
export function formatJson(value: unknown, space = 2): string {
  try {
    const text = JSON.stringify(value, null, space);
    return text ?? String(value);
  } catch {
    return String(value);
  }
}

/** Maps a status word to the fixed semantic color. */
export function statusTone(status: string | boolean | null | undefined): Tone {
  if (typeof status === 'boolean') return status ? 'ok' : 'error';
  switch ((status ?? '').toLowerCase()) {
    case 'ok':
    case 'completed':
    case 'success':
    case 'ready':
    case 'connected':
      return 'ok';
    case 'error':
    case 'failed':
    case 'timeout':
    case 'cancelled':
    case 'disconnected':
      return 'error';
    case 'queued':
    case 'waiting':
    case 'input_required':
      return 'queue';
    case 'working':
    case 'running':
    case 'reconnecting':
      return 'info';
    case 'slow':
      return 'slow';
    default:
      return 'neutral';
  }
}

/** Elapsed time tone: at or above `slowMs` is the slow (orange) tier. */
export function durationTone(ms: number | null | undefined, slowMs = 1000): Tone {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'neutral';
  return ms >= slowMs ? 'slow' : 'ok';
}
