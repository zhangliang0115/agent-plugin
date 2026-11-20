import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listOptions,
  mergeBindings,
  mergeValues,
} from '../src/lib/filter-options.ts';

test('mergeValues keeps a stable sorted union and skips empty strings', () => {
  const first = mergeValues([], ['b', 'a', '']);
  assert.deepEqual(first, ['a', 'b']);
  const second = mergeValues(first, ['a', 'c']);
  assert.deepEqual(second, ['a', 'b', 'c']);
  assert.equal(mergeValues(second, ['a', 'b']), second, 'no new value keeps the same array');
});

test('mergeBindings upgrades an id-only label once a real label arrives', () => {
  const seeded = mergeBindings([], [{ value: 'cb_1', label: 'cb_1' }]);
  const upgraded = mergeBindings(seeded, [{ value: 'cb_1', label: 'Kiro (cb_1)' }]);
  assert.deepEqual(upgraded, [{ value: 'cb_1', label: 'Kiro (cb_1)' }]);
  assert.deepEqual(
    mergeBindings(upgraded, [{ value: 'cb_2', label: 'cb_2' }]),
    [
      { value: 'cb_1', label: 'Kiro (cb_1)' },
      { value: 'cb_2', label: 'cb_2' },
    ],
  );
  assert.equal(mergeBindings(upgraded, [{ value: 'cb_1', label: 'cb_1' }]), upgraded);
});

test('listOptions maps raw values to labelled options', () => {
  assert.deepEqual(listOptions(['tools/call']), [
    { value: 'tools/call', label: 'tools/call' },
  ]);
});
