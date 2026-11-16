import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addParallel,
  allowsParallel,
  parallelPatternError,
  removeParallel,
  serverPattern,
  toggleParallel,
} from '../src/parallel-list.ts';

test('matches a tool name exactly when the pattern has no trailing star', () => {
  // Arrange
  const patterns = ['mcp__fs__read'];

  // Act & Assert
  assert.equal(allowsParallel('mcp__fs__read', patterns), true);
  assert.equal(allowsParallel('mcp__fs__read__file', patterns), false);
  assert.equal(allowsParallel('mcp__fs__write', patterns), false);
});

test('matches every name with the prefix when the pattern ends in a star', () => {
  // Arrange
  const patterns = ['mcp__fs__*'];

  // Act & Assert
  assert.equal(allowsParallel('mcp__fs__read', patterns), true);
  assert.equal(allowsParallel('mcp__fs__', patterns), true);
  assert.equal(allowsParallel('mcp__git__status', patterns), false);
});

test('matches nothing when the list is empty', () => {
  // Act & Assert
  assert.equal(allowsParallel('mcp__fs__read', []), false);
});

test('adds a pattern without mutating the input list', () => {
  // Arrange
  const before = ['mcp__fs__read'];

  // Act
  const after = addParallel(before, 'mcp__git__status');

  // Assert
  assert.deepEqual(after, ['mcp__fs__read', 'mcp__git__status']);
  assert.deepEqual(before, ['mcp__fs__read']);
});

test('adding an existing pattern leaves the list unchanged', () => {
  // Arrange
  const before = ['mcp__fs__read'];

  // Act
  const after = addParallel(before, '  mcp__fs__read ');

  // Assert
  assert.deepEqual(after, ['mcp__fs__read']);
});

test('adding an invalid pattern throws the validation message', () => {
  // Act & Assert
  assert.throws(() => addParallel([], 'mcp__*__read'), /只能出现在末尾/);
});

test('removes only the exact pattern', () => {
  // Arrange
  const before = ['mcp__fs__*', 'mcp__fs__read'];

  // Act
  const after = removeParallel(before, 'mcp__fs__read');

  // Assert
  assert.deepEqual(after, ['mcp__fs__*']);
});

test('toggles a pattern on and off', () => {
  // Arrange
  const start = ['mcp__fs__read'];

  // Act
  const on = toggleParallel(start, 'mcp__git__status', true);
  const off = toggleParallel(on, 'mcp__fs__read', false);

  // Assert
  assert.deepEqual(on, ['mcp__fs__read', 'mcp__git__status']);
  assert.deepEqual(off, ['mcp__git__status']);
});

test('builds the server-wide prefix pattern', () => {
  // Act & Assert
  assert.equal(serverPattern('fs'), 'mcp__fs__*');
});

test('rejects empty patterns, bare stars, and stars that are not at the end', () => {
  // Act & Assert
  assert.match(parallelPatternError('') ?? '', /不能为空/);
  assert.match(parallelPatternError('*') ?? '', /至少/);
  assert.match(parallelPatternError('mcp__*__read') ?? '', /只能出现在末尾/);
  assert.equal(parallelPatternError('mcp__fs__*'), undefined);
  assert.equal(parallelPatternError('mcp__fs__read'), undefined);
});
