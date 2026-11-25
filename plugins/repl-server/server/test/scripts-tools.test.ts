import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { openStateDb } from '../src/db/migrate.ts';
import type {
  CatalogSnapshot,
  CatalogTool,
  ExecutionGateway,
  RequestIdentity,
  ScriptOutcome,
  ScriptRequest,
  TaskSnapshot,
} from '../src/ports.ts';
import { ScriptError, ScriptService, SCRIPT_CODE_MAX_BYTES } from '../src/scripts/service.ts';
import { callTool, type ToolCallContext } from '../src/tools/call.ts';
import type { CallToolResult } from '../src/tools/registry.ts';
import { McpTaskStore } from '../src/tasks/mcp-tasks.ts';

const NOW = Date.UTC(2026, 10, 24, 6, 0, 0);
const IDENTITY: RequestIdentity = {
  identity: 'bound',
  binding: 'cb_scripts',
  client: 'test-client/1.0',
  mcp: 'mcp_scripts',
};

const CATALOG: CatalogTool[] = [
  {
    name: 'Bash',
    kind: 'builtin',
    inputSchema: { type: 'object' },
    concurrency: 'serial',
    enabled: true,
  },
];

class FakeGateway implements ExecutionGateway {
  readonly runCalls: ScriptRequest[] = [];
  readonly dispatchCalls: ScriptRequest[] = [];
  runOutcome: ScriptOutcome = {
    content: '<repl-output eval="1" run="run_ok"><result>ok</result></repl-output>',
    isError: false,
    runId: 'run_ok',
  };
  runError: unknown = null;
  /** Lets a test mimic the settle-time archive/activation the real gateway owns. */
  afterRun?: (request: ScriptRequest, outcome: ScriptOutcome) => void;

  async runScript(request: ScriptRequest): Promise<ScriptOutcome> {
    this.runCalls.push(request);
    if (this.runError !== null) throw this.runError;
    this.afterRun?.(request, this.runOutcome);
    return this.runOutcome;
  }

  async dispatchScript(
    request: ScriptRequest,
  ): Promise<{ taskId: string; evalId: number; runId: string }> {
    this.dispatchCalls.push(request);
    return { taskId: 't_1', evalId: 2, runId: 'run_async' };
  }

  async waitTasks(): Promise<unknown> {
    return { ok: true, timedOut: false, events: [], pending: 0 };
  }

  async getTask(): Promise<TaskSnapshot | null> {
    return null;
  }

  async cancelTask(): Promise<boolean> {
    return true;
  }

  async destroyOwner(): Promise<void> {}
  async destroyTransport(): Promise<void> {}
}

interface Fixture {
  db: DatabaseSync;
  service: ScriptService;
  gateway: FakeGateway;
  ctx: ToolCallContext;
  audits: Array<Record<string, unknown> & { event: string }>;
}

function fixture(t: TestContext, now: () => number = () => NOW): Fixture {
  const db = openStateDb(':memory:');
  t.after(() => db.close());
  const service = new ScriptService({ db, now });
  const gateway = new FakeGateway();
  const audits: Array<Record<string, unknown> & { event: string }> = [];
  const catalog = {
    snapshot: (): CatalogSnapshot => ({ revision: 1, tools: CATALOG }),
  };
  const ctx: ToolCallContext = {
    identity: IDENTITY,
    gateway,
    catalog,
    tasks: new McpTaskStore({ clock: { now } }),
    scripts: service,
    audit: (event) => audits.push(event),
  };
  return { db, service, gateway, ctx, audits };
}

function archiveRun(
  fixture: Fixture,
  overrides: Partial<Parameters<ScriptService['archiveRun']>[0]> = {},
): string {
  const runId = overrides.runId ?? 'run_1';
  fixture.service.archiveRun({
    runId,
    createdAt: new Date(NOW).toISOString(),
    execId: 'es_1',
    evalId: 1,
    requestId: 2,
    binding: 'cb_scripts',
    clientName: 'test-client',
    clientVersion: '1.0',
    workspace: 'default',
    entryTool: 'run_script',
    entryMode: 'code',
    args: null,
    scriptId: null,
    scriptVersion: null,
    scriptMode: null,
    code: 'return 41 + 1;',
    ok: true,
    error: null,
    resultBytes: 2,
    durationMs: 5,
    toolsUsed: ['Bash'],
    purpose: 'run',
    ...overrides,
  });
  return runId;
}

function resultText(result: unknown): string {
  const call = result as CallToolResult;
  const block = call.content[0];
  assert.ok(block !== undefined && block.type === 'text');
  return block.text;
}

function errorCodeOf(error: unknown): string | undefined {
  return error instanceof ScriptError ? error.code : undefined;
}

test('exact save stores the source run as an active zero-argument script', (t) => {
  const f = fixture(t);
  const runId = archiveRun(f);
  const saved = f.service.save(
    { createdBy: 'cb_scripts' },
    { runId, mode: 'exact', name: 'answer', description: 'Return forty-two' },
  );
  assert.deepEqual(saved, {
    scriptId: saved.scriptId,
    name: 'answer',
    version: 1,
    status: 'active',
    activeVersion: 1,
    mode: 'exact',
    warnings: [],
  });
  assert.match(saved.scriptId, /^s_[0-9A-Z]{26}$/);

  const found = f.service.search({ query: 'answer' });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.name, 'answer');
  assert.equal(found[0]?.mode, 'exact');
  assert.equal(found[0]?.activeVersion, 1);
  assert.deepEqual(found[0]?.inputSchema, {});

  const resolved = f.service.resolveExecution({ scriptId: saved.scriptId });
  assert.equal(resolved.code, 'return 41 + 1;');
  assert.equal(resolved.purpose, 'run');
  assert.throws(
    () => f.service.resolveExecution({ scriptId: saved.scriptId, args: { x: 1 } }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_ARGS_INVALID',
  );
});

test('parameterized save is a draft, validates args, and needs an explicit version', (t) => {
  const f = fixture(t);
  const runId = archiveRun(f, { runId: 'run_source' });
  const saved = f.service.save(
    { createdBy: 'cb_scripts' },
    {
      runId,
      mode: 'parameterized',
      name: 'add-one',
      description: 'Add one to x',
      code: 'return args.x + 1;',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'integer', minimum: 0 } },
        required: ['x'],
        additionalProperties: false,
      },
      exampleArgs: { x: 1 },
    },
  );
  assert.equal(saved.status, 'draft');
  assert.equal(saved.activeVersion, null);
  assert.equal(saved.mode, 'parameterized');

  assert.deepEqual(f.service.search({ query: 'add' }), [], 'draft scripts are not searchable');
  assert.throws(
    () => f.service.resolveExecution({ scriptId: saved.scriptId }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_NOT_ACTIVE',
  );

  const resolved = f.service.resolveExecution(
    { scriptId: saved.scriptId, scriptVersion: 1, args: { x: 41 } },
    { actor: { createdBy: 'cb_scripts' } },
  );
  assert.equal(resolved.purpose, 'test');
  assert.match(resolved.code, /^async function __savedScript\(args\)/);
  assert.match(resolved.code, /JSON\.parse\("\{\\"x\\":41\}"\)/);
  assert.deepEqual(resolved.args, { x: 41 });

  for (const args of [undefined, {}, { x: -1 }, { x: 1, y: 2 }, { x: 'one' }]) {
    assert.throws(
      () =>
        f.service.resolveExecution(
          { scriptId: saved.scriptId, scriptVersion: 1, args },
          { actor: { createdBy: 'cb_scripts' } },
        ),
      (error: unknown) => errorCodeOf(error) === 'SCRIPT_ARGS_INVALID',
      `expected ${JSON.stringify(args)} to be rejected`,
    );
  }
});

test('parameterized save does not require a source run', (t) => {
  const f = fixture(t);
  const saved = f.service.save(
    { createdBy: 'cb_scripts' },
    {
      mode: 'parameterized',
      name: 'no-source',
      description: 'Written from scratch',
      code: 'return 1;',
      inputSchema: { type: 'object', properties: {} },
    },
  );
  assert.equal(saved.status, 'draft');
});

test('save rejects unsupported schemas, syntax errors and oversized code', (t) => {
  const f = fixture(t);
  const base = {
    mode: 'parameterized' as const,
    name: 'bad',
    description: 'bad script',
    inputSchema: { type: 'object', properties: {} },
  };
  assert.throws(
    () =>
      f.service.save(
        { createdBy: 'x' },
        {
          ...base,
          code: 'return 1;',
          inputSchema: { type: 'object', properties: { x: { $ref: '#/x' } } },
        },
      ),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_INPUT_SCHEMA_INVALID',
  );
  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { ...base, code: 'return (;' }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_CODE_INVALID',
  );
  const big = `// ${'x'.repeat(SCRIPT_CODE_MAX_BYTES)}\nreturn 1;`;
  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { ...base, code: big }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_CODE_INVALID',
  );
  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { ...base, code: 'return 1;', exampleArgs: { x: 1 } }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_ARGS_INVALID',
  );
});

test('exact save refuses a source run without reusable code', (t) => {
  const f = fixture(t);
  archiveRun(f, { runId: 'run_failed', ok: false, error: 'boom', code: null });
  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { runId: 'run_failed', mode: 'exact', name: 'n', description: 'd' }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_RUN_NOT_SUCCESSFUL',
  );
  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { runId: 'missing', mode: 'exact', name: 'n', description: 'd' }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_RUN_NOT_FOUND',
  );
});

test('exact save takes code from the run and rejects submitted code or non-empty schema', (t) => {
  const f = fixture(t);
  const runId = archiveRun(f);
  const base = { mode: 'exact' as const, name: 'strict', description: 'strict exact script' };

  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { ...base, runId, code: 'return 1;' }),
    (error: unknown) => errorCodeOf(error) === 'INVALID_ARGUMENT',
    'exact mode must not accept a code override',
  );
  assert.throws(
    () =>
      f.service.save(
        { createdBy: 'x' },
        { ...base, runId, inputSchema: { type: 'object', properties: { x: { type: 'integer' } } } },
      ),
    (error: unknown) => errorCodeOf(error) === 'INVALID_ARGUMENT',
    'exact mode must not accept a non-empty inputSchema',
  );
  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { ...base, runId, exampleArgs: { x: 1 } }),
    (error: unknown) => errorCodeOf(error) === 'INVALID_ARGUMENT',
    'exact mode must not accept exampleArgs',
  );
  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { mode: 'exact', name: 'no-run', description: 'd' }),
    (error: unknown) => errorCodeOf(error) === 'INVALID_ARGUMENT',
    'exact mode requires runId',
  );

  const saved = f.service.save(
    { createdBy: 'x' },
    { ...base, runId, inputSchema: {}, exampleArgs: {} },
  );
  assert.equal(saved.status, 'active');
  assert.equal(f.service.get(saved.scriptId)?.mode, 'exact');
  assert.equal(f.service.version(saved.scriptId, 1).verifiedRunId, runId);
});

test('scripts.mode fixes the mode of every version', (t) => {
  const f = fixture(t);
  const runId = archiveRun(f, { runId: 'run_exact_1', code: 'return 1;' });
  const exact = f.service.save(
    { createdBy: 'x' },
    { runId, mode: 'exact', name: 'fixed-exact', description: 'd' },
  );
  assert.equal(f.service.get(exact.scriptId)?.mode, 'exact');

  archiveRun(f, { runId: 'run_exact_2', code: 'return 2;' });
  f.service.save(
    { createdBy: 'x' },
    { scriptId: exact.scriptId, runId: 'run_exact_2', baseVersion: 1 },
  );
  assert.deepEqual(
    f.service.versions(exact.scriptId).map((version) => version.mode),
    ['exact', 'exact'],
  );

  const parameterized = f.service.save(
    { createdBy: 'x' },
    {
      mode: 'parameterized',
      name: 'fixed-parameterized',
      description: 'd',
      code: 'return args.x;',
      inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
    },
  );
  assert.equal(f.service.get(parameterized.scriptId)?.mode, 'parameterized');
  f.service.createVersion(parameterized.scriptId, {
    code: 'return args.x + 1;',
    inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
  });
  assert.deepEqual(
    f.service.versions(parameterized.scriptId).map((version) => version.mode),
    ['parameterized', 'parameterized'],
  );
});

test('updates: metadata only, baseVersion conflicts and fixed mode', (t) => {
  const f = fixture(t);
  const runId = archiveRun(f, { runId: 'run_v1', code: 'return 1;' });
  const saved = f.service.save(
    { createdBy: 'x' },
    { runId, mode: 'exact', name: 'stable', description: 'first' },
  );

  const renamed = f.service.save({ createdBy: 'x' }, { scriptId: saved.scriptId, name: 'renamed' });
  assert.equal(renamed.version, 1, 'metadata changes do not create a version');
  assert.equal(f.service.get(saved.scriptId)?.name, 'renamed');

  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { scriptId: saved.scriptId, code: 'return 7;' }),
    (error: unknown) => errorCodeOf(error) === 'INVALID_ARGUMENT',
    'a code update requires baseVersion',
  );

  assert.throws(
    () =>
      f.service.save(
        { createdBy: 'x' },
        { scriptId: saved.scriptId, baseVersion: 1, inputSchema: {} },
      ),
    (error: unknown) => errorCodeOf(error) === 'INVALID_ARGUMENT',
    'an exact update requires runId',
  );

  archiveRun(f, { runId: 'run_v2', code: 'return 7;' });
  assert.throws(
    () =>
      f.service.save(
        { createdBy: 'x' },
        { scriptId: saved.scriptId, runId: 'run_v2', code: 'return 7;', baseVersion: 1 },
      ),
    (error: unknown) => errorCodeOf(error) === 'INVALID_ARGUMENT',
    'an exact update must not submit code',
  );
  assert.throws(
    () =>
      f.service.save(
        { createdBy: 'x' },
        {
          scriptId: saved.scriptId,
          runId: 'run_v2',
          baseVersion: 1,
          inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
        },
      ),
    (error: unknown) => errorCodeOf(error) === 'INVALID_ARGUMENT',
    'an exact update must not submit a non-empty inputSchema',
  );

  const updated = f.service.save(
    { createdBy: 'x' },
    { scriptId: saved.scriptId, runId: 'run_v2', baseVersion: 1 },
  );
  assert.equal(updated.version, 2);
  assert.equal(updated.status, 'active');
  assert.equal(updated.activeVersion, 1, 'the active version stays until activation');
  const draft = f.service.version(saved.scriptId, 2);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.code, 'return 7;', 'the exact version takes code from the source run');
  assert.equal(draft.verifiedRunId, 'run_v2');

  assert.throws(
    () =>
      f.service.save(
        { createdBy: 'x' },
        { scriptId: saved.scriptId, runId: 'run_v2', baseVersion: 1 },
      ),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_VERSION_CONFLICT',
  );

  assert.throws(
    () =>
      f.service.save(
        { createdBy: 'x' },
        {
          scriptId: saved.scriptId,
          code: 'return args.x;',
          inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
          baseVersion: 2,
          mode: 'parameterized',
        },
      ),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_MODE_CONFLICT',
  );

  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { scriptId: 's_missing', name: 'x' }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_NOT_FOUND',
  );
});

test('script names are unique globally', (t) => {
  const f = fixture(t);
  const first = archiveRun(f, { runId: 'run_a' });
  f.service.save({ createdBy: 'x' }, { runId: first, mode: 'exact', name: 'same', description: 'a' });
  const second = archiveRun(f, { runId: 'run_b' });
  assert.throws(
    () => f.service.save({ createdBy: 'x' }, { runId: second, mode: 'exact', name: 'same', description: 'b' }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_NAME_CONFLICT',
  );
});

test('usage counters move only for real script runs', (t) => {
  const f = fixture(t);
  const saved = f.service.save(
    { createdBy: 'x' },
    {
      mode: 'parameterized',
      name: 'counted',
      description: 'counted',
      code: 'return 1;',
      inputSchema: { type: 'object', properties: {} },
    },
  );
  assert.equal(f.service.search({}).length, 0, 'a draft is not searchable');
  f.service.activate(saved.scriptId, 1, 'run_verified', { createdBy: 'x' });
  let item = f.service.search({})[0];
  assert.equal(item?.useCount, 0);
  assert.equal(item?.lastUsedAt, null);

  f.service.noteUsage(saved.scriptId);
  item = f.service.search({})[0];
  assert.equal(item?.useCount, 1);
  assert.equal(item?.lastUsedAt, new Date(NOW).toISOString());
});

test('search filters by query and tags and caps the limit', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 3; index += 1) {
    const runId = archiveRun(f, { runId: `run_${index}` });
    f.service.save(
      { createdBy: 'x' },
      {
        runId,
        mode: 'exact',
        name: `script-${index}`,
        description: `desc ${index}`,
        tags: index === 0 ? ['alpha', 'beta'] : ['beta'],
      },
    );
  }
  assert.equal(f.service.search({ query: 'script-1' }).length, 1);
  assert.equal(f.service.search({ tags: ['alpha'] }).length, 1);
  assert.equal(f.service.search({ tags: ['beta'] }).length, 3);
  assert.equal(f.service.search({ tags: ['alpha', 'missing'] }).length, 0);
  assert.equal(f.service.search({ limit: 2 }).length, 2);
  assert.equal(f.service.search({ limit: 999 }).length, 3);
});

test('FTS search ranks by BM25, supports prefixes and Chinese, and follows index updates', (t) => {
  const f = fixture(t);
  const save = (runId: string, name: string, description: string, tags: string[] = []) => {
    archiveRun(f, { runId });
    return f.service.save({ createdBy: 'x' }, { runId, mode: 'exact', name, description, tags });
  };
  save('run_1', 'report helper', 'nothing here');
  save('run_2', 'helper', 'report and more');
  save('run_3', '加法脚本', '把两个数相加');
  save('run_4', 'elastic query', '查询 Elasticsearch 文档');
  save('run_5', 'tagged report', 'tagged', ['alpha']);

  assert.deepEqual(
    f.service.search({ query: 'report' }).map((item) => item.name).slice(0, 2).sort(),
    ['report helper', 'tagged report'],
    'name hits rank above description hits',
  );
  assert.equal(
    f.service.search({ query: 'report' }).at(-1)?.name,
    'helper',
    'the description-only hit ranks last',
  );
  assert.deepEqual(
    f.service.search({ query: 'repor' }).map((item) => item.name).slice(0, 2).sort(),
    ['report helper', 'tagged report'],
    'tokens are prefix-matched',
  );
  assert.deepEqual(
    f.service.search({ query: '加法' }).map((item) => item.name),
    ['加法脚本'],
    'a Chinese prefix matches the larger Chinese token',
  );
  assert.deepEqual(
    f.service.search({ query: '脚本' }).map((item) => item.name),
    ['加法脚本'],
    'a mid-token Chinese substring falls back to LIKE when FTS misses',
  );
  assert.deepEqual(
    f.service.search({ query: '查询 文档' }).map((item) => item.name),
    ['elastic query'],
    'multiple words are ANDed',
  );
  assert.deepEqual(
    f.service.search({ query: 'report', tags: ['alpha'] }).map((item) => item.name),
    ['tagged report'],
    'tag filters combine with MATCH',
  );

  const beforeRename = save('run_6', 'legacy token', 'fresh');
  const renamed = f.service.save(
    { createdBy: 'x' },
    { scriptId: beforeRename.scriptId, name: 'renamed result' },
  );
  assert.deepEqual(
    f.service.search({ query: 'renamed' }).map((item) => item.name),
    ['renamed result'],
    'the update trigger refreshes the FTS row',
  );
  assert.deepEqual(
    f.service.search({ query: 'legacy' }).map((item) => item.name),
    [],
    'the old name is gone from the index',
  );
  f.db.prepare('DELETE FROM scripts WHERE script_id = ?').run(renamed.scriptId);
  assert.deepEqual(
    f.service.search({ query: 'renamed' }).map((item) => item.name),
    [],
    'the delete trigger drops the FTS row',
  );
});

test('FTS search survives special characters and never returns drafts', (t) => {
  const f = fixture(t);
  archiveRun(f, { runId: 'run_active' });
  f.service.save(
    { createdBy: 'x' },
    { runId: 'run_active', mode: 'exact', name: 'safe active', description: 'queryable' },
  );
  f.service.save(
    { createdBy: 'x' },
    {
      mode: 'parameterized',
      name: 'safe draft',
      description: 'queryable',
      code: 'return 1;',
      inputSchema: { type: 'object', properties: {} },
    },
  );

  for (const query of ['"', '""', 'AND OR NOT', '* - ( )', '!!!', 'a:b', 'foo"bar', '   ']) {
    assert.doesNotThrow(() => f.service.search({ query }), `query ${JSON.stringify(query)} must not throw`);
  }
  assert.deepEqual(f.service.search({ query: 'safe' }).map((item) => item.name), ['safe active']);
  assert.deepEqual(f.service.search({ query: '!!!' }), []);
});

test('script runs archive the workspace default, mode, args and preview, then expire', (t) => {
  let now = NOW;
  const f = fixture(t, () => now);
  archiveRun(f, { runId: 'run_default', workspace: '' });
  const run = f.service.getRun('run_default');
  assert.equal(run?.workspace, 'default');
  assert.equal(run?.expiresAt, new Date(NOW + 30 * 86_400_000).toISOString());

  archiveRun(f, {
    runId: 'run_scripted',
    entryMode: 'script',
    scriptId: 's_01JABCDEFGHJKMNPQRSTVWXYZ0',
    scriptVersion: 1,
    scriptMode: 'parameterized',
    args: { x: 1 },
    argsPreview: '{"x":1}',
  });
  const scripted = f.service.getRun('run_scripted');
  assert.equal(scripted?.scriptMode, 'parameterized');
  assert.deepEqual(scripted?.args, { x: 1 });
  assert.equal(scripted?.argsPreview, '{"x":1}');

  now += 31 * 86_400_000;
  assert.equal(f.service.pruneExpiredRuns(), 2);
  assert.equal(f.service.getRun('run_default'), null);
});

test('run_script scriptId mode validates args, activates a draft and reports the envelope', async (t) => {
  const f = fixture(t);
  const saved = f.service.save(
    { createdBy: IDENTITY.binding as string },
    {
      mode: 'parameterized',
      name: 'add',
      description: 'add',
      code: 'return args.x + 1;',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'integer' } },
        required: ['x'],
        additionalProperties: false,
      },
    },
  );

  f.gateway.afterRun = (request, outcome) => {
    // The real gateway archives at settle and activates there; this fake only
    // proves the tool surface hands activation to the execution path.
    if (request.activateOnSuccess === true && request.scriptId !== undefined && request.scriptVersion !== undefined) {
      assert.ok(request.actor !== undefined);
      assert.deepEqual(request.actor, { createdBy: IDENTITY.binding });
      f.service.activate(request.scriptId, request.scriptVersion, outcome.runId ?? null, request.actor);
    }
  };

  const result = (await callTool(
    'run_script',
    { scriptId: saved.scriptId, scriptVersion: 1, args: { x: 1 }, activateOnSuccess: true },
    f.ctx,
  )) as CallToolResult;
  assert.equal(result.isError, false);
  const request = f.gateway.runCalls[0];
  assert.ok(request !== undefined);
  assert.equal(request.entryMode, 'script');
  assert.equal(request.scriptId, saved.scriptId);
  assert.equal(request.scriptVersion, 1);
  assert.equal(request.scriptMode, 'parameterized');
  assert.equal(request.purpose, 'test');
  assert.deepEqual(request.args, { x: 1 });
  assert.equal(request.activateOnSuccess, true);
  assert.match(request.code, /__savedScript\(JSON\.parse/);

  const script = f.service.get(saved.scriptId);
  assert.equal(script?.status, 'active');
  assert.equal(script?.activeVersion, 1);
  assert.equal(f.service.version(saved.scriptId, 1).verifiedRunId, 'run_ok');

  assert.throws(
    () =>
      f.service.resolveExecution(
        { scriptId: saved.scriptId, scriptVersion: 1, args: {} },
        { actor: { createdBy: IDENTITY.binding as string } },
      ),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_ARGS_INVALID',
  );
});

test('run_script argument rules and async activateOnSuccess dispatch', async (t) => {
  const f = fixture(t);
  const both = (await callTool(
    'run_script',
    { code: 'x', scriptId: 's_1' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(both.isError, true);
  assert.match(resultText(both), /exactly one of code or scriptName/);

  const withCode = (await callTool(
    'run_script',
    { code: 'x', args: { a: 1 } },
    f.ctx,
  )) as CallToolResult;
  assert.equal(withCode.isError, true);
  assert.match(resultText(withCode), /require scriptName/);

  const saved = f.service.save(
    { createdBy: IDENTITY.binding as string },
    { mode: 'parameterized', name: 'async-test', description: 'd', code: 'return 1;', inputSchema: { type: 'object', properties: {} } },
  );
  const asyncAttempt = (await callTool(
    'run_script',
    { scriptId: saved.scriptId, scriptVersion: 1, async: true, activateOnSuccess: true },
    f.ctx,
  )) as CallToolResult;
  assert.equal(asyncAttempt.isError, false);
  assert.match(resultText(asyncAttempt), /async="true"/);
  const dispatched = f.gateway.dispatchCalls[0];
  assert.ok(dispatched !== undefined);
  assert.equal(dispatched.activateOnSuccess, true);
  assert.equal(dispatched.purpose, 'test');
  assert.equal(f.service.get(saved.scriptId)?.status, 'draft', 'activation waits for the async settle');
});

test('run_script resolves a saved script by name to the same execution as scriptId', async (t) => {
  const f = fixture(t);
  const runId = archiveRun(f, { runId: 'run_named' });
  const saved = f.service.save(
    { createdBy: IDENTITY.binding as string },
    { runId, mode: 'exact', name: 'answer-by-name', description: 'd' },
  );

  const byName = (await callTool(
    'run_script',
    { scriptName: 'answer-by-name' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(byName.isError, false);
  const nameRequest = f.gateway.runCalls[0];
  assert.ok(nameRequest !== undefined);
  assert.equal(nameRequest.entryMode, 'script');
  assert.equal(nameRequest.scriptId, saved.scriptId, 'the name resolves to the real scriptId');
  assert.equal(nameRequest.scriptVersion, 1);
  assert.equal(nameRequest.code, 'return 41 + 1;');

  const byId = (await callTool('run_script', { scriptId: saved.scriptId }, f.ctx)) as CallToolResult;
  assert.equal(byId.isError, false);
  assert.deepEqual(f.gateway.runCalls[1], nameRequest, 'name and id produce the same request');

  const idAsName = (await callTool(
    'run_script',
    { scriptName: saved.scriptId },
    f.ctx,
  )) as CallToolResult;
  assert.equal(idAsName.isError, true);
  assert.match(resultText(idAsName), /SCRIPT_NOT_FOUND/);
  assert.equal(f.gateway.runCalls.length, 2, 'a scriptId is never reinterpreted as a name');
});

test('run_script rejects unknown, empty and competing script names', async (t) => {
  const f = fixture(t);

  const missing = (await callTool('run_script', { scriptName: 'no-such-script' }, f.ctx)) as CallToolResult;
  assert.equal(missing.isError, true);
  assert.match(resultText(missing), /SCRIPT_NOT_FOUND/);
  assert.match(resultText(missing), /no-such-script/);

  const empty = (await callTool('run_script', { scriptName: '' }, f.ctx)) as CallToolResult;
  assert.equal(empty.isError, true);
  assert.match(resultText(empty), /INVALID_ARGUMENT: exactly one of code or scriptName is required/);

  const both = (await callTool(
    'run_script',
    { scriptId: 's_1', scriptName: 'x' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(both.isError, true);
  assert.match(resultText(both), /scriptId is a legacy alias; pass only scriptName/);

  const codeAndName = (await callTool(
    'run_script',
    { code: 'x', scriptName: 'x' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(codeAndName.isError, true);
  assert.match(resultText(codeAndName), /exactly one of code or scriptName/);

  assert.equal(f.gateway.runCalls.length, 0, 'no invalid shape reaches execution');
});

test('run_script by name keeps version, args and lifecycle checks', async (t) => {
  const f = fixture(t);
  const saved = f.service.save(
    { createdBy: IDENTITY.binding as string },
    {
      mode: 'parameterized',
      name: 'add-by-name',
      description: 'add',
      code: 'return args.x + 1;',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'integer' } },
        required: ['x'],
        additionalProperties: false,
      },
    },
  );

  const result = (await callTool(
    'run_script',
    { scriptName: 'add-by-name', scriptVersion: 1, args: { x: 41 } },
    f.ctx,
  )) as CallToolResult;
  assert.equal(result.isError, false);
  const request = f.gateway.runCalls[0];
  assert.ok(request !== undefined);
  assert.equal(request.scriptId, saved.scriptId);
  assert.equal(request.scriptVersion, 1);
  assert.equal(request.purpose, 'test', 'the owner still tests an unactivated draft');
  assert.deepEqual(request.args, { x: 41 });

  const badArgs = (await callTool(
    'run_script',
    { scriptName: 'add-by-name', scriptVersion: 1, args: {} },
    f.ctx,
  )) as CallToolResult;
  assert.equal(badArgs.isError, true);
  assert.match(resultText(badArgs), /SCRIPT_ARGS_INVALID/);
  assert.equal(f.gateway.runCalls.length, 1, 'argument checks run before dispatch');
});

test('save_script and search_scripts emit audit and validate through the tool surface', async (t) => {
  const f = fixture(t);
  const runId = archiveRun(f);
  const saved = (await callTool(
    'save_script',
    { runId, mode: 'exact', name: 'audited', description: 'd' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(saved.isError, false);
  assert.equal(f.audits.at(-1)?.['event'], 'script_saved');
  assert.equal(f.audits.at(-1)?.['ok'], true);
  assert.equal(f.audits.at(-1)?.['name'], 'audited');
  assert.equal(f.audits.at(-1)?.['sourceRunId'], runId);

  const bad = (await callTool(
    'save_script',
    { runId: 'missing', mode: 'exact', name: 'x', description: 'd' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(bad.isError, true);
  assert.equal(f.audits.at(-1)?.['ok'], false);
  assert.deepEqual(f.audits.at(-1)?.['error'], {
    code: 'SCRIPT_RUN_NOT_FOUND',
    message: 'run missing was not found',
  });

  const found = (await callTool('search_scripts', { query: 'audited' }, f.ctx)) as CallToolResult;
  assert.equal(found.isError, false);
  const payload = JSON.parse(resultText(found)) as { scripts: Array<{ scriptName: string }> };
  assert.deepEqual(payload.scripts.map((item) => item.scriptName), ['audited']);
});

test('run_script by name keeps the system id out of lifecycle errors', async (t) => {
  const f = fixture(t);
  const saved = f.service.save(
    { createdBy: IDENTITY.binding as string },
    {
      mode: 'parameterized',
      name: 'disabled-by-name',
      description: 'd',
      code: 'return 1;',
      inputSchema: { type: 'object', properties: {} },
    },
  );
  f.service.patch(saved.scriptId, { status: 'disabled' });

  const disabled = (await callTool(
    'run_script',
    { scriptName: 'disabled-by-name' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(disabled.isError, true);
  assert.match(resultText(disabled), /SCRIPT_DISABLED/);
  assert.match(resultText(disabled), /disabled-by-name/);
  assert.doesNotMatch(resultText(disabled), new RegExp(saved.scriptId));
});

test('save_script updates by scriptName and returns scriptName without scriptId', async (t) => {
  const f = fixture(t);
  const saved = f.service.save(
    { createdBy: IDENTITY.binding as string },
    {
      mode: 'parameterized',
      name: 'rename-me',
      description: 'before',
      code: 'return 1;',
      inputSchema: { type: 'object', properties: {} },
    },
  );

  const updated = (await callTool(
    'save_script',
    { scriptName: 'rename-me', name: 'renamed-by-tool', description: 'after' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(updated.isError, false);
  const payload = JSON.parse(resultText(updated)) as Record<string, unknown>;
  assert.equal(payload['scriptName'], 'renamed-by-tool');
  assert.equal('scriptId' in payload, false);
  assert.equal(payload['version'], 1);
  assert.equal(payload['status'], 'draft');
  assert.equal(payload['activeVersion'], null);
  assert.equal(payload['mode'], 'parameterized');
  assert.deepEqual(payload['warnings'], []);
  assert.equal(f.service.get(saved.scriptId)?.name, 'renamed-by-tool');

  const unknown = (await callTool(
    'save_script',
    { scriptName: 'no-such-script', description: 'x' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(unknown.isError, true);
  assert.match(resultText(unknown), /SCRIPT_NOT_FOUND/);
  assert.match(resultText(unknown), /no-such-script/);

  const foreign = f.service.save(
    { createdBy: 'someone-else' },
    {
      mode: 'parameterized',
      name: 'owned-elsewhere',
      description: 'd',
      code: 'return 1;',
      inputSchema: { type: 'object', properties: {} },
    },
  );
  const forbidden = (await callTool(
    'save_script',
    { scriptName: 'owned-elsewhere', description: 'x' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(forbidden.isError, true);
  assert.match(resultText(forbidden), /SCRIPT_FORBIDDEN/);
  assert.match(resultText(forbidden), /owned-elsewhere/);
  assert.doesNotMatch(resultText(forbidden), new RegExp(foreign.scriptId));

  const both = (await callTool(
    'save_script',
    { scriptId: saved.scriptId, scriptName: 'renamed-by-tool', description: 'x' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(both.isError, true);
  assert.match(resultText(both), /scriptId is a legacy alias; pass only scriptName/);
});

test('save_script still updates a legacy scriptId target', async (t) => {
  const f = fixture(t);
  const saved = f.service.save(
    { createdBy: IDENTITY.binding as string },
    {
      mode: 'parameterized',
      name: 'legacy-target',
      description: 'before',
      code: 'return 1;',
      inputSchema: { type: 'object', properties: {} },
    },
  );

  const updated = (await callTool(
    'save_script',
    { scriptId: saved.scriptId, description: 'after' },
    f.ctx,
  )) as CallToolResult;
  assert.equal(updated.isError, false);
  const payload = JSON.parse(resultText(updated)) as Record<string, unknown>;
  assert.equal(payload['scriptName'], 'legacy-target');
  assert.equal('scriptId' in payload, false);
  assert.equal(f.service.get(saved.scriptId)?.description, 'after');
});

test('search_scripts returns scriptName and keeps every documented field', async (t) => {
  const f = fixture(t);
  const runId = archiveRun(f, { runId: 'run_search' });
  const saved = f.service.save(
    { createdBy: 'x' },
    { runId, mode: 'exact', name: 'searchable', description: 'find me', tags: ['demo'] },
  );
  f.service.noteUsage(saved.scriptId);

  const found = (await callTool('search_scripts', { query: 'searchable' }, f.ctx)) as CallToolResult;
  assert.equal(found.isError, false);
  const { scripts } = JSON.parse(resultText(found)) as {
    scripts: Array<Record<string, unknown>>;
  };
  assert.equal(scripts.length, 1);
  const item = scripts[0];
  assert.ok(item !== undefined);
  assert.equal('scriptId' in item, false);
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      'scriptName',
      'description',
      'tags',
      'mode',
      'activeVersion',
      'inputSchema',
      'exampleArgs',
      'useCount',
      'lastUsedAt',
      'updatedAt',
    ].sort(),
  );
  assert.equal(item['scriptName'], 'searchable');
  assert.equal(item['description'], 'find me');
  assert.deepEqual(item['tags'], ['demo']);
  assert.equal(item['mode'], 'exact');
  assert.equal(item['activeVersion'], 1);
  assert.deepEqual(item['inputSchema'], {});
  assert.equal(item['exampleArgs'], null);
  assert.equal(item['useCount'], 1);
  assert.equal(typeof item['lastUsedAt'], 'string');
  assert.equal(typeof item['updatedAt'], 'string');
});

test('scriptId mode surfaces lifecycle errors', async (t) => {
  const f = fixture(t);
  const missing = (await callTool('run_script', { scriptId: 's_missing' }, f.ctx)) as CallToolResult;
  assert.equal(missing.isError, true);
  assert.match(resultText(missing), /SCRIPT_NOT_FOUND/);

  const saved = f.service.save(
    { createdBy: 'x' },
    {
      mode: 'parameterized',
      name: 'disabled-one',
      description: 'd',
      code: 'return 1;',
      inputSchema: { type: 'object', properties: {} },
    },
  );
  f.service.patch(saved.scriptId, { status: 'disabled' });
  const disabled = (await callTool('run_script', { scriptId: saved.scriptId }, f.ctx)) as CallToolResult;
  assert.equal(disabled.isError, true);
  assert.match(resultText(disabled), /SCRIPT_DISABLED/);
});
