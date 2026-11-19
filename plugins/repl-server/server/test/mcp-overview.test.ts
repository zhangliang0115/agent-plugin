import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInstructions, INSTRUCTIONS } from '../src/mcp/discover.ts';
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
    summary: null,
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
    server({ id: 'pg', category: 'database', summary: 'Postgres' }),
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

test('server lines are compact and never print summary, tool names or env tags', () => {
  const missing = formatServerLine({
    id: 'pg',
    category: '',
    summary: '',
    tags: [],
    toolCount: 2,
    toolNames: ['query', 'insert', 'list', 'migrate', 'drop'],
  });
  assert.equal(missing, 'pg  [other]  2 tools');

  const bare = formatServerLine({
    id: 'pg',
    category: 'database',
    summary: '',
    tags: [],
    toolCount: 0,
    toolNames: [],
  });
  assert.equal(bare, 'pg  [database]  0 tools');

  const detailed = formatServerLine({
    id: 'gh',
    category: 'vcs',
    summary: 'GitHub repository tools',
    tags: ['vcs', 'env.dev', 'env.test'],
    toolCount: 1,
    toolNames: ['issues'],
  });
  assert.equal(detailed, 'gh  [vcs]  1 tools');
  assert.ok(!detailed.includes('GitHub'));
  assert.ok(!detailed.includes('issues'));
  assert.ok(!detailed.includes('env.'));
});

test('run_script description appends the visible servers and fixed guidance', () => {
  const servers = visible(
    [server({ id: 'pg', category: 'database', summary: 'Postgres' })],
    [tool('pg', 'query')],
  );
  const description = buildRunScriptDescription(RUN_SCRIPT_DESCRIPTION, servers);

  assert.ok(description.startsWith(RUN_SCRIPT_DESCRIPTION));
  assert.match(description, /## MCP servers \(server id, category, visible tool count\)/);
  assert.match(description, /pg {2}\[database\] {2}1 tools/);
  assert.ok(!description.includes('Postgres'), 'the summary is not part of the description');
  assert.match(description, /Call: tools\.mcp\.<server>\.<tool>\(args\)/);
  assert.match(description, /Find: search_tools\(\{ query, server\?, category\?, tags\? \}\)/);
  assert.match(description, /Args: describe_tools\(\{ names \}\)/);
});

test('run_script description says when no server is visible', () => {
  const description = buildRunScriptDescription(RUN_SCRIPT_DESCRIPTION, []);
  assert.ok(description.includes('No MCP servers are visible to this client.'));
  assert.ok(description.includes('Find: search_tools'));
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
  assert.ok(description.includes('Args: describe_tools({ names })'));
  assert.ok(description.includes('Call: tools.mcp.<server>.<tool>(args)'));
  assert.ok(description.includes('Find: search_tools({ query, server?, category?, tags? })'));
});

test('buildInstructions lists visible servers with category, count and summary', () => {
  const servers = visible(
    [
      server({ id: 'pg', category: 'database', summary: 'Postgres tools' }),
      server({ id: 'gh', category: 'vcs', summary: 'GitHub tools', tags: ['env.dev'] }),
      server({ id: 'off', enabled: false }),
    ],
    [tool('pg', 'query'), tool('gh', 'issues')],
  );
  const instructions = buildInstructions(INSTRUCTIONS, servers);

  assert.ok(instructions.includes('MCP servers visible to this client:'));
  assert.ok(instructions.includes('- pg [database] 1 tool — Postgres tools'));
  assert.ok(instructions.includes('- gh [vcs] 1 tool — GitHub tools'));
  assert.ok(!instructions.includes('[env.dev]'), 'env tags stay in the search_tools overview');
  assert.ok(!instructions.includes('- off'));
  assert.ok(instructions.includes('The search_tools schema lists'));
  assert.ok(instructions.includes('the available server, category and tag filter values'));
  assert.ok(!instructions.includes('database, vcs'), 'the category vocabulary is not repeated');
  assert.ok(instructions.includes('## Return values'), 'the rest of the template is unchanged');
  assert.ok(instructions.includes('## Top-level MCP tools'));
});

test('buildInstructions reports an empty visible set', () => {
  const instructions = buildInstructions(INSTRUCTIONS, []);
  assert.ok(instructions.includes('No MCP servers are visible to this client.'));
  assert.ok(instructions.includes('tools.mcp.<server>.<tool>(args).'));
});
