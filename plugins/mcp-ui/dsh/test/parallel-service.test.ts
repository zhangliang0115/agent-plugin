import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createParallelService } from '../src/parallel-service.ts';

test('reports a tool as parallel when the live list names it', () => {
  // Arrange
  const service = createParallelService(() => ['mcp__fs__read']);

  // Act & Assert
  assert.equal(service.isParallel('mcp__fs__read'), true);
  assert.equal(service.isParallel('mcp__fs__write'), false);
});

test('reads the list on every call so a change takes effect without rebuilding the service', () => {
  // Arrange
  let live: string[] = [];
  const service = createParallelService(() => live);
  const before = service.isParallel('mcp__git__status');

  // Act
  live = ['mcp__git__*'];
  const after = service.isParallel('mcp__git__status');

  // Assert
  assert.equal(before, false);
  assert.equal(after, true);
});

test('honours trailing-star prefixes', () => {
  // Arrange
  const service = createParallelService(() => ['mcp__fs__*']);

  // Act & Assert
  assert.equal(service.isParallel('mcp__fs__read__file'), true);
  assert.equal(service.isParallel('mcp__git__status'), false);
});
