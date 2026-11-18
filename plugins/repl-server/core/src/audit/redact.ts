/** Value-level redaction shared by argument summaries, URLs and the audit writer. @module */

/** Key-name matcher used when an entire object is recorded. */
export const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie)/i;

/** `Authorization: Bearer ...` style header; the whole value is replaced. */
const AUTH_HEADER = /\b(authorization\s*[:=]\s*)[^\r\n,;"']+/gi;

/** A bare `Bearer <token>` with a realistic token length. */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g;

/** `*_TOKEN=`, `*_KEY=`, `password:`, `secret=` and similar assignments. */
const CREDENTIAL =
  /\b([A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|_KEY))\s*[:=]\s*(?!<redacted>)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi;

/** `?token=`, `&key=`, `?secret=` in a URL query string. */
const QUERY_SECRET = /([?&](?:token|access[_-]?token|api[_-]?key|key|secret|password)=)[^&\s#]+/gi;

/** Three dot-separated segments, each long enough to be a JWT part. */
const JWT = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g;

/**
 * Replaces credential values inside free text while keeping key names.
 * Every retained audit string passes through this function.
 */
export function redactValue(value: string): string {
  let out = String(value);
  out = out.replace(AUTH_HEADER, '$1<redacted>');
  out = out.replace(BEARER, 'Bearer <redacted>');
  out = out.replace(CREDENTIAL, (_match, key: string) => `${key}=<redacted>`);
  out = out.replace(QUERY_SECRET, '$1<redacted>');
  out = out.replace(JWT, '<redacted>');
  return out;
}

/** Drops the query string so `?token=...` never reaches an audit record. */
export function stripUrlQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    const query = url.indexOf('?');
    return query === -1 ? url : url.slice(0, query);
  }
}

/**
 * Recursively redacts string values and secret-named keys.
 * Depth-bounded so a hostile object cannot stall the writer.
 */
export function redactDeep(value: unknown, maxDepth = 8): unknown {
  return walk(value, 0, maxDepth);
}

function walk(value: unknown, level: number, maxDepth: number): unknown {
  if (typeof value === 'string') return redactValue(value);
  if (value === null || typeof value !== 'object') return value;
  if (level >= maxDepth) return '[max-depth]';

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, level + 1, maxDepth));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '<redacted>' : walk(item, level + 1, maxDepth);
  }
  return out;
}
