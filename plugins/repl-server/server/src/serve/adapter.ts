import { McpToolError, parseBashResult, type ToolCallRequest } from '@zhangliang0115/repl-server-core';

import type { ServeClient } from './client.ts';

interface CallToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

function textOf(result: CallToolResultLike): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n');
}

function parseInner(result: CallToolResultLike): unknown {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function officialName(tool: string): string {
  return tool.startsWith('tools.') ? tool.slice('tools.'.length) : tool;
}

/** Routes script tool calls to one `claude mcp serve` connection. */
export function createServeCallTool(client: ServeClient) {
  return async (call: ToolCallRequest): Promise<unknown> => {
    const name = officialName(call.tool);
    if (name.startsWith('mcp.')) {
      throw new McpToolError('third-party MCP routing is not wired yet', {
        code: 'MCP_SERVER_UNAVAILABLE',
        tool: name,
      });
    }
    const result = (await client.callTool(name, call.args)) as CallToolResultLike;
    if (name === 'Bash') return parseBashResult(result);
    if (result.isError === true) return { error: textOf(result) };
    return parseInner(result);
  };
}
