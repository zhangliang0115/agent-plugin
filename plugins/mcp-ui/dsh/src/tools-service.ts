/**
 * The `mcpTools` service. DSH's Typert gateway only serves a service that exposes a `typertRemote`
 * binding naming the service itself; first-party services get it by extending `TypertRemoteService`,
 * which is not part of the runtime this package can import, so the same frozen binding is built here. @module
 */
import type { ServerToolsView } from '@zhangliang0115/mcp-ui-core';
import { watchTools, type ToolsSource } from './tools-watch.ts';

/** Cordis key and Remote namespace; the descriptor in `mcp-tools-remote.ts` uses the same name. */
export const SERVICE_KEY = 'mcpTools';

/** What the gateway reads to find and check the receiver. */
export interface TypertBinding {
  readonly service: object;
  readonly serviceKey: string;
  readonly namespace: string;
}

/** The service behind the remote of the same name. */
export interface McpToolsService {
  /** Every MCP server with status and tools; the full list on subscription and after each change. */
  watch(signal: AbortSignal): AsyncIterable<ServerToolsView[]>;
}

export class McpToolsServiceImpl implements McpToolsService {
  readonly typertRemote: TypertBinding;
  private readonly source: ToolsSource;

  constructor(source: ToolsSource) {
    this.source = source;
    this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY });
  }

  watch(signal: AbortSignal): AsyncIterable<ServerToolsView[]> {
    return watchTools(this.source, signal);
  }
}
