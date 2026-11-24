/** Tag dictionary admin API: revision guard, validation and round-trip. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AdminApiError } from '../src/admin/servers.ts';
import {
  DEFAULT_TAG_DICTIONARY,
  appendTagDictionary,
  createAdminTagsHandler,
  isLockedTagKey,
  parseTagDictionary,
  readTagDictionary,
} from '../src/admin/tags.ts';
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

test('GET /tags returns the built-in dictionary until it is replaced', async () => {
  const handler = createAdminTagsHandler({ settings: memoryStore({ capacity: {} }, 3) });
  const response = await handler({ method: 'GET', path: '/tags' });
  assert.equal(response?.status, 200);
  const body = response?.body as { tags: Array<{ key: string; zh: string; en: string }>; revision: number };
  assert.equal(body.revision, 3);
  assert.equal(body.tags.length, 20);
  assert.deepEqual(
    body.tags.find((tag) => tag.key === 'official'),
    { key: 'official', zh: '官方', en: 'Official' },
  );
  for (const key of [
    'builtin',
    'env.dev',
    'env.test',
    'env.pre',
    'env.prod',
    'cross-env',
    'memory',
    'docs',
    'testing',
    'security',
    'mysql',
    'postgresql',
    'elasticsearch',
    'redis',
    'prometheus',
    'apm',
    'gitlab',
    'browser',
    'computer-use',
  ]) {
    assert.ok(body.tags.some((tag) => tag.key === key), key);
  }
});

const LEGACY_TAG_DEFAULT = [
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
  const upgraded = readTagDictionary({ tagDictionary: LEGACY_TAG_DEFAULT });
  assert.equal(upgraded.length, 20);
  assert.ok(upgraded.some((tag) => tag.key === 'env.prod'));
  assert.ok(!upgraded.some((tag) => tag.key === 'database'));
});

test('a reordered old default is kept as-is', () => {
  const reordered = [...LEGACY_TAG_DEFAULT].reverse();
  assert.deepEqual(readTagDictionary({ tagDictionary: reordered }), reordered);
});

test('the old 15 keys with a changed label are kept as-is', () => {
  for (const changed of ['zh', 'en'] as const) {
    const relabelled = LEGACY_TAG_DEFAULT.map((entry, index) =>
      index === 2 ? { ...entry, [changed]: `${entry[changed]} 自定义` } : entry,
    );
    assert.deepEqual(readTagDictionary({ tagDictionary: relabelled }), relabelled, changed);
  }
});

test('a custom subset of the old keys is kept as-is', () => {
  const subset = LEGACY_TAG_DEFAULT.slice(0, 5);
  assert.deepEqual(readTagDictionary({ tagDictionary: subset }), subset);
});

test('a customised dictionary is kept as-is', () => {
  const custom = [
    { key: 'db', zh: '数据库', en: 'Database' },
    { key: 'custom', zh: '自定义', en: 'Custom' },
  ];
  assert.deepEqual(readTagDictionary({ tagDictionary: custom }), custom);
});

test('appendTagDictionary adds only unknown keys and keeps existing labels', () => {
  const settings: StoredSettings = {
    tagDictionary: [{ key: 'docs', zh: '文档', en: 'Docs' }],
  };
  const result = appendTagDictionary(settings, [
    { key: 'docs', zh: '重复', en: 'Duplicate' },
    { key: 'postgresql', zh: 'PostgreSQL', en: 'PostgreSQL' },
  ]);
  assert.deepEqual(result.added, [
    { key: 'postgresql', zh: 'PostgreSQL', en: 'PostgreSQL' },
  ]);
  assert.deepEqual(result.tags, [
    { key: 'docs', zh: '文档', en: 'Docs' },
    { key: 'postgresql', zh: 'PostgreSQL', en: 'PostgreSQL' },
  ]);
});

test('action keys are rejected by the tag dictionary and dropped from stale settings', () => {
  assert.throws(
    () => parseTagDictionary([{ key: 'read', zh: '只读', en: 'Read-only' }]),
    (error: unknown) => error instanceof AdminApiError && error.code === 'INVALID_TAGS',
  );
  assert.throws(
    () => appendTagDictionary({}, [{ key: 'write', zh: '写入', en: 'Write' }]),
    (error: unknown) => error instanceof AdminApiError && error.code === 'INVALID_TAGS',
  );
  const stale = readTagDictionary({
    tagDictionary: [
      { key: 'read', zh: '只读', en: 'Read-only' },
      { key: 'docs', zh: '文档', en: 'Docs' },
    ],
  });
  assert.deepEqual(stale, [{ key: 'docs', zh: '文档', en: 'Docs' }]);
});

test('every built-in tag key is locked, custom keys are not', () => {
  for (const tag of DEFAULT_TAG_DICTIONARY) {
    assert.equal(isLockedTagKey(tag.key), true, tag.key);
  }
  assert.equal(isLockedTagKey('env.qa'), true);
  assert.equal(isLockedTagKey('sentry'), false);
  assert.equal(isLockedTagKey('kimi'), false);
});

test('PUT /tags refuses to drop or relabel system-managed tags', async () => {
  const store = memoryStore({}, 1);
  const handler = createAdminTagsHandler({ settings: store });
  const current = (await handler({ method: 'GET', path: '/tags' }))?.body as {
    tags: Array<{ key: string; zh: string; en: string }>;
  };

  const dropped = await handler({
    method: 'PUT',
    path: '/tags',
    headers: { 'if-match': '"1"' },
    body: { tags: current.tags.filter((tag) => tag.key !== 'official') },
  });
  assert.equal(dropped?.status, 422);
  assert.match(
    String((dropped?.body as { error?: { message?: string } }).error?.message),
    /system-managed/,
  );

  const relabelled = await handler({
    method: 'PUT',
    path: '/tags',
    headers: { 'if-match': '"1"' },
    body: {
      tags: current.tags.map((tag) =>
        tag.key === 'env.prod' ? { ...tag, zh: 'Prod' } : tag,
      ),
    },
  });
  assert.equal(relabelled?.status, 422);

  const droppedBuiltin = await handler({
    method: 'PUT',
    path: '/tags',
    headers: { 'if-match': '"1"' },
    body: { tags: current.tags.filter((tag) => tag.key !== 'memory') },
  });
  assert.equal(droppedBuiltin?.status, 422);
});

test('PUT /tags accepts the effective dictionary verbatim', async () => {
  const store = memoryStore({}, 1);
  const handler = createAdminTagsHandler({ settings: store });
  const current = (await handler({ method: 'GET', path: '/tags' }))?.body as {
    tags: Array<{ key: string; zh: string; en: string }>;
    revision: number;
  };

  const put = await handler({
    method: 'PUT',
    path: '/tags',
    headers: { 'if-match': '"1"' },
    body: { tags: current.tags },
  });
  assert.equal(put?.status, 200);
  assert.equal((put?.body as { tags: unknown[] }).tags.length, 20);
  assert.deepEqual(
    (await store.read()).settings['tagDictionary'],
    current.tags,
    'the submission is stored verbatim',
  );
});

test('appendTagDictionary refuses to exceed the 200-entry limit', () => {
  const full = Array.from({ length: 200 }, (_entry, index) => ({
    key: `tag${index}`,
    zh: `标签${index}`,
    en: `Tag ${index}`,
  }));
  assert.throws(
    () => appendTagDictionary({ tagDictionary: full }, [{ key: 'extra', zh: '额外', en: 'Extra' }]),
    (error: unknown) => error instanceof AdminApiError && error.code === 'INVALID_TAGS',
  );

  const lastSlot = appendTagDictionary({ tagDictionary: full.slice(0, 199) }, [
    { key: 'extra', zh: '额外', en: 'Extra' },
  ]);
  assert.equal(lastSlot.tags.length, 200);
  assert.deepEqual(lastSlot.added, [{ key: 'extra', zh: '额外', en: 'Extra' }]);
});

test('an explicitly saved empty dictionary stays empty', async () => {
  const handler = createAdminTagsHandler({ settings: memoryStore({ tagDictionary: [] }, 2) });
  const response = await handler({ method: 'GET', path: '/tags' });
  assert.deepEqual(response?.body, { tags: [], revision: 2 });
});

test('PUT /tags replaces the dictionary and preserves other settings', async () => {
  const store = memoryStore(
    {
      capacity: { maxWorkers: 4 },
      tagDictionary: [
        { key: 'official', zh: '官方', en: 'Official' },
        { key: 'builtin', zh: '内置', en: 'Built-in' },
        { key: 'db', zh: '数据库', en: 'Database' },
      ],
    },
    7,
  );
  const handler = createAdminTagsHandler({ settings: store });
  const body = {
    tags: [
      { key: 'official', zh: '官方', en: 'Official' },
      { key: 'builtin', zh: '内置', en: 'Built-in' },
      { key: 'db', zh: '数据库', en: 'Database' },
      { key: 'sql.read', zh: '只读查询', en: 'Read-only query' },
    ],
  };
  const put = await handler({
    method: 'PUT',
    path: '/tags',
    headers: { 'if-match': '"7"' },
    body,
  });
  assert.equal(put?.status, 200);
  assert.deepEqual(put?.body, { tags: body.tags, revision: 8 });

  const get = await handler({ method: 'GET', path: '/tags' });
  assert.deepEqual(get?.body, { tags: body.tags, revision: 8 });

  const stored = await store.read();
  assert.deepEqual(stored.settings['capacity'], { maxWorkers: 4 });
});

test('PUT /tags rejects malformed entries and duplicate keys', async () => {
  const handler = createAdminTagsHandler({ settings: memoryStore() });
  const cases = [
    { tags: 'nope' },
    { tags: [{ key: 'Upper', zh: '大写', en: 'Upper' }] },
    { tags: [{ key: 'db', zh: '', en: 'Database' }] },
    { tags: [{ key: 'db', zh: '数据库', en: 'Database' }, { key: 'db', zh: '库', en: 'DB' }] },
  ];
  for (const body of cases) {
    const response = await handler({
      method: 'PUT',
      path: '/tags',
      headers: { 'if-match': '1' },
      body,
    });
    assert.equal(response?.status, 422, JSON.stringify(body));
  }
});

test('PUT /tags without If-Match or with a stale revision is refused', async () => {
  const handler = createAdminTagsHandler({ settings: memoryStore() });
  const missing = await handler({ method: 'PUT', path: '/tags', body: { tags: [] } });
  assert.equal(missing?.status, 400);

  const stale = await handler({
    method: 'PUT',
    path: '/tags',
    headers: { 'if-match': '9' },
    body: { tags: [] },
  });
  assert.equal(stale?.status, 409);
});

test('readTagDictionary skips malformed stored entries', () => {
  assert.deepEqual(
    readTagDictionary({
      tagDictionary: [
        { key: 'db', zh: '数据库', en: 'Database' },
        { key: 'bad key', zh: '坏', en: 'Bad' },
        { key: 'db', zh: '重复', en: 'Dup' },
        'nope',
      ],
    }),
    [{ key: 'db', zh: '数据库', en: 'Database' }],
  );
  assert.deepEqual(readTagDictionary({ tagDictionary: 'nope' }), []);
});

test('parseTagDictionary trims labels and keys', () => {
  assert.deepEqual(parseTagDictionary([{ key: ' db ', zh: ' 数据库 ', en: ' Database ' }]), [
    { key: 'db', zh: '数据库', en: 'Database' },
  ]);
});
