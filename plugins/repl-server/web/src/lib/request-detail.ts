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
