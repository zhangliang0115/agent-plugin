/** Tool metadata repository and the derived `index_*` columns read by FTS. @module */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { withTransaction } from './migrate.ts';
import { bumpRevision, getRevision } from './meta.ts';
import {
  DbNotFoundError,
  DbValidationError,
  isoNow,
  jsonText,
  readFlag,
  readJsonValue,
  readStringArray,
  readText,
  requireText,
} from './schema.ts';
import type { DbRow } from './schema.ts';

export type ToolConcurrency = 'parallel' | 'serial' | 'exclusive';

/** Where a catalog row came from: upstream `tools/list` or a discovery scan. */
export type ToolDiscoverySource = 'static' | 'search';

export interface ToolRecord {
  serverId: string;
  name: string;
  displayName: string | null;
  description: string | null;
  descriptionOverride: string | null;
  enabled: boolean;
  concurrency: ToolConcurrency;
  type: string | null;
  tags: string[];
  indexDescription: string;
  indexSummary: string;
  indexTags: string[];
  inputSchema: unknown;
  schemaHash: string;
  category: string | null;
  compositeCode: string | null;
  discoveredVia: ToolDiscoverySource;
  stale: boolean;
  staleOverride: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** One tool as reported by an upstream `tools/list`. Admin edits are preserved. */
export interface ToolUpsert {
  name: string;
  displayName?: string | null;
  description?: string | null;
  inputSchema: unknown;
  schemaHash?: string;
  type?: string | null;
  tags?: string[];
  category?: string | null;
  /** Source for a new row; defaults to `static`. Existing rows keep their source. */
  discoveredVia?: ToolDiscoverySource;
  /** Rewrite an existing `static` row's source to `search`. Default false. */
  overwriteStatic?: boolean;
}

/** Admin edits. `description` is stored in `description_override`. */
export interface ToolPatch {
  displayName?: string | null;
  description?: string | null;
  enabled?: boolean;
  concurrency?: ToolConcurrency;
  type?: string | null;
  tags?: string[];
  category?: string | null;
  compositeCode?: string | null;
  staleOverride?: boolean;
}

export interface ToolWriteResult {
  tool: ToolRecord;
  revision: number;
}

export function listTools(db: DatabaseSync, serverId: string): ToolRecord[] {
  const rows = db.prepare('SELECT * FROM tools WHERE server_id = ? ORDER BY name').all(serverId);
  return rows.map(toTool);
}

/** Stored tool counts per server; used by the admin server list. */
export interface ServerToolCounts {
  total: number;
  enabled: number;
}

export function countToolsByServer(db: DatabaseSync): Map<string, ServerToolCounts> {
  const rows = db
    .prepare(
      'SELECT server_id, COUNT(*) AS total, SUM(enabled) AS enabled FROM tools GROUP BY server_id',
    )
    .all();
  const counts = new Map<string, ServerToolCounts>();
  for (const rawRow of rows) {
    const row = rawRow as Record<string, unknown>;
    const serverId = readText(row, 'server_id');
    if (serverId === null) continue;
    counts.set(serverId, {
      total: Number(row['total'] ?? 0),
      enabled: Number(row['enabled'] ?? 0),
    });
  }
  return counts;
}

export function getTool(db: DatabaseSync, serverId: string, name: string): ToolRecord | null {
  const row = db.prepare('SELECT * FROM tools WHERE server_id = ? AND name = ?').get(serverId, name);
  return row ? toTool(row) : null;
}

export function hashToolSchema(inputSchema: unknown): string {
  return createHash('sha256').update(jsonText(inputSchema ?? {})).digest('hex');
}

/**
 * Inserts a tool on first sight, then refreshes the upstream columns on later
 * calls. `enabled`, `concurrency`, `tags`, `type`, `category`, `composite_code`
 * and `description_override` are admin state and are never overwritten here.
 */
export function upsertTool(
  db: DatabaseSync,
  serverId: string,
  input: ToolUpsert,
): ToolWriteResult {
  const name = requireToolName(input.name);
  const schemaJson = jsonText(input.inputSchema ?? {});
  const schemaHash = input.schemaHash ?? hashToolSchema(input.inputSchema);
  const discoveredVia = requireDiscoverySource(input.discoveredVia ?? 'static');
  return withTransaction(db, () => {
    assertServerExists(db, serverId);
    const now = isoNow();
    const existing = getTool(db, serverId, name);
    if (existing) {
      const nextSource =
        existing.discoveredVia === 'static' && input.overwriteStatic === true
          ? 'search'
          : existing.discoveredVia;
      db.prepare(`
        UPDATE tools
        SET display_name = ?, description = ?, schema_json = ?, schema_hash = ?,
            discovered_via = ?, stale = 0, last_seen_at = ?
        WHERE server_id = ? AND name = ?
      `).run(
        input.displayName ?? null,
        input.description ?? null,
        schemaJson,
        schemaHash,
        nextSource,
        now,
        serverId,
        name,
      );
    } else {
      db.prepare(`
        INSERT INTO tools (
          server_id, name, display_name, description, description_override,
          enabled, concurrency, type, tags_json,
          index_description, index_summary, index_tags_json,
          schema_json, schema_hash, category, composite_code,
          discovered_via, stale, stale_override, first_seen_at, last_seen_at
        ) VALUES (
          ?, ?, ?, ?, NULL,
          1, 'parallel', ?, ?,
          '', '', '[]',
          ?, ?, ?, NULL,
          ?, 0, 0, ?, ?
        )
      `).run(
        serverId,
        name,
        input.displayName ?? null,
        input.description ?? null,
        input.type ?? null,
        jsonText(input.tags ?? []),
        schemaJson,
        schemaHash,
        input.category ?? null,
        discoveredVia,
        now,
        now,
      );
    }
    refreshServerIndex(db, serverId, name);
    const revision = bumpRevision(db);
    return { tool: mustGetTool(db, serverId, name), revision };
  });
}

export type SeedToolOutcome = 'inserted' | 'filled' | 'unchanged';

/**
 * Inserts a fixed tool row on first sight. On later runs with `refresh` it
 * rewrites the upstream columns when the definition changed; otherwise it only
 * fills upstream columns that are still empty (`description`, an empty
 * `schema_json`). Admin state (`enabled`, `concurrency`, `tags`, `type`,
 * `category`, `description_override`, `composite_code`, `stale*`) is never
 * touched. Runs in the caller's transaction and does not bump the revision.
 */
export function seedTool(
  db: DatabaseSync,
  serverId: string,
  input: { name: string; description?: string | null; inputSchema: unknown },
  options: { refresh?: boolean } = {},
): SeedToolOutcome {
  const name = requireToolName(input.name);
  const schemaJson = jsonText(input.inputSchema ?? {});
  const schemaHash = hashToolSchema(input.inputSchema);
  const now = isoNow();
  assertServerExists(db, serverId);
  const existing = getTool(db, serverId, name);
  if (existing === null) {
    db.prepare(`
      INSERT INTO tools (
        server_id, name, display_name, description, description_override,
        enabled, concurrency, type, tags_json,
        index_description, index_summary, index_tags_json,
        schema_json, schema_hash, category, composite_code,
        discovered_via, stale, stale_override, first_seen_at, last_seen_at
      ) VALUES (
        ?, ?, NULL, ?, NULL,
        1, 'parallel', NULL, '[]',
        '', '', '[]',
        ?, ?, NULL, NULL,
        'static', 0, 0, ?, ?
      )
    `).run(serverId, name, input.description ?? null, schemaJson, schemaHash, now, now);
    return 'inserted';
  }

  if (options.refresh === true) {
    const description = input.description ?? null;
    if (existing.description === description && existing.schemaHash === schemaHash) {
      db.prepare('UPDATE tools SET last_seen_at = ? WHERE server_id = ? AND name = ?')
        .run(now, serverId, name);
      return 'unchanged';
    }
    db.prepare(`
      UPDATE tools
      SET description = ?, schema_json = ?, schema_hash = ?, last_seen_at = ?
      WHERE server_id = ? AND name = ?
    `).run(description, schemaJson, schemaHash, now, serverId, name);
    return 'filled';
  }

  const fillDescription = (existing.description ?? '').trim() === '';
  const fillSchema = isEmptyJsonObject(existing.inputSchema);
  if (!fillDescription && !fillSchema) {
    db.prepare('UPDATE tools SET last_seen_at = ? WHERE server_id = ? AND name = ?')
      .run(now, serverId, name);
    return 'unchanged';
  }
  db.prepare(`
    UPDATE tools
    SET description = ?, schema_json = ?, schema_hash = ?, last_seen_at = ?
    WHERE server_id = ? AND name = ?
  `).run(
    fillDescription ? input.description ?? null : existing.description,
    fillSchema ? schemaJson : jsonText(existing.inputSchema),
    fillSchema ? schemaHash : existing.schemaHash,
    now,
    serverId,
    name,
  );
  return 'filled';
}

export function patchTool(
  db: DatabaseSync,
  serverId: string,
  name: string,
  patch: ToolPatch,
): ToolWriteResult | null {
  return withTransaction(db, () => {
    const current = getTool(db, serverId, name);
    if (!current) return null;
    const next = applyToolPatch(current, patch);
    writeToolRow(db, next);
    refreshServerIndex(db, serverId, name);
    const revision = bumpRevision(db);
    return { tool: mustGetTool(db, serverId, name), revision };
  });
}

export function deleteTool(
  db: DatabaseSync,
  serverId: string,
  name: string,
): { deleted: boolean; revision: number } {
  return withTransaction(db, () => {
    const result = db.prepare('DELETE FROM tools WHERE server_id = ? AND name = ?').run(serverId, name);
    if (Number(result.changes) === 0) {
      return { deleted: false, revision: getRevision(db) };
    }
    return { deleted: true, revision: bumpRevision(db) };
  });
}

/**
 * Recomputes `index_description`, `index_summary` and `index_tags_json` for a
 * server (or a single tool) in the caller's transaction. The `tools_au`
 * trigger mirrors the new values into FTS.
 */
export function refreshServerIndex(db: DatabaseSync, serverId: string, onlyName?: string): void {
  const base = `
    SELECT t.name, t.description, t.description_override, t.tags_json,
           s.summary, s.tags_json AS server_tags_json
    FROM tools t
    JOIN servers s ON s.id = t.server_id
    WHERE t.server_id = ?
  `;
  const rows =
    onlyName === undefined
      ? db.prepare(base).all(serverId)
      : db.prepare(`${base} AND t.name = ?`).all(serverId, onlyName);
  const update = db.prepare(`
    UPDATE tools
    SET index_description = ?, index_summary = ?, index_tags_json = ?
    WHERE server_id = ? AND name = ?
  `);
  for (const row of rows) {
    const description = readText(row, 'description_override') ?? readText(row, 'description') ?? '';
    const summary = readText(row, 'summary') ?? '';
    const tags = unionTags(readStringArray(row, 'server_tags_json'), readStringArray(row, 'tags_json'));
    update.run(description, summary, jsonText(tags), serverId, requireText(row, 'name'));
  }
}

/**
 * Marks every `discovered_via = 'search'` row of one server stale (design 07
 * §3.8, mode switch back to static). Runs in the caller's transaction and is
 * idempotent: already-stale rows are left untouched. `stale_override` does
 * **not** exempt a row — it keeps search visibility, not callability.
 */
export function demoteDiscoveredTools(db: DatabaseSync, serverId: string): number {
  const result = db
    .prepare(`
      UPDATE tools
      SET stale = 1
      WHERE server_id = ? AND discovered_via = 'search' AND stale = 0
    `)
    .run(serverId);
  return Number(result.changes);
}

/**
 * Marks every row of one server stale whose name the latest upstream
 * `tools/list` did not return (design 03 §5.1: "每次 `tools/list` 刷新时，上游
 * 缺席的工具置 `stale=1`，重新出现置 0"). `upsertTool` resets `stale` on the
 * rows that were returned, so this only needs the absent ones.
 *
 * Runs in its own transaction and bumps `meta.revision` once when it changed a
 * row, matching `upsertTool`. `stale_override` is deliberately untouched: it
 * preserves search visibility, not callability. An empty `seenNames` marks the
 * whole server stale — that is the literal meaning of an empty `tools/list`,
 * and the next non-empty list restores the rows.
 */
export function markAbsentToolsStale(
  db: DatabaseSync,
  serverId: string,
  seenNames: readonly string[],
): number {
  return withTransaction(db, () => {
    const placeholders = seenNames.map(() => '?').join(', ');
    const sql = `UPDATE tools SET stale = 1 WHERE server_id = ? AND stale = 0${
      seenNames.length === 0 ? '' : ` AND name NOT IN (${placeholders})`
    }`;
    const result = db.prepare(sql).run(serverId, ...seenNames);
    const changed = Number(result.changes);
    if (changed > 0) bumpRevision(db);
    return changed;
  });
}

/** Applies admin-editable fields to an in-memory row; pure, no database access. */
export function applyToolPatch(current: ToolRecord, patch: ToolPatch): ToolRecord {
  const next: ToolRecord = { ...current };
  if (patch.displayName !== undefined) next.displayName = patch.displayName;
  if (patch.description !== undefined) next.descriptionOverride = patch.description;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.concurrency !== undefined) next.concurrency = requireConcurrency(patch.concurrency);
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.tags !== undefined) next.tags = requireTags(patch.tags);
  if (patch.category !== undefined) next.category = patch.category;
  if (patch.compositeCode !== undefined) next.compositeCode = patch.compositeCode;
  if (patch.staleOverride !== undefined) next.staleOverride = patch.staleOverride;
  return next;
}

/**
 * Writes the admin-editable columns of an existing row. Runs in the caller's
 * transaction and does not refresh indexes or bump the revision, so batch
 * callers can do both once.
 */
export function writeToolRow(db: DatabaseSync, tool: ToolRecord): void {
  const result = db.prepare(`
    UPDATE tools
    SET display_name = ?, description_override = ?, enabled = ?, concurrency = ?,
        type = ?, tags_json = ?, category = ?, composite_code = ?, stale_override = ?
    WHERE server_id = ? AND name = ?
  `).run(
    tool.displayName,
    tool.descriptionOverride,
    tool.enabled ? 1 : 0,
    tool.concurrency,
    tool.type,
    jsonText(tool.tags),
    tool.category,
    tool.compositeCode,
    tool.staleOverride ? 1 : 0,
    tool.serverId,
    tool.name,
  );
  if (Number(result.changes) === 0) {
    throw new DbNotFoundError(`tool ${tool.serverId}.${tool.name} does not exist`);
  }
}

function toTool(row: DbRow): ToolRecord {
  return {
    serverId: requireText(row, 'server_id'),
    name: requireText(row, 'name'),
    displayName: readText(row, 'display_name'),
    description: readText(row, 'description'),
    descriptionOverride: readText(row, 'description_override'),
    enabled: readFlag(row, 'enabled'),
    concurrency: requireConcurrency(requireText(row, 'concurrency')),
    type: readText(row, 'type'),
    tags: readStringArray(row, 'tags_json'),
    indexDescription: readText(row, 'index_description') ?? '',
    indexSummary: readText(row, 'index_summary') ?? '',
    indexTags: readStringArray(row, 'index_tags_json'),
    inputSchema: readJsonValue(row, 'schema_json'),
    schemaHash: requireText(row, 'schema_hash'),
    category: readText(row, 'category'),
    compositeCode: readText(row, 'composite_code'),
    discoveredVia: readDiscoverySource(row),
    stale: readFlag(row, 'stale'),
    staleOverride: readFlag(row, 'stale_override'),
    firstSeenAt: requireText(row, 'first_seen_at'),
    lastSeenAt: requireText(row, 'last_seen_at'),
  };
}

function mustGetTool(db: DatabaseSync, serverId: string, name: string): ToolRecord {
  const tool = getTool(db, serverId, name);
  if (!tool) throw new DbNotFoundError(`tool ${serverId}.${name} does not exist`);
  return tool;
}

function assertServerExists(db: DatabaseSync, serverId: string): void {
  const row = db.prepare('SELECT 1 AS present FROM servers WHERE id = ?').get(serverId);
  if (!row) throw new DbNotFoundError(`server ${serverId} does not exist`);
}

function requireToolName(value: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length === 0) throw new DbValidationError('tool name must not be empty');
  return name;
}

function requireConcurrency(value: string): ToolConcurrency {
  if (value === 'parallel' || value === 'serial' || value === 'exclusive') return value;
  throw new DbValidationError(`unknown tool concurrency: ${value}`);
}

function requireDiscoverySource(value: string): ToolDiscoverySource {
  if (value === 'static' || value === 'search') return value;
  throw new DbValidationError(`unknown tool discovery source: ${value}`);
}

/** Missing column (an unmigrated v1 schema) reads as `static`, the v1 default. */
function readDiscoverySource(row: DbRow): ToolDiscoverySource {
  const raw = readText(row, 'discovered_via');
  return raw === null ? 'static' : requireDiscoverySource(raw);
}

function requireTags(value: string[]): string[] {
  if (!Array.isArray(value)) throw new DbValidationError('tags must be an array');
  return value.map((tag) => {
    if (typeof tag !== 'string') throw new DbValidationError('tags must contain strings only');
    return tag;
  });
}

function unionTags(serverTags: string[], toolTags: string[]): string[] {
  const out: string[] = [];
  for (const tag of [...serverTags, ...toolTags]) {
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** `true` for the `{}` that a tool row gets when it was stored without a schema. */
function isEmptyJsonObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
