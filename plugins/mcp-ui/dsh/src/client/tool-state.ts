/**
 * Checkbox state of one tool in the parallel list. The list holds full model-facing names
 * (`mcp__<server>__<tool>`) because that is what the code-mode executor classifies; `probe`
 * returns the raw names a server advertises. @module
 */
import { allowsParallel, coveringWildcard, isDisabled, mcpToolName, serverPattern } from '@zhangliang0115/mcp-ui-core';

/** What the row needs to draw and toggle one tool. */
export interface ToolCheckState {
  /** Name to store in the list when the box is toggled. */
  readonly fullName: string;
  readonly checked: boolean;
  /** True when another entry (a server-wide pattern) decides, so the box cannot change on its own. */
  readonly disabled: boolean;
  /** The pattern that covers this tool, when one does. */
  readonly cover: string | undefined;
}

/**
 * @param server - configured server key.
 * @param rawTool - tool name as `probe` lists it.
 * @param parallelTools - the saved list.
 */
export function toolCheckState(server: string, rawTool: string, parallelTools: readonly string[]): ToolCheckState {
  const fullName = mcpToolName(server, rawTool);
  const explicit = parallelTools.includes(fullName);
  const wide = serverPattern(server);
  const cover = explicit
    ? undefined
    : parallelTools.includes(wide)
      ? wide
      : parallelTools.find(pattern => pattern.endsWith('*') && pattern !== fullName && allowsParallel(fullName, [pattern]));
  return { fullName, checked: explicit || cover !== undefined, disabled: cover !== undefined, cover };
}

/** What the row needs to draw the 启用 box of one tool. */
export interface ToolEnableState {
  /** Full model-facing name, the value stored in the disabled list when the box is cleared. */
  readonly fullName: string;
  /** False when the tool is disabled, either by its exact name or by a prefix. */
  readonly enabled: boolean;
  /** The prefix pattern that disables the tool. Enabling it is refused while this is set, so the box is locked. */
  readonly cover: string | undefined;
}

/**
 * @param server - configured server key.
 * @param rawTool - tool name as `probe` lists it.
 * @param disabledTools - the saved disabled list.
 */
export function toolEnableState(server: string, rawTool: string, disabledTools: readonly string[]): ToolEnableState {
  const fullName = mcpToolName(server, rawTool);
  return {
    fullName,
    enabled: !isDisabled(fullName, disabledTools),
    cover: coveringWildcard(fullName, disabledTools),
  };
}
