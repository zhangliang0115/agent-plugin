/** Schema-driven argument form planning and raw JSON fallbacks. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  argsFormPlan,
  argsFromJsonText,
  argsObjectFrom,
  jsonValueFromText,
  missingRequiredFields,
} from '../src/lib/schema-args.ts';

test('object schema plans typed fields with title, description and required flags', () => {
  const plan = argsFormPlan({
    type: 'object',
    required: ['query', 'limit'],
    properties: {
      query: { type: 'string', title: '查询词', description: 'Search text' },
      limit: { type: 'integer' },
      ratio: { type: 'number' },
      exact: { type: 'boolean' },
      order: { type: 'string', enum: ['asc', 'desc'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
  });

  assert.equal(plan.mode, 'form');
  assert.equal(plan.reason, null);
  assert.deepEqual(
    plan.fields.map((field) => [field.name, field.kind, field.label, field.required]),
    [
      ['query', 'string', '查询词', true],
      ['limit', 'integer', 'limit', true],
      ['ratio', 'number', 'ratio', false],
      ['exact', 'boolean', 'exact', false],
      ['order', 'enum', 'order', false],
      ['tags', 'string-array', 'tags', false],
    ],
  );
  assert.equal(plan.fields[0]?.description, 'Search text');
  assert.deepEqual(plan.fields[4]?.enumValues, ['asc', 'desc']);
});

test('enum values keep their JSON types', () => {
  const plan = argsFormPlan({
    type: 'object',
    properties: {
      count: { enum: [0, 1, 2] },
      flag: { type: 'boolean', enum: [true, false] },
    },
  });
  assert.deepEqual(
    plan.fields.map((field) => [field.kind, field.enumValues]),
    [
      ['enum', [0, 1, 2]],
      ['enum', [true, false]],
    ],
  );
});

test('unsupported field shapes fall back to per-field JSON', () => {
  const plan = argsFormPlan({
    type: 'object',
    properties: {
      target: { $ref: '#/$defs/Target' },
      choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      nested: { type: 'object', properties: { a: { type: 'string' } } },
      rows: { type: 'array', items: { type: 'object' } },
      loose: { type: 'array' },
      union: { type: ['string', 'null'] },
      mystery: {},
    },
  });

  assert.equal(plan.mode, 'form');
  for (const field of plan.fields) {
    assert.equal(field.kind, 'json', `${field.name} should use the JSON fallback`);
    assert.notEqual(field.fallbackReason, null, `${field.name} should explain the fallback`);
  }
});

test('a non-object or composed root forces JSON mode', () => {
  for (const schema of [null, undefined, 'text', 42, [], { type: 'string' }]) {
    const plan = argsFormPlan(schema);
    if (schema === null || schema === undefined) {
      assert.equal(plan.mode, 'form');
      assert.deepEqual(plan.fields, []);
    } else {
      assert.equal(plan.mode, 'json');
      assert.notEqual(plan.reason, null);
    }
  }
  for (const schema of [
    { oneOf: [{ type: 'object' }, { type: 'string' }] },
    { $ref: '#/$defs/Args' },
    { type: ['object', 'null'] },
  ]) {
    assert.equal(argsFormPlan(schema).mode, 'json');
  }
});

test('argsFromJsonText accepts objects and rejects everything else', () => {
  assert.deepEqual(argsFromJsonText(''), { ok: true, value: {} });
  assert.deepEqual(argsFromJsonText('  {"a":1} '), { ok: true, value: { a: 1 } });
  assert.deepEqual(argsFromJsonText('[1]'), { ok: false, error: '参数必须是 JSON 对象' });
  assert.deepEqual(argsFromJsonText('null'), { ok: false, error: '参数必须是 JSON 对象' });
  assert.deepEqual(argsFromJsonText('{bad'), { ok: false, error: '参数不是合法 JSON' });
});

test('jsonValueFromText separates blank, valid and invalid input', () => {
  assert.deepEqual(jsonValueFromText(' '), { ok: true, present: false });
  assert.deepEqual(jsonValueFromText('0'), { ok: true, present: true, value: 0 });
  assert.deepEqual(jsonValueFromText('{"a":true}'), {
    ok: true,
    present: true,
    value: { a: true },
  });
  assert.equal(jsonValueFromText('{bad').ok, false);
});

test('missingRequiredFields reports blank required values and keeps falsy ones', () => {
  const plan = argsFormPlan({
    type: 'object',
    required: ['query', 'limit', 'exact', 'target'],
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer' },
      exact: { type: 'boolean' },
      target: { type: 'object', properties: { id: { type: 'string' } } },
      optional: { type: 'string' },
    },
  });

  assert.deepEqual(
    missingRequiredFields(plan, {}).map((field) => field.name),
    ['query', 'limit', 'exact', 'target'],
  );
  assert.deepEqual(
    missingRequiredFields(plan, {
      query: '  ',
      limit: 0,
      exact: false,
      target: { id: 'a' },
    }).map((field) => field.name),
    ['query'],
  );
});

test('a missing required constructor field is reported missing, not resolved from the prototype', () => {
  const plan = argsFormPlan({
    type: 'object',
    required: ['constructor'],
    properties: { constructor: { type: 'string' } },
  });

  assert.deepEqual(
    missingRequiredFields(plan, {}).map((field) => field.name),
    ['constructor'],
  );
  assert.deepEqual(
    missingRequiredFields(plan, JSON.parse('{"constructor":"x"}')).map((field) => field.name),
    [],
  );
});

test('argsObjectFrom copies objects only', () => {
  const source = { a: 1 };
  const copy = argsObjectFrom(source);
  assert.deepEqual(copy, { a: 1 });
  assert.notEqual(copy, source);
  assert.deepEqual(argsObjectFrom(undefined), {});
  assert.deepEqual(argsObjectFrom([1]), {});
  assert.deepEqual(argsObjectFrom('x'), {});
});
