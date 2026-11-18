/** Minimal tool description shared by the tool bridge. Retrieval lives elsewhere. @module */

/** How a tool is reached: a bare official tool name or `<server>.<tool>` over MCP. */
export type ToolKind = 'builtin' | 'mcp';

/**
 * One tool as an eval sees it. `name` is canonical: the bare name for builtin
 * tools and `<server>.<tool>` for MCP tools, the same spelling `visibleTools`
 * uses. This module deliberately stops at the description: search, ranking and
 * schemas are built on top of it elsewhere.
 */
export interface ToolDescriptor {
  readonly name: string;
  readonly kind: ToolKind;
  /** MCP server id. Present only when `kind` is `'mcp'`. */
  readonly server?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

/** Canonical names allowed in one eval. `undefined` means no narrowing. */
export type VisibleTools = readonly string[] | undefined;
