import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseToolsPayload } from '../src/client/tools-payload.ts';

const TOOL = {
  name: 'mcp__fs__read',
  rawName: 'read',
  description: 'read a file',
  descriptionTruncated: false,
};

const SERVER = {
  name: 'fs',
  configured: true,
  status: { state: 'connected', toolCount: 1 },
  tools: [TOOL],
  truncated: false,
};

test('returns the servers and their tools from a well-formed payload', () => {
  // Act
  const servers = parseToolsPayload([SERVER]);

  // Assert
  assert.deepEqual(servers, [SERVER]);
});

test('returns undefined when the payload is not a list', () => {
  // Act & Assert
  assert.equal(parseToolsPayload({ servers: [SERVER] }), undefined);
  assert.equal(parseToolsPayload(undefined), undefined);
});

test('returns undefined when a server has no name', () => {
  // Arrange
  const { name: _name, ...nameless } = SERVER;

  // Act & Assert
  assert.equal(parseToolsPayload([nameless]), undefined);
});

test('returns undefined when a tool lacks its full name or description flag', () => {
  // Arrange
  const { description: _description, ...noDescription } = TOOL;
  const { descriptionTruncated: _flag, ...noFlag } = TOOL;

  // Act & Assert
  assert.equal(parseToolsPayload([{ ...SERVER, tools: [noDescription] }]), undefined);
  assert.equal(parseToolsPayload([{ ...SERVER, tools: [noFlag] }]), undefined);
});

test('returns undefined when a server status has no state', () => {
  // Act & Assert
  assert.equal(parseToolsPayload([{ ...SERVER, status: { toolCount: 1 } }]), undefined);
});

test('keeps an empty list of servers as an empty list', () => {
  // Act & Assert
  assert.deepEqual(parseToolsPayload([]), []);
});
