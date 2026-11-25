import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateAcceptFrom,
  candidatesFrom,
  createdVersion,
  diffFrom,
  failedRunCount,
  nextCursorFrom,
  runHasRequestDetail,
  runsFrom,
  scanResultFrom,
  scriptDetailFrom,
  scriptsFrom,
  successRateFraction,
  testResultFrom,
  versionDetailFrom,
  versionsFrom,
} from '../src/lib/script-api.ts';

const script = {
  scriptId: 's_1',
  name: 'demo',
  description: 'demo script',
  tags: ['a', 'b'],
  status: 'active',
  activeVersion: 2,
  useCount: 5,
  lastUsedAt: '2026-11-24T00:00:00.000Z',
  updatedAt: '2026-11-24T00:00:00.000Z',
  createdBy: 'admin',
  createdAt: '2026-11-20T00:00:00.000Z',
  sourceRunId: null,
};

test('scriptsFrom reads the documented items envelope and a bare array', () => {
  assert.equal(scriptsFrom({ items: [script], nextCursor: null }).length, 1);
  assert.equal(scriptsFrom([script]).length, 1);
  assert.equal(scriptsFrom({ scripts: [script] }).length, 1);
  assert.deepEqual(scriptsFrom({ items: [{ noId: true }] }), []);
  assert.deepEqual(scriptsFrom(null), []);
});

test('scriptDetailFrom unwraps { script } and keeps owner fields', () => {
  const detail = scriptDetailFrom({ script });
  assert.equal(detail?.scriptId, 's_1');
  assert.equal(detail?.createdBy, 'admin');
  assert.equal(detail?.activeVersion, 2);
  assert.equal(scriptDetailFrom(script)?.name, 'demo');
  assert.equal(scriptDetailFrom({}), null);
});

test('versionsFrom and versionDetailFrom keep code out of the list and in the detail', () => {
  const summary = { version: 2, status: 'active', mode: 'parameterized', codeSha256: 'abc' };
  assert.deepEqual(versionsFrom({ items: [summary] }).map((entry) => entry.version), [2]);
  const detail = versionDetailFrom({
    version: { ...summary, code: 'return args;', inputSchema: { type: 'object' }, exampleArgs: { a: 1 } },
  });
  assert.equal(detail?.code, 'return args;');
  assert.deepEqual(detail?.inputSchema, { type: 'object' });
  assert.deepEqual(detail?.exampleArgs, { a: 1 });
  assert.deepEqual(detail?.warnings, []);
  const warned = versionDetailFrom({
    version: { ...summary, code: 'const token = ...' },
    warnings: [{ field: 'code', kind: 'provider_token', severity: 'high', count: 1 }],
  });
  assert.deepEqual(warned?.warnings, [
    { field: 'code', kind: 'provider_token', severity: 'high', count: 1 },
  ]);
  assert.equal(versionDetailFrom({ version: { code: 'x' } }), null);
});

test('createdVersion reads the edit response', () => {
  assert.equal(createdVersion({ version: { version: 3 } }), 3);
  assert.equal(createdVersion({ version: 3 }), 3);
  assert.equal(createdVersion({}), null);
});

test('runsFrom keeps the request/exec identifiers used to reopen the request drawer', () => {
  const run = {
    runId: 'r_1',
    createdAt: '2026-11-24T00:00:00.000Z',
    execId: 'es_1',
    requestId: '7',
    evalId: 3,
    scriptVersion: 1,
    scriptMode: 'parameterized',
    entryMode: 'script',
    purpose: 'run',
    ok: true,
    error: null,
    durationMs: 12,
    args: { a: 1 },
  };
  const [parsed] = runsFrom({ items: [run] });
  assert.equal(parsed?.runId, 'r_1');
  assert.equal(parsed?.execId, 'es_1');
  assert.equal(parsed?.requestId, '7');
  assert.equal(parsed?.ok, true);
  assert.deepEqual(parsed?.args, { a: 1 });
  const [redacted] = runsFrom({ items: [{ ...run, args: undefined, argsPreview: '{"x":"<redacted>"}' }] });
  assert.equal(redacted?.argsPreview, '{"x":"<redacted>"}');
  assert.equal(redacted?.args, undefined);
  assert.deepEqual(runsFrom({}), []);
});

test('runHasRequestDetail only depends on requestId; purpose is not an input', () => {
  assert.equal(runHasRequestDetail({ requestId: '7' }), true);
  assert.equal(runHasRequestDetail({ requestId: null }), false);
});

test('P2 stats are optional and tolerate a ratio or a percentage rate', () => {
  const [withStats] = scriptsFrom({
    items: [{ ...script, createdBy: 'agent-a', runCount: 10, successCount: 7, successRate: 0.7 }],
  });
  assert.equal(withStats?.createdBy, 'agent-a');
  assert.equal(withStats?.runCount, 10);
  assert.equal(withStats?.successCount, 7);
  assert.equal(successRateFraction(withStats?.successRate), 0.7);
  assert.equal(failedRunCount({ runCount: 10, successCount: 7 }), 3);

  const [legacy] = scriptsFrom({ items: [script] });
  assert.equal(legacy?.runCount, null);
  assert.equal(legacy?.successCount, null);
  assert.equal(legacy?.successRate, null);
  assert.equal(failedRunCount({ runCount: null, successCount: null }), null);
  assert.equal(successRateFraction(70), 0.7);
  assert.equal(successRateFraction(1), 1);
  assert.equal(successRateFraction(150), null);
  assert.equal(successRateFraction(-1), null);
});

test('diffFrom reads per-line rows and rejects a payload without lines', () => {
  const diff = diffFrom({
    fromVersion: 1,
    toVersion: 2,
    lines: [
      { type: 'same', text: 'const a = 1;' },
      { type: 'add', text: 'const b = 2;' },
      { type: 'del', text: 'return 1;' },
    ],
  });
  assert.deepEqual(diff?.lines, [
    { type: 'same', text: 'const a = 1;' },
    { type: 'add', text: 'const b = 2;' },
    { type: 'del', text: 'return 1;' },
  ]);
  assert.equal(diff?.fromVersion, 1);
  assert.equal(diff?.toVersion, 2);

  const aliases = diffFrom({
    diff: {
      lines: [
        { type: 'added', line: 'x' },
        { type: 'removed', value: 'y' },
        { type: 'context', text: 'z' },
      ],
    },
  });
  assert.deepEqual(aliases?.lines.map((line) => line.type), ['add', 'del', 'same']);

  assert.deepEqual(diffFrom({ lines: [] })?.lines, []);
  assert.equal(diffFrom({ fromVersion: 1, toVersion: 2 }), null);
  assert.equal(diffFrom(null), null);
});

test('candidatesFrom and scan/accept readers tolerate missing fields', () => {
  const candidate = {
    candidateId: 'c_1',
    status: 'pending',
    score: 0.82,
    codeSha256: 'abcd',
    sourceRunIds: ['r_1', 'r_2'],
    suggestedName: 'demo',
    suggestedDescription: 'demo candidate',
    suggestedTags: ['ops'],
    suggestedInputSchema: { type: 'object' },
    suggestedCode: 'return args.x;',
    code: 'return 1;',
    lastSeenAt: '2026-11-24T00:00:00.000Z',
  };
  const [parsed] = candidatesFrom({ items: [candidate], nextCursor: 'next-1' });
  assert.equal(parsed?.id, 'c_1');
  assert.equal(parsed?.runCount, 2);
  assert.equal(parsed?.suggestedName, 'demo');
  assert.deepEqual(parsed?.suggestedTags, ['ops']);
  assert.equal(nextCursorFrom({ items: [candidate], nextCursor: 'next-1' }), 'next-1');
  assert.equal(nextCursorFrom({ items: [] }), null);
  assert.equal(candidatesFrom({ candidates: [{ id: 'c_2' }] })[0]?.id, 'c_2');
  assert.deepEqual(candidatesFrom(null), []);

  assert.deepEqual(scanResultFrom({ result: { scanned: 5, created: 2, updated: 1 } }), {
    scanned: 5,
    created: 2,
    updated: 1,
  });
  assert.deepEqual(scanResultFrom({ scanned: 5 }), {
    scanned: 5,
    created: null,
    updated: null,
  });
  assert.deepEqual(scanResultFrom({ scan: { scanned: 1, created: 2, updated: 3 } }), {
    scanned: 1,
    created: 2,
    updated: 3,
  });

  const accepted = candidateAcceptFrom({
    scriptId: 's_1',
    version: { version: 3, status: 'draft' },
  });
  assert.equal(accepted.scriptId, 's_1');
  assert.equal(accepted.version, 3);
  assert.equal(accepted.status, 'draft');
  assert.deepEqual(accepted.warnings, []);
  const warned = candidateAcceptFrom({
    script: {
      scriptId: 's_3',
      warnings: [{ field: 'code', kind: 'provider_token', severity: 'high', count: 2 }],
    },
  });
  assert.deepEqual(warned.warnings, [
    { field: 'code', kind: 'provider_token', severity: 'high', count: 2 },
  ]);
  assert.equal(candidateAcceptFrom({ script: { scriptId: 's_2' }, version: 4 }).scriptId, 's_2');
});

test('testResultFrom reads the run result and keeps wrapper objects out of output', () => {
  const result = testResultFrom({
    runId: 'r_1',
    ok: true,
    durationMs: 12,
    output: { answer: 42 },
    activated: true,
    status: 'active',
  });
  assert.equal(result?.runId, 'r_1');
  assert.equal(result?.ok, true);
  assert.equal(result?.durationMs, 12);
  assert.deepEqual(result?.output, { answer: 42 });
  assert.equal(result?.activated, true);
  assert.deepEqual(result?.secretWarnings, []);
  const flagged = testResultFrom({
    runId: 'r_4',
    ok: true,
    secretWarnings: [{ field: 'args', kind: 'env_assignment', severity: 'medium', count: 1 }],
  });
  assert.deepEqual(flagged?.secretWarnings, [
    { field: 'args', kind: 'env_assignment', severity: 'medium', count: 1 },
  ]);

  const nested = testResultFrom({ run: { runId: 'r_2', ok: false, error: 'boom' } });
  assert.equal(nested?.runId, 'r_2');
  assert.equal(nested?.ok, false);
  assert.equal(nested?.error, 'boom');

  const wrapper = testResultFrom({
    runId: 'r_3',
    ok: true,
    result: { runId: 'r_3', ok: true },
  });
  assert.equal(wrapper?.output, undefined);
  assert.equal(testResultFrom(null), null);
});
