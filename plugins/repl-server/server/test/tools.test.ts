import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogSnapshot, CatalogTool } from '../src/ports.ts';
import { describeTools } from '../src/tools/describe.ts';
import {
  canonicalToolName,
  getToolDefinition,
  listTools,
  TOOL_ORDER,
  validateToolArguments,
} from '../src/tools/registry.ts';
import { searchTools } from '../src/tools/search.ts';

function makeTool(overrides: Partial<CatalogTool> & Pick<CatalogTool, 'name' | 'kind'>): CatalogTool {
  return {
    name: overrides.name,
    kind: overrides.kind,
    server: overrides.server,
    description: overrides.description,
    tags: overrides.tags,
    inputSchema: overrides.inputSchema ?? { type: 'object', properties: {} },
    concurrency: overrides.concurrency ?? 'parallel',
    enabled: overrides.enabled ?? true,
  };
}

function failure(tool: string, input: unknown): string {
  const result = validateToolArguments(tool, input);
  assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected`);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.code, 'INVALID_ARGUMENT');
  return result.message;
}

test('tools/list exposes the five tools in the frozen order', () => {
  const names = listTools().map((tool) => tool.name);
  assert.deepEqual(names, [
    'run_script',
    'search_tools',
    'describe_tools',
    'wait_tasks',
    'report_problem',
  ]);
  assert.deepEqual([...TOOL_ORDER], names);
});

test('every tool is alwaysLoad and only run_script and report_problem lack annotations', () => {
  for (const tool of listTools()) {
    assert.equal(tool._meta['anthropic/alwaysLoad'], true);
  }
  const byName = new Map(listTools().map((tool) => [tool.name, tool]));
  assert.equal(byName.get('run_script')?.annotations, undefined);
  assert.equal(byName.get('report_problem')?.annotations, undefined);
  for (const name of ['search_tools', 'describe_tools', 'wait_tasks'] as const) {
    assert.deepEqual(byName.get(name)?.annotations, {
      readOnlyHint: true,
      idempotentHint: true,
    });
  }
});

test('run_script description stays within the 2KB ceiling and mentions the async path', () => {
  const tool = getToolDefinition('run_script');
  assert.ok(tool !== undefined);
  const bytes = Buffer.byteLength(tool.description, 'utf8');
  assert.ok(bytes <= 2048, `description is ${bytes} bytes`);
  assert.match(tool.description, /async/);
  assert.match(tool.description, /wait_tasks/);
});

test('the frozen schemas match docs/protocol.md §4', () => {
  assert.deepEqual(getToolDefinition('run_script')?.inputSchema, {
    type: 'object',
    properties: {
      code: { type: 'string' },
      timeout: { type: 'integer', minimum: 1000, maximum: 7200000, default: 30000 },
      async: { type: 'boolean', default: false },
      workspace: { type: 'string' },
      visibleTools: { type: 'array', items: { type: 'string' } },
      excludeTags: { type: 'array', items: { type: 'string' } },
    },
    required: ['code'],
    additionalProperties: false,
  });
  assert.deepEqual(getToolDefinition('search_tools')?.inputSchema, {
    type: 'object',
    properties: {
      query: { type: 'string' },
      category: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      max: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    additionalProperties: false,
  });
  assert.deepEqual(getToolDefinition('describe_tools')?.inputSchema, {
    type: 'object',
    properties: {
      names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
    },
    required: ['names'],
    additionalProperties: false,
  });
  assert.deepEqual(getToolDefinition('wait_tasks')?.inputSchema, {
    type: 'object',
    properties: {
      taskIds: { type: 'array', items: { type: 'string' } },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, default: 270000 },
    },
    additionalProperties: false,
  });
  assert.deepEqual(getToolDefinition('report_problem')?.inputSchema, {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      detail: { type: 'string', minLength: 1, maxLength: 20000 },
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      context: { type: 'object', additionalProperties: true },
    },
    required: ['title', 'detail', 'severity'],
    additionalProperties: false,
  });
});

test('the published tool surface cannot be mutated', () => {
  assert.equal(Object.isFrozen(TOOL_ORDER), true);
  const tool = getToolDefinition('run_script');
  assert.ok(tool !== undefined);
  assert.equal(Object.isFrozen(tool), true);
  assert.equal(Object.isFrozen(tool.inputSchema), true);
  const code = tool.inputSchema.properties.code;
  assert.ok(code !== undefined);
  assert.equal(Object.isFrozen(code), true);
  assert.throws(() => {
    (code as { type: string }).type = 'number';
  }, TypeError);
});

test('validateToolArguments enforces required fields, types and additionalProperties', () => {
  assert.match(failure('run_script', {}), /code is required/);
  assert.match(failure('run_script', null), /must be an object/);
  assert.match(failure('run_script', []), /must be an object/);
  assert.match(failure('run_script', { code: 3 }), /code must be a string/);
  assert.match(failure('run_script', { code: 'x', extra: 1 }), /does not accept the argument "extra"/);
  assert.match(failure('run_script', { code: 'x', timeout: 999 }), /timeout must be >= 1000/);
  assert.match(failure('run_script', { code: 'x', timeout: 7200001 }), /timeout must be <= 7200000/);
  assert.match(failure('run_script', { code: 'x', timeout: 1.5 }), /timeout must be an integer/);
  assert.match(failure('run_script', { code: 'x', async: 'yes' }), /async must be a boolean/);
  assert.match(failure('run_script', { code: 'x', visibleTools: [1] }), /visibleTools\[0\] must be a string/);
  assert.match(failure('search_tools', { max: 0 }), /max must be >= 1/);
  assert.match(failure('search_tools', { max: 51 }), /max must be <= 50/);
  assert.match(failure('search_tools', { tags: 'db' }), /tags must be an array/);
  assert.match(failure('describe_tools', {}), /names is required/);
  assert.match(failure('describe_tools', { names: [] }), /at least 1 item/);
  assert.match(failure('describe_tools', { names: Array.from({ length: 11 }, (_, index) => `t${index}`) }), /at most 10 item/);
  assert.match(failure('wait_tasks', { taskIds: 't_1' }), /taskIds must be an array/);
  assert.match(failure('wait_tasks', { timeoutMs: 999 }), /timeoutMs must be >= 1000/);
  assert.match(failure('wait_tasks', { timeoutMs: 600001 }), /timeoutMs must be <= 600000/);
  assert.match(failure('report_problem', {}), /title is required/);
  assert.match(failure('report_problem', { title: '', detail: 'd', severity: 'low' }), /at least 1 character/);
  assert.match(
    failure('report_problem', { title: 't', detail: 'd', severity: 'low', context: [] }),
    /context must be an object/,
  );
  assert.match(failure('nope', {}), /unknown tool/);
});

test('validateToolArguments accepts valid calls without filling defaults', () => {
  const result = validateToolArguments('run_script', {
    code: 'return 1',
    timeout: 2000,
    async: true,
    workspace: '/repo',
    visibleTools: ['Read', 'pg.query'],
    excludeTags: ['destructive'],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    code: 'return 1',
    timeout: 2000,
    async: true,
    workspace: '/repo',
    visibleTools: ['Read', 'pg.query'],
    excludeTags: ['destructive'],
  });

  const minimal = validateToolArguments('run_script', { code: 'return 1' });
  assert.equal(minimal.ok, true);
  if (!minimal.ok) return;
  assert.equal('timeout' in minimal.value, false);
});

test('canonicalToolName prefixes MCP tools exactly once', () => {
  assert.equal(canonicalToolName({ name: 'query', kind: 'mcp', server: 'pg' }), 'pg.query');
  assert.equal(canonicalToolName({ name: 'pg.query', kind: 'mcp', server: 'pg' }), 'pg.query');
  assert.equal(canonicalToolName({ name: 'Read', kind: 'builtin' }), 'Read');
});

const SNAPSHOT: CatalogSnapshot = {
  revision: 7,
  tools: [
    makeTool({ name: 'Read', kind: 'builtin', description: 'Read a file from disk', tags: ['files', 'read'] }),
    makeTool({
      name: 'pg.query',
      kind: 'mcp',
      server: 'pg',
      description: 'Run a read-only SQL query',
      tags: ['db', 'read'],
    }),
    makeTool({
      name: 'insert_row',
      kind: 'mcp',
      server: 'pg',
      description: 'Insert a row',
      tags: ['db', 'write'],
    }),
    makeTool({
      name: 'create_issue',
      kind: 'mcp',
      server: 'github',
      description: 'Create an issue',
      tags: ['vcs', 'write'],
    }),
    makeTool({
      name: 'delete_all',
      kind: 'mcp',
      server: 'pg',
      description: 'Delete everything',
      tags: ['db', 'destructive'],
      enabled: false,
    }),
  ],
};

test('search_tools ranks an exact canonical name first', () => {
  const items = searchTools(SNAPSHOT, { query: 'pg.query' });
  assert.equal(items[0]?.name, 'pg.query');
  assert.equal(items[0]?.kind, 'mcp');
  assert.equal(items[0]?.server, 'pg');
});

test('search_tools matches names, descriptions and tags', () => {
  const byQuery = (query: string) => searchTools(SNAPSHOT, { query }).map((item) => item.name);
  assert.deepEqual(byQuery('insert'), ['pg.insert_row']);
  assert.deepEqual(byQuery('sql'), ['pg.query']);
  assert.deepEqual(byQuery('db'), ['pg.insert_row', 'pg.query']);
  assert.deepEqual(byQuery('delete'), []);
  assert.deepEqual(byQuery('disk'), ['Read']);
  assert.deepEqual(byQuery('read'), ['Read', 'pg.query']);
});

test('search_tools applies category, tags and max filters', () => {
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'db', category: 'pg' }).map((item) => item.name),
    ['pg.insert_row', 'pg.query'],
  );
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'db', category: 'github' }).map((item) => item.name),
    [],
  );
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'db', tags: ['db', 'read'] }).map((item) => item.name),
    ['pg.query'],
  );
  assert.deepEqual(searchTools(SNAPSHOT, { query: 'db', max: 1 }).map((item) => item.name), ['pg.insert_row']);
});

test('search_tools returns the server overview for an empty query', () => {
  const items = searchTools(SNAPSHOT, { query: '   ' });
  assert.deepEqual(items, [
    {
      name: 'github',
      kind: 'mcp',
      server: 'github',
      description: '1 tool; call tools.mcp.github.<tool>(args)',
      tags: ['vcs', 'write'],
    },
    {
      name: 'pg',
      kind: 'mcp',
      server: 'pg',
      description: '2 tools; call tools.mcp.pg.<tool>(args)',
      tags: ['db', 'read', 'write'],
    },
  ]);
});

test('search_tools excludes disabled tools and honors the default max', () => {
  const many: CatalogTool[] = Array.from({ length: 15 }, (_, index) =>
    makeTool({ name: `tool_${index}`, kind: 'builtin', description: 'matching tool' }),
  );
  const items = searchTools({ revision: 1, tools: many }, { query: 'matching' });
  assert.equal(items.length, 10);
});

test('describe_tools returns complete schemas under canonical names', () => {
  const schema = {
    type: 'object',
    properties: { sql: { type: 'string', description: 'SQL text' } },
    required: ['sql'],
  };
  const snapshot: CatalogSnapshot = {
    revision: 1,
    tools: [
      makeTool({ name: 'Read', kind: 'builtin', inputSchema: { type: 'object', properties: {} } }),
      makeTool({ name: 'query', kind: 'mcp', server: 'pg', inputSchema: schema }),
      makeTool({ name: 'broken', kind: 'builtin', enabled: false }),
    ],
  };

  const result = describeTools(snapshot, ['Read', 'pg.query', 'pg.query', 'missing', 'broken']);
  assert.deepEqual(result.tools, [
    { name: 'Read', inputSchema: { type: 'object', properties: {} } },
    { name: 'pg.query', inputSchema: schema },
  ]);
  assert.deepEqual(result.omitted, ['missing', 'broken']);
  assert.equal(result.tools[1]?.inputSchema, schema);
});

test('describe_tools omits entries that would exceed the batch budget', () => {
  const big = 'x'.repeat(80);
  const snapshot: CatalogSnapshot = {
    revision: 1,
    tools: [
      makeTool({ name: 'a', kind: 'builtin', inputSchema: { type: 'object', description: big } }),
      makeTool({ name: 'b', kind: 'builtin', inputSchema: { type: 'object', description: big } }),
    ],
  };

  const single = JSON.stringify({
    name: 'a',
    inputSchema: { type: 'object', description: big },
  }).length;
  const result = describeTools(snapshot, ['a', 'b'], single + 5);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['a']);
  assert.deepEqual(result.omitted, ['b']);
});

test('a single oversize schema is returned alone without an omission hint', () => {
  const schema = { type: 'object', description: 'y'.repeat(500) };
  const snapshot: CatalogSnapshot = {
    revision: 1,
    tools: [makeTool({ name: 'huge', kind: 'builtin', inputSchema: schema })],
  };
  const result = describeTools(snapshot, ['huge', 'huge'], 20);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]?.name, 'huge');
  assert.deepEqual(result.tools[0]?.inputSchema, schema);
  assert.equal(result.omitted, undefined);
});
