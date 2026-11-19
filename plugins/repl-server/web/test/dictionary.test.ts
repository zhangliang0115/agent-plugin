/** Label and option resolution shared by the tag/category dictionaries. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { dictionaryLabel, dictionarySelectOptions } from '../src/lib/dictionary.ts';

const entries = [
  { key: 'database', zh: '数据库', en: 'Database' },
  { key: 'search', zh: '搜索', en: 'Search' },
];

test('dictionaryLabel prefers the Chinese label and keeps unknown keys as-is', () => {
  assert.equal(dictionaryLabel(entries, 'database'), '数据库');
  assert.equal(dictionaryLabel(entries, 'legacy'), 'legacy');
  assert.equal(dictionaryLabel([], 'legacy'), 'legacy');
});

test('dictionarySelectOptions shows 中文 / English and marks an unregistered saved key', () => {
  assert.deepEqual(dictionarySelectOptions(entries), [
    { value: 'database', label: '数据库 / Database' },
    { value: 'search', label: '搜索 / Search' },
  ]);
  assert.deepEqual(dictionarySelectOptions(entries, 'legacy')[0], {
    value: 'legacy',
    label: 'legacy（未登记）',
  });
  assert.equal(dictionarySelectOptions(entries, 'database').length, 2);
  assert.equal(dictionarySelectOptions(entries, '').length, 2);
});
