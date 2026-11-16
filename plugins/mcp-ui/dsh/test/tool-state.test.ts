import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCheckState } from '../src/client/tool-state.ts';

test('saves and matches the full model-facing name, not the raw tool name', () => {
  // Act
  const state = toolCheckState('echo', 'slow', ['mcp__echo__slow']);

  // Assert
  assert.equal(state.fullName, 'mcp__echo__slow');
  assert.equal(state.checked, true);
  assert.equal(state.disabled, false);
});

test('a raw name left in the list from an older build does not count as checked', () => {
  // Act
  const state = toolCheckState('echo', 'slow', ['slow']);

  // Assert
  assert.equal(state.checked, false);
});

test('a server-wide pattern checks and locks every tool of that server only', () => {
  // Act
  const own = toolCheckState('echo', 'slow', ['mcp__echo__*']);
  const other = toolCheckState('fs', 'read', ['mcp__echo__*']);

  // Assert
  assert.deepEqual({ checked: own.checked, disabled: own.disabled, cover: own.cover }, { checked: true, disabled: true, cover: 'mcp__echo__*' });
  assert.equal(other.checked, false);
  assert.equal(other.disabled, false);
});

test('an unchecked tool is neither checked nor locked', () => {
  // Act
  const state = toolCheckState('echo', 'echo', []);

  // Assert
  assert.deepEqual({ checked: state.checked, disabled: state.disabled, cover: state.cover }, { checked: false, disabled: false, cover: undefined });
});
