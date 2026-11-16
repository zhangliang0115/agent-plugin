/**
 * The `mcpDisabled` service: answers whether a tool is disabled in the MCP page. The list is
 * read on every query, so a saved change applies to the next call without a reload. @module
 */
import { isDisabled } from '@zhangliang0115/mcp-ui-core';

/** Service other plugins read with `ctx.get('mcpDisabled')`. */
export interface McpDisabledService {
  /** True when the full tool name is disabled by the live list, exactly or by a prefix. */
  isDisabled(name: string): boolean;
}

/**
 * Whether a tool is disabled right now. A list that cannot be read disables nothing, so a
 * failing read never blocks a call and never throws.
 * @param name - full tool name.
 * @param read - returns the current list.
 */
export function isDisabledNow(name: string, read: () => readonly string[]): boolean {
  try {
    return isDisabled(name, read());
  } catch {
    return false;
  }
}

/**
 * @param read - returns the current list; called on every query.
 */
export function createDisabledService(read: () => readonly string[]): McpDisabledService {
  return {
    isDisabled: (name: string): boolean => isDisabledNow(name, read),
  };
}
