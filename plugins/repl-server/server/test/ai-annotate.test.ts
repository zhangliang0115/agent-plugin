/** AI annotation: preview, apply transaction semantics, summary_source and automatic apply. */
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
import { TAG_SETTING_KEY, readTagDictionary } from '../src/admin/tags.ts';
import { applyAnnotation } from '../src/ai/apply.ts';
import type { AiRunAuditEvent, AiService } from '../src/ai/service.ts';
import { createAiService } from '../src/ai/service.ts';
import { DEFAULT_AI_SETTINGS, putAiSettings } from '../src/ai/settings.ts';
import type { AiRunner } from '../src/ai/runner.ts';
import { normalizeAnnotation, restrictAnnotationToDictionary } from '../src/ai/validate.ts';
import { DbServerStore, DbSettingsStore, DbToolStore } from '../src/assembly-stores.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { getRevision, listSettings, setSetting, bumpRevision } from '../src/db/meta.ts';
import { createServer, getServer, updateServer } from '../src/db/servers.ts';
import { deleteTool, getTool, patchTool, upsertTool } from '../src/db/tools.ts';
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
  servers: DbServerStore;
  settings: DbSettingsStore;
  service: AiService;
  rebuilds: string[][];
  audits: AiRunAuditEvent[];
  clock: MutableClock;
}

async function makeFixture(
  t: TestContext,
  options: {
    settings?: Partial<typeof DEFAULT_AI_SETTINGS>;
    extraEnv?: Record<string, string>;
    runner?: AiRunner;
  } = {},
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
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    onAiRun: (event) => audits.push(event),
  });

  return { db, servers, settings, service, rebuilds, audits, clock };
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

function seedTool(
  db: DatabaseSync,
  name = 'query',
  description = 'Run a read-only SQL query.',
  tags: string[] = [],
): void {
  upsertTool(db, 'pg', { name, description, inputSchema: { type: 'object' }, tags });
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

const APPLY = {
  summary: 'PostgreSQL 查询与写入 (postgres sql database query write)',
  category: 'database',
  tags: ['postgresql'],
  toolOverrides: [
    {
      name: 'query',
      tags: ['docs'],
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
  assert.deepEqual(preview.proposed.tags, ['postgresql']);
  assert.deepEqual(preview.proposed.tagSuggestions, []);
  assert.equal(preview.proposed.toolOverrides?.[0]?.name, 'query');
  assert.equal(preview.omittedTools, 0);
  assert.equal(preview.meta.promptVersion, 10);

  assert.equal(getRevision(fixture.db), before);
  assert.equal(getServer(fixture.db, 'pg')?.summary, null);
  assert.equal(fixture.rebuilds.length, 0);
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0]?.kind, 'annotate');
});

test('preview trims tool additions against the existing tool tags', async (t) => {
  const runner: AiRunner = {
    async run() {
      return {
        payload: {
          summary: null,
          category: null,
          tags: [],
          toolOverrides: [{ name: 'query', tags: ['memory', 'gitlab'] }],
          warnings: [],
        },
        resultText: '{}',
        model: null,
        durationMs: 1,
        costUsd: null,
      };
    },
    async close(): Promise<void> {},
  };
  const fixture = await makeFixture(t, { runner });
  seedServer(fixture.db);
  seedTool(fixture.db, 'query', 'Run a read-only SQL query.', ['docs', 'testing', 'security']);

  const preview = await fixture.service.annotatePreview('pg');
  assert.deepEqual(preview.proposed.toolOverrides, [{ name: 'query', tags: ['memory'] }]);
  assert.ok(
    preview.warnings.some(
      (warning) => warning.includes('叠加现有标签后最多 4 个') && warning.includes('gitlab'),
    ),
  );

  const before = getRevision(fixture.db);
  const response = await fixture.service.annotateApply(
    'pg',
    { toolOverrides: preview.proposed.toolOverrides },
    before,
  );
  assert.deepEqual(response.changed, ['tools.query.tags']);
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, [
    'docs',
    'testing',
    'security',
    'memory',
  ]);
});

test('annotate prompt hides literal args and keeps secret names', async (t) => {
  const prompts: string[] = [];
  const runner: AiRunner = {
    async run(prompt) {
      prompts.push(prompt);
      return {
        payload: {
          summary: APPLY.summary,
          category: 'database',
          tags: ['postgresql'],
          toolOverrides: [],
          warnings: [],
        },
        resultText: '{}',
        model: null,
        durationMs: 1,
        costUsd: null,
      };
    },
    async close(): Promise<void> {},
  };
  const fixture = await makeFixture(t, { runner });
  const skToken = `sk-live-${'A1b2C3d4'.repeat(4)}`;
  const opaqueToken = `${'opaque-token-'.repeat(4)}9f8e7d6c`;
  createServer(fixture.db, {
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', skToken, opaqueToken, { $secret: 'DATABASE_URL' }],
    env: { DATABASE_URL: { $secret: 'DATABASE_URL' } },
  });
  seedTool(fixture.db);

  const preview = await fixture.service.annotatePreview('pg');
  assert.equal(preview.meta.promptVersion, 10);
  assert.equal(prompts.length, 1);
  const prompt = prompts[0] ?? '';
  assert.ok(!prompt.includes(skToken));
  assert.ok(!prompt.includes(opaqueToken));
  assert.ok(prompt.includes('"<literal>"'));
  assert.ok(prompt.includes('"<secret:DATABASE_URL>"'));
  assert.match(prompt, /"argCount": 4/);
});

test('annotate prompt redacts URL query and fragment values', async (t) => {
  const prompts: string[] = [];
  const runner: AiRunner = {
    async run(prompt) {
      prompts.push(prompt);
      return {
        payload: {
          summary: APPLY.summary,
          category: 'database',
          tags: ['postgresql'],
          toolOverrides: [],
          warnings: [],
        },
        resultText: '{}',
        model: null,
        durationMs: 1,
        costUsd: null,
      };
    },
    async close(): Promise<void> {},
  };
  const fixture = await makeFixture(t, { runner });
  createServer(fixture.db, {
    id: 'pg',
    label: 'Remote MCP',
    transport: 'http',
    url: 'https://mcp.example.com/mcp?token=sk-secret&lang=zh#access_token=sk-fragment-token',
    headers: { Authorization: { $secret: 'MCP_TOKEN' } },
  });
  seedTool(fixture.db);
  createServer(fixture.db, {
    id: 'broken',
    label: 'Broken URL',
    transport: 'http',
    url: 'not a url',
  });
  createServer(fixture.db, {
    id: 'fileurl',
    label: 'Non-http URL',
    transport: 'http',
    url: 'file:///tmp/sk-file-token',
  });

  await fixture.service.annotatePreview('pg');
  await fixture.service.annotatePreview('broken');
  await fixture.service.annotatePreview('fileurl');
  assert.equal(prompts.length, 3);

  const prompt = prompts[0] ?? '';
  assert.ok(!prompt.includes('sk-secret'));
  assert.ok(!prompt.includes('sk-fragment-token'));
  assert.ok(
    prompt.includes(
      '"url": "https://mcp.example.com/mcp?token=<redacted>&lang=<redacted>#<redacted>"',
    ),
  );
  assert.ok((prompts[1] ?? '').includes('"url": "<redacted-url>"'));
  assert.ok(!(prompts[2] ?? '').includes('sk-file-token'));
  assert.ok((prompts[2] ?? '').includes('"url": "<redacted-url>"'));
});

test('preview rejects a prompt over 64 KiB without echoing the server view', async (t) => {
  const fixture = await makeFixture(t);
  const sentinel = 'SENTINEL_ENV_KEY_';
  const env: Record<string, { $secret: string }> = {};
  for (let index = 0; index < 1200; index += 1) {
    env[`${sentinel}${String(index).padStart(4, '0')}_${'K'.repeat(48)}`] = {
      $secret: `S${String(index).padStart(4, '0')}`,
    };
  }
  createServer(fixture.db, {
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio',
    command: 'npx',
    args: ['-y'],
    env,
  });
  seedTool(fixture.db);

  const error = await expectApiError(
    fixture.service.annotatePreview('pg'),
    'AI_PROMPT_TOO_LARGE',
    422,
  );
  const details = error.details as { limitBytes: number; actualBytes: number };
  assert.equal(details.limitBytes, 64 * 1024);
  assert.ok(details.actualBytes > details.limitBytes);
  const exposed = JSON.stringify({ message: error.message, details: error.details });
  assert.ok(!exposed.includes(sentinel));
  assert.deepEqual(fixture.audits, []);
});

test('preview truncates over-limit tag counts with a warning; apply stays strict', async (t) => {
  const suggestions = Array.from({ length: 10 }, (_, index) => ({
    key: `suggested-${index}`,
    zh: `建议${index}`,
    en: `Suggestion ${index}`,
  }));
  const runner: AiRunner = {
    async run() {
      return {
        payload: {
          summary: APPLY.summary,
          category: 'database',
          tags: [],
          tagSuggestions: suggestions,
          toolOverrides: [],
          warnings: [],
        },
        resultText: '{}',
        model: null,
        durationMs: 1,
        costUsd: null,
      };
    },
    async close(): Promise<void> {},
  };
  const fixture = await makeFixture(t, { runner });
  seedServer(fixture.db);
  seedTool(fixture.db);

  const preview = await fixture.service.annotatePreview('pg');
  assert.equal(preview.proposed.tagSuggestions?.length, 8);
  assert.ok(
    preview.warnings.some((warning) => warning.includes('建议标签超过 8 个')),
    preview.warnings.join('; '),
  );

  await expectApiError(
    fixture.service.annotateApply('pg', { tagSuggestions: suggestions }, getRevision(fixture.db)),
    'AI_ANNOTATION_INVALID',
    422,
  );
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
    'tools.query.tags',
  ]);
  assert.equal(response.revision, before + 1);
  assert.equal(getRevision(fixture.db), before + 1);
  assert.equal(response.server.summarySource, 'ai');
  assert.deepEqual(response.server.tags, ['postgresql']);
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
  // Tool descriptions belong to the third party; annotation never writes an override.
  assert.equal(tool?.descriptionOverride, null);
  assert.deepEqual(tool?.tags, ['docs']);

  const index = fixture.db
    .prepare('SELECT index_description, index_tags_json FROM tools WHERE server_id = ? AND name = ?')
    .get('pg', 'query');
  assert.ok(String(index?.['index_description']).includes('Run a read-only SQL query.'));
  const indexTags = JSON.parse(String(index?.['index_tags_json'])) as string[];
  assert.deepEqual([...indexTags].sort(), ['docs', 'postgresql']);
  assert.equal(
    response.tools.find((entry) => entry.name === 'query')?.descriptionOverride,
    null,
  );
});

test('server tags above the limit are trimmed in preview and rejected on apply', async (t) => {
  const runner: AiRunner = {
    async run() {
      return {
        payload: {
          summary: 'PostgreSQL 查询 (postgres sql)',
          category: 'database',
          tags: ['postgresql', 'docs', 'testing'],
          toolOverrides: [],
          warnings: [],
        },
        resultText: '{}',
        model: null,
        durationMs: 1,
        costUsd: null,
      };
    },
    async close(): Promise<void> {},
  };
  const fixture = await makeFixture(t, { runner });
  seedServer(fixture.db);
  seedTool(fixture.db);

  const preview = await fixture.service.annotatePreview('pg');
  assert.deepEqual(preview.proposed.tags, ['postgresql', 'docs']);
  assert.ok(
    preview.warnings.some((warning) => warning.includes('最多 2 个')),
    preview.warnings.join('; '),
  );

  await expectApiError(
    fixture.service.annotateApply(
      'pg',
      { tags: ['postgresql', 'docs', 'testing'] },
      getRevision(fixture.db),
    ),
    'TAG_POLICY_VIOLATION',
    422,
  );
});

test('tool tags respect the effective limit in preview and apply', async (t) => {
  const runner: AiRunner = {
    async run() {
      return {
        payload: {
          summary: 'PostgreSQL 查询 (postgres sql)',
          category: 'database',
          tags: ['postgresql', 'docs'],
          toolOverrides: [{ name: 'query', tags: ['testing', 'security', 'memory'] }],
          warnings: [],
        },
        resultText: '{}',
        model: null,
        durationMs: 1,
        costUsd: null,
      };
    },
    async close(): Promise<void> {},
  };
  const fixture = await makeFixture(t, { runner });
  seedServer(fixture.db);
  seedTool(fixture.db);

  const preview = await fixture.service.annotatePreview('pg');
  assert.deepEqual(preview.proposed.toolOverrides[0]?.tags, ['testing', 'security']);
  assert.ok(
    preview.warnings.some((warning) => warning.includes('最多 4 个')),
    preview.warnings.join('; '),
  );

  await expectApiError(
    fixture.service.annotateApply(
      'pg',
      {
        tags: ['postgresql', 'docs'],
        toolOverrides: [{ name: 'query', tags: ['testing', 'security', 'memory'] }],
      },
      getRevision(fixture.db),
    ),
    'TAG_POLICY_VIOLATION',
    422,
  );
});

test('apply strips tool tags that repeat server tags and reports a warning', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db, { tags: ['postgresql'] });
  seedTool(fixture.db);

  const response = await fixture.service.annotateApply(
    'pg',
    { toolOverrides: [{ name: 'query', tags: ['postgresql', 'docs'] }] },
    getRevision(fixture.db),
  );

  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, ['docs']);
  assert.ok(
    response.warnings.some((warning) => warning.includes('重复')),
    response.warnings.join('; '),
  );
  assert.ok(response.changed.includes('tools.query.tags'));
});

test('a stray toolOverrides description is ignored, never written as an override', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);

  const response = await fixture.service.annotateApply(
    'pg',
    { toolOverrides: [{ name: 'query', description: 'AI rewrite', tags: ['docs'] }] },
    getRevision(fixture.db),
  );
  assert.deepEqual(response.changed, ['tools.query.tags']);
  assert.equal(getTool(fixture.db, 'pg', 'query')?.descriptionOverride, null);
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, ['docs']);
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
  seedServer(fixture.db, { tags: ['env.prod'] });
  upsertTool(fixture.db, 'pg', {
    name: 'query',
    description: 'Run a read-only SQL query.',
    inputSchema: { type: 'object' },
    tags: ['testing'],
  });

  await fixture.service.annotateApply('pg', APPLY, getRevision(fixture.db));
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, ['env.prod', 'postgresql']);
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, ['testing', 'docs']);

  const revision = getRevision(fixture.db);
  const response = await fixture.service.annotateApply(
    'pg',
    { tags: [], toolOverrides: [{ name: 'query', tags: [] }] },
    revision,
  );
  assert.deepEqual(response.changed, []);
  assert.equal(response.revision, revision);
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, ['env.prod', 'postgresql']);
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, ['testing', 'docs']);
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
  ]);
  const stored = getServer(fixture.db, 'pg');
  assert.equal(stored?.category, 'vector-db');
  assert.deepEqual(stored?.tags, []);

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
      tagSuggestions: [{ key: 'docs', zh: '换个标签', en: 'Different label' }],
    },
    before,
  );

  assert.deepEqual(response.changed, ['server.category']);
  assert.equal(getServer(fixture.db, 'pg')?.category, 'database');
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, []);
  const settings = listSettings(fixture.db);
  assert.deepEqual(
    readCategoryDictionary(settings).find((entry) => entry.key === 'database'),
    { key: 'database', zh: '数据库', en: 'Database' },
  );
  assert.deepEqual(
    readTagDictionary(settings).find((entry) => entry.key === 'docs'),
    { key: 'docs', zh: '文档', en: 'Docs' },
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
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, []);
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
    { tagDictionary: [{ key: 'docs', zh: '文档', en: 'Docs' }] },
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
    ['docs'],
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
  assert.deepEqual(preview.proposed.toolOverrides[0]?.tags, ['vector']);
  assert.ok(preview.warnings.some((warning) => warning.includes('sql')));
  assert.ok(preview.warnings.some((warning) => warning.includes('env.prod')));
  assert.ok(
    preview.warnings.some((warning) => warning.includes('read') && warning.includes('动作键')),
  );
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
  assert.deepEqual(preview.proposed.toolOverrides[0]?.tags, []);
  assert.ok(
    preview.warnings.some(
      (warning) => warning.includes('official') && warning.includes('由管理员维护'),
    ),
  );
  assert.ok(
    preview.warnings.some(
      (warning) => warning.includes('read') && warning.includes('动作键'),
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

  // A client may resubmit the raw draft. Values the restriction drops are
  // reported as warnings; a draft with nothing left after the drops is rejected.
  const before = getRevision(fixture.db);
  const rejected = [
    { tags: ['env.prod'] },
    { tags: ['database'] },
    { tags: ['read'] },
    { toolOverrides: [{ name: 'query', tags: ['read'] }] },
    { categorySuggestion: { key: 'official', zh: '官方', en: 'Official' } },
    { categorySuggestion: { key: 'browser', zh: '浏览器', en: 'Browser' } },
    { tagSuggestions: [{ key: 'database', zh: '数据库', en: 'Database' }] },
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

  // A raw draft whose valid part survives still applies; the dropped part is
  // reported in `warnings` and never written.
  const partial = await fixture.service.annotateApply(
    'pg',
    {
      categorySuggestion: { key: 'vector', zh: '向量', en: 'Vector' },
      tagSuggestions: [{ key: 'vector', zh: '向量', en: 'Vector' }],
    },
    getRevision(fixture.db),
  );
  assert.ok(partial.warnings.some((warning) => warning.includes('重名')), partial.warnings.join('; '));
  assert.deepEqual([...(getServer(fixture.db, 'pg')?.tags ?? [])].sort(), ['postgresql']);

  const mixed = await fixture.service.annotateApply(
    'pg',
    { toolOverrides: [{ name: 'query', tags: ['database', 'testing'] }] },
    getRevision(fixture.db),
  );
  assert.deepEqual(mixed.changed, ['tools.query.tags']);
  assert.ok(mixed.warnings.some((warning) => warning.includes('database')), mixed.warnings.join('; '));
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, ['testing']);

  await expectApiError(
    fixture.service.annotateApply(
      'pg',
      { toolOverrides: [{ name: 'query', tags: ['database', 'env.prod'] }] },
      getRevision(fixture.db),
    ),
    'AI_ANNOTATION_INVALID',
    422,
  );
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, ['testing']);
});

test('apply drops tags deleted from the dictionary and writes the rest', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db);
  seedTool(fixture.db);

  // The admin deleted `testing` after the proposal was generated.
  setSetting(
    fixture.db,
    TAG_SETTING_KEY,
    readTagDictionary(listSettings(fixture.db)).filter((entry) => entry.key !== 'testing'),
  );

  const response = await fixture.service.annotateApply(
    'pg',
    {
      tags: ['testing', 'postgresql'],
      tagSuggestions: [{ key: 'vector', zh: '向量', en: 'Vector' }],
      toolOverrides: [{ name: 'query', tags: ['testing'] }],
    },
    getRevision(fixture.db),
  );

  assert.ok(response.warnings.some((warning) => warning.includes('testing')), response.warnings.join('; '));
  assert.deepEqual([...(getServer(fixture.db, 'pg')?.tags ?? [])].sort(), ['postgresql']);
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, []);
  assert.ok(response.changed.includes('server.tags'));
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
// Server tag revalidation
// ---------------------------------------------------------------------------

test('server tag changes revalidate every enabled tool, not only overrides', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db, { tags: ['docs'] });
  upsertTool(fixture.db, 'pg', {
    name: 'query',
    description: 'Run a read-only SQL query.',
    inputSchema: { type: 'object' },
    tags: ['memory', 'testing', 'security'],
  });
  const before = getRevision(fixture.db);

  const error = await expectApiError(
    fixture.service.annotateApply('pg', { tags: ['postgresql'] }, before),
    'TAG_POLICY_VIOLATION',
    422,
  );
  const details = error.details as { tools?: Array<{ name: string; errors: string[] }> };
  assert.equal(details.tools?.[0]?.name, 'query');
  assert.ok(details.tools?.[0]?.errors.join(' ').includes('TAG_TOOL_LIMIT'));
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, ['docs']);
  assert.equal(getRevision(fixture.db), before);

  // Disabled tools do not inherit server tags for the limit check.
  assert.ok(patchTool(fixture.db, 'pg', 'query', { enabled: false }) !== null);
  const response = await fixture.service.annotateApply(
    'pg',
    { tags: ['postgresql'] },
    getRevision(fixture.db),
  );
  assert.deepEqual(response.changed, ['server.tags']);
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, ['docs', 'postgresql']);
});

// ---------------------------------------------------------------------------
// Auto annotation and failure queue
// ---------------------------------------------------------------------------

async function seedNewServer(fixture: Fixture): Promise<void> {
  seedServer(fixture.db);
  seedTool(fixture.db);
}

function payloadRunner(payload: Record<string, unknown>): AiRunner {
  return {
    async run() {
      return {
        payload,
        resultText: '{}',
        model: null,
        durationMs: 1,
        costUsd: null,
      };
    },
    async close(): Promise<void> {},
  };
}

test('auto annotation is skipped when autoAnnotate is false', async (t) => {
  const fixture = await makeFixture(t, { settings: { autoAnnotate: false } });
  await seedNewServer(fixture);
  const before = getRevision(fixture.db);
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  assert.deepEqual(fixture.audits, []);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
  assert.equal(getServer(fixture.db, 'pg')?.summary, null);
  assert.equal(getRevision(fixture.db), before);
});

test('auto annotation applies directly and leaves no pending entry', async (t) => {
  const fixture = await makeFixture(t);
  await seedNewServer(fixture);
  const before = getRevision(fixture.db);
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  const stored = getServer(fixture.db, 'pg');
  assert.equal(stored?.summary, APPLY.summary);
  assert.equal(stored?.summarySource, 'ai');
  assert.equal(stored?.category, 'database');
  assert.deepEqual(stored?.tags, ['postgresql']);
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, []);
  assert.equal(getRevision(fixture.db), before + 1);
  assert.deepEqual(fixture.rebuilds.at(-1), ['pg']);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0]?.trigger, 'auto');
  assert.equal(fixture.audits[0]?.kind, 'annotate');

  // The attempt budget prevents a second paid run for the same tool set.
  await fixture.service.onToolsIndexed('pg');
  assert.equal(fixture.audits.length, 1);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});

test('auto annotation runs for an existing incomplete server without a creation hook', async (t) => {
  const fixture = await makeFixture(t);
  await seedNewServer(fixture);
  // Registration happened in an earlier process: no onServerCreated call here.
  await fixture.service.onToolsIndexed('pg');
  assert.equal(getServer(fixture.db, 'pg')?.category, 'database');
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, ['postgresql']);
});

test('auto annotation skips when summary, category and every tool tag set are complete', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db, {
    summary: 'manual',
    summarySource: 'manual',
    category: 'database',
    tags: [],
  });
  // Server tags may be empty; one valid tool tag is enough for completeness.
  seedTool(fixture.db, 'query', 'Run a read-only SQL query.', ['docs']);
  const before = getRevision(fixture.db);
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  assert.deepEqual(fixture.audits, []);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
  assert.equal(getServer(fixture.db, 'pg')?.summary, 'manual');
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, []);
  assert.equal(getRevision(fixture.db), before);
});

test('auto annotation fills only missing fields and leaves manual metadata alone', async (t) => {
  const fixture = await makeFixture(t, {
    runner: payloadRunner({
      summary: 'AI 摘要 (ai summary)',
      category: 'observability',
      tags: ['postgresql'],
      toolOverrides: [],
      warnings: [],
    }),
  });
  seedServer(fixture.db, {
    summary: '人工摘要',
    summarySource: 'manual',
    category: 'database',
  });
  // Effective tags = 0, so the server is incomplete even though the tag list is empty.
  seedTool(fixture.db, 'query', 'Run a read-only SQL query.', []);
  const before = getRevision(fixture.db);
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  const stored = getServer(fixture.db, 'pg');
  assert.equal(stored?.summary, '人工摘要');
  assert.equal(stored?.summarySource, 'manual');
  assert.equal(stored?.category, 'database');
  assert.deepEqual(stored?.tags, ['postgresql']);
  assert.equal(getRevision(fixture.db), before + 1);
  assert.equal(fixture.audits.length, 1);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});

test('auto annotation still completes a server that only has a summary', async (t) => {
  const fixture = await makeFixture(t);
  seedServer(fixture.db, { summary: 'manual', summarySource: 'manual' });
  seedTool(fixture.db);
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  const stored = getServer(fixture.db, 'pg');
  assert.equal(stored?.summary, 'manual');
  assert.equal(stored?.summarySource, 'manual');
  assert.equal(stored?.category, 'database');
  assert.deepEqual(stored?.tags, ['postgresql']);
});

test('auto annotation failures keep the proposal and error in the queue', async (t) => {
  const fixture = await makeFixture(t, {
    runner: payloadRunner({
      summary: 'PostgreSQL 查询与写入 (postgres sql database query write)',
      category: 'database',
      tags: ['postgresql'],
      toolOverrides: [],
      warnings: [],
    }),
  });
  seedServer(fixture.db, { tags: ['docs'] });
  upsertTool(fixture.db, 'pg', {
    name: 'query',
    description: 'Run a read-only SQL query.',
    inputSchema: { type: 'object' },
    tags: ['memory', 'testing', 'security', 'gitlab'],
  });
  const before = getRevision(fixture.db);

  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  const pending = await fixture.service.pendingAnnotations();
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0]?.serverId, 'pg');
  assert.equal(pending.items[0]?.error.code, 'TAG_POLICY_VIOLATION');
  assert.ok(pending.items[0]?.error.message.includes('TAG_TOOL_LIMIT'));
  assert.deepEqual(pending.items[0]?.proposed.tags, ['postgresql']);
  assert.equal(getServer(fixture.db, 'pg')?.summary, null);
  assert.deepEqual(getServer(fixture.db, 'pg')?.tags, ['docs']);
  assert.equal(getRevision(fixture.db), before);
  assert.equal(fixture.audits[0]?.trigger, 'auto');

  // The failed attempt is not retried automatically.
  await fixture.service.onToolsIndexed('pg');
  assert.equal(fixture.audits.length, 1);
  assert.equal((await fixture.service.pendingAnnotations()).items.length, 1);
});

test('queued auto failures drop dictionary suggestions so retries cannot add keys', async (t) => {
  const fixture = await makeFixture(t, {
    runner: payloadRunner({
      summary: 'PostgreSQL 查询与写入 (postgres sql database query write)',
      category: null,
      categorySuggestion: { key: 'vector-db', zh: '向量数据库', en: 'Vector database' },
      tags: ['postgresql'],
      tagSuggestions: [{ key: 'vector', zh: '向量', en: 'Vector' }],
      toolOverrides: [{ name: 'query', tags: ['vector'] }],
      warnings: [],
    }),
  });
  seedServer(fixture.db, { tags: ['docs'] });
  upsertTool(fixture.db, 'pg', {
    name: 'query',
    description: 'Run a read-only SQL query.',
    inputSchema: { type: 'object' },
    tags: ['memory', 'testing', 'security'],
  });
  const categoriesBefore = readCategoryDictionary(listSettings(fixture.db));
  const tagsBefore = readTagDictionary(listSettings(fixture.db));

  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  const pending = await fixture.service.pendingAnnotations();
  assert.equal(pending.items.length, 1);
  const queued = pending.items[0];
  assert.ok(queued !== undefined);
  assert.equal(queued.error.code, 'TAG_POLICY_VIOLATION');
  assert.equal(queued.proposed.categorySuggestion, null);
  assert.deepEqual(queued.proposed.tagSuggestions, []);

  // The UI retry sends the same fields as a manual apply; with the suggestions
  // removed there is no way for it to write new dictionary keys.
  const retry: Record<string, unknown> = {};
  if (queued.proposed.summary !== null) retry['summary'] = queued.proposed.summary;
  if (queued.proposed.category !== null) retry['category'] = queued.proposed.category;
  if (queued.proposed.tags.length > 0) retry['tags'] = queued.proposed.tags;
  const overrides = queued.proposed.toolOverrides
    .filter((override) => (override.tags?.length ?? 0) > 0)
    .map((override) => ({ name: override.name, tags: override.tags }));
  if (overrides.length > 0) retry['toolOverrides'] = overrides;
  assert.equal('categorySuggestion' in retry, false);
  assert.equal('tagSuggestions' in retry, false);

  await expectApiError(
    fixture.service.annotateApply('pg', retry, getRevision(fixture.db)),
    'TAG_POLICY_VIOLATION',
    422,
  );
  assert.deepEqual(readCategoryDictionary(listSettings(fixture.db)), categoriesBefore);
  assert.deepEqual(readTagDictionary(listSettings(fixture.db)), tagsBefore);
});

test('auto annotation never treats null or empty proposals as a clear', async (t) => {
  const fixture = await makeFixture(t, {
    runner: payloadRunner({
      summary: null,
      category: null,
      tags: [],
      toolOverrides: [],
      warnings: [],
    }),
  });
  seedServer(fixture.db, {
    summary: '人工摘要',
    summarySource: 'manual',
    category: 'database',
  });
  seedTool(fixture.db);
  const before = getRevision(fixture.db);

  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  const stored = getServer(fixture.db, 'pg');
  assert.equal(stored?.summary, '人工摘要');
  assert.equal(stored?.summarySource, 'manual');
  assert.equal(stored?.category, 'database');
  assert.deepEqual(stored?.tags, []);
  assert.equal(getRevision(fixture.db), before);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
  assert.equal(fixture.audits.length, 1);
});

test('auto annotation only writes dictionary tags and never new suggestions', async (t) => {
  const fixture = await makeFixture(t, {
    runner: payloadRunner({
      summary: '向量检索 (vector search)',
      category: null,
      tags: [],
      tagSuggestions: [{ key: 'vector', zh: '向量', en: 'Vector' }],
      toolOverrides: [{ name: 'query', tags: ['vector'] }],
      warnings: [],
    }),
  });
  seedServer(fixture.db);
  seedTool(fixture.db);
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  assert.equal(getServer(fixture.db, 'pg')?.summary, '向量检索 (vector search)');
  assert.deepEqual(getTool(fixture.db, 'pg', 'query')?.tags, []);
  assert.equal(
    readTagDictionary(listSettings(fixture.db)).some((entry) => entry.key === 'vector'),
    false,
  );
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});

test('auto annotation retries a revision conflict once with a fresh revision', async (t) => {
  const fixture = await makeFixture(t);
  await seedNewServer(fixture);

  const originalGet = fixture.servers.get.bind(fixture.servers);
  let getCalls = 0;
  let injected = false;
  fixture.servers.get = async (serverId: string) => {
    getCalls += 1;
    const record = await originalGet(serverId);
    // #1 is the skip check, #2 the preview, #3 the apply body read, #4 the
    // first apply attempt. Bumping there makes its expected revision stale.
    if (getCalls === 4 && !injected) {
      injected = true;
      bumpRevision(fixture.db);
    }
    return record;
  };

  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');

  assert.equal(injected, true);
  assert.equal(getServer(fixture.db, 'pg')?.summary, APPLY.summary);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});

test('failed auto annotations expire and are dropped on mutation', async (t) => {
  const fixture = await makeFixture(t, {
    runner: payloadRunner({
      summary: 'PostgreSQL 查询与写入 (postgres sql database query write)',
      category: 'database',
      tags: ['postgresql'],
      toolOverrides: [],
      warnings: [],
    }),
  });
  seedServer(fixture.db, { tags: ['docs'] });
  upsertTool(fixture.db, 'pg', {
    name: 'query',
    description: 'Run a read-only SQL query.',
    inputSchema: { type: 'object' },
    tags: ['memory', 'testing', 'security', 'gitlab'],
  });
  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');
  assert.equal((await fixture.service.pendingAnnotations()).items.length, 1);

  fixture.service.onServerMutated('pg');
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });

  // A new tool changes the toolsHash; step past the 60s throttle as well.
  fixture.clock.advance(61_000);
  seedTool(fixture.db, 'query2', 'Another query tool.');
  await fixture.service.onToolsIndexed('pg');
  assert.equal((await fixture.service.pendingAnnotations()).items.length, 1);
  fixture.clock.advance(24 * 60 * 60_000 + 60_000);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});

test('an oversized auto preview does not consume the attempt budget', async (t) => {
  let calls = 0;
  const runner: AiRunner = {
    async run() {
      calls += 1;
      return {
        payload: {
          summary: APPLY.summary,
          category: 'database',
          tags: ['postgresql'],
          toolOverrides: [],
          warnings: [],
        },
        resultText: '{}',
        model: null,
        durationMs: 1,
        costUsd: null,
      };
    },
    async close(): Promise<void> {},
  };
  const fixture = await makeFixture(t, { runner });
  const env: Record<string, { $secret: string }> = {};
  for (let index = 0; index < 1200; index += 1) {
    env[`${'K'.repeat(40)}_${String(index).padStart(4, '0')}`] = { $secret: 'S' };
  }
  createServer(fixture.db, {
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio',
    command: 'npx',
    args: ['-y'],
    env,
  });
  seedTool(fixture.db);

  fixture.service.onServerCreated('pg');
  await fixture.service.onToolsIndexed('pg');
  assert.equal(calls, 0);
  assert.deepEqual(fixture.audits, []);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });

  // Shrinking the config makes the same (serverId, toolsHash) prompt fit again.
  updateServer(fixture.db, 'pg', { env: {} });
  fixture.clock.advance(61_000);
  await fixture.service.onToolsIndexed('pg');
  assert.equal(calls, 1);
  assert.equal(getServer(fixture.db, 'pg')?.summary, APPLY.summary);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});

test('concurrent tools/list runs only one auto annotation', async (t) => {
  let calls = 0;
  const runner: AiRunner = {
    async run() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        payload: {
          summary: APPLY.summary,
          category: 'database',
          tags: ['postgresql'],
          toolOverrides: [],
          warnings: [],
        },
        resultText: '{}',
        model: null,
        durationMs: 1,
        costUsd: null,
      };
    },
    async close(): Promise<void> {},
  };
  const fixture = await makeFixture(t, { runner });
  await seedNewServer(fixture);
  fixture.service.onServerCreated('pg');

  await Promise.all([
    fixture.service.onToolsIndexed('pg'),
    fixture.service.onToolsIndexed('pg'),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
  assert.equal(getServer(fixture.db, 'pg')?.summary, APPLY.summary);
});
