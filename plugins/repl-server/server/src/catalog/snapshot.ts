/** Immutable catalog snapshots and revision bookkeeping over SQLite. @module */
import type { DatabaseSync } from 'node:sqlite';

import { bumpRevision, getRevision } from '../db/meta.ts';
import { BUILTIN_SERVER_ID } from '../db/servers.ts';
import type { CatalogSnapshot, CatalogTool } from '../ports.ts';

const CONCURRENCY_VALUES = new Set<CatalogTool['concurrency']>([
  'parallel',
  'serial',
  'exclusive',
]);

const SELECT_CATALOG_ROWS = `
SELECT
  t.server_id AS server_id,
  t.name AS name,
  t.description AS description,
  t.description_override AS description_override,
  t.index_description AS index_description,
  t.index_tags_json AS index_tags_json,
  t.tags_json AS tool_tags_json,
  t.schema_json AS schema_json,
  t.concurrency AS concurrency,
  t.enabled AS tool_enabled,
  s.enabled AS server_enabled,
  s.transport AS transport,
  s.category AS server_category,
  s.summary AS server_summary,
  s.tags_json AS server_tags_json
FROM tools t
JOIN servers s ON s.id = t.server_id
WHERE NOT (t.stale = 1 AND t.stale_override = 0)
  AND s.id <> ?
ORDER BY t.server_id, t.name`;

/** Reads a text column from a `node:sqlite` row. @module */
export function readTextColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

/** Reads an integer column from a `node:sqlite` row. @module */
export function readNumberColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Parses a JSON string-array column, dropping non-string and duplicate entries. @module */
export function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const value = entry.trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Effective description used by search and snapshots: override, then upstream. @module */
export function effectiveToolDescription(row: Record<string, unknown>): string {
  const indexed = readTextColumn(row, 'index_description');
  if (indexed !== '') return indexed;
  const overrideValue = row.description_override;
  const override = typeof overrideValue === 'string' ? overrideValue : null;
  if (override !== null) return override;
  return readTextColumn(row, 'description');
}

/** Effective tags used by search and snapshots: the server/tool union. @module */
export function effectiveToolTags(row: Record<string, unknown>): string[] {
  const indexed = parseStringArray(readTextColumn(row, 'index_tags_json'));
  if (indexed.length > 0) return indexed;
  // The index columns are the source of truth; the union is a safety net for a
  // row written without refreshFts (for example during a partial migration).
  const merged = new Set<string>([
    ...parseStringArray(readTextColumn(row, 'server_tags_json')),
    ...parseStringArray(readTextColumn(row, 'tool_tags_json')),
  ]);
  return [...merged];
}

function readConcurrency(raw: unknown): CatalogTool['concurrency'] {
  return typeof raw === 'string' && CONCURRENCY_VALUES.has(raw as CatalogTool['concurrency'])
    ? (raw as CatalogTool['concurrency'])
    : 'parallel';
}

function parseInputSchema(raw: string, serverId: string, toolName: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `catalog: tools.${serverId}.${toolName} has invalid schema_json`,
      { cause: error },
    );
  }
}

/** Reads `meta.revision`, the global catalog revision. Missing means 0. @module */
export function readCatalogRevision(db: DatabaseSync): number {
  return getRevision(db);
}

/** Increments `meta.revision` and returns the new value. @module */
export function bumpCatalogRevision(db: DatabaseSync): number {
  return bumpRevision(db);
}

/**
 * Builds a frozen snapshot of the execution-facing catalog.
 *
 * Builtin servers (`transport = 'builtin'`) are exposed under their bare tool
 * name, matching `tools.Read` in scripts; MCP tools use `<server>.<tool>`.
 * `__builtin__` is the exception: it holds admin-visible definitions only until
 * composite tools get a script executor, so its rows stay out of the execution
 * surface. Stale rows that the administrator did not explicitly keep are
 * excluded.
 * @module
 */
export function buildCatalogSnapshot(
  db: DatabaseSync,
  revision: number = readCatalogRevision(db),
): CatalogSnapshot {
  const rows = db.prepare(SELECT_CATALOG_ROWS).all(BUILTIN_SERVER_ID);
  const tools: CatalogTool[] = [];

  for (const rawRow of rows) {
    const row = rawRow as Record<string, unknown>;
    const serverId = readTextColumn(row, 'server_id');
    const toolName = readTextColumn(row, 'name');
    const builtin = readTextColumn(row, 'transport') === 'builtin';
    // Frozen at runtime; CatalogTool declares a mutable array.
    const tags = Object.freeze(effectiveToolTags(row)) as string[];
    const tool: CatalogTool = {
      name: builtin ? toolName : `${serverId}.${toolName}`,
      kind: builtin ? 'builtin' : 'mcp',
      description: effectiveToolDescription(row),
      tags,
      inputSchema: parseInputSchema(
        readTextColumn(row, 'schema_json'),
        serverId,
        toolName,
      ),
      concurrency: readConcurrency(row.concurrency),
      enabled:
        readNumberColumn(row, 'tool_enabled') === 1
        && readNumberColumn(row, 'server_enabled') === 1,
    };
    if (!builtin) tool.server = serverId;
    // Category and summary live on the server row; builtins inherit them too.
    const category = readTextColumn(row, 'server_category');
    if (category !== '') tool.category = category;
    const summary = readTextColumn(row, 'server_summary');
    if (summary !== '') tool.summary = summary;
    tools.push(Object.freeze(tool));
  }

  return Object.freeze({ revision, tools: Object.freeze(tools) });
}
