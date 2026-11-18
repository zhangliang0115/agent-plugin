import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISCOVERY_MAX_ELEMENTS,
  parseDiscoveryResult,
  TOOL_NAME_PATTERN,
} from '../src/discovery/parse.ts';
import { buildPrepareCall, buildSearchArgs } from '../src/discovery/prepare.ts';

function callResult(payload: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function tool(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    ...extra,
  };
}

test('P-01: CallToolResult text with {tools:[...]} JSON', () => {
  const outcome = parseDiscoveryResult(
    callResult({ tools: [tool('list_tables')] }),
    'lazy',
  );
  assert.equal(outcome.parsed, true);
  assert.equal(outcome.shape, 'call_result_tools');
  assert.deepEqual(outcome.tools.map((entry) => entry.name), ['list_tables']);
  assert.equal(outcome.tools[0]?.description, 'list_tables description');
  assert.equal(outcome.tools[0]?.schemaMissing, false);
});

test('P-01b: CallToolResult text with a bare array', () => {
  const outcome = parseDiscoveryResult(callResult([tool('a'), tool('b')]), 'lazy');
  assert.equal(outcome.shape, 'call_result_array');
  assert.deepEqual(outcome.tools.map((entry) => entry.name), ['a', 'b']);
});

test('P-02/P-03: direct tools object and bare array', () => {
  const object = parseDiscoveryResult({ tools: [tool('a')] }, 'lazy');
  assert.equal(object.shape, 'tools_object');
  const array = parseDiscoveryResult([tool('a')], 'lazy');
  assert.equal(array.shape, 'tool_array');
  const single = parseDiscoveryResult(tool('solo'), 'lazy');
  assert.equal(single.shape, 'tool_array');
  assert.deepEqual(single.tools.map((entry) => entry.name), ['solo']);
});

test('P-04: one-level result/data envelope', () => {
  const result = parseDiscoveryResult({ result: { tools: [tool('a')] } }, 'lazy');
  assert.equal(result.shape, 'envelope_tools');
  assert.deepEqual(result.tools.map((entry) => entry.name), ['a']);
  const data = parseDiscoveryResult({ data: [tool('b')] }, 'lazy');
  assert.equal(data.shape, 'envelope_tools');
  assert.deepEqual(data.tools.map((entry) => entry.name), ['b']);
});

test('P-05/P-06: unrecognized payloads keep the raw text and never guess', () => {
  const text = parseDiscoveryResult(
    { content: [{ type: 'text', text: 'not json' }] },
    'lazy',
  );
  assert.equal(text.parsed, false);
  assert.equal(text.shape, 'unknown');
  assert.equal(text.raw, 'not json');
  assert.deepEqual(text.tools, []);
  assert.equal(text.skipped[0]?.reason, 'unrecognized_shape');

  const structured = parseDiscoveryResult({ hello: 'world' }, 'lazy');
  assert.equal(structured.parsed, false);
  assert.equal(structured.shape, 'unknown');
});

test('P-07: missing schema becomes the normalized empty object schema', () => {
  const outcome = parseDiscoveryResult({ tools: [{ name: 'a', description: 42 }] }, 'lazy');
  assert.equal(outcome.tools[0]?.schemaMissing, true);
  assert.deepEqual(outcome.tools[0]?.inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: true,
  });
  assert.equal(outcome.tools[0]?.description, null);
});

test('P-08: an oversized schema is skipped, not truncated', () => {
  const outcome = parseDiscoveryResult(
    { tools: [tool('a', { inputSchema: { type: 'object', blob: 'x'.repeat(70 * 1024) } })] },
    'lazy',
  );
  assert.deepEqual(outcome.tools, []);
  assert.equal(outcome.skipped[0]?.reason, 'schema_too_large');
});

test('P-09: invalid, duplicate and non-object elements are classified', () => {
  const outcome = parseDiscoveryResult(
    {
      tools: [
        tool('ok_one'),
        { name: 'bad name!' },
        tool('ok_one'),
        'nope',
        { name: '' },
      ],
    },
    'lazy',
  );
  assert.deepEqual(outcome.tools.map((entry) => entry.name), ['ok_one']);
  const reasons = outcome.skipped.map((entry) => entry.reason).sort();
  assert.deepEqual(reasons, ['duplicate_name', 'invalid_name', 'invalid_name', 'not_an_object']);
});

test('P-10: mcp__server__ and server. prefixes are stripped', () => {
  const outcome = parseDiscoveryResult(
    { tools: [tool('mcp__hexhub__list_tables'), tool('hexhub.list_tables_2')] },
    'hexhub',
  );
  assert.deepEqual(
    outcome.tools.map((entry) => entry.name),
    ['list_tables', 'list_tables_2'],
  );
  assert.ok(TOOL_NAME_PATTERN.test(outcome.tools[0]?.name ?? ''));
});

test('P-11: nextCursor and next_cursor are read when present', () => {
  assert.equal(
    parseDiscoveryResult({ tools: [tool('a')], nextCursor: 'page-2' }, 'lazy').nextCursor,
    'page-2',
  );
  assert.equal(
    parseDiscoveryResult({ tools: [tool('a')], next_cursor: 'page-3' }, 'lazy').nextCursor,
    'page-3',
  );
  assert.equal(parseDiscoveryResult({ tools: [tool('a')] }, 'lazy').nextCursor, null);
});

test('P-12: more than 2000 elements are capped and counted as omitted', () => {
  const tools = Array.from({ length: DISCOVERY_MAX_ELEMENTS + 1 }, (_value, index) =>
    tool(`t_${index}`),
  );
  const outcome = parseDiscoveryResult({ tools }, 'lazy');
  assert.equal(outcome.tools.length, DISCOVERY_MAX_ELEMENTS);
  assert.equal(outcome.omitted, 1);
  assert.equal(outcome.elements, DISCOVERY_MAX_ELEMENTS + 1);
});

test('description longer than 8192 characters is truncated and flagged', () => {
  const outcome = parseDiscoveryResult(
    { tools: [tool('a', { description: 'd'.repeat(9000) })] },
    'lazy',
  );
  assert.equal(outcome.tools[0]?.description?.length, 8192);
  assert.equal(outcome.tools[0]?.descriptionTruncated, true);
});

test('search args replace $query at every level and never pollute prototypes', () => {
  const args = JSON.parse(
    '{"q":"$query","nested":{"targets":["$query","fixed"]},"__proto__":{"polluted":true}}',
  ) as Record<string, unknown>;
  const built = buildSearchArgs(
    { mode: 'search', searchTool: 'search_tools', args },
    'list_tables',
  );
  assert.deepEqual(built['q'], 'list_tables');
  assert.deepEqual(built['nested'], { targets: ['list_tables', 'fixed'] });
  assert.equal(Object.hasOwn(built, '__proto__'), true);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.deepEqual(Object.keys(built).includes('query'), false, 'placeholder suppresses the default');

  const appended = buildSearchArgs({ mode: 'search', searchTool: 's', args: {} }, 'my_tool');
  assert.deepEqual(appended, { query: 'my_tool' });
  const fixed = buildSearchArgs(
    { mode: 'search', searchTool: 's', args: { query: 'constant' } },
    'my_tool',
  );
  assert.deepEqual(fixed, { query: 'constant' });

  const prepare = buildPrepareCall(
    { mode: 'search', searchTool: 'search_tools', args: { q: '$query' } },
    'list_tables',
  );
  assert.deepEqual(prepare, { tool: 'search_tools', args: { q: 'list_tables' } });
});
