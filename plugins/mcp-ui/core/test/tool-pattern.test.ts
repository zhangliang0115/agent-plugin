import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coveringWildcard, matchesToolPattern } from '../src/tool-pattern.ts';

test('matches a name exactly, or by prefix when the pattern ends in a star', () => {
  // Act & Assert
  assert.equal(matchesToolPattern('mcp__fs__read', ['mcp__fs__read']), true);
  assert.equal(matchesToolPattern('mcp__fs__read', ['mcp__fs__*']), true);
  assert.equal(matchesToolPattern('mcp__fs__read', ['mcp__git__*']), false);
});

test('reports the first trailing-star pattern that covers a name, and ignores exact entries', () => {
  // Act & Assert
  assert.equal(coveringWildcard('mcp__fs__read', ['mcp__fs__read']), undefined);
  assert.equal(coveringWildcard('mcp__fs__read', ['mcp__fs__read', 'mcp__fs__*']), 'mcp__fs__*');
  assert.equal(coveringWildcard('mcp__fs__read', ['mcp__git__*']), undefined);
});
