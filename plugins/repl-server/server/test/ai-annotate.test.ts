/** AI annotation: preview, apply transaction semantics, summary_source and auto previews. */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AdminApiError } from '../src/admin/servers.ts';
import { readCategoryDictionary } from '../src/admin/categories.ts';
import { readTagDictionary } from '../src/admin/tags.ts';
import { applyAnnotation } from '../src/ai/apply.ts';
import type { AiRunAuditEvent, AiService } from '../src/ai/service.ts';
import { createAiService } from '../src/ai/service.ts';
import { DEFAULT_AI_SETTINGS, putAiSettings } from '../src/ai/settings.ts';
import { normalizeAnnotation, restrictAnnotationToDictionary } from '../src/ai/validate.ts';
import { DbServerStore, DbSettingsStore, DbToolStore } from '../src/assembly-stores.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { getRevision, listSettings } from '../src/db/meta.ts';
import { createServer, getServer } from '../src/db/servers.ts';
import { deleteTool, getTool, upsertTool } from '../src/db/tools.ts';
import type { Clock } from '../src/ports.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));

class MutableClock implements Clock {
  private current: number;

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

interface Fixture {
  db: DatabaseSync;
  settings: DbSettingsStore;
  service: AiService;
  rebuilds: string[][];
  audits: AiRunAuditEvent[];
  clock: MutableClock;
}

async function makeFixture(
  t: TestContext,
  options: { settings?: Partial<typeof DEFAULT_AI_SETTINGS>; extraEnv?: Record<string, string> } = {},
): Promise<Fixture> {
  await chmod(FIXTURE, 0o755);
  const dir = await mkdtemp(join(tmpdir(), 'repl-ai-annotate-'));
  const db = openStateDb(':memory:');
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const servers = new DbServerStore(db);
  const tools = new DbToolStore(db);
  const settings = new DbSettingsStore(db);
  const clock = new MutableClock(Date.UTC(2026, 10, 18, 10, 0, 0));
  const rebuilds: string[][] = [];
  const audits: AiRunAuditEvent[] = [];
  const catalog = {
    rebuild(changedServers: readonly string[] = []): unknown {
      rebuilds.push([...changedServers]);
      return {};
    },
  };

  putAiSettings(
    db,
    { ...DEFAULT_AI_SETTINGS, claudeBin: FIXTURE, ...options.settings },
    getRevision(db),
  );

  const service = createAiService({
    db,
    servers,
    tools,
    catalog,
    settings,
    clock,
    dataDir: dir,
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    onAiRun: (event) => audits.push(event),
  });

  return { db, settings, service, rebuilds, audits, clock };
}

function seedServer(
  db: DatabaseSync,
  overrides: {
    summary?: string | null;
    summarySource?: string | null;
    category?: string | null;
    tags?: string[];
  } = {},
): void {
  createServer(db, {
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', { $secret: 'DATABASE_URL' }],
    env: { DATABASE_URL: { $secret: 'DATABASE_URL' } },
    summary: overrides.summary ?? null,
    summarySource: overrides.summarySource ?? null,
    category: overrides.category ?? null,
    tags: overrides.tags ?? [],
  });
}

function seedTool(db: DatabaseSync, name = 'query', description = 'Run a read-only SQL query.'): void {
  upsertTool(db, 'pg', { name, description, inputSchema: { type: 'object' } });
}

async function expectApiError(
  promise: Promise<unknown>,
  code: string,
  status?: number,
): Promise<AdminApiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AdminApiError, `expected AdminApiError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  if (status !== undefined) assert.equal(caught.status, status);
  return caught;
}

const QUERY_DESCRIPTION = 'Run a read-only SQL query; 执行只读 SQL 查询';

const APPLY = {
  summary: 'PostgreSQL 查询与写入 (postgres sql database query write)',
  category: 'database',
  tags: ['postgresql', 'query', 'write'],
  toolOverrides: [
    {
      name: 'query',
      description: QUERY_DESCRIPTION,
      tags: ['read', 'query'],
    },
  ],
};

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test('preview returns proposed metadata without writing', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const before = getRevision(fixture.db);

  const preview = await fixture.service.annotatePreview('pg');
  assert.equal(preview.serverId, 'pg');
  assert.deepEqual(preview.current, {
    summary: null,
    summarySource: null,
    category: null,
    tags: [],
  });
  assert.equal(preview.proposed.summary, APPLY.summary);
  assert.equal(preview.proposed.category, 'database');
  assert.equal(preview.proposed.categorySuggestion, null);
  assert.deepEqual(preview.proposed.tags, ['postgresql', 'query', 'write']);
  assert.deepEqual(preview.proposed.tagSuggestions, []);
  assert.equal(preview.proposed.toolOverrides?.[0]?.name, 'query');
  assert.equal(preview.omittedTools, 0);
  assert.equal(preview.meta.promptVersion, 5);

  assert.equal(getRevision(fixture.db), before);
  assert.equal(getServer(fixture.db, 'pg')?.summary, null);
  assert.equal(fixture.rebuilds.length, 0);
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0]?.kind, 'annotate');
});

test('preview reports omittedTools beyond the 80-tool cap', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  for (let index = 0; index < 85; index += 1) {
    seedTool(fixture.db, index === 0 ? 'query' : `tool_${String(index).padStart(3, '0')}`, `d${index}`);
  }
  const preview = await fixture.service.annotatePreview('pg');
  assert.equal(preview.omittedTools, 5);
});

test('preview rejects unknown and builtin servers', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);

  await expectApiError(fixture.service.annotatePreview('missing'), 'SERVER_NOT_FOUND', 404);
  await expectApiError(fixture.service.annotatePreview('__official__'), 'SERVER_NOT_ANNOTATABLE', 422);
});

test('annotate is disabled when ai.enabled is false', async (t) => {
  const fixture = await makeFixture(t, { settings: { enabled: false } });
  seedServer(fixture.db);
  await expectApiError(fixture.service.annotatePreview('pg'), 'AI_DISABLED', 409);
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

test('apply writes metadata and tool overrides in one revision bump', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const before = getRevision(fixture.db);
  const rebuildsBefore = fixture.rebuilds.length;

  const response = await fixture.service.annotateApply('pg', APPLY, before);
  assert.deepEqual(response.changed, [
    'server.summary',
    'server.category',
    'server.tags',
    'tools.query.description_override',
    'tools.query.tags',
  ]);
  assert.equal(response.revision, before + 1);
  assert.equal(getRevision(fixture.db), before + 1);
  assert.equal(response.server.summarySource, 'ai');
  assert.deepEqual(response.server.tags, ['postgresql', 'query', 'write']);
  assert.equal(fixture.rebuilds.length, rebuildsBefore + 1);
  assert.deepEqual(fixture.rebuilds.at(-1), ['pg']);

  const stored = getServer(fixture.db, 'pg');
  assert.ok(stored !== null);
  assert.equal(stored?.summary, APPLY.summary);
  assert.equal(stored?.summarySource, 'ai');
  assert.equal(stored?.category, 'database');
  // `servers.revision` is the pool cfgVersion; metadata edits must not move it.
  assert.equal(stored?.revision, 1);

  const tool = getTool(fixture.db, 'pg', 'query');
  assert.ok(tool !== null);
  assert.equal(tool?.descriptionOverride, QUERY_DESCRIPTION);
  assert.deepEqual(tool?.tags, ['read', 'query']);

  const index = fixture.db
    .prepare('SELECT index_description, index_tags_json FROM tools WHERE server_id = ? AND name = ?')
    .get('pg', 'query');
  assert.ok(String(index?.['index_description']).includes('执行只读 SQL 查询'));
  const indexTags = JSON.parse(String(index?.['index_tags_json'])) as string[];
  assert.deepEqual([...indexTags].sort(), ['postgresql', 'query', 'read', 'write']);
  assert.equal(
    response.tools.find((entry) => entry.name === 'query')?.descriptionOverride,
    QUERY_DESCRIPTION,
  );
});

test('apply with no actual change writes nothing and does not bump', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const revision = getRevision(fixture.db);
  await fixture.service.annotateApply('pg', APPLY, revision);

  const afterFirst = getRevision(fixture.db);
  const rebuildsAfterFirst = fixture.rebuilds.length;
  const response = await fixture.service.annotateApply('pg', APPLY, afterFirst);
  assert.deepEqual(response.changed, []);
  assert.equal(response.revision, afterFirst);
  assert.equal(getRevision(fixture.db), afterFirst);
  assert.equal(fixture.rebuilds.length, rebuildsAfterFirst);
});

test('apply merges server and tool tags; empty arrays never clear existing tags', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db, { tags: ['env.prod', 'official'] });
  upsertTool(fixture.db, 'pg', {
    name: 'query',
    description: 'Run a read-only SQL query.',
    inputSchema: { type: 'object' },
    tags: ['read'],
  });

  await fixture.service.annotateApply('pg', APPLY, getRevision(fixture.db));
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, [
    'env.prod',
    'official',
    'postgresql',
    'query',
    'write',
  ]);
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, ['read', 'query']);

  const revision = getRevision(fixture.db);
  const response = await fixture.service.annotateApply(
    'pg',
    { tags: [], toolOverrides: [{ name: 'query', tags: [] }] },
    revision,
  );
  assert.deepEqual(response.changed, []);
  assert.equal(response.revision, revision);
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, [
    'env.prod',
    'official',
    'postgresql',
    'query',
    'write',
  ]);
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, ['read', 'query']);
});

test('accepted suggestions are written to both dictionaries in one revision bump', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const before = getRevision(fixture.db);

  const response = await fixture.service.annotateApply(
    'pg',
    {
      categorySuggestion: { key: 'vector-db', zh: '向量数据库', en: 'Vector database' },
      tagSuggestions: [
        { key: 'vector', zh: '向量', en: 'Vector' },
        { key: 'embedding', zh: '嵌入', en: 'Embedding' },
      ],
    },
    before,
  );

  assert.equal(response.revision, before + 1);
  assert.deepEqual(response.changed, [
    'dictionary.categories',
    'dictionary.tags',
    'server.category',
    'server.tags',
  ]);
  const stored = getServer(fixture.db, 'pg');
  assert.equal(stored?.category, 'vector-db');
  assert.deepEqual(stored?.tags, ['vector', 'embedding']);

  const settings = listSettings(fixture.db);
  assert.deepEqual(
    readCategoryDictionary(settings).find((entry) => entry.key === 'vector-db'),
    { key: 'vector-db', zh: '向量数据库', en: 'Vector database' },
  );
  assert.deepEqual(
    readTagDictionary(settings).find((entry) => entry.key === 'vector'),
    { key: 'vector', zh: '向量', en: 'Vector' },
  );
});

test('suggestions for existing dictionary keys are treated as the existing item', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const before = getRevision(fixture.db);

  const response = await fixture.service.annotateApply(
    'pg',
    {
      categorySuggestion: { key: 'database', zh: '换个标签', en: 'Different label' },
      tagSuggestions: [{ key: 'read', zh: '换个标签', en: 'Different label' }],
    },
    before,
  );

  assert.deepEqual(response.changed, ['server.category', 'server.tags']);
  assert.equal(getServer(fixture.db, 'pg')?.category, 'database');
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, ['read']);
  const settings = listSettings(fixture.db);
  assert.deepEqual(
    readCategoryDictionary(settings).find((entry) => entry.key === 'database'),
    { key: 'database', zh: '数据库', en: 'Database' },
  );
  assert.deepEqual(
    readTagDictionary(settings).find((entry) => entry.key === 'read'),
    { key: 'read', zh: '只读', en: 'Read-only' },
  );
});

test('duplicate suggestions are added once', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const suggestion = { key: 'vector', zh: '向量', en: 'Vector' };

  await fixture.service.annotateApply(
    'pg',
    { tagSuggestions: [suggestion, suggestion] },
    getRevision(fixture.db),
  );

  const tags = readTagDictionary(listSettings(fixture.db));
  assert.equal(tags.filter((entry) => entry.key === 'vector').length, 1);
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, ['vector']);
});

test('illegal suggestions are rejected before any write', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const before = getRevision(fixture.db);

  const cases = [
    { categorySuggestion: { key: 'Bad Key', zh: '坏', en: 'Bad' } },
    { categorySuggestion: { key: 'ok', zh: '', en: 'Ok' } },
    { tagSuggestions: [{ key: 'ok', zh: '好', en: '' }] },
    { tagSuggestions: [{ key: 'ok', zh: '好', en: 'x'.repeat(41) }] },
    { tagSuggestions: 'nope' },
  ];
  for (const body of cases) {
    await expectApiError(
      fixture.service.annotateApply('pg', body, before),
      'AI_ANNOTATION_INVALID',
      422,
    );
  }
  assert.equal(getRevision(fixture.db), before);
  assert.deepEqual(readTagDictionary(listSettings(fixture.db)), readTagDictionary({}));
  assert.deepEqual(readCategoryDictionary(listSettings(fixture.db)), readCategoryDictionary({}));
});

test('forbidden suggestions never re-enter a customised tag dictionary', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  await fixture.settings.replace(
    { tagDictionary: [{ key: 'read', zh: '只读', en: 'Read-only' }] },
    getRevision(fixture.db),
  );
  const before = getRevision(fixture.db);

  for (const key of ['env.prod', 'cross-env', 'official', 'builtin']) {
    await expectApiError(
      fixture.service.annotateApply(
        'pg',
        { tagSuggestions: [{ key, zh: '来源', en: 'Source' }] },
        before,
      ),
      'AI_ANNOTATION_INVALID',
      422,
    );
  }
  assert.equal(getRevision(fixture.db), before);
  assert.deepEqual(
    readTagDictionary(listSettings(fixture.db)).map((entry) => entry.key),
    ['read'],
  );
});

test('a failed apply leaves accepted suggestions out of the dictionaries', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const before = getRevision(fixture.db);
  const body = {
    categorySuggestion: { key: 'vector-db', zh: '向量数据库', en: 'Vector database' },
    tagSuggestions: [{ key: 'vector', zh: '向量', en: 'Vector' }],
    toolOverrides: [{ name: 'missing', tags: ['read'] }],
  };

  await expectApiError(fixture.service.annotateApply('pg', body, before), 'AI_UNKNOWN_TOOL', 422);
  assert.equal(getRevision(fixture.db), before);
  assert.deepEqual(readCategoryDictionary(listSettings(fixture.db)), readCategoryDictionary({}));
  assert.deepEqual(readTagDictionary(listSettings(fixture.db)), readTagDictionary({}));

  await expectApiError(
    fixture.service.annotateApply(
      'pg',
      {
        categorySuggestion: { key: 'vector-db', zh: '向量数据库', en: 'Vector database' },
        tagSuggestions: [{ key: 'vector', zh: '向量', en: 'Vector' }],
      },
      before - 1,
    ),
    'REVISION_CONFLICT',
    409,
  );
  assert.deepEqual(readCategoryDictionary(listSettings(fixture.db)), readCategoryDictionary({}));
});

test('a failure after the dictionary write rolls the dictionary back', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const before = getRevision(fixture.db);
  fixture.db.exec(`
    CREATE TRIGGER fail_revision BEFORE UPDATE ON meta
    WHEN OLD.key = 'revision'
    BEGIN SELECT RAISE(ABORT, 'revision write failed'); END;
  `);
  assert.throws(() =>
    applyAnnotation(
      fixture.db,
      {
        serverId: 'pg',
        patch: { tagSuggestions: [{ key: 'vector', zh: '向量', en: 'Vector' }] },
      },
      before,
    ),
  );
  fixture.db.exec('DROP TRIGGER fail_revision');

  assert.equal(getRevision(fixture.db), before);
  assert.deepEqual(readTagDictionary(listSettings(fixture.db)), readTagDictionary({}));
});

test('preview splits existing values from suggestions and warns about dropped ones', async (t) => {
  const fixture = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: JSON.stringify({
        summary: '向量检索 (vector search)',
        category: null,
        categorySuggestion: {
          key: 'vector-db',
          zh: '向量数据库',
          en: 'Vector database',
        },
        tags: ['postgresql', 'sql'],
        tagSuggestions: [
          { key: 'env.prod', zh: '生产环境', en: 'Production' },
          { key: 'vector', zh: '向量', en: 'Vector' },
        ],
        toolOverrides: [{ name: 'query', tags: ['read', 'vector'] }],
        warnings: [],
      }),
    },
  });
  seedServer(fixture.db);
  seedTool(fixture.db);

  const preview = await fixture.service.annotatePreview('pg');
  assert.equal(preview.proposed.category, null);
  assert.deepEqual(preview.proposed.categorySuggestion, {
    key: 'vector-db',
    zh: '向量数据库',
    en: 'Vector database',
  });
  assert.deepEqual(preview.proposed.tags, ['postgresql']);
  assert.deepEqual(preview.proposed.tagSuggestions, [
    { key: 'vector', zh: '向量', en: 'Vector' },
  ]);
  assert.deepEqual(preview.proposed.toolOverrides[0]?.tags, ['read', 'vector']);
  assert.ok(preview.warnings.some((warning) => warning.includes('sql')));
  assert.ok(preview.warnings.some((warning) => warning.includes('env.prod')));
});

test('categories and tags stay separate and provenance tags are rejected at both layers', async (t) => {
  const fixture = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: JSON.stringify({
        summary: '数据库 (database)',
        category: null,
        categorySuggestion: { key: 'official', zh: '官方', en: 'Official' },
        tags: ['env.prod', 'database', 'postgresql'],
        tagSuggestions: [{ key: 'database', zh: '数据库', en: 'Database' }],
        toolOverrides: [{ name: 'query', tags: ['env.prod', 'database', 'read'] }],
        warnings: [],
      }),
    },
  });
  seedServer(fixture.db);
  seedTool(fixture.db);

  const preview = await fixture.service.annotatePreview('pg');
  assert.equal(preview.proposed.categorySuggestion, null);
  assert.deepEqual(preview.proposed.tags, ['postgresql']);
  assert.deepEqual(preview.proposed.tagSuggestions, []);
  assert.deepEqual(preview.proposed.toolOverrides[0]?.tags, ['read']);
  assert.ok(
    preview.warnings.some(
      (warning) => warning.includes('official') && warning.includes('由管理员维护'),
    ),
  );
  assert.ok(
    preview.warnings.some(
      (warning) => warning.includes('env.prod') && warning.includes('由管理员维护'),
    ),
  );
  assert.ok(
    preview.warnings.some(
      (warning) => warning.includes('database') && warning.includes('分类 key 不能当标签'),
    ),
  );
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, []);

  // A client may resubmit the raw draft; the HTTP path drops these values with
  // a warning, so apply must reject instead of writing them silently.
  const before = getRevision(fixture.db);
  const rejected = [
    { tags: ['env.prod'] },
    { tags: ['database'] },
    { categorySuggestion: { key: 'official', zh: '官方', en: 'Official' } },
    { categorySuggestion: { key: 'browser', zh: '浏览器', en: 'Browser' } },
    {
      categorySuggestion: { key: 'vector', zh: '向量', en: 'Vector' },
      tagSuggestions: [{ key: 'vector', zh: '向量', en: 'Vector' }],
    },
    { tagSuggestions: [{ key: 'database', zh: '数据库', en: 'Database' }] },
    { toolOverrides: [{ name: 'query', tags: ['env.prod'] }] },
    { toolOverrides: [{ name: 'query', tags: ['database'] }] },
  ];
  for (const body of rejected) {
    await expectApiError(
      fixture.service.annotateApply('pg', body, before),
      'AI_ANNOTATION_INVALID',
      422,
    );
  }
  assert.equal(getRevision(fixture.db), before);

  // The low-level apply is the last line of defense for callers that skip the
  // service-level restriction.
  for (const patch of rejected) {
    assert.throws(
      () => applyAnnotation(fixture.db, { serverId: 'pg', patch }, before),
      (error: unknown) =>
        error instanceof AdminApiError && error.code === 'AI_ANNOTATION_INVALID',
    );
  }
  assert.equal(getRevision(fixture.db), before);
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, []);

  // Ordinary dictionary tags still merge through the low-level path.
  const applied = applyAnnotation(
    fixture.db,
    { serverId: 'pg', patch: { tags: ['postgresql'] } },
    before,
  );
  assert.deepEqual(applied.changed, ['server.tags']);
  assert.equal(applied.revision, before + 1);
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, ['postgresql']);
});

test('preview rejects category keys used as tags and tag keys used as categories', async (t) => {
  const fixture = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: JSON.stringify({
        summary: '数据库 (database)',
        category: null,
        categorySuggestion: { key: 'browser', zh: '浏览器', en: 'Browser' },
        tags: ['database'],
        tagSuggestions: [{ key: 'database', zh: '数据库', en: 'Database' }],
        toolOverrides: [{ name: 'query', tags: ['database'] }],
        warnings: [],
      }),
    },
  });
  seedServer(fixture.db);
  seedTool(fixture.db);

  const preview = await fixture.service.annotatePreview('pg');
  assert.equal(preview.proposed.categorySuggestion, null);
  assert.deepEqual(preview.proposed.tags, []);
  assert.deepEqual(preview.proposed.tagSuggestions, []);
  assert.deepEqual(preview.proposed.toolOverrides[0]?.tags, []);
  assert.ok(
    preview.warnings.some((warning) => warning.includes('browser') && warning.includes('标签 key')),
  );
  assert.ok(
    preview.warnings.some(
      (warning) => warning.includes('database') && warning.includes('分类 key 不能当标签'),
    ),
  );
});

test('preview rejects a key suggested as both category and tag', async (t) => {
  const fixture = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: JSON.stringify({
        summary: '向量检索 (vector search)',
        category: null,
        categorySuggestion: { key: 'vector', zh: '向量', en: 'Vector' },
        tagSuggestions: [{ key: 'vector', zh: '向量', en: 'Vector' }],
        warnings: [],
      }),
    },
  });
  seedServer(fixture.db);
  seedTool(fixture.db);

  const preview = await fixture.service.annotatePreview('pg');
  assert.equal(preview.proposed.categorySuggestion, null);
  assert.deepEqual(preview.proposed.tagSuggestions, [
    { key: 'vector', zh: '向量', en: 'Vector' },
  ]);
  assert.ok(
    preview.warnings.some((warning) => warning.includes('vector') && warning.includes('重名')),
  );
});

test('category keys accept every dictionary key shape', () => {
  for (const key of ['my.cat', 'my_cat', '1cat']) {
    assert.equal(normalizeAnnotation({ category: key }, []).category, key);
    assert.equal(
      normalizeAnnotation(
        { categorySuggestion: { key, zh: '自定义', en: 'Custom' } },
        [],
      ).categorySuggestion?.key,
      key,
    );
  }

  const missing = restrictAnnotationToDictionary(
    normalizeAnnotation({ category: 'my.cat' }, []),
    { categories: new Set(), tags: new Set() },
  );
  assert.equal(missing.annotation.category, null);

  const promoted = restrictAnnotationToDictionary(
    normalizeAnnotation(
      { categorySuggestion: { key: 'my.cat', zh: '自定义', en: 'Custom' } },
      [],
    ),
    { categories: new Set(['my.cat']), tags: new Set() },
  );
  assert.equal(promoted.annotation.category, 'my.cat');
  assert.equal(promoted.annotation.categorySuggestion, null);
});

test('apply shape errors: empty patch, missing patch, bad tools and tags', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const revision = getRevision(fixture.db);

  await expectApiError(fixture.service.annotateApply('pg', {}, revision), 'EMPTY_PATCH', 422);
  await expectApiError(fixture.service.annotateApply('pg', undefined, revision), 'INVALID_FIELD', 400);

  await expectApiError(
    fixture.service.annotateApply('pg', { toolOverrides: [{ name: 'missing' }] }, revision),
    'AI_UNKNOWN_TOOL',
    422,
  );
  await expectApiError(
    fixture.service.annotateApply(
      'pg',
      { toolOverrides: [{ name: 'query' }, { name: 'query' }] },
      revision,
    ),
    'AI_ANNOTATION_INVALID',
    422,
  );
  await expectApiError(
    fixture.service.annotateApply(
      'pg',
      { tags: ['Bad Tag'] },
      revision,
    ),
    'AI_ANNOTATION_INVALID',
    422,
  );

  const tooMany = Array.from({ length: 81 }, (_, index) => ({ name: `tool_${index}` }));
  await expectApiError(
    fixture.service.annotateApply('pg', { toolOverrides: tooMany }, revision),
    'AI_ANNOTATION_INVALID',
    422,
  );
  assert.equal(getRevision(fixture.db), revision);
  assert.equal(getServer(fixture.db, 'pg')?.summary, null);
});

test('apply rejects a stale If-Match', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  await expectApiError(
    fixture.service.annotateApply('pg', APPLY, getRevision(fixture.db) - 1),
    'REVISION_CONFLICT',
    409,
  );
  assert.equal(getServer(fixture.db, 'pg')?.summary, null);
});

test('apply reports tools deleted after preview as unknown', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);
  const revision = getRevision(fixture.db);
  deleteTool(fixture.db, 'pg', 'query');
  await expectApiError(
    fixture.service.annotateApply('pg', APPLY, getRevision(fixture.db)),
    'AI_UNKNOWN_TOOL',
    422,
  );
  void revision;
});

test('summary_source follows only real summary changes', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db, { summary: '人工摘要', summarySource: 'manual' });
  seedTool(fixture.db);

  // Category-only change keeps the manual source.
  await fixture.service.annotateApply(
    'pg',
    { category: 'database' },
    getRevision(fixture.db),
  );
  assert.equal(getServer(fixture.db, 'pg')?.summarySource, 'manual');

  // A real summary change marks it AI.
  await fixture.service.annotateApply(
    'pg',
    { summary: 'AI 摘要 (ai summary)' },
    getRevision(fixture.db),
  );
  assert.equal(getServer(fixture.db, 'pg')?.summarySource, 'ai');

  // Clearing the summary clears the source.
  await fixture.service.annotateApply('pg', { summary: null }, getRevision(fixture.db));
  assert.equal(getServer(fixture.db, 'pg')?.summary, null);
  assert.equal(getServer(fixture.db, 'pg')?.summarySource, null);
});

test('blank summaries are stored as null with no source', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db, { summary: '人工摘要', summarySource: 'manual' });
  seedTool(fixture.db);

  // A client may resubmit an edited draft straight to applyAnnotation.
  applyAnnotation(
    fixture.db,
    { serverId: 'pg', patch: { summary: '   ' } },
    getRevision(fixture.db),
  );
  assert.equal(getServer(fixture.db, 'pg')?.summary, null);
  assert.equal(getServer(fixture.db, 'pg')?.summarySource, null);

  // The validate + apply route normalizes the empty string too.
  await fixture.service.annotateApply(
    'pg',
    { summary: '恢复的摘要' },
    getRevision(fixture.db),
  );
  assert.equal(getServer(fixture.db, 'pg')?.summarySource, 'ai');

  await fixture.service.annotateApply('pg', { summary: '' }, getRevision(fixture.db));
  assert.equal(getServer(fixture.db, 'pg')?.summary, null);
  assert.equal(getServer(fixture.db, 'pg')?.summarySource, null);
});

// ---------------------------------------------------------------------------
// Auto preview
// ---------------------------------------------------------------------------

async function seedNewServer(fixture: Fixture): Promise<void> {
  seedServer(fixture.db);
  seedTool(fixture.db);
}

test('auto preview is skipped when autoAnnotate is false', async (t) => {
  const fixture = await makeFixture(t, { settings: { autoAnnotate: false } });
  await seedNewServer(fixture);
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');
  assert.deepEqual(fixture.audits, []);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});

test('auto preview runs once for a new server and is listed as pending', async (t) => {
  const fixture = await makeFixture(t);
  await seedNewServer(fixture);
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  const pending = await fixture.service.pendingAnnotations();
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0]?.serverId, 'pg');
  assert.equal(pending.items[0]?.proposed.summary, APPLY.summary);
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0]?.trigger, 'auto');
  assert.equal(fixture.audits[0]?.kind, 'annotate');

  // Attempt bookkeeping prevents a second paid run for the same tool set.
  await fixture.service.onToolsIndexed('pg');
  assert.equal(fixture.audits.length, 1);
  assert.equal((await fixture.service.pendingAnnotations()).items.length, 1);

  // Applying the suggestion clears the pending preview.
  await fixture.service.annotateApply('pg', APPLY, getRevision(fixture.db));
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});

test('auto preview also runs for an explicit refresh', async (t) => {
  const fixture = await makeFixture(t);
  await seedNewServer(fixture);
  await fixture.service.onToolsIndexed('pg', { explicit: true });
  assert.equal((await fixture.service.pendingAnnotations()).items.length, 1);
});

test('auto preview does not run without creation or explicit refresh', async (t) => {
  const fixture = await makeFixture(t);
  await seedNewServer(fixture);
  await fixture.service.onToolsIndexed('pg');
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
  assert.equal(fixture.audits.length, 0);
});

test('auto preview skips servers that already have summary or category', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db, { summary: 'manual', summarySource: 'manual' });
  seedTool(fixture.db);
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});

test('pending previews expire and are dropped on mutation', async (t) => {
  const fixture = await makeFixture(t);
  await seedNewServer(fixture);
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');
  assert.equal((await fixture.service.pendingAnnotations()).items.length, 1);

  fixture.service.onServerMutated('pg');
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });

  // A new tool changes the toolsHash; step past the 60s throttle as well.
  fixture.clock.advance(61_000);
  seedTool(fixture.db, 'query2', 'Another query tool.');
  await fixture.service.onToolsIndexed('pg', { explicit: true });
  assert.equal((await fixture.service.pendingAnnotations()).items.length, 1);
  fixture.clock.advance(31 * 60_000);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});
