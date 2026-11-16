import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDisabledService, isDisabledNow } from '../src/disabled-service.ts';

test('reports a tool as disabled when the live list names it exactly or by prefix', () => {
  // Arrange
  const service = createDisabledService(() => ['mcp__fs__read', 'mcp__git__*']);

  // Act & Assert
  assert.equal(service.isDisabled('mcp__fs__read'), true);
  assert.equal(service.isDisabled('mcp__git__status'), true);
  assert.equal(service.isDisabled('mcp__fs__write'), false);
});

test('reads the list on every call, so a change applies to the next query', () => {
  // Arrange
  const live: string[] = [];
  const service = createDisabledService(() => live);

  // Act
  const before = service.isDisabled('mcp__fs__read');
  live.push('mcp__fs__read');
  const after = service.isDisabled('mcp__fs__read');

  // Assert
  assert.deepEqual({ before, after }, { before: false, after: true });
});

test('treats a throwing read as nothing disabled and never throws', () => {
  // Arrange
  const service = createDisabledService(() => {
    throw new Error('config unavailable');
  });

  // Act & Assert
  assert.equal(isDisabledNow('mcp__fs__read', () => {
    throw new Error('config unavailable');
  }), false);
  assert.equal(service.isDisabled('mcp__fs__read'), false);
});
