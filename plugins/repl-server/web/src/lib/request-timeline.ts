/** Pure layout for the request process view: request/response markers plus event bars. */
import { eventLabel, eventSubject } from './audit-labels.ts';
import { formatDuration, formatTimestamp } from './format.ts';

export interface TimelineFrameLike {
  ts?: unknown;
  method?: unknown;
  [key: string]: unknown;
}

export interface TimelineEventLike {
  ts?: unknown;
  event?: unknown;
  ok?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface TimelineItem {
  key: string;
  label: string;
  detail: string;
  kind: 'marker' | 'bar';
  start: number;
  end: number;
  color: string;
}

export interface RequestTimeline {
  from: number;
  to: number;
  items: TimelineItem[];
}

/** Parses an ISO timestamp; `null` when the value cannot be placed on the axis. */
export function timelineTime(ts: unknown): number | null {
  if (typeof ts !== 'string' || ts === '') return null;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Duration carried by one event, whichever field the event type uses. */
function durationOf(event: TimelineEventLike): number {
  for (const key of ['durMs', 'ms', 'elapsedMs']) {
    const value = event[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function colorOf(event: TimelineEventLike): string {
  switch (event.event) {
    case 'eval_start':
    case 'eval_end':
      return '#722ed1';
    case 'tool_result':
    case 'tool_call':
      return event.ok === false ? '#ff4d4f' : '#13c2c2';
    case 'tool_denied':
      return '#faad14';
    case 'ai_run':
      return '#2f54eb';
    default:
      return '#8c8c8c';
  }
}

function errorText(event: TimelineEventLike): string {
  const error = event['error'];
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

/**
 * One row per request marker, event and response marker, positioned on a shared
 * axis. Events without a parseable `ts` are skipped; `null` means nothing to draw.
 */
export function buildRequestTimeline(
  request: TimelineFrameLike | null,
  response: TimelineFrameLike | null,
  events: readonly TimelineEventLike[],
): RequestTimeline | null {
  const items: TimelineItem[] = [];
  const requestTs = timelineTime(request?.ts);
  if (requestTs !== null) {
    const method = typeof request?.method === 'string' ? request.method : 'request';
    items.push({
      key: 'request',
      label: '请求',
      detail: `${method} · ${formatTimestamp(requestTs)}`,
      kind: 'marker',
      start: requestTs,
      end: requestTs,
      color: '#1677ff',
    });
  }
  events.forEach((event, index) => {
    const ts = timelineTime(event.ts);
    if (ts === null) return;
    const duration = durationOf(event);
    const label = eventLabel(event.event);
    const parts = [eventSubject(event)];
    parts.push(formatTimestamp(ts));
    if (duration > 0) parts.push(`用时 ${formatDuration(duration)}`);
    const error = errorText(event);
    if (error !== '') parts.push(error);
    items.push({
      key: `event-${index}-${String(event.event ?? '')}`,
      label,
      detail: parts.join(' · '),
      kind: duration > 0 ? 'bar' : 'marker',
      start: ts - duration,
      end: ts,
      color: colorOf(event),
    });
  });
  const responseTs = timelineTime(response?.ts);
  if (responseTs !== null) {
    items.push({
      key: 'response',
      label: '响应',
      detail: `响应 · ${formatTimestamp(responseTs)}`,
      kind: 'marker',
      start: responseTs,
      end: responseTs,
      color: response?.['ok'] === false ? '#ff4d4f' : '#52c41a',
    });
  }
  if (items.length === 0) return null;
  items.sort((left, right) => left.start - right.start || left.end - right.end);
  const from = Math.min(...items.map((item) => item.start));
  const to = Math.max(...items.map((item) => item.end));
  return { from, to: to > from ? to : from + 1, items };
}
