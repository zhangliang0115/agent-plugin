import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { createAdminScriptCandidatesHandler } from '../src/admin/script-candidates.ts';
import type { AdminResponse } from '../src/admin/servers.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { hashScriptCode, type ScriptCandidateSuggester } from '../src/scripts/analysis/index.ts';
import { ScriptCandidatesService } from '../src/scripts/candidates.ts';
import { normalizeCandidateSuggestion } from '../src/scripts/candidate-suggester.ts';
import { ScriptService, SCRIPT_RUN_RETENTION_DAYS } from '../src/scripts/service.ts';

const NOW = Date.UTC(2026, 10, 24, 6, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const OLD_ISO = new Date(NOW - (SCRIPT_RUN_RETENTION_DAYS + 10) * 86_400_000).toISOString();

const echo = (text: string): string => `return tools.demo.echo({ text: '${text}' });`;
const LIST_CODE = 'return tools.demo.list({ limit: 5 });';

interface Fixture {
  db: DatabaseSync;
  scripts: ScriptService;
  candidates: ScriptCandidatesService;
  call: (
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => Promise<AdminResponse>;
}

function fixture(t: TestContext, suggester?: ScriptCandidateSuggester): Fixture {
  const db = openStateDb(':memory:');
  t.after(() => db.close());
  const scripts = new ScriptService({ db, now: () => NOW });
  const candidates = new ScriptCandidatesService({
    db,
    scripts,
    now: () => NOW,
    ...(suggester === undefined ? {} : { suggester }),
  });
  const handler = createAdminScriptCandidatesHandler({ candidates });
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
  return { db, scripts, candidates, call };
}

interface SeedOptions {
  ok?: boolean;
  entryMode?: 'code' | 'script';
  code?: string | null;
  execId?: string | null;
  workspace?: string;
  createdAt?: string;
  toolsUsed?: string[];
}

function seedRun(
  f: Fixture,
  runId: string,
  code: string,
  options: SeedOptions = {},
): void {
  const entryMode = options.entryMode ?? 'code';
  f.scripts.archiveRun({
    runId,
    createdAt: options.createdAt ?? NOW_ISO,
    execId: options.execId === undefined ? `es_${runId}` : options.execId,
    evalId: 1,
    requestId: runId,
    binding: 'cb_test',
    clientName: 'test',
    clientVersion: '1',
    workspace: options.workspace ?? 'default',
    entryTool: 'run_script',
    entryMode,
    scriptId: entryMode === 'script' ? 's_existing' : null,
    scriptVersion: entryMode === 'script' ? 1 : null,
    scriptMode: entryMode === 'script' ? 'parameterized' : null,
    args: null,
    code: entryMode === 'script' ? null : (options.code === undefined ? code : options.code),
    ok: options.ok ?? true,
    error: null,
    resultBytes: 1,
    durationMs: 1,
    toolsUsed: options.toolsUsed ?? [],
    purpose: 'run',
  });
}

interface ScanBody {
  scanned: number;
  created: number;
  updated: number;
  warnings: string[];
}

interface CandidateItem {
  candidateId: string;
  code: string;
  codeSha256: string;
  sourceRunIds: string[];
  suggestedName: string | null;
  suggestedDescription: string | null;
  suggestedTags: string[] | null;
  suggestedInputSchema: Record<string, unknown> | null;
  suggestedCode: string | null;
  status: string;
  scriptId: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

function body<T>(response: AdminResponse): T {
  return response.body as T;
}

function errorCode(response: AdminResponse): string {
  const value = body<{ error?: { code: string } }>(response);
  assert.ok(value.error !== undefined, 'expected an error body');
  return value.error.code;
}

async function scan(f: Fixture, limit?: number): Promise<ScanBody> {
  const response = await f.call(
    'POST',
    '/admin/api/script-candidates/scan',
    limit === undefined ? undefined : { limit },
  );
  assert.equal(response.status, 200);
  return body<ScanBody>(response);
}

async function list(f: Fixture, query: Record<string, string> = {}): Promise<{
  items: CandidateItem[];
  nextCursor: string | null;
}> {
  const response = await f.call('GET', '/admin/api/script-candidates', undefined, query);
  assert.equal(response.status, 200);
  return body(response);
}

test('scan clusters successful code runs and lists pending candidates', async (t) => {
  const f = fixture(t);
  seedRun(f, 'r1', echo('alpha'), {
    execId: 'es_1',
    workspace: 'alpha',
    createdAt: '2026-11-22T10:00:00.000Z',
    toolsUsed: ['demo.echo'],
  });
  seedRun(f, 'r2', echo('beta'), {
    execId: 'es_2',
    workspace: 'beta',
    createdAt: '2026-11-23T10:00:00.000Z',
    toolsUsed: ['demo.echo'],
  });
  seedRun(f, 'r3', LIST_CODE, {
    execId: 'es_3',
    workspace: 'alpha',
    createdAt: '2026-11-21T10:00:00.000Z',
    toolsUsed: ['demo.list'],
  });

  const result = await scan(f);
  assert.deepEqual(result, { scanned: 3, created: 2, updated: 0, warnings: [] });

  const pending = await list(f, { status: 'pending' });
  assert.equal(pending.items.length, 2);
  const echoCandidate = pending.items.find((item) => item.suggestedName === 'demo: echo');
  assert.ok(echoCandidate !== undefined);
  assert.deepEqual(echoCandidate.sourceRunIds, ['r1', 'r2']);
  // The most recent raw source is the representative when counts tie.
  assert.equal(echoCandidate.code, echo('beta'));
  assert.equal(echoCandidate.codeSha256, hashScriptCode(echo('beta')));
  assert.deepEqual(echoCandidate.suggestedTags, ['demo']);

  assert.deepEqual((await list(f, { status: 'accepted' })).items, []);
  assert.deepEqual((await list(f, { status: 'rejected' })).items, []);

  const badStatus = await f.call('GET', '/admin/api/script-candidates', undefined, {
    status: 'nope',
  });
  assert.equal(badStatus.status, 400);
  assert.equal(errorCode(badStatus), 'INVALID_FIELD');

  const badLimit = await f.call('GET', '/admin/api/script-candidates', undefined, { limit: '0' });
  assert.equal(badLimit.status, 400);
  assert.equal(errorCode(badLimit), 'INVALID_QUERY');

  const badCursor = await f.call('GET', '/admin/api/script-candidates', undefined, {
    cursor: '!!!!',
  });
  assert.equal(badCursor.status, 400);
  assert.equal(errorCode(badCursor), 'INVALID_CURSOR');

  const wrongMethod = await f.call('GET', '/admin/api/script-candidates/scan');
  assert.equal(wrongMethod.status, 405);
});

test('scan skips failed, script, empty and expired runs and honors the sample limit', async (t) => {
  const f = fixture(t);
  seedRun(f, 'failed', echo('a'), { ok: false });
  seedRun(f, 'script-mode', '', { entryMode: 'script' });
  seedRun(f, 'empty-code', '', { code: '   ' });
  seedRun(f, 'expired', echo('b'), { createdAt: OLD_ISO });

  assert.deepEqual(await scan(f), { scanned: 0, created: 0, updated: 0, warnings: [] });
  assert.deepEqual((await list(f)).items, []);

  seedRun(f, 'fresh-1', echo('c'));
  seedRun(f, 'fresh-2', echo('d'));
  assert.equal((await scan(f, 1)).scanned, 1);
  assert.equal((await list(f)).items.length, 1);
});

test('scan is idempotent and never overwrites accepted or rejected candidates', async (t) => {
  const f = fixture(t);
  seedRun(f, 'r1', echo('a'), { toolsUsed: ['demo.echo'] });
  seedRun(f, 'r2', LIST_CODE, { toolsUsed: ['demo.list'] });

  assert.equal((await scan(f)).created, 2);
  assert.deepEqual(await scan(f), { scanned: 2, created: 0, updated: 2, warnings: [] });

  const first = (await list(f)).items;
  const echoCandidate = first.find((item) => item.suggestedName === 'demo: echo');
  const listCandidate = first.find((item) => item.suggestedName === 'demo: list');
  assert.ok(echoCandidate !== undefined);
  assert.ok(listCandidate !== undefined);

  const accepted = await f.call(
    'POST',
    `/admin/api/script-candidates/${echoCandidate.candidateId}/accept`,
  );
  assert.equal(accepted.status, 200);
  const rejected = await f.call(
    'POST',
    `/admin/api/script-candidates/${listCandidate.candidateId}/reject`,
  );
  assert.equal(rejected.status, 200);

  assert.deepEqual(await scan(f), { scanned: 2, created: 0, updated: 0, warnings: [] });

  const after = (await list(f)).items;
  const acceptedAfter = after.find((item) => item.candidateId === echoCandidate.candidateId);
  const rejectedAfter = after.find((item) => item.candidateId === listCandidate.candidateId);
  assert.equal(acceptedAfter?.status, 'accepted');
  assert.notEqual(acceptedAfter?.scriptId, null);
  assert.equal(rejectedAfter?.status, 'rejected');
});

test('a fake AI suggester merges name, description, tags, schema and code', async (t) => {
  const suggester: ScriptCandidateSuggester = {
    suggest(candidate) {
      assert.equal(candidate.suggestedName, 'demo: echo');
      return {
        name: 'Echo text',
        description: 'Echo a caller supplied text.',
        tags: ['demo', 'echo'],
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        code: 'return tools.demo.echo({ text: args.text });',
      };
    },
  };
  const f = fixture(t, suggester);
  seedRun(f, 'r1', echo('alpha'), { toolsUsed: ['demo.echo'] });

  assert.equal((await scan(f)).created, 1);
  const candidate = (await list(f)).items[0];
  assert.ok(candidate !== undefined);
  assert.equal(candidate.suggestedName, 'Echo text');
  assert.equal(candidate.suggestedDescription, 'Echo a caller supplied text.');
  assert.deepEqual(candidate.suggestedTags, ['demo', 'echo']);
  assert.deepEqual(candidate.suggestedInputSchema, {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  });
  assert.equal(candidate.suggestedCode, 'return tools.demo.echo({ text: args.text });');

  const accepted = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/accept`,
  );
  assert.equal(accepted.status, 200);
  const saved = body<{ script: { scriptId: string; status: string; activeVersion: number | null } }>(
    accepted,
  ).script;
  assert.equal(saved.status, 'draft');
  assert.equal(saved.activeVersion, null);
  const version = f.scripts.version(saved.scriptId, 1);
  assert.equal(version.mode, 'parameterized');
  assert.equal(version.code, 'return tools.demo.echo({ text: args.text });');
  assert.deepEqual(version.inputSchema, {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  });
});

test('a failing AI suggester keeps deterministic values and reports a warning', async (t) => {
  const f = fixture(t, {
    suggest() {
      throw new Error('model unavailable');
    },
  });
  seedRun(f, 'r1', echo('alpha'), { toolsUsed: ['demo.echo'] });

  const result = await scan(f);
  assert.equal(result.created, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /model unavailable/u);
  const candidate = (await list(f)).items[0];
  assert.equal(candidate?.suggestedName, 'demo: echo');
  assert.equal(candidate?.suggestedCode, null);
  assert.equal(candidate?.suggestedInputSchema, null);
});

test('accept overrides generate a draft and reject invalid input', async (t) => {
  const f = fixture(t);
  seedRun(f, 'r1', echo('alpha'), { toolsUsed: ['demo.echo'] });
  await scan(f);
  const candidate = (await list(f)).items[0];
  assert.ok(candidate !== undefined);

  // Another script already owns the requested name; acceptance must not win.
  f.scripts.save(
    { createdBy: 'admin' },
    {
      mode: 'parameterized',
      name: 'taken',
      description: 'existing',
      code: 'return 1;',
      inputSchema: { type: 'object', properties: {} },
    },
  );
  const conflict = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/accept`,
    { name: 'taken', description: 'override' },
  );
  assert.equal(conflict.status, 409);
  assert.equal(errorCode(conflict), 'SCRIPT_NAME_CONFLICT');

  const badSchema = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/accept`,
    { inputSchema: { type: 'object', properties: { x: { type: 'date' } } } },
  );
  assert.equal(badSchema.status, 422);
  assert.equal(errorCode(badSchema), 'SCRIPT_INPUT_SCHEMA_INVALID');

  const badCode = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/accept`,
    { code: 'return (' },
  );
  assert.equal(badCode.status, 422);
  assert.equal(errorCode(badCode), 'SCRIPT_CODE_INVALID');

  const stillPending = (await list(f)).items.find(
    (item) => item.candidateId === candidate.candidateId,
  );
  assert.equal(stillPending?.status, 'pending');

  const accepted = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/accept`,
    {
      name: 'accepted-script',
      description: 'accepted with overrides',
      tags: ['ops'],
      code: 'return tools.demo.echo({ text: args.text });',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      exampleArgs: { text: 'hello' },
    },
  );
  assert.equal(accepted.status, 200);
  const result = body<{
    candidate: CandidateItem;
    script: { scriptId: string; version: number; status: string; activeVersion: number | null };
  }>(accepted);
  assert.equal(result.candidate.status, 'accepted');
  assert.equal(result.candidate.reviewedBy, 'admin');
  assert.equal(result.candidate.reviewedAt, NOW_ISO);
  assert.equal(result.candidate.scriptId, result.script.scriptId);
  assert.equal(result.script.status, 'draft');
  assert.equal(result.script.activeVersion, null);
  assert.equal(f.scripts.get(result.script.scriptId)?.name, 'accepted-script');
  assert.deepEqual(f.scripts.version(result.script.scriptId, 1).exampleArgs, { text: 'hello' });

  const again = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/accept`,
  );
  assert.equal(again.status, 409);
  assert.equal(errorCode(again), 'SCRIPT_CANDIDATE_ALREADY_REVIEWED');

  const rejectReviewed = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/reject`,
  );
  assert.equal(rejectReviewed.status, 409);
  assert.equal(errorCode(rejectReviewed), 'SCRIPT_CANDIDATE_ALREADY_REVIEWED');

  const missing = await f.call('POST', '/admin/api/script-candidates/c_missing/accept');
  assert.equal(missing.status, 404);
  assert.equal(errorCode(missing), 'SCRIPT_CANDIDATE_NOT_FOUND');

  const unknownField = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/accept`,
    { workspace: 'x' },
  );
  assert.equal(unknownField.status, 400);
  assert.equal(errorCode(unknownField), 'UNKNOWN_FIELD');
});

test('accept falls back to the original code and empty schema without AI suggestions', async (t) => {
  const f = fixture(t);
  seedRun(f, 'r1', 'return 1 + 1;');
  await scan(f);
  const candidate = (await list(f)).items[0];
  assert.ok(candidate !== undefined);
  assert.equal(candidate.suggestedName, null);

  const incomplete = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/accept`,
    { description: 'no name' },
  );
  assert.equal(incomplete.status, 422);
  assert.equal(errorCode(incomplete), 'SCRIPT_CANDIDATE_INCOMPLETE');

  const accepted = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/accept`,
    { name: 'inline-sum', description: 'a small inline script' },
  );
  assert.equal(accepted.status, 200);
  const saved = body<{ script: { scriptId: string; status: string } }>(accepted).script;
  assert.equal(saved.status, 'draft');
  const version = f.scripts.version(saved.scriptId, 1);
  assert.equal(version.code, 'return 1 + 1;');
  assert.deepEqual(version.inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
});

test('accept carries the save-time secret warnings', async (t) => {
  const f = fixture(t);
  const token = 'ghp_' + 'A'.repeat(36);
  seedRun(f, 'r1', `const value = '${token}';\nreturn 1;`);
  await scan(f);
  const candidate = (await list(f)).items[0];
  assert.ok(candidate !== undefined);

  const accepted = await f.call(
    'POST',
    `/admin/api/script-candidates/${candidate.candidateId}/accept`,
    { name: 'secret-accepted', description: 'saved from a secret-looking run' },
  );
  assert.equal(accepted.status, 200);
  const script = body<{
    script: { scriptId: string; warnings: Array<{ field: string; kind: string; count: number }> };
  }>(accepted).script;
  assert.deepEqual(script.warnings, [
    { field: 'code', kind: 'provider_token', severity: 'high', count: 1 },
  ]);
  assert.equal(f.scripts.version(script.scriptId, 1).status, 'draft');
});

test('candidate list paginates, filters and rejects reviewed candidates once', async (t) => {
  const f = fixture(t);
  seedRun(f, 'r1', echo('a'), { toolsUsed: ['demo.echo'] });
  seedRun(f, 'r2', LIST_CODE, { toolsUsed: ['demo.list'] });
  seedRun(f, 'r3', 'return tools.demo.count({});');
  await scan(f);

  const firstPage = await list(f, { limit: '1' });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor !== null);
  const secondPage = await list(f, {
    limit: '2',
    cursor: firstPage.nextCursor as string,
  });
  assert.equal(secondPage.items.length, 2);
  assert.equal(secondPage.nextCursor, null);

  const target = secondPage.items[0];
  assert.ok(target !== undefined);
  const rejected = await f.call(
    'POST',
    `/admin/api/script-candidates/${target.candidateId}/reject`,
  );
  assert.equal(rejected.status, 200);
  const rejectedCandidate = body<{ candidate: CandidateItem }>(rejected).candidate;
  assert.equal(rejectedCandidate.status, 'rejected');
  assert.equal(rejectedCandidate.reviewedBy, 'admin');
  assert.equal(rejectedCandidate.reviewedAt, NOW_ISO);

  const again = await f.call('POST', `/admin/api/script-candidates/${target.candidateId}/reject`);
  assert.equal(again.status, 409);
  assert.equal(errorCode(again), 'SCRIPT_CANDIDATE_ALREADY_REVIEWED');

  assert.equal((await list(f, { status: 'rejected' })).items.length, 1);
  assert.equal((await list(f, { status: 'pending' })).items.length, 2);

  const scanValidation = await f.call('POST', '/admin/api/script-candidates/scan', {
    limit: 0,
  });
  assert.equal(scanValidation.status, 400);
  assert.equal(errorCode(scanValidation), 'INVALID_FIELD');
});

test('AI suggestion validation rejects invalid schemas, code and empty output', () => {
  const normalized = normalizeCandidateSuggestion({
    name: 'Echo',
    tags: [' demo ', 'demo'],
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    code: 'return tools.demo.echo({ text: args.text });',
  });
  assert.equal(normalized.name, 'Echo');
  assert.deepEqual(normalized.tags, ['demo', 'demo']);
  assert.deepEqual(normalized.inputSchema, {
    type: 'object',
    properties: { text: { type: 'string' } },
    additionalProperties: false,
  });

  assert.throws(
    () => normalizeCandidateSuggestion({ inputSchema: { type: 'object', properties: { x: { type: 'date' } } } }),
    /inputSchema\.properties\.x\.type/u,
  );
  assert.throws(
    () => normalizeCandidateSuggestion({ code: 'return (' }),
    /does not compile/u,
  );
  assert.throws(() => normalizeCandidateSuggestion({}), /no usable field/u);
  assert.throws(() => normalizeCandidateSuggestion('not an object'), /not a JSON object/u);
});
