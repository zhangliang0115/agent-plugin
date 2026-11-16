/**
 * The "disabled tools" list. A disabled tool cannot be called. The list holds full model-facing
 * names (`mcp__<server>__<tool>`) or trailing-`*` prefixes, matched the same way as the parallel
 * list. @module
 */
import { coveringWildcard, matchesToolPattern } from './tool-pattern.ts';

/**
 * Result of changing one tool's state. A prefix pattern that still covers the tool
 * blocks enabling it, so the list is not edited and the covering pattern is returned.
 */
export type ToggleDisabledResult =
  | { readonly ok: true; readonly list: string[] }
  | { readonly ok: false; readonly cover: string };

/**
 * Whether a tool name is disabled by the list, through an exact entry or a prefix.
 * @param name - full tool name.
 * @param disabled - the stored list.
 */
export function isDisabled(name: string, disabled: readonly string[]): boolean {
  return matchesToolPattern(name, disabled);
}

/**
 * Disable or enable one tool, returning a new list. Disabling adds the exact name unless the
 * list already covers it. Enabling removes the exact name, unless a prefix pattern still covers
 * the tool; then nothing is edited and the covering pattern is returned.
 * @param disabled - the current list; not modified.
 * @param fullName - full model-facing tool name.
 * @param shouldDisable - true to disable the tool, false to enable it.
 */
export function toggleDisabled(
  disabled: readonly string[],
  fullName: string,
  shouldDisable: boolean,
): ToggleDisabledResult {
  if (shouldDisable) {
    return { ok: true, list: isDisabled(fullName, disabled) ? [...disabled] : [...disabled, fullName] };
  }
  const remaining = disabled.filter(entry => entry !== fullName);
  const cover = coveringWildcard(fullName, remaining);
  return cover === undefined ? { ok: true, list: remaining } : { ok: false, cover };
}

/**
 * The text the model sees when a call to a disabled tool is refused.
 * @param name - full tool name that was called.
 */
export function denialMessage(name: string): string {
  return `工具 ${name} 已被用户在 MCP 设置里禁用。`;
}
