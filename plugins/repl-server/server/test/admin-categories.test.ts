/** Category dictionary admin API: defaults, revision guard, validation and round-trip. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AdminApiError } from '../src/admin/servers.ts';
import {
  appendCategoryDictionary,
  createAdminCategoriesHandler,
  isLockedCategoryKey,
  parseCategoryDictionary,
  readCategoryDictionary,
} from '../src/admin/categories.ts';
import { DEFAULT_TAG_DICTIONARY } from '../src/admin/tags.ts';
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
  assert.deepEqual(
    body.categories.map((category) => category.key),
    [
      'database',
      'observability',
      'devtools',
      'ui-automation',
      'filesystem',
      'search',
      'messaging',
      'cloud',
      'ai',
      'other',
    ],
  );
  assert.deepEqual(
    body.categories.find((category) => category.key === 'database'),
    { key: 'database', zh: '数据库', en: 'Database' },
  );
});

test('default category keys never overlap tag keys', () => {
  const tagKeys = new Set(DEFAULT_TAG_DICTIONARY.map((tag) => tag.key));
  for (const category of readCategoryDictionary({})) {
    assert.equal(tagKeys.has(category.key), false, category.key);
  }
});

const LEGACY_CATEGORY_DEFAULT = [
  { key: 'official', zh: '官方', en: 'Official' },
  { key: 'builtin', zh: '内置', en: 'Built-in' },
  { key: 'database', zh: '数据库', en: 'Database' },
  { key: 'filesystem', zh: '文件系统', en: 'Filesystem' },
  { key: 'search', zh: '搜索', en: 'Search' },
  { key: 'web', zh: '网页', en: 'Web' },
  { key: 'browser', zh: '浏览器', en: 'Browser' },
  { key: 'ai', zh: '人工智能', en: 'AI' },
  { key: 'dev', zh: '开发', en: 'Development' },
  { key: 'ops', zh: '运维', en: 'Operations' },
  { key: 'docs', zh: '文档', en: 'Docs' },
  { key: 'messaging', zh: '消息', en: 'Messaging' },
  { key: 'memory', zh: '记忆', en: 'Memory' },
  { key: 'security', zh: '安全', en: 'Security' },
  { key: 'testing', zh: '测试', en: 'Testing' },
];

test('the old 15-entry default is upgraded on read', () => {
  const upgraded = readCategoryDictionary({ categoryDictionary: LEGACY_CATEGORY_DEFAULT });
  assert.equal(upgraded.length, 10);
  assert.ok(upgraded.some((category) => category.key === 'observability'));
  assert.ok(!upgraded.some((category) => category.key === 'official'));
});

test('a reordered old default is kept as-is', () => {
  const reordered = [...LEGACY_CATEGORY_DEFAULT].reverse();
  assert.deepEqual(readCategoryDictionary({ categoryDictionary: reordered }), reordered);
});

test('the old 15 keys with a changed label are kept as-is', () => {
  for (const changed of ['zh', 'en'] as const) {
    const relabelled = LEGACY_CATEGORY_DEFAULT.map((entry, index) =>
      index === 2 ? { ...entry, [changed]: `${entry[changed]} 自定义` } : entry,
    );
    assert.deepEqual(
      readCategoryDictionary({ categoryDictionary: relabelled }),
      relabelled,
      changed,
    );
  }
});

test('a custom subset of the old keys is kept as-is', () => {
  const subset = LEGACY_CATEGORY_DEFAULT.slice(0, 5);
  assert.deepEqual(readCategoryDictionary({ categoryDictionary: subset }), subset);
});

test('a customised dictionary is kept as-is', () => {
  const custom = [
    { key: 'db', zh: '数据库', en: 'Database' },
    { key: 'custom', zh: '自定义', en: 'Custom' },
  ];
  assert.deepEqual(readCategoryDictionary({ categoryDictionary: custom }), custom);
});

test('appendCategoryDictionary adds only unknown keys and keeps existing labels', () => {
  const settings: StoredSettings = {
    categoryDictionary: [{ key: 'database', zh: '数据库', en: 'Database' }],
  };
  const result = appendCategoryDictionary(settings, [
    { key: 'database', zh: '重复', en: 'Duplicate' },
    { key: 'observability', zh: '可观测性', en: 'Observability' },
  ]);
  assert.deepEqual(result.added, [
    { key: 'observability', zh: '可观测性', en: 'Observability' },
  ]);
  assert.deepEqual(result.categories, [
    { key: 'database', zh: '数据库', en: 'Database' },
    { key: 'observability', zh: '可观测性', en: 'Observability' },
  ]);
});

test('PUT /categories rejects the old 15-entry default while the built-in dictionary is in effect', async () => {
  const store = memoryStore({}, 1);
  const handler = createAdminCategoriesHandler({ settings: store });
  // The old default has no observability/devtools/ui-automation/cloud/other, so a
  // full replacement with it would drop built-in categories.
  const put = await handler({
    method: 'PUT',
    path: '/categories',
    headers: { 'if-match': '"1"' },
    body: { categories: LEGACY_CATEGORY_DEFAULT },
  });
  assert.equal(put?.status, 422);
  assert.equal(
    (put?.body as { error?: { code?: string } } | undefined)?.error?.code,
    'INVALID_CATEGORIES',
  );
  assert.deepEqual((await store.read()).settings['categoryDictionary'], undefined);
});

test('appendCategoryDictionary refuses to exceed the 100-entry limit', () => {
  const full = Array.from({ length: 100 }, (_entry, index) => ({
    key: `cat${index}`,
    zh: `分类${index}`,
    en: `Category ${index}`,
  }));
  assert.throws(
    () => appendCategoryDictionary({ categoryDictionary: full }, [{ key: 'extra', zh: '额外', en: 'Extra' }]),
    (error: unknown) => error instanceof AdminApiError && error.code === 'INVALID_CATEGORIES',
  );

  const lastSlot = appendCategoryDictionary({ categoryDictionary: full.slice(0, 99) }, [
    { key: 'extra', zh: '额外', en: 'Extra' },
  ]);
  assert.equal(lastSlot.categories.length, 100);
  assert.deepEqual(lastSlot.added, [{ key: 'extra', zh: '额外', en: 'Extra' }]);
});

test('an explicitly saved empty dictionary stays empty', async () => {
  const handler = createAdminCategoriesHandler({ settings: memoryStore({ categoryDictionary: [] }, 2) });
  const response = await handler({ method: 'GET', path: '/categories' });
  assert.deepEqual(response?.body, { categories: [], revision: 2 });
});

test('every built-in category key is locked, custom keys are not', () => {
  for (const key of [
    'database',
    'observability',
    'devtools',
    'ui-automation',
    'filesystem',
    'search',
    'messaging',
    'cloud',
    'ai',
    'other',
  ]) {
    assert.equal(isLockedCategoryKey(key), true, key);
  }
  assert.equal(isLockedCategoryKey('sql'), false);
});

test('PUT /categories refuses to drop or relabel built-in categories', async () => {
  const handler = createAdminCategoriesHandler({ settings: memoryStore({}, 1) });
  const current = (await handler({ method: 'GET', path: '/categories' }))?.body as {
    categories: Array<{ key: string; zh: string; en: string }>;
  };

  const dropped = await handler({
    method: 'PUT',
    path: '/categories',
    headers: { 'if-match': '"1"' },
    body: { categories: current.categories.filter((entry) => entry.key !== 'other') },
  });
  assert.equal(dropped?.status, 422);
  assert.match(
    String((dropped?.body as { error?: { message?: string } }).error?.message),
    /system-managed/,
  );

  const relabelled = await handler({
    method: 'PUT',
    path: '/categories',
    headers: { 'if-match': '"1"' },
    body: {
      categories: current.categories.map((entry) =>
        entry.key === 'database' ? { ...entry, en: 'DB' } : entry,
      ),
    },
  });
  assert.equal(relabelled?.status, 422);

  const kept = await handler({
    method: 'PUT',
    path: '/categories',
    headers: { 'if-match': '"1"' },
    body: {
      categories: [
        ...current.categories,
        { key: 'sql', zh: 'SQL', en: 'SQL' },
      ],
    },
  });
  assert.equal(kept?.status, 200);
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
