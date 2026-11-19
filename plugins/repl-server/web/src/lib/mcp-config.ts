/** MCP client snippets for a client binding. @module */

/** Server name used by the docs and the JSON snippet. */
export const MCP_SERVER_NAME = 'repl';

export interface McpSnippetInput {
  /** MCP endpoint; it lives on the same origin as the admin UI. */
  url: string;
  /** Plaintext binding token. */
  token: string;
}

/** `mcpServers` document accepted by Claude Code and other Streamable HTTP clients. */
export function buildMcpConfigText({ url, token }: McpSnippetInput): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

/** Command syntax checked against `claude mcp add --help` (HTTP + `--header`). */
export function buildClaudeMcpAddCommand({ url, token }: McpSnippetInput): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`;
}

/** `/mcp` is served by the same server as the admin UI. */
export function mcpEndpoint(origin: string): string {
  return new URL('/mcp', origin).toString();
}
