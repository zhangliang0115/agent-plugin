import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupToolsByServer, mcpToolName, parseMcpToolName } from '../src/tool-name.ts';

test('builds the model-facing name from server and tool', () => {
  // Arrange
  const server = 'fs';
  const tool = 'read';

  // Act
  const name = mcpToolName(server, tool);

  // Assert
  assert.equal(name, 'mcp__fs__read');
});

test('parses server and tool from an MCP tool name', () => {
  // Arrange
  const name = 'mcp__fs__read';

  // Act
  const ref = parseMcpToolName(name);

  // Assert
  assert.deepEqual(ref, { server: 'fs', tool: 'read' });
});

test('keeps later separators inside the tool part', () => {
  // Arrange
  const name = 'mcp__fs__read__file';

  // Act
  const ref = parseMcpToolName(name);

  // Assert
  assert.deepEqual(ref, { server: 'fs', tool: 'read__file' });
});

test('returns undefined for names that are not MCP tools', () => {
  // Arrange
  const names = ['run_code', 'bash', 'mcp_fs_read', 'mcp__', 'mcp____read', 'mcp__fs__'];

  // Act
  const refs = names.map(parseMcpToolName);

  // Assert
  assert.deepEqual(refs, names.map(() => undefined));
});

test('groups tool names by server in sorted server order and skips non-MCP names', () => {
  // Arrange
  const names = ['mcp__git__status', 'run_code', 'mcp__fs__write', 'mcp__fs__read', 'bogus'];

  // Act
  const groups = groupToolsByServer(names);

  // Assert
  assert.deepEqual([...groups.entries()], [
    ['fs', ['mcp__fs__write', 'mcp__fs__read']],
    ['git', ['mcp__git__status']],
  ]);
});
