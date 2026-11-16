import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TOOLS_PER_SERVER,
  joinServerTools,
} from '../src/tool-list.ts';

const CONNECTED = { state: 'connected', toolCount: 2, connectedAt: 1 };

test('joins each tool to the server whose name is its mcp__<server>__ prefix', () => {
  // Arrange
  const views = [
    { name: 'fs', configured: true, status: CONNECTED },
    { name: 'echo', configured: true, status: CONNECTED },
  ];
  const definitions = [
    { name: 'mcp__fs__read', description: 'read a file' },
    { name: 'mcp__echo__slow', description: 'wait' },
    { name: 'run_code' },
  ];

  // Act
  const joined = joinServerTools(views, definitions);

  // Assert
  assert.deepEqual(joined.map(server => [server.name, server.tools.map(tool => tool.rawName)]), [
    ['fs', ['read']],
    ['echo', ['slow']],
  ]);
  assert.equal(joined[0]?.tools[0]?.name, 'mcp__fs__read');
  assert.equal(joined[0]?.tools[0]?.description, 'read a file');
});

test('a tool name that only looks like another server is not assigned to it', () => {
  // Arrange: server "fs" must not claim a tool of server "fs_extra".
  const views = [{ name: 'fs', configured: true, status: CONNECTED }];

  // Act
  const joined = joinServerTools(views, [{ name: 'mcp__fs_extra__read', description: 'x' }]);

  // Assert
  assert.deepEqual(joined[0]?.tools, []);
});

test('assigns a tool to the longest known server prefix when two server names overlap', () => {
  // Arrange: "a" and "a_" are both valid server keys; "mcp__a___x" is server "a_", tool "x".
  const views = [
    { name: 'a', configured: true, status: CONNECTED },
    { name: 'a_', configured: true, status: CONNECTED },
  ];

  // Act
  const joined = joinServerTools(views, [{ name: 'mcp__a___x' }]);

  // Assert
  assert.deepEqual(joined.map(server => server.tools.length), [0, 1]);
  assert.equal(joined[1]?.tools[0]?.rawName, 'x');
});

test('keeps a configured server with no tools and a disabled server as an empty list', () => {
  // Arrange
  const views = [
    { name: 'off', configured: true, status: { state: 'disabled' } },
    { name: 'idle', configured: false, status: { state: 'connecting', attempt: 0 } },
  ];

  // Act
  const joined = joinServerTools(views, []);

  // Assert
  assert.deepEqual(joined, [
    { name: 'off', configured: true, status: { state: 'disabled' }, tools: [], truncated: false },
    { name: 'idle', configured: false, status: { state: 'connecting', attempt: 0 }, tools: [], truncated: false },
  ]);
});

test('copies only the status fields the page reads', () => {
  // Arrange
  const status = { state: 'failed', reason: 'gave-up', lastError: 'boom', connectedAt: 9, nextRetryAtMs: 4 };

  // Act
  const [server] = joinServerTools([{ name: 'fs', configured: true, status }], []);

  // Assert
  assert.deepEqual(server?.status, { state: 'failed', reason: 'gave-up', lastError: 'boom' });
});

test('caps a long description and marks it truncated', () => {
  // Arrange
  const long = 'x'.repeat(MAX_DESCRIPTION_LENGTH + 50);
  const views = [{ name: 'fs', configured: true, status: CONNECTED }];

  // Act
  const [tool] = joinServerTools(views, [{ name: 'mcp__fs__read', description: long }])[0]?.tools ?? [];

  // Assert
  assert.equal(tool?.description.length, MAX_DESCRIPTION_LENGTH);
  assert.equal(tool?.description.endsWith('…'), true);
  assert.equal(tool?.descriptionTruncated, true);
});

test('leaves a description at the cap untouched and missing descriptions empty', () => {
  // Arrange
  const exact = 'y'.repeat(MAX_DESCRIPTION_LENGTH);
  const views = [{ name: 'fs', configured: true, status: CONNECTED }];

  // Act
  const tools = joinServerTools(views, [
    { name: 'mcp__fs__exact', description: exact },
    { name: 'mcp__fs__bare' },
  ])[0]?.tools ?? [];

  // Assert
  assert.deepEqual(tools.map(tool => [tool.description, tool.descriptionTruncated]), [
    [exact, false],
    ['', false],
  ]);
});

test('caps the tools of one server and reports the server as truncated', () => {
  // Arrange
  const definitions = Array.from({ length: MAX_TOOLS_PER_SERVER + 3 }, (_, index) => ({ name: `mcp__big__t${index}` }));
  const views = [{ name: 'big', configured: true, status: CONNECTED }];

  // Act
  const [server] = joinServerTools(views, definitions);

  // Assert
  assert.equal(server?.tools.length, MAX_TOOLS_PER_SERVER);
  assert.equal(server?.truncated, true);
});

test('does not mark a server truncated when it is exactly at the cap', () => {
  // Arrange
  const definitions = Array.from({ length: MAX_TOOLS_PER_SERVER }, (_, index) => ({ name: `mcp__big__t${index}` }));

  // Act
  const [server] = joinServerTools([{ name: 'big', configured: true, status: CONNECTED }], definitions);

  // Assert
  assert.equal(server?.tools.length, MAX_TOOLS_PER_SERVER);
  assert.equal(server?.truncated, false);
});
