import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { buildCatalogSnapshot } from '../src/catalog/snapshot.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { getRevision } from '../src/db/meta.ts';
import { BUILTIN_SERVER_ID, OFFICIAL_SERVER_ID } from '../src/db/servers.ts';
import { getTool, hashToolSchema, listTools, patchTool, upsertTool } from '../src/db/tools.ts';
import { seedBuiltinTools } from '../src/tools/builtin-seed.ts';
import { TOOL_DEFINITIONS, TOOL_ORDER } from '../src/tools/registry.ts';

function fixture(t: TestContext): ReturnType<typeof openStateDb> {
  const db = openStateDb(':memory:');
  t.after(() => db.close());
  return db;
}

test('seedBuiltinTools writes the five protocol tools once', (t) => {
  const db = fixture(t);
  assert.equal(getRevision(db), 0);

  const first = seedBuiltinTools(db);
  assert.deepEqual(first, { inserted: 5, filled: 0 });
  assert.equal(getRevision(db), 1);

  const rows = listTools(db, BUILTIN_SERVER_ID);
  assert.deepEqual(rows.map((row) => row.name).sort(), [...TOOL_ORDER].sort());
  for (const definition of TOOL_DEFINITIONS) {
    const row = getTool(db, BUILTIN_SERVER_ID, definition.name);
    assert.ok(row, `${definition.name} must exist`);
    assert.equal(row.description, definition.description);
    assert.deepEqual(row.inputSchema, definition.inputSchema);
    assert.equal(row.enabled, true);
    assert.equal(row.concurrency, 'parallel');
    assert.deepEqual(row.tags, []);
    assert.equal(row.discoveredVia, 'static');
  }

  const second = seedBuiltinTools(db);
  assert.deepEqual(second, { inserted: 0, filled: 0 });
  assert.equal(getRevision(db), 1, 'an idempotent seed must not bump the revision');
  assert.equal(listTools(db, BUILTIN_SERVER_ID).length, 5);
});

test('seedBuiltinTools preserves admin fields and only fills empty upstream fields', (t) => {
  const db = fixture(t);
  seedBuiltinTools(db);

  const override = '管理员改写后的描述';
  patchTool(db, BUILTIN_SERVER_ID, 'run_script', {
    description: override,
    enabled: false,
    concurrency: 'serial',
    tags: ['local'],
  });
  const runScript = getTool(db, BUILTIN_SERVER_ID, 'run_script');
  assert.ok(runScript);

  db.prepare('UPDATE tools SET description = NULL, schema_json = ?, schema_hash = ? WHERE server_id = ? AND name = ?')
    .run('{}', 'empty', BUILTIN_SERVER_ID, 'wait_tasks');
  const revisionBefore = getRevision(db);

  const result = seedBuiltinTools(db);
  assert.deepEqual(result, { inserted: 0, filled: 1 });
  assert.equal(getRevision(db), revisionBefore + 1);

  const kept = getTool(db, BUILTIN_SERVER_ID, 'run_script');
  assert.ok(kept);
  assert.equal(kept.description, runScript.description, 'upstream description is not rewritten');
  assert.equal(kept.descriptionOverride, override);
  assert.equal(kept.enabled, false);
  assert.equal(kept.concurrency, 'serial');
  assert.deepEqual(kept.tags, ['local']);

  const filled = getTool(db, BUILTIN_SERVER_ID, 'wait_tasks');
  assert.ok(filled);
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'wait_tasks');
  assert.ok(definition);
  assert.equal(filled.description, definition.description);
  assert.deepEqual(filled.inputSchema, definition.inputSchema);
});

test('seedBuiltinTools refreshes a definition that changed upstream', (t) => {
  const db = fixture(t);
  seedBuiltinTools(db);
  const revisionBefore = getRevision(db);
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'wait_tasks');
  assert.ok(definition);

  db.prepare('UPDATE tools SET description = ?, schema_json = ?, schema_hash = ? WHERE server_id = ? AND name = ?')
    .run('旧描述', '{}', 'old_hash', BUILTIN_SERVER_ID, 'wait_tasks');

  const refreshed = seedBuiltinTools(db);
  assert.deepEqual(refreshed, { inserted: 0, filled: 1 });
  assert.equal(getRevision(db), revisionBefore + 1);

  const row = getTool(db, BUILTIN_SERVER_ID, 'wait_tasks');
  assert.ok(row);
  assert.equal(row.description, definition.description);
  assert.deepEqual(row.inputSchema, definition.inputSchema);
  assert.equal(row.schemaHash, hashToolSchema(definition.inputSchema));

  const second = seedBuiltinTools(db);
  assert.deepEqual(second, { inserted: 0, filled: 0 });
  assert.equal(getRevision(db), revisionBefore + 1, 'a matching definition is not refreshed again');
});

test('builtin rows stay out of the execution catalog; official rows do not', (t) => {
  const db = fixture(t);
  seedBuiltinTools(db);
  upsertTool(db, OFFICIAL_SERVER_ID, {
    name: 'Read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: {} },
  });

  const snapshot = buildCatalogSnapshot(db);
  const names = snapshot.tools.map((tool) => tool.name);
  for (const name of TOOL_ORDER) {
    assert.equal(names.includes(name), false, `${name} must not be exposed to scripts`);
  }
  const read = snapshot.tools.find((tool) => tool.name === 'Read');
  assert.ok(read, 'official tools remain script-visible');
  assert.equal(read.kind, 'builtin');
});
