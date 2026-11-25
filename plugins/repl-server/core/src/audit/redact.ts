/** Value-level redaction shared by argument summaries, URLs and the audit writer. @module */

/**
 * Key-name matcher used when an entire object is recorded. A key that ends in a
 * descriptive suffix (`tokenCount`, `secretType`, `apiKeyUrl`) describes the
 * value instead of holding it, so it keeps its value.
 */
export const SECRET_KEY =
  /(token|secret|password|passwd|api[_-]?key|authorization|cookie)(?![\s\S]*(?:Count|Length|Size|Type|Name|Url|Uri|Path|Header|Param)$)/i;

/** `Authorization: Bearer ...` style header; the whole value is replaced. */
const AUTH_HEADER = /\b(authorization\s*[:=]\s*)[^\r\n,;"']+/gi;

/** A bare `Bearer <token>` with a realistic token length. */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/**
 * The `#fragment` of a URL, which can carry an OAuth token. Only `scheme://`
 * tokens match, so plain `#anchors` in prose are left alone.
 */
const URL_FRAGMENT = /([a-z][a-z0-9+.-]*:\/\/[^\s#]*)#(?!<redacted>)[^\s<>"']*/gi;

/**
 * `scheme://user:pass@host` — the userinfo can carry a password. The scheme is
 * kept; bare `user@host` text has no `://` and is not touched.
 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@<>"']+@/gi;

/**
 * `*_TOKEN=`, `*_KEY=`, `password:`, `secret=` and similar assignments. Keys
 * may be quoted (`"token": "..."`, `'password': '...'`); the key and separator
 * are kept and the value is replaced.
 */
const CREDENTIAL =
  /(["']?)([A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|_KEY))(["']?)\s*([:=])\s*(?!<redacted>)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi;

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
  // URL rules first: the userinfo replacement contains `<` and `>`, which the
  // fragment pattern stops at.
  out = out.replace(URL_FRAGMENT, '$1#<redacted>');
  out = out.replace(URL_USERINFO, '$1<redacted>@');
  out = out.replace(AUTH_HEADER, '$1<redacted>');
  out = out.replace(BEARER, 'Bearer <redacted>');
  out = out.replace(
    CREDENTIAL,
    (_match, open: string, key: string, close: string, separator: string) =>
      `${open}${key}${close}${separator}<redacted>`,
  );
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
 * Sixteen levels cover common query structures (an ES
 * `body.query.bool.filter[].range.gte` is about 9 deep) while still bounding
 * hostile deep objects.
 */
export function redactDeep(value: unknown, maxDepth = 16): unknown {
  return walk(value, 0, maxDepth);
}

function walk(value: unknown, level: number, maxDepth: number): unknown {
  if (typeof value === 'string') return redactValue(value);
  if (value === null || typeof value !== 'object') return value;
  if (level >= maxDepth) return '[max-depth]';

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, level + 1, maxDepth));
  }

  // A null prototype plus `defineProperty` keeps a `__proto__` key a plain
  // data field instead of an assignment that rewrites the result's prototype.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    const redacted = SECRET_KEY.test(key) ? '<redacted>' : walk(item, level + 1, maxDepth);
    Object.defineProperty(out, key, { value: redacted, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
