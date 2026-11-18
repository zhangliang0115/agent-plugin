/** `describe_tools` over an immutable catalog snapshot, with the frozen response budget. @module */

import type { CatalogSnapshot } from '../ports.ts';
import { canonicalToolName } from './registry.ts';

/** The batch budget from docs/protocol.md §4: 32000 characters, measured on serialized entries. */
export const DESCRIBE_BUDGET_CHARS = 32_000;

export interface DescribeToolsInput {
  names: string[];
}

export interface DescribedTool {
  name: string;
  inputSchema: unknown;
}

export interface DescribeToolsResult {
  tools: DescribedTool[];
  omitted?: string[];
}

/**
 * Individual schemas are never truncated. Entries are packed in request order until the budget is
 * reached; the rest are reported in `omitted`. A single schema that exceeds the budget by itself
 * is returned alone without an omission hint, so retrying with fewer names cannot dead-loop.
 */
export function describeTools(
  snapshot: CatalogSnapshot,
  names: readonly string[],
  budget: number = DESCRIBE_BUDGET_CHARS,
): DescribeToolsResult {
  const available = new Map<string, DescribedTool>();
  for (const tool of snapshot.tools) {
    if (!tool.enabled) continue;
    const name = canonicalToolName(tool);
    available.set(name, { name, inputSchema: tool.inputSchema });
  }

  const requested: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    requested.push(name);
  }

  const tools: DescribedTool[] = [];
  const omitted: string[] = [];
  let used = 0;

  for (let index = 0; index < requested.length; index += 1) {
    const name = requested[index];
    if (name === undefined) continue;
    const entry = available.get(name);
    if (entry === undefined) {
      omitted.push(name);
      continue;
    }
    const size = JSON.stringify(entry).length;
    if (size > budget) {
      return { tools: [entry] };
    }
    const separator = tools.length === 0 ? 0 : 1;
    if (used + separator + size > budget) {
      for (const rest of requested.slice(index)) omitted.push(rest);
      break;
    }
    used += separator + size;
    tools.push(entry);
  }

  return omitted.length > 0 ? { tools, omitted } : { tools };
}
