import assert from 'node:assert/strict';
import test from 'node:test';

import { toolFailedCount, toolStatsFrom, toolSuccessRate } from '../src/lib/tool-stats.ts';

const EMPTY = {
  callCount: 0,
  successCount: 0,
  successRate: null,
  lastCalledAt: null,
  modelBytes: { definition: 0, searchItem: 0, schema: 0, description: 0 },
};

test('toolStatsFrom reads call counters and model bytes', () => {
  assert.deepEqual(
    toolStatsFrom({
      callCount: 12,
      successCount: 11,
      successRate: 0.9166666666666666,
      lastCalledAt: '2026-11-24T08:30:00.000Z',
      modelBytes: { definition: 1536, searchItem: 512, schema: 1024, description: 200 },
    }),
    {
      callCount: 12,
      successCount: 11,
      successRate: 0.9166666666666666,
      lastCalledAt: '2026-11-24T08:30:00.000Z',
      modelBytes: { definition: 1536, searchItem: 512, schema: 1024, description: 200 },
    },
  );
});

test('toolStatsFrom defaults missing and malformed fields for older backends', () => {
  assert.deepEqual(toolStatsFrom({}), EMPTY);
  assert.deepEqual(toolStatsFrom(null), EMPTY);
  assert.deepEqual(
    toolStatsFrom({
      callCount: -3,
      successCount: '9',
      successRate: Number.NaN,
      lastCalledAt: 42,
      modelBytes: { definition: 1024, schema: -1 },
    }),
    {
      callCount: 0,
      successCount: 0,
      successRate: null,
      lastCalledAt: null,
      modelBytes: { definition: 1024, searchItem: 0, schema: 0, description: 0 },
    },
  );
});

test('toolSuccessRate accepts fractions, percentages and the counter fallback', () => {
  assert.equal(toolSuccessRate({ callCount: 4, successCount: 3, successRate: 0.75 }), 0.75);
  assert.equal(toolSuccessRate({ callCount: 4, successCount: 3, successRate: 75 }), 0.75);
  assert.equal(toolSuccessRate({ callCount: 4, successCount: 3, successRate: null }), 0.75);
  assert.equal(toolSuccessRate({ callCount: 4, successCount: 3, successRate: 250 }), 0.75);
  assert.equal(toolSuccessRate({ callCount: 0, successCount: 0, successRate: null }), null);
});

test('toolFailedCount clamps counters so a bad success count stays readable', () => {
  assert.equal(toolFailedCount({ callCount: 12, successCount: 11 }), 1);
  assert.equal(toolFailedCount({ callCount: 12, successCount: 10 }), 2);
  assert.equal(toolFailedCount({ callCount: 0, successCount: 0 }), 0);
  assert.equal(toolFailedCount({ callCount: 1, successCount: 2 }), 0);
});
