/**
 * Validation and normalization of `toolDiscovery` (design 07 §2.1/§2.2).
 *
 * One validator serves every entry point: `POST/PATCH /servers`, config import,
 * preview overrides and apply. It returns a *complete* search config (defaults
 * filled in) or `null` for static, so callers can compare and store it without
 * re-deriving defaults. Errors are {@link DiscoveryConfigError} with the frozen
 * codes `DISCOVERY_CONFIG_INVALID` / `DISCOVERY_SECRET_NOT_ALLOWED`.
 *
 * @module
 */

import {
  DiscoveryConfigError,
  type ToolDiscoveryConfig,
  type ToolDiscoveryMode,
} from './types.ts';

export const DISCOVERY_ARGS_MAX_BYTES = 16 * 1024;
export const DISCOVERY_ARGS_MAX_DEPTH = 8;
export const DISCOVERY_DEFAULT_MAX_TOOLS = 50;
export const DISCOVERY_MAX_TOOLS = 200;
export const DISCOVERY_SEARCH_TOOL_MAX_CHARS = 256;
export const DISCOVERY_QUERY_MAX_CHARS = 4096;

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'mode',
  'searchTool',
  'query',
  'args',
  'maxTools',
  'prepareOnCall',
]);

const STATIC_FORBIDDEN_KEYS = ['searchTool', 'query', 'args', 'maxTools', 'prepareOnCall'] as const;

export interface ParseDiscoveryOptions {
  /** Prefix for `details.field`; defaults to `toolDiscovery`. */
  field?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(field: string, message: string): DiscoveryConfigError {
  return new DiscoveryConfigError(
    'DISCOVERY_CONFIG_INVALID',
    `${field} ${message}`,
    { field },
  );
}

/** Rejects values that JSON would silently coerce (undefined, NaN, functions). */
function assertJsonValue(value: unknown, field: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(field, 'must be a finite number');
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], `${field}[${index}]`);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      assertJsonValue(nested, `${field}.${key}`);
    }
    return;
  }
  throw invalid(field, 'must be a JSON value');
}

/** Container nesting depth; the top-level object counts as 1. */
function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let max = 0;
    for (const entry of value) max = Math.max(max, jsonDepth(entry));
    return 1 + max;
  }
  if (isPlainObject(value)) {
    let max = 0;
    for (const entry of Object.values(value)) max = Math.max(max, jsonDepth(entry));
    return 1 + max;
  }
  return 0;
}

/**
 * Finds the first `{ "$secret": ... }` marker at any depth. Search arguments
 * are configuration, never credentials; secrets belong in env/headers.
 */
function findSecretPath(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSecretPath(value[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  if (Object.hasOwn(value, '$secret')) return path;
  for (const [key, nested] of Object.entries(value)) {
    const found = findSecretPath(nested, `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
}

function readArgs(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalid(field, 'must be a JSON object');
  assertJsonValue(value, field);

  const depth = jsonDepth(value);
  if (depth > DISCOVERY_ARGS_MAX_DEPTH) {
    throw invalid(field, `must not nest deeper than ${DISCOVERY_ARGS_MAX_DEPTH} levels`);
  }

  const secretPath = findSecretPath(value, field);
  if (secretPath !== null) {
    throw new DiscoveryConfigError(
      'DISCOVERY_SECRET_NOT_ALLOWED',
      `${secretPath} must not use "$secret"; put credentials in the server env/headers`,
      { path: secretPath },
    );
  }

  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > DISCOVERY_ARGS_MAX_BYTES) {
    throw invalid(
      field,
      `must serialize to at most ${DISCOVERY_ARGS_MAX_BYTES} bytes (got ${bytes})`,
    );
  }
  return value;
}

function readMode(value: unknown, field: string): ToolDiscoveryMode {
  if (value === undefined) return 'static';
  if (value === 'static' || value === 'search') return value;
  throw invalid(field, 'must be "static" or "search"');
}

function readSearchTool(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalid(field, 'must be a string');
  const text = value.trim();
  if (text === '') throw invalid(field, 'must not be empty');
  if (text.length > DISCOVERY_SEARCH_TOOL_MAX_CHARS) {
    throw invalid(field, `must be at most ${DISCOVERY_SEARCH_TOOL_MAX_CHARS} characters`);
  }
  return text;
}

function readQuery(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalid(field, 'must be a string');
  if (value.length > DISCOVERY_QUERY_MAX_CHARS) {
    throw invalid(field, `must be at most ${DISCOVERY_QUERY_MAX_CHARS} characters`);
  }
  return value;
}

function readMaxTools(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(field, 'must be an integer');
  }
  if (value < 1 || value > DISCOVERY_MAX_TOOLS) {
    throw invalid(field, `must be between 1 and ${DISCOVERY_MAX_TOOLS}`);
  }
  return value;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalid(field, 'must be a boolean');
  return value;
}

/**
 * Validates and normalizes one `toolDiscovery` value.
 *
 * `undefined`/`null` and `{ "mode": "static" }` both normalize to `null`, the
 * storage form for "no discovery configuration" (static catalog).
 */
export function parseToolDiscoveryConfig(
  value: unknown,
  options: ParseDiscoveryOptions = {},
): ToolDiscoveryConfig | null {
  const field = options.field ?? 'toolDiscovery';
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw invalid(field, 'must be an object or null');

  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw invalid(`${field}.${key}`, 'is not a known field');
  }

  const mode = readMode(value['mode'], `${field}.mode`);
  if (mode === 'static') {
    for (const key of STATIC_FORBIDDEN_KEYS) {
      if (value[key] !== undefined) {
        throw invalid(
          `${field}.${key}`,
          'is not allowed when mode is "static"',
        );
      }
    }
    return null;
  }

  if (value['searchTool'] === undefined) {
    throw invalid(`${field}.searchTool`, 'is required when mode is "search"');
  }

  const config: ToolDiscoveryConfig = {
    mode: 'search',
    searchTool: readSearchTool(value['searchTool'], `${field}.searchTool`),
    query:
      value['query'] === undefined ? '' : readQuery(value['query'], `${field}.query`),
    args:
      value['args'] === undefined
        ? {}
        : readArgs(value['args'], `${field}.args`),
    maxTools:
      value['maxTools'] === undefined
        ? DISCOVERY_DEFAULT_MAX_TOOLS
        : readMaxTools(value['maxTools'], `${field}.maxTools`),
    prepareOnCall:
      value['prepareOnCall'] === undefined
        ? true
        : readBoolean(value['prepareOnCall'], `${field}.prepareOnCall`),
  };
  return config;
}

/** Parses a stored `servers.discovery_json`; malformed or static values read as `null`. */
export function decodeStoredDiscovery(json: string | null): ToolDiscoveryConfig | null {
  if (json === null || json === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  try {
    return parseToolDiscoveryConfig(parsed);
  } catch {
    return null;
  }
}

/** Storage form: normalized search config as JSON text, or `null` for static. */
export function toolDiscoveryToJson(config: ToolDiscoveryConfig | null | undefined): string | null {
  const normalized = parseToolDiscoveryConfig(config);
  return normalized === null ? null : JSON.stringify(normalized);
}

/** Recursively sorts object keys so canonical comparison is order-independent. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    // Args may carry a `__proto__` key; defineProperty keeps it own data.
    Object.defineProperty(out, key, {
      value: sortJsonValue(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

/**
 * Deterministic canonical form used by config import/export diffing and the
 * "did the discovery config change?" check inside apply.
 */
export function canonicalToolDiscovery(config: ToolDiscoveryConfig | null | undefined): string {
  let normalized: ToolDiscoveryConfig | null;
  try {
    normalized = parseToolDiscoveryConfig(config);
  } catch {
    // A malformed row must never break config export/diff; keep it distinct.
    return `invalid:${JSON.stringify(config ?? null)}`;
  }
  if (normalized === null) return 'null';
  return JSON.stringify({
    mode: 'search',
    searchTool: normalized.searchTool ?? '',
    query: normalized.query ?? '',
    args: sortJsonValue(normalized.args ?? {}),
    maxTools: normalized.maxTools ?? DISCOVERY_DEFAULT_MAX_TOOLS,
    prepareOnCall: normalized.prepareOnCall !== false,
  });
}

/** Request-side overrides accepted by `POST .../tools/discover`. */
export interface ToolDiscoveryOverride {
  mode?: ToolDiscoveryMode;
  searchTool?: string;
  query?: string;
  args?: Record<string, unknown>;
  maxTools?: number;
  prepareOnCall?: boolean;
}

const OVERRIDE_KEYS: readonly (keyof ToolDiscoveryOverride)[] = [
  'searchTool',
  'query',
  'args',
  'maxTools',
  'prepareOnCall',
];

/**
 * Merges request overrides over the saved configuration, then validates the
 * result with the same rules as PATCH. Providing a search-specific field for a
 * static server implies `mode = "search"`; an explicit `mode` always wins.
 */
export function mergeToolDiscovery(
  saved: ToolDiscoveryConfig | null,
  override: ToolDiscoveryOverride,
): ToolDiscoveryConfig {
  const hasSearchField = OVERRIDE_KEYS.some((key) => override[key] !== undefined);
  const mode =
    override.mode ??
    (saved?.mode === 'search' ? 'search' : hasSearchField ? 'search' : 'static');

  if (mode === 'static') {
    return { mode: 'static' };
  }

  const raw: Record<string, unknown> = { mode: 'search' };
  if (saved?.mode === 'search') {
    raw['searchTool'] = saved.searchTool;
    raw['query'] = saved.query ?? '';
    raw['args'] = saved.args ?? {};
    raw['maxTools'] = saved.maxTools ?? DISCOVERY_DEFAULT_MAX_TOOLS;
    raw['prepareOnCall'] = saved.prepareOnCall !== false;
  }
  if (override.searchTool !== undefined) raw['searchTool'] = override.searchTool;
  if (override.query !== undefined) raw['query'] = override.query;
  if (override.args !== undefined) raw['args'] = override.args;
  if (override.maxTools !== undefined) raw['maxTools'] = override.maxTools;
  if (override.prepareOnCall !== undefined) raw['prepareOnCall'] = override.prepareOnCall;

  const normalized = parseToolDiscoveryConfig(raw);
  if (normalized === null) throw invalid('toolDiscovery.mode', 'must be "search"');
  return normalized;
}
