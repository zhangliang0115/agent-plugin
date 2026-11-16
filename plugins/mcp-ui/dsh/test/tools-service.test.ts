import { test } from 'node:test';
import assert from 'node:assert/strict';

import { McpToolsServiceImpl } from '../src/tools-service.ts';
import type { ToolsSource } from '../src/tools-watch.ts';

const SOURCE: ToolsSource = {
  list: () => [{ name: 'fs', configured: true, status: { state: 'connected', toolCount: 1 } }],
  definitions: () => [{ name: 'mcp__fs__read', description: 'Read a file' }],
  onChange: () => () => {},
};

test('carries the binding the Typert gateway looks for, pointing at itself', () => {
  // Arrange
  const service = new McpToolsServiceImpl(SOURCE);

  // Act
  const binding = service.typertRemote;

  // Assert: the gateway rejects a binding whose `service` is not the receiver itself.
  assert.equal(binding.service, service);
  assert.equal(binding.serviceKey, 'mcpTools');
  assert.equal(binding.namespace, 'mcpTools');
  assert.ok(Object.isFrozen(binding));
});

test('watch is a prototype method taking only the signal, which the gateway reads by name', () => {
  // Arrange
  const descriptor = Object.getOwnPropertyDescriptor(McpToolsServiceImpl.prototype, 'watch');

  // Assert
  assert.equal(typeof descriptor?.value, 'function');
  assert.match(Function.prototype.toString.call(descriptor?.value), /^watch\s*\(\s*signal\s*\)/);
});

test('watch streams the joined servers and tools', async () => {
  // Arrange
  const controller = new AbortController();
  const stream = new McpToolsServiceImpl(SOURCE).watch(controller.signal)[Symbol.asyncIterator]();

  // Act
  const first = await stream.next();
  controller.abort();

  // Assert
  assert.equal(first.value?.[0]?.tools[0]?.description, 'Read a file');
});
