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
  evalTaskId?: unknown;
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

/**
 * Exact identifiers of the work one request started.
 *
 * `runId` covers sync evals and everything they touch. `evalTaskId` is the only
 * link an async dispatch has: `async_dispatch` itself carries no `runId`, so
 * without it the background part of the eval (task settle, `task_cancel`) is
 * unreachable from the request row.
 */
export interface RequestDetailKeys {
  runIds: string[];
  taskIds: string[];
}

export function requestDetailKeys(
  events: readonly AuditEventLike[],
  requestId: string | number | null,
): RequestDetailKeys {
  if (requestId === null) return { runIds: [], taskIds: [] };
  const wanted = String(requestId);
  const runIds: string[] = [];
  const taskIds: string[] = [];
  for (const event of events) {
    if (event.requestId === undefined || String(event.requestId) !== wanted) continue;
    if (event.event === 'eval_start') {
      const runId = event.runId;
      if (typeof runId === 'string' && runId !== '' && !runIds.includes(runId)) runIds.push(runId);
      continue;
    }
    if (event.event === 'async_dispatch') {
      const taskId = event.evalTaskId;
      if (typeof taskId === 'string' && taskId !== '' && !taskIds.includes(taskId)) taskIds.push(taskId);
    }
  }
  return { runIds, taskIds };
}

/** True when one live audit frame belongs to the detail panel that is open. */
export function matchesDetailKeys(value: unknown, keys: RequestDetailKeys): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  const runId = frame['runId'];
  if (typeof runId === 'string' && keys.runIds.includes(runId)) return true;
  const taskId = frame['evalTaskId'];
  if (typeof taskId === 'string' && keys.taskIds.includes(taskId)) return true;
  const plainTask = frame['taskId'];
  return typeof plainTask === 'string' && keys.taskIds.includes(plainTask);
}

/** Pads a request/response timestamp pair so the event query covers both boundaries. */export function eventWindow(
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

export interface ToolCallOutcome {
  ok: boolean;
  /** Leading error code, e.g. `CAPACITY_EXCEEDED`, when the text looks like one. */
  code?: string;
  /** Full error text for the tooltip. */
  message?: string;
}

/**
 * Result of one `tools/call`. A JSON-RPC success still carries `isError: true`
 * for execution failures (quota, unknown tool, script errors), which is the
 * state Kiro shows as a failed call; the protocol status alone cannot tell.
 */
export function toolCallOutcome(response: unknown): ToolCallOutcome | null {
  if (typeof response !== 'object' || response === null) return null;
  if ((response as { error?: unknown }).error !== undefined) return null;
  const result = (response as { result?: unknown }).result;
  // An externalised body leaves only `resultIsError` on the row.
  const raw = typeof result === 'object' && result !== null
    ? (result as { isError?: unknown }).isError
    : (response as { resultIsError?: unknown }).resultIsError;
  if (typeof raw !== 'boolean') return null;
  if (!raw) return { ok: true };
  // The error text lives in the externalised body, so it may be absent.
  return { ok: false, ...toolErrorDetail(responseText(response) ?? '') };
}

function toolErrorDetail(text: string): Pick<ToolCallOutcome, 'code' | 'message'> {
  const envelope = /<error>([\s\S]*?)<\/error>/u.exec(text);
  const raw = (envelope?.[1] ?? text).trim();
  if (raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown } };
    if (typeof parsed.error?.code === 'string') {
      return { code: parsed.error.code, message: raw };
    }
  } catch {
    // Not JSON: `run_script` failures use the `<repl-output><error>` envelope.
  }
  const head = raw.split('\n')[0]?.split(':')[0]?.trim() ?? '';
  const code = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(head) && head.length <= 48 ? head : undefined;
  return code === undefined ? { message: raw } : { code, message: raw };
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
