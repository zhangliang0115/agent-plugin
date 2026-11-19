/** Flattening tool input schemas into documentation rows. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { schemaDoc, SCHEMA_DOC_MAX_DEPTH, SCHEMA_DOC_MAX_FIELDS } from '../src/lib/schema-doc.ts';

test('nested objects expand to dotted paths with required flags and defaults', () => {
  const doc = schemaDoc({
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search text' },
      options: {
        type: 'object',
        required: ['limit'],
        properties: {
          limit: { type: 'integer', default: 10 },
          flags: {
            type: 'object',
            properties: { exact: { type: 'boolean', default: false } },
          },
        },
      },
    },
  });

  assert.equal(doc.truncated, false);
  assert.deepEqual(
    doc.fields.map((field) => field.path),
    ['query', 'options', 'options.limit', 'options.flags', 'options.flags.exact'],
  );
  const query = doc.fields[0];
  assert.equal(query?.name, 'query');
  assert.equal(query?.type, 'string');
  assert.equal(query?.required, true);
  assert.equal(query?.description, 'Search text');
  assert.equal(doc.fields.find((field) => field.path === 'options')?.required, false);
  assert.equal(doc.fields.find((field) => field.path === 'options.limit')?.required, true);
  assert.equal(doc.fields.find((field) => field.path === 'options.limit')?.defaultValue, '10');
  assert.equal(doc.fields.find((field) => field.path === 'options.flags.exact')?.defaultValue, 'false');
});

test('array items expand through [] paths', () => {
  const doc = schemaDoc({
    type: 'object',
    properties: {
      tools: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            args: { type: 'object', properties: { q: { type: 'string' } } },
          },
        },
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'flat list' },
    },
  });

  assert.deepEqual(
    doc.fields.map((field) => field.path),
    ['tools', 'tools[].name', 'tools[].args', 'tools[].args.q', 'tags'],
  );
  assert.equal(doc.fields[0]?.type, 'array<object>');
  assert.equal(doc.fields.find((field) => field.path === 'tools[].name')?.required, true);
  assert.equal(doc.fields.find((field) => field.path === 'tags')?.type, 'array<string>');
  assert.equal(doc.fields.find((field) => field.path === 'tags')?.description, 'flat list');
});

test('enum, $ref, type unions and oneOf are summarized', () => {
  const doc = schemaDoc({
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['fast', 'safe'], default: 'fast' },
      target: { $ref: '#/$defs/Target' },
      nullable: { type: ['string', 'null'] },
      choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      count: { type: 'integer', enum: [0, 1, 2], default: 0 },
    },
  });
  const byPath = new Map(doc.fields.map((field) => [field.path, field]));

  assert.deepEqual(byPath.get('mode')?.enumValues, ['fast', 'safe']);
  assert.equal(byPath.get('mode')?.defaultValue, 'fast');
  assert.equal(byPath.get('target')?.type, '$ref:#/$defs/Target');
  assert.equal(byPath.get('nullable')?.type, 'string | null');
  assert.equal(byPath.get('choice')?.type, 'oneOf(string | number)');
  assert.deepEqual(byPath.get('count')?.enumValues, ['0', '1', '2']);
  assert.equal(byPath.get('count')?.defaultValue, '0');
});

test('additionalProperties is reported for object schemas', () => {
  const doc = schemaDoc({
    type: 'object',
    properties: {
      bag: { type: 'object', additionalProperties: true },
      closed: { type: 'object', additionalProperties: false },
      nested: { type: 'object', additionalProperties: { type: 'string' } },
      plain: { type: 'string' },
    },
  });
  const byPath = new Map(doc.fields.map((field) => [field.path, field]));

  assert.equal(byPath.get('bag')?.additionalProperties, true);
  assert.equal(byPath.get('closed')?.additionalProperties, false);
  assert.equal(byPath.get('nested')?.additionalProperties, true);
  assert.equal(byPath.get('plain')?.additionalProperties, null);
});

test('non-object and malformed schemas yield rows instead of throwing', () => {
  for (const value of [undefined, null, 'text', 42, [], true]) {
    assert.deepEqual(schemaDoc(value), { fields: [], truncated: false });
  }

  const doc = schemaDoc({
    type: 'object',
    required: 'query',
    properties: {
      ok: { type: 'string' },
      broken: true,
      also: null,
    },
  });
  assert.deepEqual(
    doc.fields.map((field) => [field.path, field.type, field.required]),
    [
      ['ok', 'string', false],
      ['broken', 'unknown', false],
      ['also', 'unknown', false],
    ],
  );
  assert.equal(doc.truncated, false);
});

test('cycles stop the walk and mark the result truncated', () => {
  const cyclic: Record<string, unknown> = { type: 'object', properties: {} };
  const properties = cyclic['properties'] as Record<string, unknown>;
  properties['self'] = cyclic;
  properties['leaf'] = { type: 'string' };

  const doc = schemaDoc(cyclic);

  assert.equal(doc.truncated, true);
  assert.deepEqual(
    doc.fields.map((field) => field.path),
    ['self', 'leaf'],
  );
});

test('self-referential array items stop the walk instead of looping', () => {
  const node = { type: 'array' } as Record<string, unknown> & { items?: unknown };
  node['items'] = node;

  const doc = schemaDoc({ type: 'object', properties: { a: node } });

  assert.equal(doc.truncated, true);
  assert.deepEqual(
    doc.fields.map((field) => field.path),
    ['a'],
  );
});

test('wide schemas stop at the row cap', () => {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < SCHEMA_DOC_MAX_FIELDS + 20; index += 1) {
    properties[`p${index}`] = { type: 'string' };
  }

  const doc = schemaDoc({ type: 'object', properties });

  assert.equal(doc.fields.length, SCHEMA_DOC_MAX_FIELDS);
  assert.equal(doc.truncated, true);
});

test('deep nesting stops at the depth cap', () => {
  let node: Record<string, unknown> = {
    type: 'object',
    properties: { leaf: { type: 'string' } },
  };
  for (let level = 0; level < SCHEMA_DOC_MAX_DEPTH + 3; level += 1) {
    node = { type: 'object', properties: { child: node } };
  }

  const doc = schemaDoc(node);

  assert.equal(doc.truncated, true);
  assert.ok(doc.fields.some((field) => field.path.split('.').length > SCHEMA_DOC_MAX_DEPTH));
  assert.ok(doc.fields.every((field) => field.path.split('.').length <= SCHEMA_DOC_MAX_DEPTH + 1));
});
