import {
  McpToolError,
  normalizeMcpResult,
  normalizeOfficialResult,
  parseBashResult,
  type ServeToolResult,
  type ToolCallRequest,
} from '@zhangliang0115/repl-server-core';

import type { ServeClient } from './client.ts';

/** Per-call transport options the gateway threads through `callTool`. */
export interface ServeCallOptions {
  /** Eval- or call-level cancellation; aborts the pending JSON-RPC request. */
  signal?: AbortSignal;
  /** Absolute deadline in epoch milliseconds; narrows the per-request timeout. */
  deadline?: number;
}

/** Minimal MCP client shape used for third-party servers. */
export interface McpToolClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown>;
}

export interface ServeAdapterOptions {
  /**
   * Resolves the client for one third-party MCP server. Routing lives in the
   * pool; when it is wired, the adapter normalizes the result with
   * `normalizeMcpResult` so images and PDFs survive. Without it, MCP calls keep
   * the explicit `MCP_SERVER_UNAVAILABLE` failure.
   */
  mcp?: (server: string) => McpToolClient | undefined;
}

function officialName(tool: string): string {
  return tool.startsWith('tools.') ? tool.slice('tools.'.length) : tool;
}

function requestTimeout(deadline: number | undefined): number | undefined {
  if (deadline === undefined || !Number.isFinite(deadline)) return undefined;
  return Math.max(0, Math.floor(deadline - Date.now()));
}

/**
 * Routes script tool calls to one `claude mcp serve` connection.
 *
 * Official results go through `normalizeOfficialResult`, so Read/Edit shapes and
 * media blocks are preserved instead of being flattened to text; Bash keeps its
 * structured `{stdout, stderr, exitCode}` shape. Third-party results go through
 * `normalizeMcpResult` when an MCP client is wired.
 */
export function createServeCallTool(client: ServeClient, options: ServeAdapterOptions = {}) {
  return async (call: ToolCallRequest, callOptions: ServeCallOptions = {}): Promise<unknown> => {
    const name = officialName(call.tool);
    if (name.startsWith('mcp.')) {
      throw new McpToolError('third-party MCP routing is not wired yet', {
        code: 'MCP_SERVER_UNAVAILABLE',
        tool: name,
      });
    }

    const timeoutMs = requestTimeout(callOptions.deadline);

    if (call.server !== undefined) {
      const target = options.mcp?.(call.server);
      if (target === undefined) {
        throw new McpToolError(
          `third-party MCP routing is not wired yet (${call.server}.${call.tool})`,
          {
            code: 'MCP_SERVER_UNAVAILABLE',
            server: call.server,
            tool: call.tool,
          },
        );
      }
      const raw = await target.callTool(call.tool, call.args, callOptions.signal, timeoutMs);
      if (raw === undefined || raw === null) return raw;
      const result = raw as ServeToolResult;
      if (result.isError === true) {
        const normalized = normalizeMcpResult(result);
        throw new McpToolError(normalized.text.trim() === '' ? `${call.server}.${call.tool} failed` : normalized.text, {
          code: 'MCP_TOOL_ERROR',
          server: call.server,
          tool: call.tool,
        });
      }
      return normalizeMcpResult(result);
    }

    const result = (await client.callTool(name, call.args, callOptions.signal, timeoutMs)) as ServeToolResult;
    if (name === 'Bash') return parseBashResult(result);
    return normalizeOfficialResult(name, result);
  };
}
