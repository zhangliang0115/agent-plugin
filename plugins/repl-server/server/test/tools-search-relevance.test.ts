import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogSnapshot, CatalogTool } from '../src/ports.ts';
import { validateToolArguments } from '../src/tools/registry.ts';
import { searchTools } from '../src/tools/search.ts';

/**
 * Relevance baseline for `search_tools` over the in-memory snapshot.
 *
 * Expectations come from the scoring rules in src/tools/search.ts, not from
 * observed output. Per query term (lowercased, whitespace split, OR across
 * terms with scores added): exact canonical or bare name +10, name substring
 * +3, exact tag +2, tag substring +1, description substring +1. Ties break on
 * canonical name ascending. Zero score is dropped.
 *
 * Official Claude Code tools are `kind: 'builtin'` and group under
 * `__official__`; the `__builtin__` protocol rows never enter the catalog
 * snapshot, so the MCP/builtin mix below is the whole surface.
 */
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

/** 30 tools: 6 official builtins, 24 MCP across 8 servers. English and Chinese
 *  names/descriptions/tags, plus the punctuation the substring matcher must
 *  treat literally. */
const TOOLS: CatalogTool[] = [
  // Official Claude Code tools (builtin kind).
  makeTool({ name: 'Read', kind: 'builtin', description: 'Read a file from disk', category: 'devtools', summary: 'Official Claude Code tools', tags: ['files', 'read'] }),
  makeTool({ name: 'Bash', kind: 'builtin', description: 'Run a shell command', category: 'devtools', summary: 'Official Claude Code tools', tags: ['shell', 'exec'] }),
  makeTool({ name: 'WebSearch', kind: 'builtin', description: 'Search the web for pages', category: 'devtools', summary: 'Official Claude Code tools', tags: ['web', 'search'] }),
  makeTool({ name: 'WebFetch', kind: 'builtin', description: 'Fetch a URL and convert to text', category: 'devtools', summary: 'Official Claude Code tools', tags: ['web', 'http'] }),
  makeTool({ name: 'Edit', kind: 'builtin', description: 'Edit a file with exact replacements', category: 'devtools', summary: 'Official Claude Code tools', tags: ['files', 'write'] }),
  makeTool({ name: 'Grep', kind: 'builtin', description: 'Search file contents with regex', category: 'devtools', summary: 'Official Claude Code tools', tags: ['files', 'search'] }),

  // pg-main: database tags drive the all-of filter tests.
  makeTool({ name: 'query', kind: 'mcp', server: 'pg-main', description: 'Run a read-only SQL query', category: 'database', summary: 'Postgres warehouse', tags: ['db', 'read'] }),
  makeTool({ name: 'insert_row', kind: 'mcp', server: 'pg-main', description: 'Insert a row into a table', category: 'database', summary: 'Postgres warehouse', tags: ['db', 'write'] }),
  makeTool({ name: 'slow_query_log', kind: 'mcp', server: 'pg-main', description: 'List slow SQL statements', category: 'database', summary: 'Postgres warehouse', tags: ['db', 'sql'] }),

  makeTool({ name: 'create_issue', kind: 'mcp', server: 'github', description: 'Create an issue in a repository', category: 'vcs', summary: 'GitHub tools', tags: ['vcs', 'write'] }),
  makeTool({ name: 'search_repos', kind: 'mcp', server: 'github', description: 'Search repositories by keyword', category: 'vcs', summary: 'GitHub tools', tags: ['vcs', 'search'] }),
  makeTool({ name: 'list_pull_requests', kind: 'mcp', server: 'github', description: 'List pull requests for a repository', category: 'vcs', summary: 'GitHub tools', tags: ['vcs', 'read'] }),

  // demo: exact bare name, name substring, exact tag and description-only hits.
  makeTool({ name: 'echo', kind: 'mcp', server: 'demo', description: 'Echo the payload back', category: 'messaging', summary: 'Demo messaging tools', tags: ['demo', 'test'] }),
  makeTool({ name: 'echo_listener', kind: 'mcp', server: 'demo', description: 'Listen for echo events', category: 'messaging', summary: 'Demo messaging tools', tags: ['demo'] }),
  makeTool({ name: 'trace_span', kind: 'mcp', server: 'demo', description: 'Record a trace span', category: 'messaging', summary: 'Demo messaging tools', tags: ['observe'] }),
  makeTool({ name: 'tagged_only', kind: 'mcp', server: 'demo', description: 'A tool without the keyword in name', category: 'messaging', summary: 'Demo messaging tools', tags: ['trace'] }),
  makeTool({ name: 'described_only', kind: 'mcp', server: 'demo', description: 'Collects trace data from agents', category: 'messaging', summary: 'Demo messaging tools', tags: ['observe'] }),

  // deploy: two-term accumulation, OR across terms, summary-only "deployment".
  makeTool({ name: 'deploy_rollback', kind: 'mcp', server: 'deploy', description: 'Release control for containers', category: 'ci', summary: 'Deployment pipeline', tags: ['ci', 'ops'] }),
  makeTool({ name: 'deploy_status', kind: 'mcp', server: 'deploy', description: 'Show the current release status', category: 'ci', summary: 'Deployment pipeline', tags: ['ci'] }),
  makeTool({ name: 'rollback_log', kind: 'mcp', server: 'deploy', description: 'Show previous release history', category: 'ci', summary: 'Deployment pipeline', tags: ['ci'] }),

  // es-logs: Chinese mid-token name and description hits.
  makeTool({ name: '日志检索', kind: 'mcp', server: 'es-logs', description: '在 ES 中按关键字搜索日志', category: 'search', summary: 'Elasticsearch cluster', tags: ['elasticsearch', 'log'] }),
  makeTool({ name: 'log_query', kind: 'mcp', server: 'es-logs', description: 'Query logs by time range', category: 'search', summary: 'Elasticsearch cluster', tags: ['log', 'search'] }),
  makeTool({ name: 'index_stats', kind: 'mcp', server: 'es-logs', description: '按条件检索索引统计', category: 'search', summary: 'Elasticsearch cluster', tags: ['metrics'] }),

  // internal: Chinese names/tags and an English name prefix.
  makeTool({ name: '重启服务', kind: 'mcp', server: 'internal', description: '重启指定命名空间的 Pod', category: 'ops', summary: '内部运维平台', tags: ['ops', 'kubernetes'] }),
  makeTool({ name: '磁盘占用', kind: 'mcp', server: 'internal', description: '统计远程主机的磁盘占用', category: 'ops', summary: '内部运维平台', tags: ['ops', 'disk', '巡检'] }),
  makeTool({ name: 'kubectl_exec', kind: 'mcp', server: 'internal', description: 'Execute a command in a pod', category: 'ops', summary: '内部运维平台', tags: ['ops', 'kubernetes'] }),

  // sql/legacy: literal % _ " ' * and parentheses.
  makeTool({ name: 'sql_query_v2', kind: 'mcp', server: 'sql', description: 'SELECT * FROM users and return rows', category: 'database', summary: 'SQL utilities', tags: ['sql', 'read'] }),
  makeTool({ name: 'percent_stats', kind: 'mcp', server: 'sql', description: 'Report 100% coverage of tables', category: 'database', summary: 'SQL utilities', tags: ['sql', 'metrics'] }),
  makeTool({ name: 'strict_mode', kind: 'mcp', server: 'sql', description: 'Enable the "strict" mode for sessions', category: 'database', summary: 'SQL utilities', tags: ['config'] }),
  makeTool({ name: 'old_helper (deprecated)', kind: 'mcp', server: 'legacy', description: "Call (deprecated) helper; owner's report is gone", category: 'tools', summary: 'Legacy helpers', tags: ['legacy'] }),
];

const SNAPSHOT: CatalogSnapshot = { revision: 11, tools: TOOLS };

function names(input: Parameters<typeof searchTools>[1]): string[] {
  return searchTools(SNAPSHOT, input).map((item) => item.name);
}

test('an exact canonical name outranks substring hits', () => {
  const items = searchTools(SNAPSHOT, { query: 'pg-main.query' });
  assert.deepEqual(items.map((item) => item.name), ['pg-main.query']);
  assert.equal(items[0]?.kind, 'mcp');
  assert.equal(items[0]?.server, 'pg-main');
});

test('an exact bare name outranks the same term in other names or descriptions', () => {
  // demo.echo: exact bare name 10 + description 1 = 11.
  // demo.echo_listener: name substring 3 + description 1 = 4.
  assert.deepEqual(names({ query: 'echo' }), ['demo.echo', 'demo.echo_listener']);
});

test('name hits rank above tags-only hits, which rank above description-only hits', () => {
  // trace_span: name 3 + description 1 = 4; tagged_only: exact tag 2;
  // described_only: description 1.
  assert.deepEqual(names({ query: 'trace' }), [
    'demo.trace_span',
    'demo.tagged_only',
    'demo.described_only',
  ]);
});

test('multiple terms are OR-ed and their scores accumulate', () => {
  // deploy_rollback hits both terms (3 + 3 = 6); each sibling hits one (3).
  // A collection of one term only would miss the union.
  assert.deepEqual(names({ query: 'deploy rollback' }), [
    'deploy.deploy_rollback',
    'deploy.deploy_status',
    'deploy.rollback_log',
  ]);
});

test('server, category and all-of tags narrow the same keyword search', () => {
  assert.deepEqual(names({ query: 'db', server: 'pg-main' }), [
    'pg-main.insert_row',
    'pg-main.query',
    'pg-main.slow_query_log',
  ]);
  assert.deepEqual(names({ query: 'db', server: 'github' }), []);
  assert.deepEqual(names({ query: 'db', category: 'database' }), [
    'pg-main.insert_row',
    'pg-main.query',
    'pg-main.slow_query_log',
  ]);
  assert.deepEqual(names({ query: 'db', category: 'vcs' }), []);
  assert.deepEqual(names({ query: 'db', tags: ['db'] }), [
    'pg-main.insert_row',
    'pg-main.query',
    'pg-main.slow_query_log',
  ]);
  assert.deepEqual(names({ query: 'db', tags: ['db', 'read'] }), ['pg-main.query']);
  assert.deepEqual(names({ query: 'db', tags: ['db', 'write'] }), ['pg-main.insert_row']);
  assert.deepEqual(names({ query: 'db', tags: ['db', 'logs'] }), []);
});

test('an empty query with server lists that server tools in canonical order', () => {
  assert.deepEqual(names({ query: '', server: 'pg-main' }), [
    'pg-main.insert_row',
    'pg-main.query',
    'pg-main.slow_query_log',
  ]);
  assert.deepEqual(names({ query: '   ', server: 'pg-main', max: 2 }), [
    'pg-main.insert_row',
    'pg-main.query',
  ]);
  assert.deepEqual(names({ query: '', server: '__official__' }), [
    'Bash',
    'Edit',
    'Grep',
    'Read',
    'WebFetch',
    'WebSearch',
  ]);

  const first = searchTools(SNAPSHOT, { query: '', server: 'pg-main' })[0];
  assert.deepEqual(first, {
    name: 'pg-main.insert_row',
    kind: 'mcp',
    server: 'pg-main',
    category: 'database',
    summary: 'Postgres warehouse',
    description: 'Insert a row into a table',
    tags: ['db', 'write'],
  });
});

test('an empty query returns the overview: official group first, then servers A-Z', () => {
  assert.deepEqual(searchTools(SNAPSHOT, { query: '' }), [
    {
      name: '__official__',
      kind: 'builtin',
      toolCount: 6,
      description: '6 tools; call tools.<tool>(args)',
      summary: 'Official Claude Code tools',
      tags: ['exec', 'files', 'http', 'read', 'search', 'shell', 'web', 'write'],
    },
    {
      name: 'demo',
      kind: 'mcp',
      server: 'demo',
      toolCount: 5,
      description: '5 tools; call tools.mcp.demo.<tool>(args)',
      category: 'messaging',
      summary: 'Demo messaging tools',
      tags: ['demo', 'observe', 'test', 'trace'],
    },
    {
      name: 'deploy',
      kind: 'mcp',
      server: 'deploy',
      toolCount: 3,
      description: '3 tools; call tools.mcp.deploy.<tool>(args)',
      category: 'ci',
      summary: 'Deployment pipeline',
      tags: ['ci', 'ops'],
    },
    {
      name: 'es-logs',
      kind: 'mcp',
      server: 'es-logs',
      toolCount: 3,
      description: '3 tools; call tools.mcp.es-logs.<tool>(args)',
      category: 'search',
      summary: 'Elasticsearch cluster',
      tags: ['elasticsearch', 'log', 'metrics', 'search'],
    },
    {
      name: 'github',
      kind: 'mcp',
      server: 'github',
      toolCount: 3,
      description: '3 tools; call tools.mcp.github.<tool>(args)',
      category: 'vcs',
      summary: 'GitHub tools',
      tags: ['read', 'search', 'vcs', 'write'],
    },
    {
      name: 'internal',
      kind: 'mcp',
      server: 'internal',
      toolCount: 3,
      description: '3 tools; call tools.mcp.internal.<tool>(args)',
      category: 'ops',
      summary: '内部运维平台',
      tags: ['disk', 'kubernetes', 'ops', '巡检'],
    },
    {
      name: 'legacy',
      kind: 'mcp',
      server: 'legacy',
      toolCount: 1,
      description: '1 tool; call tools.mcp.legacy.<tool>(args)',
      category: 'tools',
      summary: 'Legacy helpers',
      tags: ['legacy'],
    },
    {
      name: 'pg-main',
      kind: 'mcp',
      server: 'pg-main',
      toolCount: 3,
      description: '3 tools; call tools.mcp.pg-main.<tool>(args)',
      category: 'database',
      summary: 'Postgres warehouse',
      tags: ['db', 'read', 'sql', 'write'],
    },
    {
      name: 'sql',
      kind: 'mcp',
      server: 'sql',
      toolCount: 3,
      description: '3 tools; call tools.mcp.sql.<tool>(args)',
      category: 'database',
      summary: 'SQL utilities',
      tags: ['config', 'metrics', 'read', 'sql'],
    },
  ]);
});

test('server ids and server summaries never match a keyword', () => {
  assert.deepEqual(names({ query: 'postgres' }), []);
  assert.deepEqual(names({ query: 'warehouse' }), []);
  assert.deepEqual(names({ query: 'pg-main' }), []);
  assert.deepEqual(names({ query: 'internal' }), []);
  assert.deepEqual(names({ query: 'deployment' }), []);
});

test('max defaults to 10 and the protocol caps it at 50', () => {
  const fifteen: CatalogTool[] = Array.from({ length: 15 }, (_, index) =>
    makeTool({ name: `bulk_${index}`, kind: 'builtin', description: 'limit fixture tool' }),
  );
  assert.equal(searchTools({ revision: 1, tools: fifteen }, { query: 'bulk' }).length, 10);

  const fiftyFive: CatalogTool[] = Array.from({ length: 55 }, (_, index) =>
    makeTool({ name: `bulk_${String(index).padStart(2, '0')}`, kind: 'builtin', description: 'limit fixture tool' }),
  );
  assert.equal(searchTools({ revision: 1, tools: fiftyFive }, { query: 'bulk', max: 1 }).length, 1);
  assert.equal(searchTools({ revision: 1, tools: fiftyFive }, { query: 'bulk', max: 50 }).length, 50);

  const atLimit = validateToolArguments('search_tools', { query: 'x', max: 50 });
  assert.equal(atLimit.ok, true);
  const overLimit = validateToolArguments('search_tools', { query: 'x', max: 51 });
  assert.equal(overLimit.ok, false);
  if (overLimit.ok) throw new Error('unreachable');
  assert.equal(overLimit.code, 'INVALID_ARGUMENT');
  assert.equal(validateToolArguments('search_tools', { query: 'x', max: 0 }).ok, false);
});

test('allowedServers hides MCP tools but never builtins', () => {
  // Read: exact name 10 + exact tag 2 + description 1 = 13.
  // pg-main.query: tag 2 + description 1 = 3; github/sql read tags score 2.
  assert.deepEqual(names({ query: 'read' }), [
    'Read',
    'pg-main.query',
    'github.list_pull_requests',
    'sql.sql_query_v2',
  ]);
  assert.deepEqual(names({ query: 'read', allowedServers: ['pg-main'] }), ['Read', 'pg-main.query']);
  assert.deepEqual(names({ query: 'read', allowedServers: [] }), ['Read']);
  assert.deepEqual(names({ query: 'read', allowedServers: ['github'] }), [
    'Read',
    'github.list_pull_requests',
  ]);

  const overview = searchTools(SNAPSHOT, { query: '', allowedServers: [] });
  assert.deepEqual(overview.map((item) => item.name), ['__official__']);
  assert.equal(overview[0]?.toolCount, 6);
});

test('allowedTags is any-of over every tool and is case-normalized', () => {
  // search scores: WebSearch 3+2+1=6, github.search_repos 3+2+1=6, Grep 2+1=3,
  // log_query 2, 日志检索 tag substring 1.
  assert.deepEqual(names({ query: 'search' }), [
    'WebSearch',
    'github.search_repos',
    'Grep',
    'es-logs.log_query',
    'es-logs.日志检索',
  ]);
  assert.deepEqual(names({ query: 'search', allowedTags: ['web'] }), ['WebSearch']);
  assert.deepEqual(names({ query: 'search', allowedTags: ['WEB'] }), ['WebSearch']);
  assert.deepEqual(names({ query: 'search', allowedTags: ['vcs'] }), ['github.search_repos']);
  assert.deepEqual(names({ query: 'search', allowedTags: [] }), []);
  assert.deepEqual(names({ query: 'read', allowedTags: ['files'] }), ['Read']);
});

test('Chinese mid-token substrings match through plain includes', () => {
  // 日志检索: name substring 3; index_stats: description substring 1.
  assert.deepEqual(names({ query: '检索' }), ['es-logs.日志检索', 'es-logs.index_stats']);
  assert.deepEqual(names({ query: '日志' }), ['es-logs.日志检索']);
  assert.deepEqual(names({ query: '磁盘' }), ['internal.磁盘占用']);
});

test('English prefixes match as substrings', () => {
  assert.deepEqual(names({ query: 'kubectl' }), ['internal.kubectl_exec']);
  assert.deepEqual(names({ query: 'sql_' }), ['sql.sql_query_v2']);
});

test('special characters are literal, not wildcards or regex', () => {
  assert.deepEqual(names({ query: '100%' }), ['sql.percent_stats']);
  assert.deepEqual(names({ query: '_v2' }), ['sql.sql_query_v2']);
  assert.deepEqual(names({ query: '"strict"' }), ['sql.strict_mode']);
  assert.deepEqual(names({ query: "owner's" }), ['legacy.old_helper (deprecated)']);
  assert.deepEqual(names({ query: 'select *' }), ['sql.sql_query_v2']);
  assert.deepEqual(names({ query: '(deprecated)' }), ['legacy.old_helper (deprecated)']);
});

test('a query that matches nothing returns an empty array', () => {
  assert.deepEqual(searchTools(SNAPSHOT, { query: 'zzz_no_such_tool' }), []);
  assert.deepEqual(searchTools(SNAPSHOT, { query: '不存在' }), []);
});
