/** Row action matrix: builtin, disabled, ready, idle/failed and transient servers. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { serverRowActions } from '../src/lib/server-actions.ts';

const keys = (plan: ReturnType<typeof serverRowActions>): string[] => [
  ...plan.primary.map((action) => action.key),
  ...plan.more.map((action) => action.key),
];

test('builtin servers only expose edit', () => {
  const plan = serverRowActions({ transport: 'builtin', state: 'ready', enabled: true }, false);
  assert.deepEqual(keys(plan), ['edit']);
  assert.deepEqual(plan.more, []);
});

test('disabled servers expose edit and delete', () => {
  const plan = serverRowActions({ transport: 'stdio', state: 'disabled', enabled: false }, false);
  assert.deepEqual(plan.primary.map((action) => action.key), ['edit', 'delete']);
  assert.deepEqual(plan.more, []);
});

test('ready servers keep connect actions visible and fold the rest into more', () => {
  const plan = serverRowActions({ transport: 'http', state: 'ready', enabled: true }, false);
  assert.deepEqual(plan.primary.map((action) => action.key), ['disconnect', 'restart', 'edit']);
  assert.deepEqual(plan.more.map((action) => action.key), ['test', 'detail', 'delete']);
  assert.ok(plan.primary.length <= 3);
});

test('idle and failed servers offer connect', () => {
  for (const state of ['idle', 'failed']) {
    const plan = serverRowActions({ transport: 'stdio', state, enabled: true }, false);
    assert.deepEqual(plan.primary.map((action) => action.key), ['connect', 'restart', 'edit']);
    assert.deepEqual(plan.more.map((action) => action.key), ['test', 'detail', 'delete']);
  }
});

test('transient servers show a disabled progress action and stop', () => {
  for (const state of ['starting', 'connecting', 'reconnecting']) {
    const plan = serverRowActions({ transport: 'stdio', state, enabled: true }, false);
    assert.deepEqual(plan.primary.map((action) => action.label), ['进行中', '停止']);
    assert.equal(plan.primary[0]?.disabled, true);
    assert.deepEqual(plan.more, []);
  }
});

test('a running operation disables repeat actions but keeps edit and detail', () => {
  const plan = serverRowActions({ transport: 'stdio', state: 'ready', enabled: true }, true);
  assert.equal(plan.primary.find((action) => action.key === 'disconnect')?.disabled, true);
  assert.equal(plan.primary.find((action) => action.key === 'restart')?.disabled, true);
  assert.equal(plan.primary.find((action) => action.key === 'edit')?.disabled, undefined);
  assert.equal(plan.more.find((action) => action.key === 'test')?.disabled, true);
  assert.equal(plan.more.find((action) => action.key === 'detail')?.disabled, undefined);
  assert.equal(plan.more.find((action) => action.key === 'delete')?.disabled, true);
});
