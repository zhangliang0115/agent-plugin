/** Pure helpers for the request-detail drawer: frame recognition and time windows. */

export interface EventTimeWindow {
  from?: string;
  to?: string;
}

/** True for audit-hub frames that represent one protocol direction. */
export function isProtocolFrame(value: unknown): boolean {
  if (typeof value === 'object' && value !== null) {
    const event = (value as { event?: unknown }).event;
    return event === 'proto_in' || event === 'proto_out';
  }
  return false;
}

/** Reads `<repl-output async="true">` so the event window keeps its tail open. */
export function isAsyncResponse(response: unknown): boolean {
  const text = responseText(response);
  return text !== null && /<repl-output[^>]*\basync="true"/u.test(text);
}

export interface AuditEventLike {
  event?: unknown;
  requestId?: unknown;
  runId?: unknown;
}

/**
 * `runId`s of the evals started by one JSON-RPC request. `eval_start` is emitted
 * while handling `tools/call` and carries that request's id; every tool event of
 * the eval reuses the same `runId`, so this is an exact link, not a time window.
 */
export function requestRunIds(
  events: readonly AuditEventLike[],
  requestId: string | number | null,
): string[] {
  if (requestId === null) return [];
  const wanted = String(requestId);
  const runIds: string[] = [];
  for (const event of events) {
    if (event.event !== 'eval_start') continue;
    if (event.requestId === undefined || String(event.requestId) !== wanted) continue;
    const runId = event.runId;
    if (typeof runId === 'string' && runId !== '' && !runIds.includes(runId)) runIds.push(runId);
  }
  return runIds;
}

/** Pads a request/response timestamp pair so the event query covers both boundaries. */
export function eventWindow(
  requestTs: unknown,
  responseTs: unknown,
  openEnded = false,
): EventTimeWindow {
  const start = requestTs ?? responseTs;
  const end = responseTs ?? requestTs;
  const from = shiftIso(start, -2_000);
  const to = openEnded ? undefined : shiftIso(end, 2_000);
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function responseText(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null;
  const result = (response as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return null;
}

function shiftIso(value: unknown, deltaMs: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time + deltaMs).toISOString();
}
