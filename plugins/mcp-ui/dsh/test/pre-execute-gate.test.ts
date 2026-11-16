import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDisabledToolGate } from '../src/pre-execute-gate.ts';

const ALLOWED = { kind: 'allow' } as const;

/** A `next` that records how often the chain continued past this listener. */
function chain() {
  let calls = 0;
  const next = async () => {
    calls += 1;
    return ALLOWED;
  };
  return { next, calls: () => calls };
}

test('denies a call to a disabled tool with the model-visible text and does not continue the chain', async () => {
  // Arrange
  const gate = createDisabledToolGate(() => ['mcp__fs__read']);
  const { next, calls } = chain();

  // Act
  const decision = await gate({ name: 'mcp__fs__read' }, next);

  // Assert
  assert.deepEqual(decision, { kind: 'deny', reason: '工具 mcp__fs__read 已被用户在 MCP 设置里禁用。' });
  assert.equal(calls(), 0);
});

test('denies a call that a prefix pattern covers', async () => {
  // Arrange
  const gate = createDisabledToolGate(() => ['mcp__fs__*']);
  const { next } = chain();

  // Act
  const decision = await gate({ name: 'mcp__fs__write' }, next);

  // Assert
  assert.equal((decision as { kind: string }).kind, 'deny');
});

test('passes a call through unchanged when the tool is not listed', async () => {
  // Arrange
  const gate = createDisabledToolGate(() => ['mcp__git__status']);
  const { next, calls } = chain();

  // Act
  const decision = await gate({ name: 'mcp__fs__read' }, next);

  // Assert
  assert.equal(decision, ALLOWED);
  assert.equal(calls(), 1);
});

test('passes every call through when the list is empty', async () => {
  // Arrange
  const gate = createDisabledToolGate(() => []);
  const { next, calls } = chain();

  // Act
  const decision = await gate({ name: 'mcp__fs__read' }, next);

  // Assert
  assert.equal(decision, ALLOWED);
  assert.equal(calls(), 1);
});

test('passes the call through and never throws when reading the list fails', async () => {
  // Arrange
  const gate = createDisabledToolGate(() => {
    throw new Error('config unavailable');
  });
  const { next, calls } = chain();

  // Act
  const decision = await gate({ name: 'mcp__fs__read' }, next);

  // Assert
  assert.equal(decision, ALLOWED);
  assert.equal(calls(), 1);
});

test('lets an error from the rest of the chain propagate', async () => {
  // Arrange
  const gate = createDisabledToolGate(() => []);
  const failing = async () => {
    throw new Error('downstream failed');
  };

  // Act & Assert
  await assert.rejects(gate({ name: 'mcp__fs__read' }, failing), /downstream failed/);
});
