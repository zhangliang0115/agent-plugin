import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDefaultEvalTimeout, resolveDefaultMaxEvalMs } from '../src/exec/gateway.ts';
import {
  MAX_ASYNC_EVAL_MS,
  MAX_SYNC_EVAL_MS,
  clampEvalTimeout,
} from '../src/exec/gateway.ts';

test('an explicit timeout is clamped to the L2 ceiling instead of rejected', () => {
  assert.equal(clampEvalTimeout(undefined, false), undefined);
  assert.equal(clampEvalTimeout(5_000, false), 5_000);
  assert.equal(clampEvalTimeout(5_000, true), 5_000);
  assert.equal(clampEvalTimeout(MAX_SYNC_EVAL_MS + 1, false), MAX_SYNC_EVAL_MS);
  assert.equal(clampEvalTimeout(MAX_SYNC_EVAL_MS + 1, true), MAX_SYNC_EVAL_MS + 1);
  assert.equal(clampEvalTimeout(MAX_ASYNC_EVAL_MS * 4, true), MAX_ASYNC_EVAL_MS);
});

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
