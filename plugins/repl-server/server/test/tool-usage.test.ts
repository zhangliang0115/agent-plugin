/** Lifetime `tool_usage` counters and their read-back through the tool repository. @module */
import assert from 'node:assert/strict';
import test from 'node:test';

import { openStateDb } from '../src/db/migrate.ts';
import { createServer } from '../src/db/servers.ts';
import { getTool, listTools, recordToolUsage, upsertTool } from '../src/db/tools.ts';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-01T00:00:01.000Z';
const T3 = '2026-01-01T00:00:02.000Z';

function openDb(): ReturnType<typeof openStateDb> {
  const db = openStateDb(':memory:');
  createServer(db, { id: 'pg', label: 'PostgreSQL', transport: 'stdio', command: 'node' });
  upsertTool(db, 'pg', { name: 'query', inputSchema: { type: 'object' } });
  upsertTool(db, 'pg', { name: 'fetch', inputSchema: { type: 'object' } });
  return db;
}

test('recordToolUsage accumulates calls and successes per tool', () => {
  const db = openDb();
  try {
    recordToolUsage(db, { serverId: 'pg', name: 'query', ok: true, at: T1 });
    recordToolUsage(db, { serverId: 'pg', name: 'query', ok: false, at: T2 });
    recordToolUsage(db, { serverId: 'pg', name: 'query', ok: true, at: T3 });

    const query = getTool(db, 'pg', 'query');
    assert.ok(query);
    assert.equal(query.callCount, 3);
    assert.equal(query.successCount, 2);
    assert.equal(query.lastCalledAt, T3);

    const fetch = getTool(db, 'pg', 'fetch');
    assert.ok(fetch);
    assert.equal(fetch.callCount, 0);
    assert.equal(fetch.successCount, 0);
    assert.equal(fetch.lastCalledAt, null);

    const listed = listTools(db, 'pg');
    assert.deepEqual(
      listed.map((tool) => [tool.name, tool.callCount, tool.successCount, tool.lastCalledAt]),
      [
        ['fetch', 0, 0, null],
        ['query', 3, 2, T3],
      ],
    );
  } finally {
    db.close();
  }
});

test('tool usage survives tool deletion and is inherited after re-add', () => {
  const db = openDb();
  try {
    recordToolUsage(db, { serverId: 'pg', name: 'query', ok: true, at: T1 });
    db.prepare("DELETE FROM tools WHERE server_id = 'pg' AND name = 'query'").run();
    assert.equal(getTool(db, 'pg', 'query'), null);

    recordToolUsage(db, { serverId: 'pg', name: 'query', ok: false, at: T2 });
    upsertTool(db, 'pg', { name: 'query', inputSchema: { type: 'object' } });
    const readded = getTool(db, 'pg', 'query');
    assert.ok(readded);
    assert.equal(readded.callCount, 2);
    assert.equal(readded.successCount, 1);
    assert.equal(readded.lastCalledAt, T2);
  } finally {
    db.close();
  }
});
