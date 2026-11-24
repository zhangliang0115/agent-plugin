import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeScriptRuns,
  applySuggestion,
  hashScriptCode,
  normalizeScriptCode,
  scoreCluster,
} from '../src/scripts/analysis/index.ts';
import type {
  ScriptCandidateSuggester,
  ScriptRunSample,
} from '../src/scripts/analysis/index.ts';

interface RunOptions {
  workspace?: string;
  toolsUsed?: string[];
  createdAt?: string;
  sessionId?: string;
}

function run(runId: string, code: string, options: RunOptions = {}): ScriptRunSample {
  return {
    runId,
    code,
    workspace: options.workspace ?? 'default',
    toolsUsed: options.toolsUsed ?? [],
    createdAt: options.createdAt ?? '2026-11-20T10:00:00.000Z',
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  };
}

const SEARCH_CODE = "const q = 'logs';\nreturn tools.elasticsearch.search_documents({ index: q });";
const SEARCH_CODE_SPACED =
  "const q='logs'; // same script, different formatting\nreturn tools.elasticsearch.search_documents({index:q});";

test('normalization ignores comments and formatting but preserves literal values', () => {
  assert.equal(
    normalizeScriptCode('  const value=1; // inline\n/* block */ return value;'),
    normalizeScriptCode('const value = 1;\n\nreturn value;'),
  );
  assert.notEqual(
    normalizeScriptCode("const url = 'http://example.test';"),
    normalizeScriptCode("const url = 'http:';"),
  );
});

test('template and regex literals are tokenized as single values', () => {
  const template = 'const text = `a${flag ? `b${value}` : "c"}//not a comment`; run(text); // trailing';
  const templateBare = 'const text = `a${flag ? `b${value}` : "c"}//not a comment`; run(text);';
  assert.equal(normalizeScriptCode(template), normalizeScriptCode(templateBare));
  assert.notEqual(
    normalizeScriptCode(template),
    normalizeScriptCode('const text = `a${flag ? `b${value}` : "c"}`; run(text);'),
  );

  const regex = 'const pattern = /a\\/\\//; run(pattern); // trailing';
  assert.equal(normalizeScriptCode(regex), normalizeScriptCode('const pattern = /a\\/\\//; run(pattern);'));
  assert.notEqual(normalizeScriptCode(regex), normalizeScriptCode('const pattern = /a\\/\\//;'));
});

test('clusters by normalized code globally and keeps the most frequent raw source', () => {
  const candidates = analyzeScriptRuns([
    run('r3', SEARCH_CODE_SPACED, {
      workspace: 'beta',
      toolsUsed: ['elasticsearch.search_documents'],
      createdAt: '2026-11-21T09:00:00.000Z',
    }),
    run('r1', SEARCH_CODE, {
      workspace: 'alpha',
      toolsUsed: ['elasticsearch.search_documents'],
      createdAt: '2026-11-19T09:00:00.000Z',
    }),
    run('r2', SEARCH_CODE, {
      workspace: 'beta',
      toolsUsed: ['elasticsearch.search_documents'],
      createdAt: '2026-11-20T09:00:00.000Z',
    }),
  ]);

  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.ok(candidate !== undefined);
  assert.equal(candidate.code, SEARCH_CODE);
  assert.equal(candidate.codeSha256, hashScriptCode(SEARCH_CODE));
  assert.deepEqual(candidate.sourceRunIds, ['r1', 'r2', 'r3']);
  assert.deepEqual(candidate.workspaces, ['alpha', 'beta']);
  assert.equal(candidate.runCount, 3);
  assert.equal(candidate.sessionCount, 3);
  assert.equal(candidate.firstSeenAt, '2026-11-19T09:00:00.000Z');
  assert.equal(candidate.lastSeenAt, '2026-11-21T09:00:00.000Z');
});

test('literal variants merge into one parameterization candidate and score higher', () => {
  const code = (value: string): string => `return tools.elasticsearch.search({ query: '${value}' });`;
  const identical = analyzeScriptRuns([
    run('a1', code('x'), { workspace: 'a', createdAt: '2026-11-18T10:00:00.000Z' }),
    run('a2', code('x'), { workspace: 'b', createdAt: '2026-11-19T10:00:00.000Z' }),
    run('a3', code('x'), { workspace: 'c', createdAt: '2026-11-20T10:00:00.000Z' }),
  ]);
  const variants = analyzeScriptRuns([
    run('b1', code('x'), { workspace: 'a', createdAt: '2026-11-18T10:00:00.000Z' }),
    run('b2', code('y'), { workspace: 'b', createdAt: '2026-11-19T10:00:00.000Z' }),
    run('b3', code('z'), { workspace: 'c', createdAt: '2026-11-20T10:00:00.000Z' }),
  ]);

  assert.equal(variants.length, 1);
  assert.equal(variants[0]?.runCount, 3);
  assert.ok(identical[0] !== undefined);
  assert.ok(variants[0] !== undefined);
  assert.ok(variants[0].score > identical[0].score);
});

test('different tool calls stay separate candidates', () => {
  const candidates = analyzeScriptRuns([
    run('r1', "return tools.alpha.read({ id: 'a' });"),
    run('r2', "return tools.beta.write({ id: 'a' });"),
  ]);
  assert.equal(candidates.length, 2);
});

test('analysis is order-independent and deduplicates repeated run ids', () => {
  const first = run('r1', SEARCH_CODE, { workspace: 'alpha', sessionId: 's1' });
  const second = run('r2', SEARCH_CODE_SPACED, { workspace: 'beta', sessionId: 's2' });
  assert.deepEqual(analyzeScriptRuns([first, second]), analyzeScriptRuns([second, first]));

  const duplicate = { ...first, workspace: 'gamma' };
  const candidates = analyzeScriptRuns([duplicate, first, second]);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.sourceRunIds, ['r1', 'r2']);
  assert.deepEqual(candidates[0]?.workspaces, ['alpha', 'beta']);
});

test('empty and comment-only runs never become candidates', () => {
  assert.deepEqual(
    analyzeScriptRuns([
      run('r1', ''),
      run('r2', '   \n\t'),
      run('r3', '// nothing here'),
      run('r4', '/* still nothing */'),
    ]),
    [],
  );
});

test('session scoring uses exec ids when present and workspace-days otherwise', () => {
  const code = "return tools.alpha.read({ id: 'a' });";
  const sameDay = analyzeScriptRuns([
    run('r1', code, { workspace: 'ws', createdAt: '2026-11-20T01:00:00.000Z' }),
    run('r2', code, { workspace: 'ws', createdAt: '2026-11-20T02:00:00.000Z' }),
  ]);
  const twoDays = analyzeScriptRuns([
    run('r3', code, { workspace: 'ws', createdAt: '2026-11-20T01:00:00.000Z' }),
    run('r4', code, { workspace: 'ws', createdAt: '2026-11-21T02:00:00.000Z' }),
  ]);
  const execIds = analyzeScriptRuns([
    run('r5', code, { workspace: 'ws', createdAt: '2026-11-20T01:00:00.000Z', sessionId: 'exec-a' }),
    run('r6', code, { workspace: 'ws', createdAt: '2026-11-20T02:00:00.000Z', sessionId: 'exec-b' }),
  ]);

  assert.equal(sameDay[0]?.sessionCount, 1);
  assert.equal(twoDays[0]?.sessionCount, 2);
  assert.equal(execIds[0]?.sessionCount, 2);
  assert.ok(sameDay[0] !== undefined);
  assert.ok(twoDays[0] !== undefined);
  assert.ok(twoDays[0].score > sameDay[0].score);
});

test('cluster score saturates at one and rewards each factor', () => {
  const base = {
    runCount: 1,
    sessionCount: 1,
    literalCount: 0,
    declarationCount: 0,
    literalVariantCount: 1,
    toolCount: 0,
  };
  const baseline = scoreCluster(base);
  assert.ok(scoreCluster({ ...base, runCount: 10 }) > baseline);
  assert.ok(scoreCluster({ ...base, sessionCount: 4 }) > baseline);
  assert.ok(scoreCluster({ ...base, literalCount: 5 }) > baseline);
  assert.ok(scoreCluster({ ...base, declarationCount: 2 }) > baseline);
  assert.ok(scoreCluster({ ...base, literalVariantCount: 3 }) > baseline);
  assert.ok(scoreCluster({ ...base, toolCount: 3 }) > baseline);
  assert.equal(
    scoreCluster({
      runCount: 100,
      sessionCount: 100,
      literalCount: 100,
      declarationCount: 100,
      literalVariantCount: 100,
      toolCount: 100,
    }),
    1,
  );
});

test('suggested metadata comes from the used tools', () => {
  const candidate = analyzeScriptRuns([
    run('r1', "return tools.elasticsearch.search_documents({ index: 'logs' });", {
      toolsUsed: ['elasticsearch.search_documents', 'github.create_issue'],
    }),
  ])[0];
  assert.ok(candidate !== undefined);
  assert.equal(candidate.suggestedName, 'elasticsearch: search documents');
  assert.deepEqual(candidate.suggestedTags, ['elasticsearch', 'github']);
  assert.match(candidate.suggestedDescription ?? '', /Reused 1 time across 1 session using/);
  assert.equal(candidate.suggestedInputSchema, null);
  assert.equal(candidate.suggestedCode, null);
});

test('a run without tools gets no name and no tags', () => {
  const candidate = analyzeScriptRuns([run('r1', 'return 1 + 2;')])[0];
  assert.ok(candidate !== undefined);
  assert.equal(candidate.suggestedName, null);
  assert.deepEqual(candidate.suggestedTags, []);
});

test('AI suggestions merge over deterministic values without mutating the candidate', () => {
  const base = analyzeScriptRuns([
    run('r1', "return tools.elasticsearch.search({ index: 'logs' });", {
      toolsUsed: ['elasticsearch.search'],
    }),
  ])[0];
  assert.ok(base !== undefined);

  const merged = applySuggestion(base, {
    name: '  Search logs  ',
    description: '  Query the log index.  ',
    tags: [' one ', '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'],
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'string' } },
      additionalProperties: false,
    },
    code: 'return tools.elasticsearch.search({ index: args.index });',
  });

  assert.equal(merged.suggestedName, 'Search logs');
  assert.equal(merged.suggestedDescription, 'Query the log index.');
  assert.deepEqual(merged.suggestedTags, [
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
  ]);
  assert.deepEqual(merged.suggestedInputSchema, {
    type: 'object',
    properties: { index: { type: 'string' } },
    additionalProperties: false,
  });
  assert.equal(merged.suggestedCode, 'return tools.elasticsearch.search({ index: args.index });');
  assert.equal(base.suggestedName, 'elasticsearch: search');
  assert.equal(applySuggestion(base, null), base);
});

test('empty suggestion fields keep deterministic values', () => {
  const base = analyzeScriptRuns([
    run('r1', "return tools.alpha.read({ id: 'a' });", { toolsUsed: ['alpha.read'] }),
  ])[0];
  assert.ok(base !== undefined);
  const merged = applySuggestion(base, { name: '   ', tags: [] });
  assert.equal(merged.suggestedName, base.suggestedName);
  assert.deepEqual(merged.suggestedTags, []);
});

test('the AI suggester contract can be implemented without the analysis calling it', async () => {
  const base = analyzeScriptRuns([run('r1', 'return 1;')])[0];
  assert.ok(base !== undefined);
  const suggester: ScriptCandidateSuggester = {
    suggest: (candidate) => ({ name: `candidate-${candidate.runCount}` }),
  };
  const suggestion = await suggester.suggest(base);
  assert.equal(suggestion?.name, 'candidate-1');
  assert.equal(base.suggestedName, null);
});

test('representative ties resolve deterministically from the source text', () => {
  const left = "return tools.alpha.read({ id: 'a' });";
  const right = "return tools.alpha.read({ id: 'b' });";
  const forward = analyzeScriptRuns([run('r1', left), run('r2', right)])[0];
  const backward = analyzeScriptRuns([run('r2', right), run('r1', left)])[0];
  assert.ok(forward !== undefined);
  assert.ok(backward !== undefined);
  assert.equal(forward.code, left < right ? left : right);
  assert.equal(backward.code, forward.code);
});

test('blank workspaces normalize to default', () => {
  const candidate = analyzeScriptRuns([run('r1', 'return 1;', { workspace: '   ' })])[0];
  assert.ok(candidate !== undefined);
  assert.deepEqual(candidate.workspaces, ['default']);
});
