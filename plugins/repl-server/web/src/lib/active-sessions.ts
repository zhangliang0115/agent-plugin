/** Which MCP transport sessions count as active on the Clients page. */

/** Fallback when `GET /clients` omits `activeWindowMs`; keep in sync with the server's 15 minutes. */
export const ACTIVE_SESSION_WINDOW_MS = 15 * 60_000;

export interface SessionTimestamps {
  connectedAt?: string;
  lastRequestAt?: string;
}

/**
 * Active means the last request falls inside `windowMs`; with no request stamp the
 * connect time stands in. Missing or unparseable stamps are never active.
 */
export function isActiveSession(
  session: SessionTimestamps,
  now: number,
  windowMs: number = ACTIVE_SESSION_WINDOW_MS,
): boolean {
  const stamp = session.lastRequestAt ?? session.connectedAt;
  if (stamp === undefined) return false;
  const at = Date.parse(stamp);
  return Number.isFinite(at) && now - at <= windowMs;
}
