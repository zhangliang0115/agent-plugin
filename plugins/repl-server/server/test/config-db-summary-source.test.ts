/** `ServerConfigPatch.summarySource` must reach the SQLite row through DbServerStore. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DbServerStore } from '../src/assembly-stores.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { getServer } from '../src/db/servers.ts';

test('DbServerStore forwards summarySource to the servers row', async (t) => {
  const db: DatabaseSync = openStateDb(':memory:');
  t.after(() => db.close());
  const store = new DbServerStore(db);

  const created = await store.create({
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: {},
    cwd: null,
    url: null,
    headers: {},
    enabled: true,
    connectMode: 'lazy',
    summary: 'AI 摘要',
    summarySource: 'ai',
    category: null,
    tags: [],
    timeoutMs: 60_000,
    maxConcurrency: 8,
  });
  assert.equal(created.server.summarySource, 'ai');

  const updated = await store.update(
    'pg',
    { summary: '人工摘要', summarySource: 'manual' },
    await store.revision(),
  );
  assert.equal(updated.server.summarySource, 'manual');
  assert.equal(getServer(db, 'pg')?.summarySource, 'manual');

  await store.update('pg', { summary: null, summarySource: null }, await store.revision());
  assert.equal(getServer(db, 'pg')?.summarySource, null);
});
