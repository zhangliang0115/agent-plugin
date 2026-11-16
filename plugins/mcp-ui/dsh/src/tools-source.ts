/**
 * Reads the host for the stream: server views from the MCP manager, tool definitions from the tool
 * registry, and the two events that mean "the list changed". Either service may be missing (a profile
 * without the manager), in which case the stream carries an empty list instead of failing. @module
 */
import type { ServerViewLike, ToolDefinitionLike } from '@zhangliang0115/mcp-ui-core';
import type { ToolsSource } from './tools-watch.ts';

/** The part of the Cordis context this file uses. */
export interface HostLike {
  get(name: string): unknown;
  on(event: string, handler: () => void): () => void;
}

/** Manager event after any server status change. */
export const STATUS_EVENT = 'mcp-manager/status';
/** Tool registry event after tools are added or removed. */
export const TOOLS_EVENT = 'tools/change';

interface ManagerLike { list(): readonly ServerViewLike[] }
interface RegistryLike { definitions(): readonly ToolDefinitionLike[] }

/**
 * @param host - the Cordis context.
 */
export function createToolsSource(host: HostLike): ToolsSource {
  return {
    list(): readonly ServerViewLike[] {
      const manager = host.get('mcpManager') as ManagerLike | undefined;
      if (manager === undefined) return [];
      try {
        return manager.list();
      } catch {
        return [];
      }
    },
    definitions(): readonly ToolDefinitionLike[] {
      const registry = host.get('tools') as RegistryLike | undefined;
      if (registry === undefined) return [];
      try {
        return registry.definitions();
      } catch {
        return [];
      }
    },
    onChange(listener: () => void): () => void {
      const offStatus = host.on(STATUS_EVENT, listener);
      const offTools = host.on(TOOLS_EVENT, listener);
      return () => {
        offStatus();
        offTools();
      };
    },
  };
}
