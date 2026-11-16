/**
 * Matcher shared by the parallel list and the disabled list. A pattern is a full tool
 * name, or a name ending in `*` that matches every name with that prefix. @module
 */

/** Trailing character that turns an entry into a prefix pattern. */
export const WILDCARD = '*';

/**
 * Whether a tool name is covered by any pattern. Exact entries match literally;
 * an entry ending in `*` matches by prefix.
 * @param name - full tool name.
 * @param patterns - the stored list.
 */
export function matchesToolPattern(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => matchesOne(name, pattern));
}

/**
 * The first prefix pattern (an entry ending in `*`) that covers a name. Exact
 * entries never count as a cover.
 * @param name - full tool name.
 * @param patterns - the stored list.
 * @returns the covering pattern, or undefined when no prefix pattern covers it.
 */
export function coveringWildcard(name: string, patterns: readonly string[]): string | undefined {
  return patterns.find(pattern => pattern.endsWith(WILDCARD) && matchesOne(name, pattern));
}

function matchesOne(name: string, pattern: string): boolean {
  return pattern.endsWith(WILDCARD)
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern;
}
