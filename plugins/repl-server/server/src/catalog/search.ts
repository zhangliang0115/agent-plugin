/** FTS5 retrieval for `search_tools`: filters, BM25, synonyms and visibility. @module */
import type { DatabaseSync } from 'node:sqlite';

import { BUILTIN_SERVER_ID } from '../db/servers.ts';
import { bm25Expression, buildFtsMatch, tokenizeFts } from '../search/fts-kernel.ts';
import {
  effectiveToolDescription,
  effectiveToolTags,
  readNumberColumn,
  readTextColumn,
  parseStringArray,
} from './snapshot.ts';

export const SEARCH_DEFAULT_MAX = 10;
export const SEARCH_MAX_LIMIT = 50;

/**
 * BM25 column weights, in `tools_fts` column order:
 * server_id, name, display_name, index_description, index_summary, index_tags_json.
 * FTS5 returns negative scores, so lower (more negative) ranks first.
 */
export const BM25_WEIGHTS = [0, 3, 2.5, 1, 1.5, 2] as const;

const BM25_SQL = bm25Expression('tools_fts', BM25_WEIGHTS);

const TOOL_SOURCE = 'FROM tools t JOIN servers s ON s.id = t.server_id';
const FTS_SOURCE =
  'FROM tools_fts JOIN tools t ON t.rowid = tools_fts.rowid JOIN servers s ON s.id = t.server_id';

const SELECT_TOOL_COLUMNS = `
SELECT
  t.server_id AS server_id,
  t.name AS name,
  t.display_name AS display_name,
  t.description AS description,
  t.description_override AS description_override,
  t.index_description AS index_description,
  t.index_tags_json AS index_tags_json,
  t.tags_json AS tool_tags_json,
  s.transport AS transport,
  s.tags_json AS server_tags_json`;

/**
 * Chinese/English synonyms. Chinese tokens rarely match Latin tool names under
 * the unicode61 tokenizer, so the query is translated before it reaches FTS.
 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  发邮件: ['send', 'mail', 'email'],
  邮件: ['mail', 'email'],
  电子邮件: ['mail', 'email'],
  数据库: ['database', 'sql', 'query'],
  查询: ['query', 'search'],
  搜索: ['search', 'find'],
  查找: ['search', 'find'],
  提交: ['commit'],
  推送: ['push'],
  文件: ['file'],
  读取: ['read'],
  写入: ['write'],
  编辑: ['edit'],
  图片: ['image'],
  截图: ['screenshot'],
  浏览器: ['browser'],
  网页: ['web', 'page'],
  命令: ['command', 'bash'],
  终端: ['terminal', 'bash'],
  测试: ['test'],
  部署: ['deploy'],
  日志: ['log'],
  任务: ['task'],
  创建: ['create'],
  删除: ['delete'],
  发送: ['send'],
  消息: ['message'],
  表格: ['table'],
  文档: ['document'],
  代码: ['code'],
  email: ['mail', 'send'],
  mail: ['email', 'send'],
  send: ['mail', 'email'],
  db: ['database', 'sql'],
  sql: ['database', 'query'],
  fs: ['file', 'filesystem'],
  gh: ['github'],
  k8s: ['kubernetes'],
  doc: ['document'],
  docs: ['document'],
};

const FILTER_RE = /(?:^|\s)(server|category|tag|type):(?:"([^"]*)"|(\S+))/gi;
const MAX_QUERY_CHARS = 16384;
const MAX_TERMS = 32;

/** Structured filters parsed out of a free-text query. @module */
export interface ParsedSearchQuery {
  text: string;
  servers: string[];
  categories: string[];
  tags: string[];
  types: string[];
}

/** Per-call visibility, matching `client_bindings.allowed_servers/allowed_tags` (any-of). @module */
export interface SearchVisibility {
  allowedServers?: readonly string[] | null;
  allowedTags?: readonly string[] | null;
}

/** Arguments accepted by the retrieval layer. `search_tools` passes its own subset. @module */
export interface SearchRequest {
  query?: string;
  server?: string;
  category?: string;
  tags?: readonly string[];
  type?: string;
  max?: number;
  visibility?: SearchVisibility;
  /** Server ids whose pool connection is currently down; their tools are hidden with a hint. */
  unavailableServers?: readonly string[];
}

/** One search result. `name` is bare for builtins and `<server>.<tool>` for MCP. @module */
export interface SearchHit {
  name: string;
  kind: 'builtin' | 'mcp';
  server?: string;
  description?: string;
  tags?: string[];
  score?: number;
}

/** Server-level entry returned for an empty query. @module */
export interface SearchServerOverview {
  server: string;
  label: string;
  kind: 'builtin' | 'mcp';
  summary?: string;
  category?: string;
  tags: string[];
  toolCount: number;
}

/** Category breakdown returned for an empty query. @module */
export interface SearchCategoryOverview {
  category: string;
  toolCount: number;
}

/** Retrieval outcome. `overview` is set only for empty queries. @module */
export interface SearchOutcome {
  mode: 'overview' | 'search';
  results: SearchHit[];
  overview?: {
    servers: SearchServerOverview[];
    categories: SearchCategoryOverview[];
  };
  hiddenByVisibility: number;
  hiddenStale: number;
  hints: string[];
}

type SqlParam = string | number;

interface Clause {
  sql: string;
  params: SqlParam[];
}

interface ResolvedFilters {
  servers: string[];
  categories: string[];
  tags: string[];
  types: string[];
}

interface SearchContext {
  db: DatabaseSync;
  active: Clause;
  visibility: Clause;
  visible: Clause;
  staleHidden: Clause;
  unavailableServers: string[];
}

function clause(sql: string, params: SqlParam[] = []): Clause {
  return { sql, params };
}

function andClauses(...clauses: Clause[]): Clause {
  const parts = clauses.filter((item) => item.sql !== '1' && item.sql !== '');
  const params = clauses.flatMap((item) => item.params);
  if (parts.length === 0) return { sql: '1', params: [] };
  return { sql: parts.map((item) => `(${item.sql})`).join(' AND '), params };
}

function uniqueValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '') continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Parses `server:`, `category:`, `tag:` and `type:` filters out of a query. @module */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const source = raw.slice(0, MAX_QUERY_CHARS);
  const parsed: ParsedSearchQuery = {
    text: '',
    servers: [],
    categories: [],
    tags: [],
    types: [],
  };
  const stripped = source.replace(
    FILTER_RE,
    (_match, key: string, quoted: string | undefined, bare: string | undefined) => {
      const value = (quoted ?? bare ?? '').trim();
      if (value !== '') {
        const normalized = key.toLowerCase();
        if (normalized === 'server') parsed.servers.push(value);
        else if (normalized === 'category') parsed.categories.push(value);
        else if (normalized === 'tag') parsed.tags.push(value);
        else if (normalized === 'type') parsed.types.push(value);
      }
      return ' ';
    },
  );
  parsed.text = stripped.trim();
  return parsed;
}

function tokenize(text: string): string[] {
  return tokenizeFts(text, MAX_TERMS).map((token) => token.toLowerCase());
}

function isHan(value: string): boolean {
  return /^\p{Script=Han}+$/u.test(value);
}

/** Expands a free-text query with the synonym table. @module */
export function expandQueryTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (term: string): void => {
    for (const part of tokenize(term)) {
      if (part === '' || seen.has(part)) continue;
      if (terms.length >= MAX_TERMS) return;
      seen.add(part);
      terms.push(part);
    }
  };

  const base = tokenize(text).slice(0, MAX_TERMS);
  for (const token of base) add(token);

  for (const token of base) {
    const direct = SYNONYMS[token];
    if (direct !== undefined) {
      for (const synonym of direct) add(synonym);
      continue;
    }
    if (!isHan(token)) continue;
    for (const [key, values] of Object.entries(SYNONYMS)) {
      if (!isHan(key)) continue;
      if (token.includes(key) || key.includes(token)) {
        for (const synonym of values) add(synonym);
      }
    }
  }

  return terms;
}

/** Builds an FTS5 MATCH expression: every term is quoted and prefix-matched. @module */
export function toFtsMatch(terms: readonly string[]): string {
  return buildFtsMatch(terms.filter((term) => term !== ''), 'OR') ?? '';
}

function resolveFilters(request: SearchRequest, parsed: ParsedSearchQuery): ResolvedFilters {
  return {
    servers: uniqueValues([
      ...parsed.servers,
      ...(request.server === undefined ? [] : [request.server]),
    ]),
    categories: uniqueValues([
      ...parsed.categories,
      ...(request.category === undefined ? [] : [request.category]),
    ]),
    tags: uniqueValues([...parsed.tags, ...(request.tags ?? [])]),
    types: uniqueValues([
      ...parsed.types,
      ...(request.type === undefined ? [] : [request.type]),
    ]),
  };
}

function filterClause(filters: ResolvedFilters): Clause {
  const parts: string[] = [];
  const params: SqlParam[] = [];

  if (filters.servers.length > 0) {
    parts.push(`t.server_id IN (${placeholders(filters.servers.length)})`);
    params.push(...filters.servers);
  }
  if (filters.categories.length > 0) {
    parts.push(
      `lower(coalesce(t.category, s.category, '')) IN (${placeholders(filters.categories.length)})`,
    );
    params.push(...filters.categories.map((value) => value.toLowerCase()));
  }
  if (filters.tags.length > 0) {
    parts.push(
      `EXISTS (SELECT 1 FROM json_each(t.index_tags_json)
               WHERE lower(json_each.value) IN (${placeholders(filters.tags.length)}))`,
    );
    params.push(...filters.tags.map((value) => value.toLowerCase()));
  }
  if (filters.types.length > 0) {
    parts.push(
      `lower(coalesce(t.type, '')) IN (${placeholders(filters.types.length)})`,
    );
    params.push(...filters.types.map((value) => value.toLowerCase()));
  }

  return parts.length === 0 ? clause('1') : clause(`(${parts.join(' AND ')})`, params);
}

function visibilityClause(visibility: SearchVisibility | undefined): Clause {
  const parts: string[] = [];
  const params: SqlParam[] = [];

  if (visibility?.allowedServers != null) {
    if (visibility.allowedServers.length === 0) {
      parts.push('0');
    } else {
      parts.push(`t.server_id IN (${placeholders(visibility.allowedServers.length)})`);
      params.push(...visibility.allowedServers);
    }
  }
  if (visibility?.allowedTags != null) {
    if (visibility.allowedTags.length === 0) {
      parts.push('0');
    } else {
      parts.push(
        `EXISTS (SELECT 1 FROM json_each(t.index_tags_json)
                 WHERE lower(json_each.value) IN (${placeholders(visibility.allowedTags.length)}))`,
      );
      params.push(...visibility.allowedTags.map((value) => value.toLowerCase()));
    }
  }

  return parts.length === 0 ? clause('1') : clause(`(${parts.join(' AND ')})`, params);
}

function unavailableClause(servers: readonly string[]): Clause {
  if (servers.length === 0) return clause('1');
  return clause(
    `t.server_id NOT IN (${placeholders(servers.length)})`,
    [...servers],
  );
}

function countRows(db: DatabaseSync, source: string, where: Clause): number {
  const row = db
    .prepare(`SELECT count(*) AS n ${source} WHERE ${where.sql}`)
    .get(...where.params);
  return row === undefined ? 0 : readNumberColumn(row as Record<string, unknown>, 'n');
}

function toHit(row: Record<string, unknown>): SearchHit {
  const serverId = readTextColumn(row, 'server_id');
  const toolName = readTextColumn(row, 'name');
  const builtin = readTextColumn(row, 'transport') === 'builtin';
  const description = effectiveToolDescription(row);
  const tags = effectiveToolTags(row);
  const hit: SearchHit = {
    name: builtin ? toolName : `${serverId}.${toolName}`,
    kind: builtin ? 'builtin' : 'mcp',
  };
  if (!builtin) hit.server = serverId;
  if (description !== '') hit.description = description;
  if (tags.length > 0) hit.tags = tags;
  const score = row.score;
  if (typeof score === 'number' && Number.isFinite(score)) hit.score = score;
  return hit;
}

function clampMax(max: number | undefined): number {
  if (max === undefined || !Number.isFinite(max)) return SEARCH_DEFAULT_MAX;
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(max)));
}

function exactNameHits(
  db: DatabaseSync,
  needle: string,
  where: Clause,
  max: number,
): SearchHit[] {
  if (needle === '') return [];
  const exact = clause(
    `((s.transport = 'builtin' AND lower(t.name) = lower(?))
      OR (s.transport <> 'builtin' AND lower(t.server_id || '.' || t.name) = lower(?)))`,
    [needle, needle],
  );
  const combined = andClauses(where, exact);
  const rows = db
    .prepare(
      `${SELECT_TOOL_COLUMNS} ${TOOL_SOURCE}
       WHERE ${combined.sql}
       ORDER BY t.server_id ASC, t.name ASC
       LIMIT ?`,
    )
    .all(...combined.params, max) as Record<string, unknown>[];
  return rows.map(toHit);
}

function substringClause(terms: readonly string[]): Clause {
  if (terms.length === 0) return clause('0');
  const params: SqlParam[] = [];
  const perTerm = terms.map((term) => {
    const pattern = `%${term.toLowerCase()}%`;
    for (let index = 0; index < 5; index += 1) params.push(pattern);
    return `(lower(coalesce(t.name, '')) LIKE ?
             OR lower(coalesce(t.display_name, '')) LIKE ?
             OR lower(coalesce(t.index_description, '')) LIKE ?
             OR lower(coalesce(t.index_summary, '')) LIKE ?
             OR lower(coalesce(t.index_tags_json, '')) LIKE ?)`;
  });
  return clause(`(${perTerm.join(' OR ')})`, params);
}

function substringScore(row: Record<string, unknown>, terms: readonly string[]): number {
  const name = readTextColumn(row, 'name').toLowerCase();
  const displayName = readTextColumn(row, 'display_name').toLowerCase();
  const description = effectiveToolDescription(row).toLowerCase();
  const summary = readTextColumn(row, 'index_summary').toLowerCase();
  const tags = effectiveToolTags(row).join(' ').toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3;
    if (displayName.includes(term)) score += 2.5;
    if (tags.includes(term)) score += 2;
    if (summary.includes(term)) score += 1.5;
    if (description.includes(term)) score += 1;
  }
  return score;
}

function listVisibleServers(context: SearchContext): string[] {
  const rows = context.db
    .prepare(
      `SELECT DISTINCT t.server_id AS server_id ${TOOL_SOURCE}
       WHERE ${context.visible.sql}
       ORDER BY t.server_id ASC`,
    )
    .all(...context.visible.params) as Record<string, unknown>[];
  return rows.map((row) => readTextColumn(row, 'server_id'));
}

function unavailableBreakdown(context: SearchContext): { server: string; hidden: number }[] {
  return context.unavailableServers.map((server) => ({
    server,
    hidden: countRows(
      context.db,
      TOOL_SOURCE,
      andClauses(
        context.active,
        context.visibility,
        clause('t.server_id = ?', [server]),
      ),
    ),
  }));
}

function buildHints(
  context: SearchContext,
  results: readonly SearchHit[],
  hiddenByVisibility: number,
  hiddenStale: number,
  mode: 'overview' | 'search',
): string[] {
  const hints: string[] = [];
  if (mode === 'search' && results.length === 0) {
    const servers = listVisibleServers(context);
    const available = servers.length > 0 ? servers.join(', ') : 'none';
    hints.push(
      `No matching tools. Available servers: ${available}. `
      + 'Tip: tool names usually start with an English verb (read, search, send, query).',
    );
  }
  if (hiddenByVisibility > 0) {
    if (mode === 'overview') {
      hints.push(`${hiddenByVisibility} tool(s) are outside your visibility scope.`);
    } else {
      hints.push(
        results.length === 0
          ? `${hiddenByVisibility} tool(s) match but are outside your visibility scope.`
          : `${hiddenByVisibility} more tool(s) match but are outside your visibility scope.`,
      );
    }
  }
  if (hiddenStale > 0) {
    hints.push(
      `${hiddenStale} stale tool(s) were not returned; refresh the server's tools to update them.`,
    );
  }
  for (const item of unavailableBreakdown(context)) {
    if (item.hidden > 0) {
      hints.push(`server ${item.server} is unavailable, ${item.hidden} tool(s) hidden.`);
    }
  }
  return hints;
}

function buildOverview(context: SearchContext): SearchOutcome {
  const serverRows = context.db
    .prepare(
      `SELECT
         t.server_id AS server_id,
         s.label AS label,
         s.transport AS transport,
         s.summary AS summary,
         s.category AS category,
         s.tags_json AS tags_json,
         count(*) AS tool_count
       ${TOOL_SOURCE}
       WHERE ${context.visible.sql}
       GROUP BY t.server_id, s.label, s.transport, s.summary, s.category, s.tags_json
       ORDER BY t.server_id ASC`,
    )
    .all(...context.visible.params) as Record<string, unknown>[];

  const servers: SearchServerOverview[] = serverRows.map((row) => {
    const serverId = readTextColumn(row, 'server_id');
    const entry: SearchServerOverview = {
      server: serverId,
      label: readTextColumn(row, 'label') || serverId,
      kind: readTextColumn(row, 'transport') === 'builtin' ? 'builtin' : 'mcp',
      tags: parseStringArray(readTextColumn(row, 'tags_json')),
      toolCount: readNumberColumn(row, 'tool_count'),
    };
    const summary = readTextColumn(row, 'summary');
    if (summary !== '') entry.summary = summary;
    const category = readTextColumn(row, 'category');
    if (category !== '') entry.category = category;
    return entry;
  });

  const categoryRows = context.db
    .prepare(
      `SELECT
         coalesce(t.category, s.category, '') AS category,
         count(*) AS tool_count
       ${TOOL_SOURCE}
       WHERE ${context.visible.sql}
         AND coalesce(t.category, s.category, '') <> ''
       GROUP BY coalesce(t.category, s.category, '')
       ORDER BY tool_count DESC, category ASC`,
    )
    .all(...context.visible.params) as Record<string, unknown>[];

  const categories: SearchCategoryOverview[] = categoryRows.map((row) => ({
    category: readTextColumn(row, 'category'),
    toolCount: readNumberColumn(row, 'tool_count'),
  }));

  const activeCount = countRows(context.db, TOOL_SOURCE, context.active);
  const activeVisibleCount = countRows(
    context.db,
    TOOL_SOURCE,
    andClauses(context.active, context.visibility),
  );
  const hiddenByVisibility = Math.max(0, activeCount - activeVisibleCount);
  const hiddenStale = countRows(context.db, TOOL_SOURCE, context.staleHidden);

  return {
    mode: 'overview',
    results: [],
    overview: { servers, categories },
    hiddenByVisibility,
    hiddenStale,
    hints: buildHints(context, [], hiddenByVisibility, hiddenStale, 'overview'),
  };
}

/**
 * Runs catalog retrieval.
 *
 * Order: structured filters, exact name, FTS5 with synonyms/BM25, then a
 * substring scan when FTS returns nothing. Visibility is applied inside the
 * query before the result limit, and hidden matches are reported as hints
 * instead of being silently dropped.
 * @module
 */
export function searchTools(db: DatabaseSync, request: SearchRequest = {}): SearchOutcome {
  const parsed = parseSearchQuery(request.query ?? '');
  const filters = resolveFilters(request, parsed);
  const max = clampMax(request.max);
  const unavailableServers = uniqueValues(request.unavailableServers ?? []);

  const gate = andClauses(
    clause('s.enabled = 1'),
    clause('t.enabled = 1'),
    // Same read-only rule as the snapshot: `__builtin__` rows are admin
    // metadata until composite tools have an executor.
    clause('t.server_id <> ?', [BUILTIN_SERVER_ID]),
    filterClause(filters),
  );
  const staleVisible = clause('NOT (t.stale = 1 AND t.stale_override = 0)');
  const staleHidden = clause('t.stale = 1 AND t.stale_override = 0');
  const visibility = visibilityClause(request.visibility);
  const active = andClauses(gate, staleVisible);
  const visible = andClauses(active, visibility, unavailableClause(unavailableServers));

  const context: SearchContext = {
    db,
    active,
    visibility,
    visible,
    staleHidden: andClauses(gate, staleHidden),
    unavailableServers,
  };

  if (parsed.text === '') return buildOverview(context);

  const terms = expandQueryTerms(parsed.text);
  if (terms.length === 0) return buildOverview(context);

  const exact = exactNameHits(db, parsed.text, visible, max);
  if (exact.length > 0) {
    return {
      mode: 'search',
      results: exact,
      hiddenByVisibility: 0,
      hiddenStale: 0,
      hints: [],
    };
  }

  const match = toFtsMatch(terms);
  const matchClause = clause('tools_fts MATCH ?', [match]);
  const ftsWhere = andClauses(visible, matchClause);
  const ftsRows = db
    .prepare(
      `${SELECT_TOOL_COLUMNS}, ${BM25_SQL} AS score
       ${FTS_SOURCE}
       WHERE ${ftsWhere.sql}
       ORDER BY score ASC, t.server_id ASC, t.name ASC
       LIMIT ?`,
    )
    .all(...ftsWhere.params, max) as Record<string, unknown>[];

  if (ftsRows.length > 0) {
    const activeMatches = andClauses(active, matchClause);
    const activeVisibleMatches = andClauses(activeMatches, visibility);
    const hiddenByVisibility = Math.max(
      0,
      countRows(db, FTS_SOURCE, activeMatches)
        - countRows(db, FTS_SOURCE, activeVisibleMatches),
    );
    const hiddenStale = countRows(
      db,
      FTS_SOURCE,
      andClauses(andClauses(gate, staleHidden), matchClause),
    );
    const results = ftsRows.map(toHit);
    return {
      mode: 'search',
      results,
      hiddenByVisibility,
      hiddenStale,
      hints: buildHints(context, results, hiddenByVisibility, hiddenStale, 'search'),
    };
  }

  const like = substringClause(terms);
  const substringActive = andClauses(active, like);
  const substringVisible = andClauses(visible, like);
  const substringRows = db
    .prepare(
      `${SELECT_TOOL_COLUMNS} ${TOOL_SOURCE}
       WHERE ${substringVisible.sql}
       ORDER BY t.server_id ASC, t.name ASC`,
    )
    .all(...substringVisible.params) as Record<string, unknown>[];

  const scored = substringRows.map((row) => ({
    row,
    score: substringScore(row, terms),
  }));
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftServer = readTextColumn(left.row, 'server_id');
    const rightServer = readTextColumn(right.row, 'server_id');
    if (leftServer !== rightServer) return leftServer < rightServer ? -1 : 1;
    const leftName = readTextColumn(left.row, 'name');
    const rightName = readTextColumn(right.row, 'name');
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });

  const results = scored.slice(0, max).map((entry) => {
    const hit = toHit(entry.row);
    hit.score = entry.score;
    return hit;
  });

  const hiddenByVisibility = Math.max(
    0,
    countRows(db, TOOL_SOURCE, substringActive)
      - countRows(db, TOOL_SOURCE, andClauses(substringActive, visibility)),
  );
  const hiddenStale = countRows(
    db,
    TOOL_SOURCE,
    andClauses(andClauses(gate, staleHidden), like),
  );

  return {
    mode: 'search',
    results,
    hiddenByVisibility,
    hiddenStale,
    hints: buildHints(context, results, hiddenByVisibility, hiddenStale, 'search'),
  };
}
