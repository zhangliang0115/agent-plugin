import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  denialMessage,
  isDisabled,
  toggleDisabled,
} from '../src/disabled-list.ts';

test('a tool is disabled when its exact name is listed', () => {
  // Arrange
  const disabled = ['mcp__fs__read'];

  // Act & Assert
  assert.equal(isDisabled('mcp__fs__read', disabled), true);
  assert.equal(isDisabled('mcp__fs__write', disabled), false);
});

test('a tool is disabled when a trailing-star prefix covers it', () => {
  // Arrange
  const disabled = ['mcp__fs__*'];

  // Act & Assert
  assert.equal(isDisabled('mcp__fs__write', disabled), true);
  assert.equal(isDisabled('mcp__git__status', disabled), false);
});

test('nothing is disabled when the list is empty', () => {
  // Act & Assert
  assert.equal(isDisabled('mcp__fs__read', []), false);
});

test('disabling a tool adds its exact name to a copy of the list', () => {
  // Arrange
  const before = ['mcp__git__status'];

  // Act
  const result = toggleDisabled(before, 'mcp__fs__read', true);

  // Assert
  assert.deepEqual(result, { ok: true, list: ['mcp__git__status', 'mcp__fs__read'] });
  assert.deepEqual(before, ['mcp__git__status']);
});

test('disabling a tool that is already listed leaves no duplicate', () => {
  // Act
  const result = toggleDisabled(['mcp__fs__read'], 'mcp__fs__read', true);

  // Assert
  assert.deepEqual(result, { ok: true, list: ['mcp__fs__read'] });
});

test('disabling a tool that a prefix already covers leaves the list unchanged', () => {
  // Act
  const result = toggleDisabled(['mcp__fs__*'], 'mcp__fs__read', true);

  // Assert
  assert.deepEqual(result, { ok: true, list: ['mcp__fs__*'] });
});

test('enabling a tool removes only its exact name', () => {
  // Arrange
  const before = ['mcp__fs__read', 'mcp__git__status'];

  // Act
  const result = toggleDisabled(before, 'mcp__fs__read', false);

  // Assert
  assert.deepEqual(result, { ok: true, list: ['mcp__git__status'] });
  assert.deepEqual(before, ['mcp__fs__read', 'mcp__git__status']);
});

test('enabling a tool that a prefix still covers reports the covering pattern and does not edit', () => {
  // Arrange
  const before = ['mcp__fs__read', 'mcp__fs__*'];

  // Act
  const result = toggleDisabled(before, 'mcp__fs__read', false);

  // Assert
  assert.deepEqual(result, { ok: false, cover: 'mcp__fs__*' });
  assert.deepEqual(before, ['mcp__fs__read', 'mcp__fs__*']);
});

test('enabling a tool covered only by a prefix reports that prefix', () => {
  // Act
  const result = toggleDisabled(['mcp__fs__*'], 'mcp__fs__write', false);

  // Assert
  assert.deepEqual(result, { ok: false, cover: 'mcp__fs__*' });
});

test('enabling a tool that is not listed leaves the list unchanged', () => {
  // Act
  const result = toggleDisabled(['mcp__git__status'], 'mcp__fs__read', false);

  // Assert
  assert.deepEqual(result, { ok: true, list: ['mcp__git__status'] });
});

test('builds the model-visible denial text with the tool name', () => {
  // Act & Assert
  assert.equal(denialMessage('mcp__fs__read'), '工具 mcp__fs__read 已被用户在 MCP 设置里禁用。');
});
