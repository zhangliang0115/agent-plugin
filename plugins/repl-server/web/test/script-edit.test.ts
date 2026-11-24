import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateAcceptBody,
  testArgsFrom,
  versionEditBody,
} from '../src/lib/script-edit.ts';

const SCHEMA = '{"type":"object","properties":{"x":{"type":"string"}}}';

test('exact edits require runId and never submit code', () => {
  const outcome = versionEditBody({
    mode: 'exact',
    code: 'return 1;',
    inputSchema: SCHEMA,
    exampleArgs: '{"x":1}',
    runId: '  r_1  ',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.body, { mode: 'exact', runId: 'r_1' });
  assert.equal('code' in outcome.body, false);
  assert.equal('inputSchema' in outcome.body, false);

  const missing = versionEditBody({
    mode: 'exact',
    code: '',
    inputSchema: '',
    exampleArgs: '',
    runId: '   ',
  });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.error, /runId/u);
});

test('parameterized edits carry code, schema and optional exampleArgs', () => {
  const outcome = versionEditBody({
    mode: 'parameterized',
    code: 'const { x } = args; return x;',
    inputSchema: SCHEMA,
    exampleArgs: '{"x":"a"}',
    runId: 'ignored-for-provenance',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.body['mode'], 'parameterized');
  assert.equal(outcome.body['code'], 'const { x } = args; return x;');
  assert.deepEqual(outcome.body['inputSchema'], { type: 'object', properties: { x: { type: 'string' } } });
  assert.deepEqual(outcome.body['exampleArgs'], { x: 'a' });
  assert.equal('runId' in outcome.body, false);

  const blankArgs = versionEditBody({
    mode: 'parameterized',
    code: 'return 1;',
    inputSchema: '{}',
    exampleArgs: '',
    runId: '',
  });
  assert.equal(blankArgs.ok, true);
  if (blankArgs.ok) assert.equal('exampleArgs' in blankArgs.body, false);
});

test('parameterized edits reject empty code and invalid JSON objects', () => {
  const noCode = versionEditBody({
    mode: 'parameterized',
    code: '   ',
    inputSchema: '{}',
    exampleArgs: '',
    runId: '',
  });
  assert.equal(noCode.ok, false);
  assert.match(noCode.ok ? '' : noCode.error, /code/u);

  const badSchema = versionEditBody({
    mode: 'parameterized',
    code: 'return 1;',
    inputSchema: '{',
    exampleArgs: '',
    runId: '',
  });
  assert.equal(badSchema.ok, false);
  assert.match(badSchema.ok ? '' : badSchema.error, /inputSchema/u);

  const arraySchema = versionEditBody({
    mode: 'parameterized',
    code: 'return 1;',
    inputSchema: '[]',
    exampleArgs: '',
    runId: '',
  });
  assert.equal(arraySchema.ok, false);

  const badArgs = versionEditBody({
    mode: 'parameterized',
    code: 'return 1;',
    inputSchema: '{}',
    exampleArgs: '"x"',
    runId: '',
  });
  assert.equal(badArgs.ok, false);
  assert.match(badArgs.ok ? '' : badArgs.error, /exampleArgs/u);

  const unknownMode = versionEditBody({
    mode: null,
    code: 'return 1;',
    inputSchema: '{}',
    exampleArgs: '',
    runId: '',
  });
  assert.equal(unknownMode.ok, false);
});

test('testArgsFrom treats blank as no args and rejects non-objects', () => {
  assert.deepEqual(testArgsFrom(''), { ok: true, body: undefined });
  assert.deepEqual(testArgsFrom('  \n'), { ok: true, body: undefined });
  assert.deepEqual(testArgsFrom('{"q":"x"}'), { ok: true, body: { q: 'x' } });
  const array = testArgsFrom('[]');
  assert.equal(array.ok, false);
  const broken = testArgsFrom('{');
  assert.equal(broken.ok, false);
});

test('candidate accept bodies validate name/code and split tags', () => {
  const outcome = candidateAcceptBody({
    name: '  demo  ',
    description: '  ',
    tags: 'ops, es，search  ',
    code: 'return args;',
    inputSchema: '{}',
    exampleArgs: '',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.body['name'], 'demo');
  assert.deepEqual(outcome.body['tags'], ['ops', 'es', 'search']);
  assert.equal('description' in outcome.body, false);
  assert.equal('exampleArgs' in outcome.body, false);

  const noName = candidateAcceptBody({
    name: ' ',
    description: '',
    tags: '',
    code: 'return 1;',
    inputSchema: '{}',
    exampleArgs: '',
  });
  assert.equal(noName.ok, false);

  const noCode = candidateAcceptBody({
    name: 'demo',
    description: '',
    tags: '',
    code: '',
    inputSchema: '{}',
    exampleArgs: '',
  });
  assert.equal(noCode.ok, false);

  const badSchema = candidateAcceptBody({
    name: 'demo',
    description: 'd',
    tags: '',
    code: 'return 1;',
    inputSchema: '[1]',
    exampleArgs: '',
  });
  assert.equal(badSchema.ok, false);
});
