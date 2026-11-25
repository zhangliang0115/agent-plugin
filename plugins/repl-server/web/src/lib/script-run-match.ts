/**
 * Matches one `/logs/frames` protocol pair to a script run.
 *
 * `exec` is compared only when a frame carries it; the MCP recorder does not
 * write it onto protocol frames, so the JSON-RPC id is usually the whole key.
 * @module
 */

/** Run identity needed by the matcher; `ScriptRun` is structurally assignable. */
export interface ScriptRunRef {
  requestId: string | null;
  execId: string | null;
}

/** Frame-pair shape needed by the matcher; `RequestFramePair` is assignable. */
export interface ProtocolFrameRef {
  id: string | number | null;
  request?: { readonly [key: string]: unknown } | null;
  response?: { readonly [key: string]: unknown } | null;
}

/** True when the frame pair is the MCP request this run was executed under. */
export function scriptRunMatchesFrame(pair: ProtocolFrameRef, run: ScriptRunRef): boolean {
  if (run.requestId === null || pair.id === null) return false;
  if (String(pair.id) !== run.requestId) return false;
  if (run.execId === null) return true;
  const frameExecs = [pair.request?.['exec'], pair.response?.['exec']].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  return frameExecs.length === 0 || frameExecs.includes(run.execId);
}

/**
 * Picks the frame pair for a run when the same JSON-RPC id was reused.
 *
 * `createdAt` is the run's settlement time, so the request can predate it by the
 * whole duration; the pair whose response timestamp (falling back to the
 * request) is closest to it wins. Unparseable `createdAt` returns the first
 * match; a pair without timestamps only wins when no timed pair is closer.
 */
export function pickRunFrame<Frame extends ProtocolFrameRef>(
  frames: readonly Frame[],
  run: ScriptRunRef,
  createdAt: string | number | null | undefined,
): Frame | null {
  const candidates = frames.filter((pair) => scriptRunMatchesFrame(pair, run));
  const first = candidates[0];
  if (first === undefined) return null;
  const settled = createdAtMs(createdAt);
  if (settled === null) return first;
  let best = first;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const pair of candidates) {
    const ts = frameTimestampMs(pair);
    if (ts === null) continue;
    const delta = Math.abs(ts - settled);
    if (delta < bestDelta) {
      best = pair;
      bestDelta = delta;
    }
  }
  return best;
}

function createdAtMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Response time is the settlement moment; fall back to the request when absent. */
function frameTimestampMs(pair: ProtocolFrameRef): number | null {
  for (const event of [pair.response, pair.request]) {
    const ts = event?.['ts'];
    if (typeof ts !== 'string') continue;
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
