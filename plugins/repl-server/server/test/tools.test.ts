import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogSnapshot, CatalogTool } from '../src/ports.ts';
import { describeTools } from '../src/tools/describe.ts';
import {
  buildSearchToolsDefinition,
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
    category: overrides.category,
    summary: overrides.summary,
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
  assert.match(tool.description, /await tools\.<name>\(args\) for built-ins/);
  assert.match(tool.description, /tools\.mcp\.<server>\.<tool>\(args\)/);
  assert.doesNotMatch(tool.description, /await Read\(/);
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
      server: { type: 'string' },
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
    makeTool({
      name: 'Read',
      kind: 'builtin',
      description: 'Read a file from disk',
      category: 'devtools',
      summary: 'Official Claude Code tools',
      tags: ['files', 'read'],
    }),
    makeTool({
      name: 'pg.query',
      kind: 'mcp',
      server: 'pg',
      description: 'Run a read-only SQL query',
      category: 'database',
      summary: 'Postgres tools',
      tags: ['db', 'read'],
    }),
    makeTool({
      name: 'insert_row',
      kind: 'mcp',
      server: 'pg',
      description: 'Insert a row',
      category: 'database',
      summary: 'Postgres tools',
      tags: ['db', 'write'],
    }),
    makeTool({
      name: 'create_issue',
      kind: 'mcp',
      server: 'github',
      description: 'Create an issue',
      category: 'vcs',
      summary: 'GitHub tools',
      tags: ['vcs', 'write'],
    }),
    makeTool({
      name: 'delete_all',
      kind: 'mcp',
      server: 'pg',
      description: 'Delete everything',
      category: 'database',
      summary: 'Postgres tools',
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
    searchTools(SNAPSHOT, { query: 'db', category: 'database' }).map((item) => item.name),
    ['pg.insert_row', 'pg.query'],
  );
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'db', category: 'vcs' }).map((item) => item.name),
    [],
  );
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'db', tags: ['db', 'read'] }).map((item) => item.name),
    ['pg.query'],
  );
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'db', tags: ['db', 'write'] }).map((item) => item.name),
    ['pg.insert_row'],
  );
  assert.deepEqual(searchTools(SNAPSHOT, { query: 'db', max: 1 }).map((item) => item.name), ['pg.insert_row']);
});

test('category matches the tool category, never the server id', () => {
  assert.deepEqual(searchTools(SNAPSHOT, { query: 'query', category: 'pg' }), []);
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'query', category: 'database' }).map((item) => item.name),
    ['pg.query'],
  );
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'disk', category: 'devtools' }).map((item) => item.name),
    ['Read'],
  );

  const uncategorized: CatalogSnapshot = {
    revision: 1,
    tools: [
      makeTool({ name: 'plain', kind: 'builtin' }),
      makeTool({ name: 'query', kind: 'mcp', server: 'pg', category: 'database' }),
    ],
  };
  assert.deepEqual(searchTools(uncategorized, { query: 'plain', category: 'database' }), []);
});

test('search_tools filters MCP tools by server and excludes builtins', () => {
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'write', server: 'pg' }).map((item) => item.name),
    ['pg.insert_row'],
  );
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'write', server: 'github' }).map((item) => item.name),
    ['github.create_issue'],
  );
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'read', server: 'pg' }).map((item) => item.name),
    ['pg.query'],
  );
  assert.deepEqual(
    searchTools(SNAPSHOT, { query: 'read', server: 'devtools' }),
    [],
    'the server filter never matches built-in groupings',
  );
});

test('an empty query with server lists that server tools; a keyword never matches the server id', () => {
  const snapshot: CatalogSnapshot = {
    revision: 1,
    tools: [
      makeTool({
        name: 'list',
        kind: 'mcp',
        server: 'es',
        description: 'List documents',
        category: 'search',
        summary: 'Elasticsearch',
      }),
      makeTool({
        name: 'get',
        kind: 'mcp',
        server: 'es',
        description: 'Get a document',
        category: 'search',
        summary: 'Elasticsearch',
        tags: ['docs'],
      }),
      makeTool({ name: 'query', kind: 'mcp', server: 'pg', description: 'Run SQL' }),
    ],
  };

  const scoped = searchTools(snapshot, { query: '', server: 'es' });
  assert.deepEqual(scoped.map((item) => item.name), ['es.get', 'es.list']);
  assert.equal(scoped[0]?.category, 'search');
  assert.equal(scoped[0]?.summary, 'Elasticsearch');
  assert.deepEqual(searchTools(snapshot, { query: '', server: 'es', tags: ['docs'] }).map((i) => i.name), ['es.get']);
  assert.deepEqual(searchTools(snapshot, { query: '', server: 'es', max: 1 }).map((i) => i.name), ['es.get']);

  assert.deepEqual(searchTools(snapshot, { query: 'es' }), [], 'the server id is not a search term');
  assert.deepEqual(
    searchTools(snapshot, { query: 'es', server: 'es' }),
    [],
    'the keyword still has to match a tool name, tag or description',
  );

  const overview = searchTools(snapshot, { query: '' });
  assert.deepEqual(overview.map((item) => item.name), ['es', 'pg']);
});

test('server summary never drives keyword matching', () => {
  assert.deepEqual(searchTools(SNAPSHOT, { query: 'postgres' }), []);

  const items = searchTools(SNAPSHOT, { query: 'insert' });
  assert.deepEqual(items[0], {
    name: 'pg.insert_row',
    kind: 'mcp',
    server: 'pg',
    category: 'database',
    summary: 'Postgres tools',
    description: 'Insert a row',
    tags: ['db', 'write'],
  });
});

test('search_tools returns the server overview for an empty query', () => {
  const items = searchTools(SNAPSHOT, { query: '   ' });
  assert.deepEqual(items, [
    {
      name: 'github',
      kind: 'mcp',
      server: 'github',
      toolCount: 1,
      description: '1 tool; call tools.mcp.github.<tool>(args)',
      category: 'vcs',
      summary: 'GitHub tools',
      tags: ['vcs', 'write'],
    },
    {
      name: 'pg',
      kind: 'mcp',
      server: 'pg',
      toolCount: 2,
      description: '2 tools; call tools.mcp.pg.<tool>(args)',
      category: 'database',
      summary: 'Postgres tools',
      tags: ['db', 'read', 'write'],
    },
  ]);
});

test('search_tools visibility: allowedServers hides MCP tools but not builtins', () => {
  const names = (allowedServers: readonly string[] | null) =>
    searchTools(SNAPSHOT, { query: 'read', allowedServers }).map((item) => item.name);

  assert.deepEqual(names(null), ['Read', 'pg.query']);
  assert.deepEqual(names([]), ['Read']);
  assert.deepEqual(names(['pg']), ['Read', 'pg.query']);
  assert.deepEqual(names(['github']), ['Read']);
});

test('search_tools visibility: allowedTags is any-of over every tool', () => {
  const names = (allowedTags: readonly string[] | null) =>
    searchTools(SNAPSHOT, { query: 'read', allowedTags }).map((item) => item.name);

  assert.deepEqual(names(['files']), ['Read']);
  assert.deepEqual(names(['db']), ['pg.query']);
  assert.deepEqual(names(['DB', 'files']).sort(), ['Read', 'pg.query']);
  assert.deepEqual(names([]), []);
  assert.deepEqual(names(['nope']), []);

  assert.deepEqual(
    searchTools(SNAPSHOT, { query: '', allowedServers: [] }),
    [],
    'the overview is empty without visible MCP servers',
  );
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

test('describe_tools omits tools hidden by the request visibility', () => {
  const snapshot: CatalogSnapshot = {
    revision: 1,
    tools: [
      makeTool({ name: 'Read', kind: 'builtin', tags: ['files'] }),
      makeTool({ name: 'query', kind: 'mcp', server: 'pg', tags: ['db'] }),
      makeTool({ name: 'issues', kind: 'mcp', server: 'github', tags: ['vcs'] }),
    ],
  };

  const serverBound = describeTools(snapshot, ['Read', 'pg.query', 'github.issues'], 32_000, {
    allowedServers: ['pg'],
  });
  assert.deepEqual(serverBound.tools.map((tool) => tool.name), ['Read', 'pg.query']);
  assert.deepEqual(serverBound.omitted, ['github.issues']);

  const tagBound = describeTools(snapshot, ['Read', 'pg.query'], 32_000, {
    allowedTags: [],
  });
  assert.deepEqual(tagBound.tools, []);
  assert.deepEqual(tagBound.omitted, ['Read', 'pg.query']);
});

test('dynamic search_tools schema carries the visible server, category and tag enums', () => {
  const definition = buildSearchToolsDefinition(
    ['database', 'vcs'],
    ['db', 'read'],
    ['github', 'pg'],
  );
  assert.deepEqual(definition.inputSchema.properties.server, {
    type: 'string',
    enum: ['github', 'pg'],
  });
  assert.deepEqual(definition.inputSchema.properties.category, {
    type: 'string',
    enum: ['database', 'vcs'],
  });
  assert.deepEqual(definition.inputSchema.properties.tags, {
    type: 'array',
    items: { type: 'string', enum: ['db', 'read'] },
  });
  assert.deepEqual(definition.inputSchema.properties.query, { type: 'string' });
  assert.deepEqual(definition.inputSchema.properties.max, {
    type: 'integer',
    minimum: 1,
    maximum: 50,
    default: 10,
  });
  assert.match(definition.description, /empty query without server returns the server overview/i);
  assert.match(definition.description, /empty query with server returns that server's tools/i);
  assert.match(definition.description, /tool names, effective tags and tool descriptions/i);
  assert.match(definition.description, /only narrow the results/i);
  assert.match(definition.description, /all-of/);
  assert.match(definition.description, /schema enums/);
  assert.equal(Object.isFrozen(definition.inputSchema.properties.category), true);

  const bare = buildSearchToolsDefinition([], []);
  assert.deepEqual(bare.inputSchema.properties.server, { type: 'string' });
  assert.deepEqual(bare.inputSchema.properties.category, { type: 'string' });
  assert.deepEqual(bare.inputSchema.properties.tags, {
    type: 'array',
    items: { type: 'string' },
  });
});

test('validateToolArguments enforces the per-request search_tools enums', () => {
  const definition = buildSearchToolsDefinition(['database'], ['db', 'read'], ['pg']);

  assert.equal(
    validateToolArguments('search_tools', { server: 'pg', category: 'database' }, definition).ok,
    true,
  );
  assert.equal(validateToolArguments('search_tools', { tags: ['db', 'read'] }, definition).ok, true);

  const server = validateToolArguments('search_tools', { server: 'mysql' }, definition);
  assert.equal(server.ok, false);
  if (!server.ok) assert.match(server.message, /server must be one of/);

  const category = validateToolArguments('search_tools', { category: 'pg' }, definition);
  assert.equal(category.ok, false);
  if (!category.ok) assert.match(category.message, /category must be one of/);

  const tags = validateToolArguments('search_tools', { tags: ['db', 'nope'] }, definition);
  assert.equal(tags.ok, false);
  if (!tags.ok) assert.match(tags.message, /tags\[1\] must be one of/);

  // Without a per-request definition the frozen enum-less schema stays permissive.
  assert.equal(validateToolArguments('search_tools', { category: 'anything' }).ok, true);
});

test('listTools applies per-request run_script and search_tools overrides only', () => {
  const definition = buildSearchToolsDefinition(['database'], ['db']);
  const tools = listTools({
    runScriptDescription: 'dynamic run_script',
    searchToolsDescription: definition.description,
    searchToolsSchema: definition.inputSchema,
  });

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('run_script')?.description, 'dynamic run_script');
  assert.deepEqual(
    byName.get('search_tools')?.inputSchema.properties.category,
    { type: 'string', enum: ['database'] },
  );
  for (const name of ['describe_tools', 'wait_tasks', 'report_problem'] as const) {
    assert.equal(byName.get(name), getToolDefinition(name), `${name} stays frozen`);
  }
});
