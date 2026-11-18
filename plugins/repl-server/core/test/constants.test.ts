import assert from 'node:assert/strict';
import test from 'node:test';

import { LIMITS } from '../src/constants.ts';
import { newId } from '../src/ids.ts';

test('frozen defaults match the design docs', () => {
  assert.equal(LIMITS.syncMs, 5_000);
  assert.equal(LIMITS.syncDefaultMs, 30_000);
  assert.equal(LIMITS.syncMaxMs, 600_000);
  assert.equal(LIMITS.asyncDefaultMs, 7_200_000);
  assert.equal(LIMITS.asyncMaxMs, 7_200_000);
  assert.equal(LIMITS.callsLimit, 50_000);
  assert.equal(LIMITS.inFlightPerExecSession, 8);
  assert.equal(LIMITS.taskTtlMs, 9_000_000);
});

test('ids carry a stable prefix and are unique', () => {
  const a = newId('task');
  const b = newId('task');
  assert.match(a, /^t_[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});
