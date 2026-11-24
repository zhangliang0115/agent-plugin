import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCKED_CATEGORY_KEYS,
  LOCKED_TAG_KEYS,
  isLockedCategoryKey,
  isLockedTagKey,
  unusedTagKeys,
} from '../src/lib/tags.ts';

test('isLockedTagKey locks every built-in tag and the env.* namespace', () => {
  assert.equal(LOCKED_TAG_KEYS.size, 20);
  for (const key of LOCKED_TAG_KEYS) assert.equal(isLockedTagKey(key), true, key);
  assert.equal(isLockedTagKey('env.qa'), true);
  assert.equal(isLockedTagKey('sentry'), false);
  assert.equal(isLockedTagKey('dev'), false);
});

test('isLockedCategoryKey locks every built-in category', () => {
  assert.equal(LOCKED_CATEGORY_KEYS.size, 10);
  for (const key of LOCKED_CATEGORY_KEYS) assert.equal(isLockedCategoryKey(key), true, key);
  assert.equal(isLockedCategoryKey('sql'), false);
});

test('unusedTagKeys keeps referenced and locked keys, normalizes case', () => {
  const unused = unusedTagKeys(
    [
      { key: 'official' },
      { key: 'env.dev' },
      { key: 'dev' },
      { key: 'unused-tag' },
      { key: '  Spaced-Tag  ' },
      { key: '' },
    ],
    new Set(['dev', 'spaced-tag']),
  );
  assert.deepEqual(unused, ['unused-tag']);
});
