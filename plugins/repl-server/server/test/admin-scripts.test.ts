import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { createAdminScriptsHandler } from '../src/admin/scripts.ts';
import type { AdminResponse } from '../src/admin/servers.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { ExecGateway } from '../src/exec/gateway.ts';
import { ScriptService } from '../src/scripts/service.ts';

const NOW = Date.UTC(2026, 10, 24, 6, 0, 0);

interface Fixture {
  db: DatabaseSync;
  service: ScriptService;
  gateway: ExecGateway;
  call: (
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => Promise<AdminResponse>;
}

function fixture(t: TestContext): Fixture {
  const db = openStateDb(':memory:');
  const service = new ScriptService({ db, now: () => NOW });
  // Mirrors assembly: admin tests go through the real eval path and archive.
  const gateway = new ExecGateway({
    callTool: async () => ({ ok: true }),
    onScriptRun: (record) => {
      service.archiveRun(record);
      if (record.ok && record.entryMode === 'script' && record.purpose !== 'test' && record.scriptId) {
        service.noteUsage(record.scriptId);
      }
    },
  });
  t.after(async () => {
    await gateway.disposeAll();
    db.close();
  });
  const handler = createAdminScriptsHandler({ scripts: service, gateway });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<AdminResponse> => {
    const response = await handler({ method, path, body, query });
    assert.ok(response !== null, `route ${method} ${path} was not handled`);
    return response;
  };
  return { db, service, gateway, call };
}

function seedRun(
  f: Fixture,
  runId: string,
  scriptId: string | null = null,
  overrides: { ok?: boolean; purpose?: 'run' | 'test' } = {},
): void {
  f.service.archiveRun({
    runId,
    createdAt: new Date(NOW).toISOString(),
    execId: 'es_admin',
    evalId: 1,
    requestId: 1,
    binding: 'cb_admin',
    clientName: 'test',
    clientVersion: '1',
    workspace: 'default',
    entryTool: 'run_script',
    entryMode: scriptId === null ? 'code' : 'script',
    code: scriptId === null ? 'return 1;' : null,
    scriptId,
    scriptVersion: scriptId === null ? null : 1,
    scriptMode: scriptId === null ? null : 'parameterized',
    args: scriptId === null ? null : { x: 1 },
    argsPreview: scriptId === null ? null : '{"x":1}',
    ok: overrides.ok ?? true,
    error: overrides.ok === false ? 'boom' : null,
    resultBytes: 1,
    durationMs: 3,
    toolsUsed: [],
    purpose: overrides.purpose ?? 'run',
  });
}

function bodyError(response: AdminResponse): { code: string; message: string } {
  const body = response.body as { error?: { code: string; message: string } };
  assert.ok(body.error !== undefined);
  return body.error;
}

test('admin scripts list, detail and not-found mapping', async (t) => {
  const f = fixture(t);
  const runId = 'run_admin_1';
  seedRun(f, runId);
  const saved = f.service.save(
    { createdBy: 'admin' },
    { runId, mode: 'exact', name: 'listed', description: 'listed script', tags: ['ops'] },
  );

  const list = await f.call('GET', '/admin/api/scripts', undefined, { limit: '10' });
  assert.equal(list.status, 200);
  const body = list.body as { items: Array<{ scriptId: string; name: string }>; nextCursor: unknown };
  assert.deepEqual(body.items.map((item) => item.name), ['listed']);
  assert.equal(body.nextCursor, null);

  const detail = await f.call('GET', `/admin/api/scripts/${saved.scriptId}`);
  assert.equal(detail.status, 200);
  assert.equal((detail.body as { script: { name: string } }).script.name, 'listed');

  const missing = await f.call('GET', '/admin/api/scripts/s_missing');
  assert.equal(missing.status, 404);
  assert.equal(bodyError(missing).code, 'SCRIPT_NOT_FOUND');

  const query = await f.call('GET', '/admin/api/scripts', undefined, { status: 'nope' });
  assert.equal(query.status, 400);
  assert.equal(bodyError(query).code, 'INVALID_FIELD');

  const badLimit = await f.call('GET', '/admin/api/scripts', undefined, { limit: '0' });
  assert.equal(badLimit.status, 400);
  assert.equal(bodyError(badLimit).code, 'INVALID_QUERY');

  const badCursor = await f.call('GET', '/admin/api/scripts', undefined, { cursor: '!!!!' });
  assert.equal(badCursor.status, 400);
  assert.equal(bodyError(badCursor).code, 'INVALID_CURSOR');
});

test('admin PATCH edits metadata, rejects duplicates and guards status', async (t) => {
  const f = fixture(t);
  seedRun(f, 'run_a');
  seedRun(f, 'run_b');
  const first = f.service.save(
    { createdBy: 'admin' },
    { runId: 'run_a', mode: 'exact', name: 'first', description: 'one' },
  );
  f.service.save(
    { createdBy: 'admin' },
    { runId: 'run_b', mode: 'exact', name: 'second', description: 'two' },
  );

  const patched = await f.call('PATCH', `/admin/api/scripts/${first.scriptId}`, {
    name: 'renamed',
    description: 'updated',
    tags: ['a', 'b'],
  });
  assert.equal(patched.status, 200);
  const script = (patched.body as { script: { name: string; tags: string[] } }).script;
  assert.equal(script.name, 'renamed');
  assert.deepEqual(script.tags, ['a', 'b']);

  const duplicate = await f.call('PATCH', `/admin/api/scripts/${first.scriptId}`, { name: 'second' });
  assert.equal(duplicate.status, 409);
  assert.equal(bodyError(duplicate).code, 'SCRIPT_NAME_CONFLICT');

  const empty = await f.call('PATCH', `/admin/api/scripts/${first.scriptId}`, {});
  assert.equal(empty.status, 400);
  assert.equal(bodyError(empty).code, 'INVALID_BODY');

  const unknown = await f.call('PATCH', `/admin/api/scripts/${first.scriptId}`, { workspace: 'x' });
  assert.equal(unknown.status, 400);
  assert.equal(bodyError(unknown).code, 'UNKNOWN_FIELD');

  const disabled = await f.call('PATCH', `/admin/api/scripts/${first.scriptId}`, { status: 'disabled' });
  assert.equal(disabled.status, 200);
  assert.equal((disabled.body as { script: { status: string } }).script.status, 'disabled');
});

test('admin cannot mark a versionless draft active through PATCH', async (t) => {
  const f = fixture(t);
  const draft = f.service.save(
    { createdBy: 'admin' },
    {
      mode: 'parameterized',
      name: 'draft-only',
      description: 'draft',
      code: 'return 1;',
      inputSchema: { type: 'object', properties: {} },
    },
  );
  const response = await f.call('PATCH', `/admin/api/scripts/${draft.scriptId}`, { status: 'active' });
  assert.equal(response.status, 422);
  assert.equal(bodyError(response).code, 'INVALID_FIELD');
});

test('admin version list, detail, edit and activation', async (t) => {
  const f = fixture(t);
  const saved = f.service.save(
    { createdBy: 'admin' },
    {
      mode: 'parameterized',
      name: 'versioned',
      description: 'versions',
      code: 'return args.x;',
      inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
    },
  );

  const versions = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions`);
  assert.equal(versions.status, 200);
  const items = (versions.body as { items: Array<Record<string, unknown>> }).items;
  assert.equal(items.length, 1);
  assert.equal('code' in (items[0] ?? {}), false, 'the list omits the code body');

  const detail = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions/1`);
  assert.equal(detail.status, 200);
  assert.equal((detail.body as { version: { code: string } }).version.code, 'return args.x;');

  const missing = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions/9`);
  assert.equal(missing.status, 404);
  assert.equal(bodyError(missing).code, 'SCRIPT_VERSION_NOT_FOUND');

  const created = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/versions`, {
    mode: 'parameterized',
    code: 'return args.x + 1;',
    inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
    changelog: 'add one',
  });
  assert.equal(created.status, 201);
  const version = (created.body as { version: { version: number; status: string; createdBy: string } }).version;
  assert.equal(version.version, 2);
  assert.equal(version.status, 'draft');
  assert.equal(version.createdBy, 'admin');

  const conflict = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/versions`, {
    mode: 'exact',
    code: 'return 1;',
  });
  assert.equal(conflict.status, 409);
  assert.equal(bodyError(conflict).code, 'SCRIPT_MODE_CONFLICT');

  const invalid = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/versions`, {
    mode: 'parameterized',
    code: 'return 1;',
    inputSchema: { type: 'object', properties: { bad: { oneOf: [] } } },
  });
  assert.equal(invalid.status, 422);
  assert.equal(bodyError(invalid).code, 'SCRIPT_INPUT_SCHEMA_INVALID');

  const untested = await f.call(
    'POST',
    `/admin/api/scripts/${saved.scriptId}/versions/1/activate`,
  );
  assert.equal(untested.status, 409);
  assert.equal(bodyError(untested).code, 'SCRIPT_VERSION_NOT_DRAFT');

  const untestedEdit = await f.call(
    'POST',
    `/admin/api/scripts/${saved.scriptId}/versions/2/activate`,
  );
  assert.equal(untestedEdit.status, 409);
  assert.equal(bodyError(untestedEdit).code, 'SCRIPT_VERSION_NOT_DRAFT');

  // The sync activateOnSuccess path records the successful test run id.
  f.service.activate(saved.scriptId, 1, 'run_verified', { createdBy: 'admin', isAdmin: true });

  const activated = await f.call(
    'POST',
    `/admin/api/scripts/${saved.scriptId}/versions/1/activate`,
  );
  assert.equal(activated.status, 200);
  const after = activated.body as {
    script: { status: string; activeVersion: number; mode: string };
    version: { status: string; verifiedRunId: string | null };
  };
  assert.equal(after.script.status, 'active');
  assert.equal(after.script.activeVersion, 1);
  assert.equal(after.script.mode, 'parameterized');
  assert.equal(after.version.status, 'active');
  assert.equal(after.version.verifiedRunId, 'run_verified');

  const archivedVersion = await f.call(
    'POST',
    `/admin/api/scripts/${saved.scriptId}/versions/9/activate`,
  );
  assert.equal(archivedVersion.status, 404);
});

test('admin run history is filtered by scriptId with a keyset cursor', async (t) => {
  const f = fixture(t);
  const runId = 'run_history_source';
  seedRun(f, runId);
  const saved = f.service.save(
    { createdBy: 'admin' },
    { runId, mode: 'exact', name: 'history', description: 'history' },
  );
  seedRun(f, 'run_script_1', saved.scriptId);
  seedRun(f, 'run_script_2', saved.scriptId);

  const first = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/runs`, undefined, {
    limit: '1',
  });
  assert.equal(first.status, 200);
  const page = first.body as {
    items: Array<{ runId: string; scriptId: string }>;
    nextCursor: string | null;
  };
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.scriptId, saved.scriptId);
  assert.ok(page.nextCursor !== null);

  const second = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/runs`, undefined, {
    limit: '1',
    cursor: page.nextCursor as string,
  });
  assert.equal(second.status, 200);
  const next = second.body as { items: Array<{ runId: string }> };
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0]?.runId, page.items[0]?.runId);
});

test('admin scripts handler ignores other admin roots', async (t) => {
  const f = fixture(t);
  const handler = createAdminScriptsHandler({ scripts: f.service, gateway: f.gateway });
  const response = await handler({ method: 'GET', path: '/admin/api/servers' });
  assert.equal(response, null);
});

function createParameterized(
  f: Fixture,
  name: string,
  code = 'return args.x + 1;',
): ReturnType<ScriptService['save']> {
  return f.service.save(
    { createdBy: 'admin' },
    {
      mode: 'parameterized',
      name,
      description: 'admin fixture',
      code,
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'integer' } },
        required: ['x'],
        additionalProperties: false,
      },
    },
  );
}

test('admin list and detail expose run statistics and the runs list keeps argsPreview', async (t) => {
  const f = fixture(t);
  seedRun(f, 'run_stats_source');
  const saved = f.service.save(
    { createdBy: 'admin' },
    { runId: 'run_stats_source', mode: 'exact', name: 'stats', description: 'stats' },
  );
  seedRun(f, 'run_stats_1', saved.scriptId);
  seedRun(f, 'run_stats_2', saved.scriptId);
  seedRun(f, 'run_stats_3', saved.scriptId, { ok: false });

  const list = await f.call('GET', '/admin/api/scripts');
  const items = (list.body as { items: Array<Record<string, unknown>> }).items;
  const item = items.find((entry) => entry['scriptId'] === saved.scriptId);
  assert.ok(item !== undefined);
  assert.equal(item['runCount'], 3);
  assert.equal(item['successCount'], 2);
  assert.equal(item['successRate'], 0.6667);

  const detail = await f.call('GET', `/admin/api/scripts/${saved.scriptId}`);
  const script = (detail.body as { script: Record<string, unknown> }).script;
  assert.equal(script['runCount'], 3);
  assert.equal(script['successCount'], 2);
  assert.equal(script['successRate'], 0.6667);

  const runs = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/runs`);
  const rows = (runs.body as { items: Array<Record<string, unknown>> }).items;
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.['argsPreview'], '{"x":1}');
  assert.equal('args' in (rows[0] ?? {}), false, 'the runs list never returns plaintext args');
  assert.equal('code' in (rows[0] ?? {}), false, 'the runs list never returns source code');

  const empty = createParameterized(f, 'no-runs-yet');
  const emptyDetail = await f.call('GET', `/admin/api/scripts/${empty.scriptId}`);
  const emptyScript = (emptyDetail.body as { script: Record<string, unknown> }).script;
  assert.equal(emptyScript['runCount'], 0);
  assert.equal(emptyScript['successCount'], 0);
  assert.equal(emptyScript['successRate'], 0);
});

test('admin version diff returns line operations and validates both versions', async (t) => {
  const f = fixture(t);
  const saved = createParameterized(f, 'diffed', 'return args.x;\nconst y = 1;');
  f.service.createVersion(saved.scriptId, {
    code: 'return args.x + 1;\nconst y = 1;',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'integer' } },
      required: ['x'],
      additionalProperties: false,
    },
  });

  const diff = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions/2/diff`, undefined, {
    baseVersion: '1',
  });
  assert.equal(diff.status, 200);
  const body = diff.body as {
    fromVersion: number;
    toVersion: number;
    lines: Array<{ type: string; text: string }>;
  };
  assert.equal(body.fromVersion, 1);
  assert.equal(body.toVersion, 2);
  assert.deepEqual(
    body.lines.filter((line) => line.type !== 'same'),
    [
      { type: 'del', text: 'return args.x;' },
      { type: 'add', text: 'return args.x + 1;' },
    ],
  );
  assert.ok(body.lines.some((line) => line.type === 'same' && line.text === 'const y = 1;'));

  const same = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions/1/diff`, undefined, {
    baseVersion: '1',
  });
  assert.equal((same.body as { lines: Array<{ type: string }> }).lines.every((line) => line.type === 'same'), true);

  const missingBase = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions/2/diff`);
  assert.equal(missingBase.status, 400);
  assert.equal(bodyError(missingBase).code, 'INVALID_QUERY');

  const badBase = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions/2/diff`, undefined, {
    baseVersion: '0',
  });
  assert.equal(badBase.status, 400);
  assert.equal(bodyError(badBase).code, 'INVALID_FIELD');

  const missingVersion = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions/9/diff`, undefined, {
    baseVersion: '1',
  });
  assert.equal(missingVersion.status, 404);
  assert.equal(bodyError(missingVersion).code, 'SCRIPT_VERSION_NOT_FOUND');

  const missingFrom = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions/2/diff`, undefined, {
    baseVersion: '9',
  });
  assert.equal(missingFrom.status, 404);
  assert.equal(bodyError(missingFrom).code, 'SCRIPT_VERSION_NOT_FOUND');
});

test('admin test endpoint runs a draft, never counts usage and can activate', async (t) => {
  const f = fixture(t);
  const saved = createParameterized(f, 'admin-tested');

  const noActive = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/test`, {
    args: { x: 1 },
  });
  assert.equal(noActive.status, 409);
  assert.equal(bodyError(noActive).code, 'SCRIPT_NOT_ACTIVE');

  const tested = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/test`, {
    version: 1,
    args: { x: 1 },
  });
  assert.equal(tested.status, 200);
  const run = tested.body as {
    runId: string;
    ok: boolean;
    durationMs: number | null;
    output: string;
    error: string | null;
    activated: boolean;
    status: string;
  };
  assert.equal(run.ok, true);
  assert.match(run.output, /<result>2<\/result>/);
  assert.equal(typeof run.durationMs, 'number');
  assert.equal(run.error, null);
  assert.equal(run.activated, false);
  assert.equal(run.status, 'draft');
  assert.equal(f.service.getRun(run.runId)?.purpose, 'test');
  assert.equal(f.service.get(saved.scriptId)?.status, 'draft');
  assert.equal(f.service.get(saved.scriptId)?.useCount, 0, 'test executions do not count as usage');

  const invalidArgs = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/test`, {
    version: 1,
    args: { x: 'one' },
  });
  assert.equal(invalidArgs.status, 422);
  assert.equal(bodyError(invalidArgs).code, 'SCRIPT_ARGS_INVALID');

  const unknown = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/test`, {
    version: 1,
    workspace: 'nope',
  });
  assert.equal(unknown.status, 400);
  assert.equal(bodyError(unknown).code, 'UNKNOWN_FIELD');

  const failing = createParameterized(f, 'admin-failing', 'throw new Error("admin boom");');
  const failed = await f.call('POST', `/admin/api/scripts/${failing.scriptId}/test`, {
    version: 1,
    args: { x: 1 },
  });
  assert.equal(failed.status, 200);
  const failedRun = failed.body as {
    ok: boolean;
    output: string;
    error: string | null;
    activated: boolean;
    status: string;
  };
  assert.equal(failedRun.ok, false);
  assert.match(failedRun.output, /admin boom/);
  assert.match(failedRun.error ?? '', /admin boom/);
  assert.equal(failedRun.activated, false);
  assert.equal(failedRun.status, 'draft');
  assert.equal(f.service.get(failing.scriptId)?.status, 'draft');

  const activated = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/test`, {
    version: 1,
    args: { x: 1 },
    activateOnSuccess: true,
  });
  assert.equal(activated.status, 200);
  const activationRun = activated.body as {
    runId: string;
    ok: boolean;
    activated: boolean;
    status: string;
  };
  assert.equal(activationRun.ok, true);
  assert.equal(activationRun.activated, true);
  assert.equal(activationRun.status, 'active');
  const script = f.service.get(saved.scriptId);
  assert.equal(script?.status, 'active');
  assert.equal(script?.activeVersion, 1);
  assert.equal(script?.useCount, 0);
  assert.equal(f.service.version(saved.scriptId, 1).verifiedRunId, activationRun.runId);

  const notDraft = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/test`, {
    version: 1,
    args: { x: 1 },
    activateOnSuccess: true,
  });
  assert.equal(notDraft.status, 409);
  assert.equal(bodyError(notDraft).code, 'SCRIPT_VERSION_NOT_DRAFT');
});

test('admin version detail and edit responses carry secret warnings without hiding code', async (t) => {
  const f = fixture(t);
  const token = 'ghp_' + 'A'.repeat(36);
  const saved = createParameterized(f, 'admin-secret', `const value = '${token}';\nreturn args.x;`);

  const detail = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions/1`);
  assert.equal(detail.status, 200);
  const detailBody = detail.body as {
    version: { code: string };
    warnings: Array<{ field: string; kind: string; severity: string; count: number }>;
  };
  assert.match(detailBody.version.code, new RegExp(token), 'admins still see the original code');
  assert.deepEqual(detailBody.warnings, [
    { field: 'code', kind: 'provider_token', severity: 'high', count: 1 },
  ]);

  const created = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/versions`, {
    code: `const key = '${token}';\nreturn args.x + 1;`,
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'integer' } },
      required: ['x'],
      additionalProperties: false,
    },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(
    (created.body as { warnings: Array<{ kind: string }> }).warnings.map((warning) => warning.kind),
    ['provider_token'],
  );

  const versionOne = await f.call('GET', `/admin/api/scripts/${saved.scriptId}/versions/1`);
  assert.deepEqual((versionOne.body as { warnings: Array<unknown> }).warnings.length, 1);
  const ordinary = createParameterized(f, 'admin-plain', 'return args.x + 1;');
  const plain = await f.call('GET', `/admin/api/scripts/${ordinary.scriptId}/versions/1`);
  assert.deepEqual((plain.body as { warnings: Array<unknown> }).warnings, []);
});

test('admin exact version edits require a source run and support rollback', async (t) => {
  const f = fixture(t);
  seedRun(f, 'run_exact_1');
  const exact = f.service.save(
    { createdBy: 'admin' },
    { runId: 'run_exact_1', mode: 'exact', name: 'exact-admin', description: 'exact' },
  );
  seedRun(f, 'run_exact_2');

  const missingRun = await f.call('POST', `/admin/api/scripts/${exact.scriptId}/versions`, {});
  assert.equal(missingRun.status, 400);
  assert.equal(bodyError(missingRun).code, 'INVALID_ARGUMENT');

  const withCode = await f.call('POST', `/admin/api/scripts/${exact.scriptId}/versions`, {
    runId: 'run_exact_2',
    code: 'return 2;',
  });
  assert.equal(withCode.status, 400);
  assert.equal(bodyError(withCode).code, 'INVALID_ARGUMENT');

  const created = await f.call('POST', `/admin/api/scripts/${exact.scriptId}/versions`, {
    runId: 'run_exact_2',
  });
  assert.equal(created.status, 201);
  const version = (created.body as {
    version: {
      version: number;
      status: string;
      code: string;
      sourceRunId: string | null;
      verifiedRunId: string | null;
    };
  }).version;
  assert.equal(version.version, 2);
  assert.equal(version.status, 'draft');
  assert.equal(version.code, 'return 1;', 'code comes from the source run');
  assert.equal(version.sourceRunId, 'run_exact_2');
  assert.equal(version.verifiedRunId, 'run_exact_2');

  const activateTwo = await f.call(
    'POST',
    `/admin/api/scripts/${exact.scriptId}/versions/2/activate`,
  );
  assert.equal(activateTwo.status, 200);
  assert.equal((activateTwo.body as { script: { activeVersion: number } }).script.activeVersion, 2);
  assert.equal(f.service.version(exact.scriptId, 1).status, 'superseded');

  const rollback = await f.call(
    'POST',
    `/admin/api/scripts/${exact.scriptId}/versions/1/activate`,
  );
  assert.equal(rollback.status, 200);
  const after = rollback.body as {
    script: { activeVersion: number };
    version: { version: number; status: string };
  };
  assert.equal(after.script.activeVersion, 1);
  assert.equal(after.version.status, 'active');
  assert.equal(f.service.version(exact.scriptId, 2).status, 'superseded');
});

test('admin version paths reject integers outside the safe range', async (t) => {
  const f = fixture(t);
  const saved = createParameterized(f, 'huge-version');

  const response = await f.call(
    'GET',
    `/admin/api/scripts/${saved.scriptId}/versions/9007199254740993`,
  );
  assert.equal(response.status, 400);
  assert.equal(bodyError(response).code, 'INVALID_FIELD');
});

test('admin parameterized version edits record an optional source run', async (t) => {
  const f = fixture(t);
  const saved = createParameterized(f, 'provenance');
  seedRun(f, 'run_provenance');

  const created = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/versions`, {
    runId: 'run_provenance',
    code: 'return args.x + 2;',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'integer' } },
      required: ['x'],
      additionalProperties: false,
    },
  });
  assert.equal(created.status, 201);
  const version = (created.body as {
    version: { sourceRunId: string | null; verifiedRunId: string | null };
  }).version;
  assert.equal(version.sourceRunId, 'run_provenance');
  assert.equal(version.verifiedRunId, null);

  const missing = await f.call('POST', `/admin/api/scripts/${saved.scriptId}/versions`, {
    runId: 'run_missing',
    code: 'return args.x + 3;',
    inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
  });
  assert.equal(missing.status, 404);
  assert.equal(bodyError(missing).code, 'SCRIPT_RUN_NOT_FOUND');
});
