/** Category dictionary admin API: defaults, revision guard, validation and round-trip. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AdminApiError } from '../src/admin/servers.ts';
import {
  createAdminCategoriesHandler,
  parseCategoryDictionary,
  readCategoryDictionary,
} from '../src/admin/categories.ts';
import type { SettingsStore, StoredSettings } from '../src/admin/settings.ts';

function memoryStore(initial: StoredSettings = {}, revision = 1): SettingsStore {
  let settings = { ...initial };
  let current = revision;
  return {
    read: async () => ({ settings, revision: current }),
    replace: async (next, expected) => {
      if (expected !== current) {
        throw new AdminApiError(409, 'REVISION_CONFLICT', 'revision conflict', {
          expected,
          current,
        });
      }
      settings = { ...next };
      current += 1;
      return { settings, revision: current };
    },
  };
}

test('GET /categories returns the built-in dictionary until it is replaced', async () => {
  const handler = createAdminCategoriesHandler({ settings: memoryStore({ capacity: {} }, 3) });
  const response = await handler({ method: 'GET', path: '/categories' });
  assert.equal(response?.status, 200);
  const body = response?.body as {
    categories: Array<{ key: string; zh: string; en: string }>;
    revision: number;
  };
  assert.equal(body.revision, 3);
  assert.ok(body.categories.length >= 15);
  assert.deepEqual(
    body.categories.find((category) => category.key === 'official'),
    { key: 'official', zh: '官方', en: 'Official' },
  );
  assert.deepEqual(
    body.categories.find((category) => category.key === 'database'),
    { key: 'database', zh: '数据库', en: 'Database' },
  );
  for (const key of ['builtin', 'filesystem', 'search', 'web', 'browser', 'ai', 'dev', 'ops', 'docs', 'messaging', 'memory', 'security', 'testing']) {
    assert.ok(body.categories.some((category) => category.key === key), key);
  }
});

test('an explicitly saved empty dictionary stays empty', async () => {
  const handler = createAdminCategoriesHandler({ settings: memoryStore({ categoryDictionary: [] }, 2) });
  const response = await handler({ method: 'GET', path: '/categories' });
  assert.deepEqual(response?.body, { categories: [], revision: 2 });
});

test('PUT /categories replaces the dictionary and preserves other settings', async () => {
  const store = memoryStore({ capacity: { maxWorkers: 4 }, categoryDictionary: [{ key: 'old', zh: '旧', en: 'Old' }] }, 7);
  const handler = createAdminCategoriesHandler({ settings: store });
  const body = {
    categories: [
      { key: 'db', zh: '数据库', en: 'Database' },
      { key: 'sql.read', zh: '只读查询', en: 'Read-only query' },
    ],
  };
  const put = await handler({
    method: 'PUT',
    path: '/categories',
    headers: { 'if-match': '"7"' },
    body,
  });
  assert.equal(put?.status, 200);
  assert.deepEqual(put?.body, { categories: body.categories, revision: 8 });

  const get = await handler({ method: 'GET', path: '/categories' });
  assert.deepEqual(get?.body, { categories: body.categories, revision: 8 });

  const stored = await store.read();
  assert.deepEqual(stored.settings['capacity'], { maxWorkers: 4 });
  assert.deepEqual(stored.settings['categoryDictionary'], body.categories);
});

test('PUT /categories rejects malformed entries, duplicate keys and too many entries', async () => {
  const handler = createAdminCategoriesHandler({ settings: memoryStore() });
  const cases = [
    { categories: 'nope' },
    { categories: [{ key: 'Upper', zh: '大写', en: 'Upper' }] },
    { categories: [{ key: 'db', zh: '', en: 'Database' }] },
    { categories: [{ key: 'db', zh: '数据库', en: 'Database' }, { key: 'db', zh: '库', en: 'DB' }] },
    {
      categories: Array.from({ length: 101 }, (_entry, index) => ({
        key: `cat${index}`,
        zh: `分类${index}`,
        en: `Category ${index}`,
      })),
    },
  ];
  for (const body of cases) {
    const response = await handler({
      method: 'PUT',
      path: '/categories',
      headers: { 'if-match': '1' },
      body,
    });
    assert.equal(response?.status, 422, JSON.stringify(body).slice(0, 120));
    assert.equal(
      (response?.body as { error?: { code?: string } } | undefined)?.error?.code,
      'INVALID_CATEGORIES',
    );
  }
});

test('PUT /categories without If-Match or with a stale revision is refused', async () => {
  const handler = createAdminCategoriesHandler({ settings: memoryStore() });
  const missing = await handler({ method: 'PUT', path: '/categories', body: { categories: [] } });
  assert.equal(missing?.status, 400);

  const stale = await handler({
    method: 'PUT',
    path: '/categories',
    headers: { 'if-match': '9' },
    body: { categories: [] },
  });
  assert.equal(stale?.status, 409);
  assert.equal(
    (stale?.body as { error?: { code?: string } } | undefined)?.error?.code,
    'REVISION_CONFLICT',
  );
});

test('readCategoryDictionary skips malformed stored entries', () => {
  assert.deepEqual(
    readCategoryDictionary({
      categoryDictionary: [
        { key: 'db', zh: '数据库', en: 'Database' },
        { key: 'bad key', zh: '坏', en: 'Bad' },
        { key: 'db', zh: '重复', en: 'Dup' },
        'nope',
      ],
    }),
    [{ key: 'db', zh: '数据库', en: 'Database' }],
  );
  assert.deepEqual(readCategoryDictionary({ categoryDictionary: 'nope' }), []);
});

test('parseCategoryDictionary trims labels and keys', () => {
  assert.deepEqual(parseCategoryDictionary([{ key: ' db ', zh: ' 数据库 ', en: ' Database ' }]), [
    { key: 'db', zh: '数据库', en: 'Database' },
  ]);
});
