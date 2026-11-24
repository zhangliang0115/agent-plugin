import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTION_TAG_KEYS,
  SERVER_TAG_LIMIT,
  TOOL_TAG_LIMIT,
  evaluateServerTags,
  evaluateTagPolicy,
} from '../src/catalog/tag-policy.ts';

test('server tags accept 0-2 descriptive keys and reject action keys', () => {
  assert.deepEqual(evaluateServerTags([]), []);
  assert.deepEqual(evaluateServerTags(['postgresql', 'env.prod']), []);
  const tooMany = evaluateServerTags(['a', 'b', 'c']);
  assert.deepEqual(tooMany.map((issue) => issue.code), ['TAG_SERVER_LIMIT']);
  const action = evaluateServerTags(['postgresql', 'read']);
  assert.deepEqual(action.map((issue) => issue.code), ['TAG_ACTION_KEY']);
  assert.equal(SERVER_TAG_LIMIT, 2);
});

test('effective tags stay within 1-4 and never repeat a server key', () => {
  const valid = evaluateTagPolicy(['postgresql'], ['docs', 'testing', 'security']);
  assert.deepEqual(valid.issues, []);
  assert.deepEqual(valid.effectiveTags, ['postgresql', 'docs', 'testing', 'security']);

  const tooMany = evaluateTagPolicy(['postgresql'], ['docs', 'testing', 'security', 'memory']);
  assert.deepEqual(tooMany.issues.map((issue) => issue.code), ['TAG_TOOL_LIMIT']);
  assert.equal(TOOL_TAG_LIMIT, 4);

  const empty = evaluateTagPolicy([], []);
  assert.deepEqual(empty.issues.map((issue) => issue.code), ['TAG_TOOL_EMPTY']);

  const inherited = evaluateTagPolicy(['postgresql'], ['postgresql', 'docs']);
  assert.deepEqual(inherited.issues.map((issue) => issue.code), ['TAG_TOOL_INHERITED']);
});

test('action keys are rejected in either layer', () => {
  assert.deepEqual(
    evaluateTagPolicy(['read'], ['docs']).issues.map((issue) => issue.code),
    ['TAG_ACTION_KEY'],
  );
  assert.deepEqual(
    evaluateTagPolicy(['postgresql'], ['write']).issues.map((issue) => issue.code),
    ['TAG_ACTION_KEY'],
  );
  for (const key of ACTION_TAG_KEYS) {
    assert.ok(evaluateTagPolicy([key], []).issues.some((issue) => issue.code === 'TAG_ACTION_KEY'));
  }
});

test('repairInherited drops duplicate tool tags and reports them', () => {
  const repaired = evaluateTagPolicy(['postgresql'], ['postgresql', 'docs', 'docs'], {
    repairInherited: true,
  });
  assert.deepEqual(repaired.toolTags, ['docs']);
  assert.deepEqual(repaired.effectiveTags, ['postgresql', 'docs']);
  assert.deepEqual(repaired.inheritedDuplicates, ['postgresql']);
  assert.deepEqual(repaired.issues, []);
});
