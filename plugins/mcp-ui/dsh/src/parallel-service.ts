/**
 * The `mcpParallel` service: answers whether a tool is listed as safe to run
 * in parallel. The list is read on every call, so a saved change applies to the
 * next call without a reload. @module
 */
import { allowsParallel } from '@zhangliang0115/mcp-ui-core';

/** Service other plugins read with `ctx.get('mcpParallel')`. */
export interface McpParallelService {
  /** True when the full tool name is covered by the live parallel list. */
  isParallel(name: string): boolean;
}

/**
 * @param read - returns the current list; called on every query.
 */
export function createParallelService(read: () => readonly string[]): McpParallelService {
  return {
    isParallel: (name: string): boolean => allowsParallel(name, read()),
  };
}
