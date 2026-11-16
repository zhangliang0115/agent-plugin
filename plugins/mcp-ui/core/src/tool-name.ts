/**
 * Model-facing names of MCP tools. DSH names a tool `mcp__<server>__<tool>`;
 * the server part is the configured server key. @module
 */

export const MCP_TOOL_PREFIX = 'mcp__';
export const MCP_NAME_SEPARATOR = '__';

/** The server key and the tool name inside that server. */
export interface McpToolRef {
  readonly server: string;
  readonly tool: string;
}

/**
 * Build the full tool name for one tool of one server.
 * @param server - configured server key.
 * @param tool - tool name as the server lists it.
 */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}${MCP_NAME_SEPARATOR}${tool}`;
}

/**
 * Split a full tool name at the first separator after the prefix. Later
 * separators stay in the tool part, so `mcp__fs__read__file` is server `fs`,
 * tool `read__file`.
 * @param name - full tool name as the model sees it.
 * @returns the reference, or undefined when the name is not an MCP tool name.
 */
export function parseMcpToolName(name: string): McpToolRef | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const split = rest.indexOf(MCP_NAME_SEPARATOR);
  if (split <= 0) return undefined;
  const server = rest.slice(0, split);
  const tool = rest.slice(split + MCP_NAME_SEPARATOR.length);
  if (tool === '') return undefined;
  return { server, tool };
}

/**
 * Group full tool names by server. Groups come out in server-name order, and
 * names that are not MCP tool names are dropped.
 * @param names - full tool names.
 */
export function groupToolsByServer(names: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const ref = parseMcpToolName(name);
    if (ref === undefined) continue;
    groups.set(ref.server, [...(groups.get(ref.server) ?? []), name]);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
