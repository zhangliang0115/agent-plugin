import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDefaultEvalTimeout, resolveDefaultMaxEvalMs } from '../src/exec/gateway.ts';

test('the default eval wall is opt-in and only applies without an explicit timeout', () => {
  assert.equal(resolveDefaultMaxEvalMs(0), 0);
  assert.equal(resolveDefaultMaxEvalMs(7_200_000), 7_200_000);
  assert.equal(resolveDefaultEvalTimeout(undefined, 0), undefined);
  assert.equal(resolveDefaultEvalTimeout(undefined, 7_200_000), 7_200_000);
  assert.equal(resolveDefaultEvalTimeout(5_000, 7_200_000), 5_000);
});

test('the default eval wall rejects negative and fractional values', () => {
  assert.throws(() => resolveDefaultMaxEvalMs(-1), RangeError);
  assert.throws(() => resolveDefaultMaxEvalMs(1.5), RangeError);
});
