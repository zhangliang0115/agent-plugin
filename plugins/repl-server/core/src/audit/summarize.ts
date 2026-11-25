/** Whitelisted, bounded tool-argument summaries for audit events. @module */
import { createHash } from 'node:crypto';

import { SECRET_KEY, redactValue } from './redact.ts';

const DEFAULT_MAX_BYTES = 2048;
const DEFAULT_DEPTH = 2;
const INITIAL_STRING_CAP = 256;
const MIN_STRING_CAP = 16;
/** Objects and arrays keep at most this many entries; the rest become `[+N more]`. */
const MAX_CONTAINER_ITEMS = 100;

export interface BoundedJsonOptions {
  /** Soft limit for the serialized JSON, in UTF-8 bytes. */
  maxBytes?: number;
  /** Container nesting kept before an object turns into `"[max-depth]"`. */
  depth?: number;
  /** Key-name matcher whose values become `"<redacted>"`. */
  redact?: RegExp;
}

/**
 * Serializes while bounding: oversized strings become `{len, sha256}` of their
 * redacted text, nested containers are cut at `depth`, containers keep at most
 * `MAX_CONTAINER_ITEMS` entries, then the whole value falls back to
 * `{truncated, bytes, sha256}` if it still does not fit `maxBytes`.
 */
export function boundedJson(value: unknown, options: BoundedJsonOptions = {}): unknown {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const depth = options.depth ?? DEFAULT_DEPTH;
  const keyPattern = options.redact ?? SECRET_KEY;

  let stringCap = INITIAL_STRING_CAP;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const normalized = normalize(value, 0, depth, stringCap, keyPattern);
    if (Buffer.byteLength(stringify(normalized), 'utf8') <= maxBytes) return normalized;
    stringCap = Math.max(MIN_STRING_CAP, Math.floor(stringCap / 2));
    if (stringCap === MIN_STRING_CAP) break;
  }

  // Hash the redacted form so the digest can never describe a secret value.
  const text = stringify(normalize(value, 0, depth, MIN_STRING_CAP, keyPattern));
  return { truncated: true, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) };
}

/**
 * Picks the documented whitelist per built-in tool. Free-text fields are
 * value-redacted before truncation; unknown tools go through `boundedJson`.
 */
export function summarizeArgs(tool: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const input = args ?? {};

  switch (tool) {
    case 'Bash':
      return {
        command: redactValue(asText(input.command)).slice(0, 500),
        timeout: input.timeout,
      };
    case 'Read':
      return {
        file_path: redactValue(asText(input.file_path)),
        offset: input.offset,
        limit: input.limit,
      };
    case 'Edit': {
      const oldString = asText(input.old_string);
      const newString = asText(input.new_string);
      return {
        file_path: redactValue(asText(input.file_path)),
        oldHead: redactValue(oldString).slice(0, 100),
        oldBytes: Buffer.byteLength(oldString, 'utf8'),
        newBytes: Buffer.byteLength(newString, 'utf8'),
      };
    }
    case 'Write':
      return {
        file_path: redactValue(asText(input.file_path)),
        contentBytes: Buffer.byteLength(asText(input.content), 'utf8'),
      };
    default:
      return boundedJson(input, { maxBytes: DEFAULT_MAX_BYTES, depth: DEFAULT_DEPTH, redact: SECRET_KEY }) as Record<
        string,
        unknown
      >;
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

function normalize(
  value: unknown,
  level: number,
  depth: number,
  stringCap: number,
  keyPattern: RegExp,
): unknown {
  if (typeof value === 'string') {
    const redacted = redactValue(value);
    if (redacted.length > stringCap) {
      return { len: redacted.length, sha256: sha256(redacted) };
    }
    return redacted;
  }
  if (value === null || typeof value !== 'object') return value;
  if (level >= depth) return '[max-depth]';

  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_CONTAINER_ITEMS)
      .map((item) => normalize(item, level + 1, depth, stringCap, keyPattern));
    if (value.length > MAX_CONTAINER_ITEMS) out.push(`[+${value.length - MAX_CONTAINER_ITEMS} more]`);
    return out;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, MAX_CONTAINER_ITEMS)) {
    keyPattern.lastIndex = 0;
    out[key] = keyPattern.test(key) ? '<redacted>' : normalize(item, level + 1, depth, stringCap, keyPattern);
  }
  if (entries.length > MAX_CONTAINER_ITEMS) {
    out[`[+${entries.length - MAX_CONTAINER_ITEMS} more]`] = true;
  }
  return out;
}

function stringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 'null' : json;
  } catch {
    return '"[unserializable]"';
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
