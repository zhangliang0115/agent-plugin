import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { openStateDb } from '../src/db/migrate.ts';
import { createServer } from '../src/db/servers.ts';
import {
  getTool,
  markAbsentToolsStale,
  patchTool,
  upsertTool,
} from '../src/db/tools.ts';
import { getRevision } from '../src/db/meta.ts';

const SERVER_ID = 'srv_stale_test';

function fixture(t: TestContext): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'repl-server-stale-'));
  const db = openStateDb(join(dir, 'state.db'));
  t.after(() => {
    try {
      db.close();
    } catch {
      // closed by the test
    }
    rmSync(dir, { recursive: true, force: true });
  });
  createServer(db, {
    id: SERVER_ID,
    label: 'Stale test',
    transport: 'http',
    url: 'https://example.test/mcp',
  });
  for (const name of ['alpha', 'beta', 'gamma']) {
    upsertTool(db, SERVER_ID, { name, inputSchema: { type: 'object' } });
  }
  return { db, dir };
}

test('tools absent from tools/list become stale, present ones stay fresh', (t) => {
  const { db } = fixture(t);

  const changed = markAbsentToolsStale(db, SERVER_ID, ['alpha', 'beta']);

  assert.equal(changed, 1);
  assert.equal(getTool(db, SERVER_ID, 'alpha')?.stale, false);
  assert.equal(getTool(db, SERVER_ID, 'beta')?.stale, false);
  assert.equal(getTool(db, SERVER_ID, 'gamma')?.stale, true);
});

test('stale marking is idempotent and a returning tool becomes fresh again', (t) => {
  const { db } = fixture(t);

  assert.equal(markAbsentToolsStale(db, SERVER_ID, ['alpha']), 2);
  assert.equal(markAbsentToolsStale(db, SERVER_ID, ['alpha']), 0);

  upsertTool(db, SERVER_ID, { name: 'beta', inputSchema: { type: 'object' } });

  assert.equal(getTool(db, SERVER_ID, 'beta')?.stale, false);
  assert.equal(getTool(db, SERVER_ID, 'gamma')?.stale, true);
});

test('stale_override survives a stale pass; it preserves visibility, not callability', (t) => {
  const { db } = fixture(t);

  patchTool(db, SERVER_ID, 'gamma', { staleOverride: true });
  markAbsentToolsStale(db, SERVER_ID, ['alpha', 'beta']);

  const gamma = getTool(db, SERVER_ID, 'gamma');
  assert.equal(gamma?.stale, true);
  assert.equal(gamma?.staleOverride, true);
});

test('an empty tools/list marks the whole server stale and bumps the revision once', (t) => {
  const { db } = fixture(t);
  const before = getRevision(db);

  assert.equal(markAbsentToolsStale(db, SERVER_ID, []), 3);
  assert.equal(getRevision(db), before + 1);
  for (const name of ['alpha', 'beta', 'gamma']) {
    assert.equal(getTool(db, SERVER_ID, name)?.stale, true);
  }
});

test('a no-op stale pass does not bump the revision', (t) => {
  const { db } = fixture(t);
  markAbsentToolsStale(db, SERVER_ID, ['alpha', 'beta', 'gamma']);
  const before = getRevision(db);

  assert.equal(markAbsentToolsStale(db, SERVER_ID, ['alpha', 'beta', 'gamma']), 0);
  assert.equal(getRevision(db), before);
});
