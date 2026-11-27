import assert from 'node:assert/strict';
import test from 'node:test';

import { INSTRUCTIONS } from '../src/mcp/discover.ts';
import {
  buildRunScriptDescription,
  collectVisibleMcpServers,
  DESCRIPTION_MAX_BYTES,
  formatServerLine,
  type McpServerOverview,
  type McpServerSource,
  type McpToolSource,
} from '../src/mcp/overview.ts';
import { RUN_SCRIPT_DESCRIPTION } from '../src/tools/registry.ts';

function server(overrides: Partial<McpServerSource> & { id: string }): McpServerSource {
  return {
    transport: 'stdio',
    enabled: true,
    category: null,
    tags: [],
    ...overrides,
  };
}

function tool(
  serverId: string,
  name: string,
  overrides: Partial<McpToolSource> = {},
): McpToolSource {
  return { name, kind: 'mcp', server: serverId, tags: [], enabled: true, ...overrides };
}

function visible(
  servers: readonly McpServerSource[],
  tools: readonly McpToolSource[],
  allowedServers: readonly string[] | null = null,
  allowedTags: readonly string[] | null = null,
): McpServerOverview[] {
  return collectVisibleMcpServers({ servers, tools, allowedServers, allowedTags });
}

test('visible servers exclude disabled and builtin-transport rows', () => {
  const servers = [
    server({ id: 'pg', category: 'database' }),
    server({ id: 'off', enabled: false }),
    server({ id: '__official__', transport: 'builtin', tags: ['official'] }),
  ];
  const tools = [
    tool('pg', 'query'),
    tool('pg', 'insert'),
    tool('pg', 'stale', { enabled: false }),
    tool('__official__', 'Read', { kind: 'builtin' }),
  ];

  const result = visible(servers, tools);
  assert.deepEqual(result.map((entry) => entry.id), ['pg']);
  assert.equal(result[0]?.toolCount, 2);
  assert.deepEqual(result[0]?.toolNames, ['query', 'insert']);
  assert.equal(result[0]?.category, 'database');
});

test('allowedServers is any-of and an empty list hides everything', () => {
  const servers = [server({ id: 'pg' }), server({ id: 'gh' })];

  assert.deepEqual(visible(servers, [], ['pg']).map((entry) => entry.id), ['pg']);
  assert.deepEqual(visible(servers, [], ['gh', 'pg']).map((entry) => entry.id), ['pg', 'gh']);
  assert.deepEqual(visible(servers, [], []), []);
  assert.deepEqual(visible(servers, [], ['nope']), []);
});

test('allowedTags filters by server tags and by tool-level tags', () => {
  const servers = [server({ id: 'pg', tags: ['db'] }), server({ id: 'gh', tags: ['vcs'] })];
  const tools = [tool('pg', 'query'), tool('gh', 'issues', { tags: ['destructive'] })];

  assert.deepEqual(visible(servers, tools, null, ['DB']).map((entry) => entry.id), ['pg']);
  const byToolTag = visible(servers, tools, null, ['destructive']);
  assert.deepEqual(byToolTag.map((entry) => entry.id), ['gh']);
  assert.equal(byToolTag[0]?.toolCount, 1);
  assert.deepEqual(visible(servers, tools, null, []), []);
});

test('an idle server stays visible when its own tags match', () => {
  const servers = [server({ id: 'fs', tags: ['files'] })];

  const result = visible(servers, [], null, ['files']);
  assert.deepEqual(result.map((entry) => entry.id), ['fs']);
  assert.equal(result[0]?.toolCount, 0);
});

test('server lines are compact and never print tool names or env tags', () => {
  const missing = formatServerLine({
    id: 'pg',
    category: '',
    tags: [],
    toolCount: 2,
    toolNames: ['query', 'insert', 'list', 'migrate', 'drop'],
  });
  assert.equal(missing, 'pg  [other]  2 tools');

  const bare = formatServerLine({
    id: 'pg',
    category: 'database',
    tags: [],
    toolCount: 0,
    toolNames: [],
  });
  assert.equal(bare, 'pg  [database]  0 tools');

  const detailed = formatServerLine({
    id: 'gh',
    category: 'vcs',
    tags: ['vcs', 'env.dev', 'env.test'],
    toolCount: 1,
    toolNames: ['issues'],
  });
  assert.equal(detailed, 'gh  [vcs]  1 tools');
  assert.ok(!detailed.includes('issues'));
  assert.ok(!detailed.includes('env.'));
});

test('run_script description appends the visible servers and fixed guidance', () => {
  const servers = visible(
    [server({ id: 'pg', category: 'database' })],
    [tool('pg', 'query')],
  );
  const description = buildRunScriptDescription(RUN_SCRIPT_DESCRIPTION, servers);

  assert.ok(description.startsWith(RUN_SCRIPT_DESCRIPTION));
  assert.ok(description.includes('repl-server skill'), 'the skill pointer survives assembly');
  assert.ok(
    Buffer.byteLength(description, 'utf8') <= DESCRIPTION_MAX_BYTES,
    `description is ${Buffer.byteLength(description, 'utf8')} bytes`,
  );
  assert.match(description, /## MCP servers \(server id, category, visible tool count\)/);
  assert.match(description, /pg {2}\[database\] {2}1 tools/);
  assert.ok(!description.includes('Postgres'), 'the summary is not part of the description');
  assert.match(description, /Call: tools\.mcp\.<server>\.<tool>\(args\)/);
  assert.match(description, /Discovery: search_tools\(\{ query, server\?, category\?, tags\? \}\)/);
  assert.match(description, /describe_tools\(\{ names \}\) for schemas/);
});

test('run_script description says when no server is visible', () => {
  const description = buildRunScriptDescription(RUN_SCRIPT_DESCRIPTION, []);
  assert.ok(description.includes('No MCP servers are visible to this client.'));
  assert.ok(description.includes('Discovery: search_tools'));
  assert.ok(!description.includes('## Built-in tools'), 'an empty builtin list adds no section');
});

test('run_script description lists visible builtin tools by bare name', () => {
  const servers = visible(
    [server({ id: 'pg', category: 'database' })],
    [tool('pg', 'query')],
  );
  const description = buildRunScriptDescription(RUN_SCRIPT_DESCRIPTION, servers, [
    'Write',
    'Read',
    'Bash',
  ]);

  assert.match(description, /## Built-in tools \(call by bare name\)/);
  assert.match(description, /Bash, Read, Write/, 'names are sorted');
  assert.match(description, /Call: tools\.<name>\(args\)/);
  assert.match(description, /## MCP servers/);
  assert.match(description, /pg {2}\[database\] {2}1 tools/);
});

test('over-budget builtin names are counted, not silently dropped', () => {
  const names = Array.from({ length: 300 }, (_unused, index) => `long_tool_${String(index).padStart(3, '0')}`);
  const description = buildRunScriptDescription(RUN_SCRIPT_DESCRIPTION, [], names);
  const bytes = Buffer.byteLength(description, 'utf8');
  assert.ok(bytes <= DESCRIPTION_MAX_BYTES, `description is ${bytes} bytes`);
  assert.ok(description.includes('long_tool_000'));
  assert.ok(!description.includes('long_tool_299'));
  assert.match(description, /… \(\+\d+ more via search_tools\)/);
  assert.ok(description.includes('describe_tools({ names }) for schemas'), 'guidance survives');
});

test('over-budget server lists are truncated from the tail and guidance survives', () => {
  const servers: McpServerOverview[] = Array.from({ length: 100 }, (_unused, index) => ({
    id: `srv${String(index).padStart(3, '0')}`,
    category: 'database',
    summary: 'x'.repeat(80),
    tags: [],
    toolCount: 12,
    toolNames: ['query'],
  }));

  const description = buildRunScriptDescription(RUN_SCRIPT_DESCRIPTION, servers);
  const bytes = Buffer.byteLength(description, 'utf8');
  assert.ok(bytes <= DESCRIPTION_MAX_BYTES, `description is ${bytes} bytes`);
  assert.ok(description.startsWith(RUN_SCRIPT_DESCRIPTION), 'base rules must never be truncated');
  assert.ok(description.includes('srv000'));
  assert.ok(!description.includes('srv099'));
  assert.ok(description.includes('describe_tools({ names }) for schemas'));
  assert.ok(description.includes('Call: tools.mcp.<server>.<tool>(args)'));
  assert.ok(description.includes('Discovery: search_tools'));
  assert.ok(description.includes('search_tools({ query, server?, category?, tags? })'));
});

test('instructions stay a pointer, with the usage guide in the skill', () => {
  assert.ok([...INSTRUCTIONS].length <= 400, `instructions are ${[...INSTRUCTIONS].length} chars`);
  const bytes = Buffer.byteLength(INSTRUCTIONS, 'utf8');
  assert.ok(bytes <= 400, `instructions are ${bytes} bytes`);
  assert.ok(INSTRUCTIONS.includes('skills/list'));
  // Everything below lives in the skill or the tool descriptions; repeating it
  // here would ship the same text twice.
  for (const moved of ['Promise.all', 'search_tools', 'JSON.parse', 'wait_tasks']) {
    assert.ok(!INSTRUCTIONS.includes(moved), `${moved} should only live in the skill or tool descriptions`);
  }
  assert.ok(RUN_SCRIPT_DESCRIPTION.includes('repl-server skill'));
  assert.ok(!INSTRUCTIONS.includes('30000'));
  assert.ok(!INSTRUCTIONS.includes('50000'));
  assert.ok(!INSTRUCTIONS.includes('7200000'));
});
