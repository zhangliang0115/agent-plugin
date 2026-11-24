/** FTS5-backed `search_tools` for non-empty queries; empty queries stay on the snapshot path. @module */

import type { DatabaseSync } from 'node:sqlite';

import {
  effectiveToolDescription,
  effectiveToolTags,
  readNumberColumn,
  readTextColumn,
} from '../catalog/snapshot.ts';
import { BUILTIN_SERVER_ID } from '../db/servers.ts';
import type { CatalogTool } from '../ports.ts';
import {
  bm25Expression,
  buildFtsMatch,
  likeContainsPattern,
  tokenizeFts,
} from '../search/fts-kernel.ts';
import {
  SEARCH_DEFAULT_MAX,
  compareNames,
  isToolVisible,
  matchesFilters,
  scoreTool,
  toItem,
  type SearchToolItem,
  type SearchToolsInput,
  type ToolVisibility,
} from './search.ts';
import { canonicalToolName } from './registry.ts';

/** Protocol cap for `search_tools.max`. */
const SEARCH_MAX_LIMIT = 50;
const MAX_FTS_TERMS = 32;
/**
 * LIKE terms per statement. SQLite rejects a chained OR whose parse tree grows
 * past its depth limit ("Expression tree is too large"), so the unbounded term
 * list is split into fixed small batches instead of one giant predicate.
 */
const LIKE_TERMS_PER_BATCH = 16;
/** LIKE terms longer than this are dropped: one such token makes SQLite raise "LIKE or GLOB pattern too complex". */
const MAX_LIKE_TERM_LENGTH = 1024;

/**
 * BM25 weights in `tools_fts` column order:
 * server_id, name, display_name, index_description, index_summary, index_tags_json.
 * Only the columns the MATCH expression may hit carry weight.
 */
const BM25_WEIGHTS = [0, 3, 0, 1, 0, 2] as const;

/** Columns needed to rebuild a `CatalogTool` with the same effective values as the snapshot. */
const SELECT_TOOL_COLUMNS = `
SELECT
  t.server_id AS server_id,
  t.name AS name,
  t.description AS description,
  t.description_override AS description_override,
  t.index_description AS index_description,
  t.index_tags_json AS index_tags_json,
  t.tags_json AS tool_tags_json,
  s.transport AS transport,
  s.category AS server_category,
  s.summary AS server_summary,
  s.tags_json AS server_tags_json`;

/** Mirrors the snapshot's exclusion of `__builtin__`, disabled and hidden-stale rows. */
const BASE_WHERE = `
  t.server_id <> ?
  AND t.enabled = 1
  AND s.enabled = 1
  AND NOT (t.stale = 1 AND t.stale_override = 0)`;

/** Effective description fallback chain, matching `effectiveToolDescription`. */
const EFFECTIVE_DESCRIPTION = `CASE
  WHEN t.index_description <> '' THEN t.index_description
  WHEN t.description_override IS NOT NULL THEN t.description_override
  ELSE coalesce(t.description, '')
END`;

/** Effective tag union, matching `effectiveToolTags`. */
const EFFECTIVE_TAGS = `CASE
  WHEN coalesce(t.index_tags_json, '') NOT IN ('', '[]') THEN t.index_tags_json
  ELSE coalesce(t.tags_json, '[]') || ' ' || coalesce(s.tags_json, '[]')
END`;

/** `search_tools` text port; sync because the catalog reads are sync SQLite calls. */
export type ToolTextSearch = (
  input: SearchToolsInput,
  visibility?: ToolVisibility,
) => SearchToolItem[];

interface Candidate {
  row: Record<string, unknown>;
  /** BM25 of the FTS hit; `Infinity` for LIKE-only rows so FTS ranks first on ties. */
  bm25: number;
}

function clampMax(max: number | undefined): number {
  if (max === undefined || !Number.isFinite(max)) return SEARCH_DEFAULT_MAX;
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(max)));
}

/** Rebuilds the snapshot's `CatalogTool` shape from one joined row. */
function toCatalogTool(row: Record<string, unknown>): CatalogTool {
  const serverId = readTextColumn(row, 'server_id');
  const toolName = readTextColumn(row, 'name');
  const builtin = readTextColumn(row, 'transport') === 'builtin';
  const tool: CatalogTool = {
    name: builtin ? toolName : `${serverId}.${toolName}`,
    kind: builtin ? 'builtin' : 'mcp',
    description: effectiveToolDescription(row),
    tags: effectiveToolTags(row),
    inputSchema: {},
    concurrency: 'parallel',
    enabled: true,
  };
  if (!builtin) tool.server = serverId;
  const category = readTextColumn(row, 'server_category');
  if (category !== '') tool.category = category;
  const summary = readTextColumn(row, 'server_summary');
  if (summary !== '') tool.summary = summary;
  return tool;
}

/**
 * Creates the SQLite-backed text search used by `search_tools` for non-empty
 * queries. FTS5 gives token-prefix relevance and BM25; LIKE keeps the snapshot's
 * literal substring recall (special characters, Chinese mid-token matches).
 */
export function createToolTextSearch(options: { db: DatabaseSync }): ToolTextSearch {
  const { db } = options;

  return (input, visibility = {}) => {
    const query = (input.query ?? '').trim();
    if (query === '') return [];

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    const likeTerms = terms.filter((term) => term.length <= MAX_LIKE_TERM_LENGTH);
    const candidates = new Map<string, Candidate>();
    const addRow = (row: Record<string, unknown>, bm25: number): void => {
      const key = `${readTextColumn(row, 'server_id')}\u0000${readTextColumn(row, 'name')}`;
      if (!candidates.has(key)) candidates.set(key, { row, bm25 });
    };

    const match = buildFtsMatch(tokenizeFts(query, MAX_FTS_TERMS), 'OR');
    if (match !== null) {
      const rows = db
        .prepare(
          `${SELECT_TOOL_COLUMNS}, ${bm25Expression('tools_fts', BM25_WEIGHTS)} AS bm25
           FROM tools_fts
           JOIN tools t ON t.rowid = tools_fts.rowid
           JOIN servers s ON s.id = t.server_id
           WHERE ${BASE_WHERE}
             AND tools_fts MATCH ?`,
        )
        .all(
          BUILTIN_SERVER_ID,
          `{name index_description index_tags_json} : (${match})`,
        ) as Record<string, unknown>[];
      for (const row of rows) addRow(row, readNumberColumn(row, 'bm25'));
    }

    // shortcut: FTS5 tokenizes whole tokens, so Chinese mid-token and literal
    // punctuation needs (`sql_`, `100%`, `owner's`) still run the snapshot's
    // LIKE scan every call; drop LIKE once FTS tokenization covers substrings.
    for (let start = 0; start < likeTerms.length; start += LIKE_TERMS_PER_BATCH) {
      const conditions: string[] = [];
      const params: string[] = [];
      for (const term of likeTerms.slice(start, start + LIKE_TERMS_PER_BATCH)) {
        const pattern = likeContainsPattern(term);
        // The exact-name branches keep pure-punctuation tools reachable: FTS has
        // no token for a name like `+++`, so `srv.+++` only matches here.
        conditions.push(
          `(lower(coalesce(t.name, '')) LIKE ? ESCAPE '\\'
            OR lower(${EFFECTIVE_DESCRIPTION}) LIKE ? ESCAPE '\\'
            OR lower(${EFFECTIVE_TAGS}) LIKE ? ESCAPE '\\'
            OR lower(t.name) = ?
            OR lower(t.server_id || '.' || t.name) = ?)`,
        );
        params.push(pattern, pattern, pattern, term, term);
      }
      const rows = db
        .prepare(
          `${SELECT_TOOL_COLUMNS}
           FROM tools t
           JOIN servers s ON s.id = t.server_id
           WHERE ${BASE_WHERE}
             AND (${conditions.join(' OR ')})`,
        )
        .all(BUILTIN_SERVER_ID, ...params) as Record<string, unknown>[];
      for (const row of rows) addRow(row, Number.POSITIVE_INFINITY);
    }

    const entries: Array<{
      item: SearchToolItem;
      name: string;
      score: number;
      bm25: number;
    }> = [];
    for (const { row, bm25 } of candidates.values()) {
      const tool = toCatalogTool(row);
      if (!isToolVisible(tool, visibility) || !matchesFilters(tool, input)) continue;
      const name = canonicalToolName(tool);
      const score = scoreTool(tool, name, terms);
      // Zero means no literal substring match; the snapshot drops those too.
      if (score <= 0) continue;
      entries.push({ item: toItem(tool, name), name, score, bm25 });
    }

    // No separate exact-name tier: scoreTool already grants +10 for an exact
    // canonical/bare name, so the ordering stays consistent with the snapshot's
    // scoring (and max truncation no longer prefers a lower-scored exact hit).
    entries.sort(
      (left, right) =>
        right.score - left.score
        || (left.bm25 === right.bm25 ? 0 : left.bm25 < right.bm25 ? -1 : 1)
        || compareNames(left.name, right.name),
    );
    return entries.slice(0, clampMax(input.max)).map((entry) => entry.item);
  };
}
