/** `describe_tools` over an immutable catalog snapshot. @module */

import type { CatalogSnapshot } from '../ports.ts';
import { canonicalToolName } from './registry.ts';
import { isToolVisible, type ToolVisibility } from './search.ts';

export interface DescribeToolsInput {
  names: string[];
}

export interface DescribedTool {
  name: string;
  inputSchema: unknown;
}

export interface DescribeToolsResult {
  tools: DescribedTool[];
  /** Requested names that are unknown or hidden from this client. */
  unknown?: string[];
}

/**
 * Returns every requested schema, deduplicated and in request order.
 * Unknown and hidden names are reported instead of skipped, so the model never
 * mistakes an omission for an empty schema.
 */
export function describeTools(
  snapshot: CatalogSnapshot,
  names: readonly string[],
  visibility: ToolVisibility = {},
): DescribeToolsResult {
  const available = new Map<string, DescribedTool>();
  for (const tool of snapshot.tools) {
    if (!tool.enabled) continue;
    if (!isToolVisible(tool, visibility)) continue;
    const name = canonicalToolName(tool);
    available.set(name, { name, inputSchema: tool.inputSchema });
  }

  const tools: DescribedTool[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = available.get(name);
    if (entry === undefined) unknown.push(name);
    else tools.push(entry);
  }

  return unknown.length > 0 ? { tools, unknown } : { tools };
}
