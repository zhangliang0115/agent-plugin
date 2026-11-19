/** Tag dictionary admin API: revision guard, validation and round-trip. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AdminApiError } from '../src/admin/servers.ts';
import {
  createAdminTagsHandler,
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
  assert.ok(body.tags.length >= 10);
  assert.deepEqual(
    body.tags.find((tag) => tag.key === 'official'),
    { key: 'official', zh: '官方', en: 'Official' },
  );
});

test('an explicitly saved empty dictionary stays empty', async () => {
  const handler = createAdminTagsHandler({ settings: memoryStore({ tagDictionary: [] }, 2) });
  const response = await handler({ method: 'GET', path: '/tags' });
  assert.deepEqual(response?.body, { tags: [], revision: 2 });
});

test('PUT /tags replaces the dictionary and preserves other settings', async () => {
  const store = memoryStore({ capacity: { maxWorkers: 4 } }, 7);
  const handler = createAdminTagsHandler({ settings: store });
  const body = {
    tags: [
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
