/**
 * Search-argument construction for discovery scans and call-time preparation
 * (design 07 §2.1, §4.4).
 *
 * `"$query"` is replaced by the scan query (preview/apply) or by the tool name
 * (prepare-before-call). When the operator configured no placeholder and no
 * top-level `query`, a `query` key is appended — but only for a non-empty scan
 * query, while preparation always appends the tool name.
 *
 * @module
 */

import { DiscoveryConfigError, type ToolDiscoveryConfig } from './types.ts';

/** Placeholder replaced at every occurrence on any nesting level. */
export const QUERY_PLACEHOLDER = '$query';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Defines an own enumerable property. Plain assignment of a JSON key named
 * `__proto__` would mutate the object's prototype instead of creating a key
 * (design 07 §7, prototype pollution).
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Deep copy with `"$query"` strings replaced; only own properties are visited. */
export function substituteQuery(value: unknown, query: string): unknown {
  if (value === QUERY_PLACEHOLDER) return query;
  if (Array.isArray(value)) return value.map((entry) => substituteQuery(entry, query));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    setOwn(out, key, substituteQuery(entry, query));
  }
  return out;
}

/** True when the configured args object contains the placeholder at any depth. */
export function hasQueryPlaceholder(value: unknown): boolean {
  if (value === QUERY_PLACEHOLDER) return true;
  if (Array.isArray(value)) return value.some(hasQueryPlaceholder);
  if (!isPlainObject(value)) return false;
  return Object.values(value).some(hasQueryPlaceholder);
}

/**
 * Builds the upstream search arguments for one query.
 *
 * Rules (design 07 §2.1):
 * - placeholder present → replace every occurrence; do not append `query`.
 * - no placeholder and no top-level `query` key → append `{ query }`, but only
 *   when the query is non-empty (scan with `query: ""` sends the args as-is).
 * - top-level `query` present → treated as a fixed literal; never overwritten.
 */
export function buildSearchArgs(
  config: ToolDiscoveryConfig,
  query: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const configured = config.args ?? {};
  const substituted = substituteQuery(configured, query);
  const args: Record<string, unknown> = isPlainObject(substituted)
    ? (substituted as Record<string, unknown>)
    : {};

  if (!hasQueryPlaceholder(configured) && !Object.hasOwn(args, 'query') && query !== '') {
    setOwn(args, 'query', query);
  }
  for (const [key, value] of Object.entries(extra)) setOwn(args, key, value);
  return args;
}

function requireSearchTool(config: ToolDiscoveryConfig): string {
  const tool = config.searchTool;
  if (tool === undefined || tool === '') {
    throw new DiscoveryConfigError(
      'DISCOVERY_CONFIG_INVALID',
      'toolDiscovery.searchTool is required for mode "search"',
      { field: 'toolDiscovery.searchTool' },
    );
  }
  return tool;
}

export interface PrepareCall {
  /** Upstream search tool. */
  tool: string;
  /** Arguments for that search tool. */
  args: Record<string, unknown>;
}

/**
 * Builds the call-time warm-up request: the query is the tool being called, so
 * a keyword search points at exactly that tool.
 */
export function buildPrepareCall(
  config: ToolDiscoveryConfig,
  toolName: string,
): PrepareCall {
  return {
    tool: requireSearchTool(config),
    args: buildSearchArgs(config, toolName),
  };
}
