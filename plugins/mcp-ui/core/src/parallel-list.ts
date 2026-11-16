/**
 * The per-tool "supports parallel" list. A pattern is a full tool name, or a
 * name ending in `*` that matches every name with that prefix. Matching is the
 * same rule code-mode uses for its `concurrentTools`. @module
 */

import { mcpToolName } from './tool-name.ts';
import { matchesToolPattern, WILDCARD } from './tool-pattern.ts';

/**
 * Explain why a pattern cannot go in the list.
 * @param pattern - text the user typed or a stored entry.
 * @returns a message to show, or undefined when the pattern is usable.
 */
export function parallelPatternError(pattern: string): string | undefined {
  const trimmed = pattern.trim();
  if (trimmed === '') return '名称不能为空';
  if (trimmed === WILDCARD) return '至少要写出服务器前缀，例如 mcp__fs__*';
  const star = trimmed.indexOf(WILDCARD);
  if (star !== -1 && star !== trimmed.length - 1) return '* 只能出现在末尾';
  return undefined;
}

/**
 * Whether a tool name is covered by the list. Exact entries match literally;
 * an entry ending in `*` matches by prefix.
 * @param name - full tool name.
 * @param patterns - the stored list.
 */
export function allowsParallel(name: string, patterns: readonly string[]): boolean {
  return matchesToolPattern(name, patterns);
}

/**
 * Add one pattern to a copy of the list. Adding a pattern already present
 * returns an equal list.
 * @param patterns - the current list; not modified.
 * @param pattern - pattern to add; trimmed before use.
 * @throws Error with the validation message when the pattern is not usable.
 */
export function addParallel(patterns: readonly string[], pattern: string): string[] {
  const error = parallelPatternError(pattern);
  if (error !== undefined) throw new Error(error);
  const value = pattern.trim();
  return patterns.includes(value) ? [...patterns] : [...patterns, value];
}

/**
 * Remove one exact pattern from a copy of the list.
 * @param patterns - the current list; not modified.
 * @param pattern - exact entry to remove.
 */
export function removeParallel(patterns: readonly string[], pattern: string): string[] {
  return patterns.filter(entry => entry !== pattern);
}

/**
 * Turn one entry on or off.
 * @param patterns - the current list; not modified.
 * @param pattern - exact entry.
 * @param enabled - whether the entry should be present.
 */
export function toggleParallel(patterns: readonly string[], pattern: string, enabled: boolean): string[] {
  return enabled ? addParallel(patterns, pattern) : removeParallel(patterns, pattern);
}

/**
 * The pattern that covers every tool of one server.
 * @param server - configured server key.
 */
export function serverPattern(server: string): string {
  return mcpToolName(server, WILDCARD);
}
