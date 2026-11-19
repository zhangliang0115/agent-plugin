/** MCP snippet builders: JSON shape and the Claude Code command. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeMcpAddCommand,
  buildMcpConfigText,
  mcpEndpoint,
} from '../src/lib/mcp-config.ts';

const URL = 'http://127.0.0.1:8787/mcp';

test('buildMcpConfigText emits an mcpServers entry with the bearer header', () => {
  const parsed = JSON.parse(buildMcpConfigText({ url: URL, token: 'secret-token' })) as {
    mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
  };
  const server = parsed.mcpServers['repl'];
  assert.ok(server !== undefined);
  assert.equal(server.type, 'http');
  assert.equal(server.url, URL);
  assert.equal(server.headers['Authorization'], 'Bearer secret-token');
});

test('buildClaudeMcpAddCommand matches the verified `claude mcp add` syntax', () => {
  assert.equal(
    buildClaudeMcpAddCommand({ url: URL, token: 'secret-token' }),
    'claude mcp add --transport http repl http://127.0.0.1:8787/mcp --header "Authorization: Bearer secret-token"',
  );
});

test('mcpEndpoint appends /mcp to the admin origin', () => {
  assert.equal(mcpEndpoint('http://127.0.0.1:8787'), URL);
  assert.equal(mcpEndpoint('http://localhost:9000/'), 'http://localhost:9000/mcp');
});
