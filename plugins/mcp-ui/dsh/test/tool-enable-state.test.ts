import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toolEnableState } from '../src/client/tool-state.ts';

test('an enabled tool is checked and not locked when nothing is disabled', () => {
  // Act
  const state = toolEnableState('echo', 'slow', []);

  // Assert
  assert.deepEqual(state, { fullName: 'mcp__echo__slow', enabled: true, cover: undefined });
});

test('a tool listed by its exact name is unchecked, and the box is not locked by a prefix', () => {
  // Act
  const state = toolEnableState('echo', 'slow', ['mcp__echo__slow']);

  // Assert
  assert.deepEqual(state, { fullName: 'mcp__echo__slow', enabled: false, cover: undefined });
});

test('a tool covered by a server prefix is unchecked and reports the covering pattern', () => {
  // Act
  const state = toolEnableState('echo', 'slow', ['mcp__echo__*']);

  // Assert
  assert.deepEqual(state, { fullName: 'mcp__echo__slow', enabled: false, cover: 'mcp__echo__*' });
});

test('a prefix on another server does not disable this tool', () => {
  // Act
  const state = toolEnableState('echo', 'slow', ['mcp__fs__*']);

  // Assert
  assert.equal(state.enabled, true);
  assert.equal(state.cover, undefined);
});

test('a tool listed exactly and also covered by a prefix reports the prefix as its cover', () => {
  // Act
  const state = toolEnableState('echo', 'slow', ['mcp__echo__slow', 'mcp__echo__*']);

  // Assert
  assert.deepEqual(state, { fullName: 'mcp__echo__slow', enabled: false, cover: 'mcp__echo__*' });
});
