/** Script archive and library repositories (design 10 §5). @module */
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { withTransaction } from './migrate.ts';
import {
  DbValidationError,
  isoNow,
  jsonText,
  readFlag,
  readJsonValue,
  readNumber,
  readStringArray,
  readText,
  requireText,
} from './schema.ts';
import type { DbRow } from './schema.ts';

export type EntryMode = 'code' | 'script';
export type ScriptRunPurpose = 'run' | 'test';
export type ScriptStatus = 'draft' | 'active' | 'disabled' | 'archived';
export type VersionMode = 'exact' | 'parameterized';
export type VersionStatus = 'draft' | 'active' | 'superseded' | 'archived';

export const SCRIPT_WORKSPACE_DEFAULT = 'default';

/** Normalizes an omitted workspace to the default namespace (design 10 §8). */
export function normalizeWorkspace(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  return text === '' ? SCRIPT_WORKSPACE_DEFAULT : text;
}

/** Crockford base32, 10 timestamp chars + 16 random chars (ULID shape). */
export function newScriptId(now = Date.now(), random: (size: number) => Buffer = randomBytes): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = '';
  let remaining = now;
  for (let index = 0; index < 10; index += 1) {
    time = alphabet[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = random(16);
  let suffix = '';
  for (let index = 0; index < 16; index += 1) {
    suffix += alphabet[(bytes[index] ?? 0) % 32];
  }
  return `s_${time}${suffix}`;
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// script_runs
// ---------------------------------------------------------------------------

export interface ScriptRunInput {
  runId: string;
  createdAt: string;
  expiresAt: string;
  execId: string | null;
  evalId: number | null;
  requestId: string | null;
  binding: string | null;
  clientName: string;
  clientVersion: string;
  workspace: string;
  entryTool: string;
  entryMode: EntryMode;
  scriptId: string | null;
  scriptVersion: number | null;
  scriptMode: VersionMode | null;
  args: Record<string, unknown> | null;
  argsPreview: string | null;
  code: string | null;
  ok: boolean;
  error: string | null;
  resultBytes: number | null;
  durationMs: number | null;
  toolsUsed: string[];
  purpose: ScriptRunPurpose;
}

export interface ScriptRunRecord extends ScriptRunInput {
  codeBytes: number | null;
  codeSha256: string | null;
}

export function insertScriptRun(db: DatabaseSync, input: ScriptRunInput): void {
  const code = input.code;
  db.prepare(`
    INSERT INTO script_runs (
      run_id, created_at, expires_at, exec_id, eval_id, request_id, binding,
      client_name, client_version, workspace, entry_tool, entry_mode,
      script_id, script_version, script_mode, args_json, args_preview, code, code_bytes, code_sha256,
      ok, error, result_bytes, duration_ms, tools_used_json, purpose
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.createdAt,
    input.expiresAt,
    input.execId,
    input.evalId,
    input.requestId,
    input.binding,
    input.clientName,
    input.clientVersion,
    input.workspace,
    input.entryTool,
    input.entryMode,
    input.scriptId,
    input.scriptVersion,
    input.scriptMode,
    input.args === null ? null : jsonText(input.args),
    input.argsPreview,
    code,
    code === null ? null : Buffer.byteLength(code, 'utf8'),
    code === null ? null : hashCode(code),
    input.ok ? 1 : 0,
    input.error,
    input.resultBytes,
    input.durationMs,
    jsonText(input.toolsUsed),
    input.purpose,
  );
}

function toScriptRun(row: DbRow): ScriptRunRecord {
  return {
    runId: requireText(row, 'run_id'),
    createdAt: requireText(row, 'created_at'),
    expiresAt: requireText(row, 'expires_at'),
    execId: readText(row, 'exec_id'),
    evalId: readNumberOrNull(row, 'eval_id'),
    requestId: readText(row, 'request_id'),
    binding: readText(row, 'binding'),
    clientName: readText(row, 'client_name') ?? '',
    clientVersion: readText(row, 'client_version') ?? '',
    workspace: requireText(row, 'workspace'),
    entryTool: requireText(row, 'entry_tool'),
    entryMode: requireText(row, 'entry_mode') as EntryMode,
    scriptId: readText(row, 'script_id'),
    scriptVersion: readNumberOrNull(row, 'script_version'),
    scriptMode: readText(row, 'script_mode') as VersionMode | null,
    args: readJsonObjectOrNull(row, 'args_json'),
    argsPreview: readText(row, 'args_preview'),
    code: readText(row, 'code'),
    codeBytes: readNumberOrNull(row, 'code_bytes'),
    codeSha256: readText(row, 'code_sha256'),
    ok: readFlag(row, 'ok'),
    error: readText(row, 'error'),
    resultBytes: readNumberOrNull(row, 'result_bytes'),
    durationMs: readNumberOrNull(row, 'duration_ms'),
    toolsUsed: readStringArray(row, 'tools_used_json'),
    purpose: requireText(row, 'purpose') as ScriptRunPurpose,
  };
}

function readNumberOrNull(row: DbRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return readNumber(row, column);
}

function readJsonObjectOrNull(row: DbRow, column: string): Record<string, unknown> | null {
  const value = readJsonValue(row, column);
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DbValidationError(`column ${column} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function getScriptRun(db: DatabaseSync, runId: string): ScriptRunRecord | null {
  const row = db.prepare('SELECT * FROM script_runs WHERE run_id = ?').get(runId);
  return row ? toScriptRun(row) : null;
}

/** Deletes archive rows past `now`; returns the removed count. */
export function pruneScriptRuns(db: DatabaseSync, now: string = isoNow()): number {
  const result = db.prepare('DELETE FROM script_runs WHERE expires_at < ?').run(now);
  return Number(result.changes);
}

export interface ScriptRunListQuery {
  scriptId: string;
  limit: number;
  cursor?: { createdAt: string; runId: string } | null;
}

export function listScriptRuns(
  db: DatabaseSync,
  query: ScriptRunListQuery,
): { items: ScriptRunRecord[]; next: { createdAt: string; runId: string } | null } {
  const where: string[] = ['script_id = ?'];
  const params: Array<string | number | null> = [query.scriptId];
  if (query.cursor !== undefined && query.cursor !== null) {
    where.push('(created_at < ? OR (created_at = ? AND run_id < ?))');
    params.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.runId);
  }
  params.push(query.limit + 1);
  const rows = db
    .prepare(
      `SELECT * FROM script_runs WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, run_id DESC LIMIT ?`,
    )
    .all(...params)
    .map((row) => toScriptRun(row as DbRow));
  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  const next =
    rows.length > query.limit && last !== undefined
      ? { createdAt: last.createdAt, runId: last.runId }
      : null;
  return { items, next };
}

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

export interface ScriptRecord {
  scriptId: string;
  name: string;
  description: string;
  tags: string[];
  mode: VersionMode;
  activeVersion: number | null;
  status: ScriptStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  sourceRunId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  /** `script_runs` aggregate for this script; 0 when the columns were not selected. */
  runCount: number;
  successCount: number;
  /** `successCount / runCount` as 0..1, rounded to 4 decimals; 0 without runs. */
  successRate: number;
}

function toScript(row: DbRow): ScriptRecord {
  const runCount = readNumberOrNull(row, 'run_count') ?? 0;
  const successCount = readNumberOrNull(row, 'success_count') ?? 0;
  return {
    scriptId: requireText(row, 'script_id'),
    name: requireText(row, 'name'),
    description: requireText(row, 'description'),
    tags: readStringArray(row, 'tags_json'),
    mode: requireText(row, 'mode') as VersionMode,
    activeVersion: readNumberOrNull(row, 'active_version'),
    status: requireText(row, 'status') as ScriptStatus,
    createdBy: readText(row, 'created_by') ?? '',
    createdAt: requireText(row, 'created_at'),
    updatedAt: requireText(row, 'updated_at'),
    sourceRunId: readText(row, 'source_run_id'),
    useCount: readNumber(row, 'use_count'),
    lastUsedAt: readText(row, 'last_used_at'),
    runCount,
    successCount,
    successRate: runCount === 0 ? 0 : Math.round((successCount / runCount) * 10_000) / 10_000,
  };
}

/** Script columns plus the run aggregates the admin list/detail show. */
const SCRIPT_WITH_STATS = `
  SELECT s.*,
    (SELECT COUNT(*) FROM script_runs r WHERE r.script_id = s.script_id) AS run_count,
    (SELECT COUNT(*) FROM script_runs r WHERE r.script_id = s.script_id AND r.ok = 1) AS success_count
  FROM scripts s`;

export interface NewScript {
  scriptId: string;
  name: string;
  description: string;
  tags: string[];
  mode: VersionMode;
  createdBy: string;
  sourceRunId: string | null;
  now?: string;
}

export function insertScript(db: DatabaseSync, script: NewScript): void {
  const now = script.now ?? isoNow();
  db.prepare(`
    INSERT INTO scripts (
      script_id, name, description, tags_json, mode, active_version,
      status, created_by, created_at, updated_at, source_run_id
    ) VALUES (?, ?, ?, ?, ?, NULL, 'draft', ?, ?, ?, ?)
  `).run(
    script.scriptId,
    script.name,
    script.description,
    jsonText(script.tags),
    script.mode,
    script.createdBy,
    now,
    now,
    script.sourceRunId,
  );
}

export function getScript(db: DatabaseSync, scriptId: string): ScriptRecord | null {
  const row = db.prepare('SELECT * FROM scripts WHERE script_id = ?').get(scriptId);
  return row ? toScript(row as DbRow) : null;
}

/** Admin detail: same row plus the run aggregates the list also carries. */
export function getScriptWithStats(db: DatabaseSync, scriptId: string): ScriptRecord | null {
  const row = db.prepare(`${SCRIPT_WITH_STATS} WHERE s.script_id = ?`).get(scriptId);
  return row ? toScript(row as DbRow) : null;
}

/** Script names are global: one namespace for every workspace (design change 2026-11-24). */
export function findScriptByName(db: DatabaseSync, name: string): ScriptRecord | null {
  const row = db.prepare('SELECT * FROM scripts WHERE name = ?').get(name);
  return row ? toScript(row as DbRow) : null;
}

export interface ScriptListQuery {
  status?: ScriptStatus;
  query?: string;
  limit: number;
  cursor?: { updatedAt: string; scriptId: string } | null;
}

export function listScripts(
  db: DatabaseSync,
  query: ScriptListQuery,
): { items: ScriptRecord[]; next: { updatedAt: string; scriptId: string } | null } {
  const where: string[] = [];
  const params: Array<string | number | null> = [];
  if (query.status !== undefined) {
    where.push('s.status = ?');
    params.push(query.status);
  }
  if (query.query !== undefined && query.query !== '') {
    where.push('(s.name LIKE ? OR s.description LIKE ? OR s.tags_json LIKE ?)');
    const like = `%${query.query}%`;
    params.push(like, like, like);
  }
  if (query.cursor !== undefined && query.cursor !== null) {
    where.push('(s.updated_at < ? OR (s.updated_at = ? AND s.script_id < ?))');
    params.push(query.cursor.updatedAt, query.cursor.updatedAt, query.cursor.scriptId);
  }
  params.push(query.limit + 1);
  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const rows = db
    .prepare(
      `${SCRIPT_WITH_STATS} ${clause} ORDER BY s.updated_at DESC, s.script_id DESC LIMIT ?`,
    )
    .all(...params)
    .map((row) => toScript(row as DbRow));
  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  const next =
    rows.length > query.limit && last !== undefined
      ? { updatedAt: last.updatedAt, scriptId: last.scriptId }
      : null;
  return { items, next };
}

export interface ScriptPatch {
  name?: string;
  description?: string;
  tags?: string[];
  status?: ScriptStatus;
}

export function touchScriptUsage(db: DatabaseSync, scriptId: string, now = isoNow()): void {
  db.prepare(
    'UPDATE scripts SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE script_id = ?',
  ).run(now, now, scriptId);
}

export function updateScriptMeta(
  db: DatabaseSync,
  scriptId: string,
  patch: ScriptPatch,
): ScriptRecord | null {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description);
  }
  if (patch.tags !== undefined) {
    sets.push('tags_json = ?');
    params.push(jsonText(patch.tags));
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (sets.length === 0) return getScript(db, scriptId);
  sets.push('updated_at = ?');
  params.push(isoNow());
  params.push(scriptId);
  db.prepare(`UPDATE scripts SET ${sets.join(', ')} WHERE script_id = ?`).run(...params);
  return getScript(db, scriptId);
}

// ---------------------------------------------------------------------------
// script_versions
// ---------------------------------------------------------------------------

export interface ScriptVersionRecord {
  scriptId: string;
  version: number;
  mode: VersionMode;
  code: string;
  codeBytes: number;
  codeSha256: string;
  inputSchema: Record<string, unknown>;
  exampleArgs: Record<string, unknown> | null;
  status: VersionStatus;
  changelog: string | null;
  createdBy: string;
  createdAt: string;
  sourceRunId: string | null;
  verifiedRunId: string | null;
  activatedAt: string | null;
}

function toVersion(row: DbRow): ScriptVersionRecord {
  return {
    scriptId: requireText(row, 'script_id'),
    version: readNumber(row, 'version'),
    mode: requireText(row, 'mode') as VersionMode,
    code: requireText(row, 'code'),
    codeBytes: readNumber(row, 'code_bytes'),
    codeSha256: requireText(row, 'code_sha256'),
    inputSchema: readJsonObjectOrNull(row, 'input_schema_json') ?? {},
    exampleArgs: readJsonObjectOrNull(row, 'example_args_json'),
    status: requireText(row, 'status') as VersionStatus,
    changelog: readText(row, 'changelog'),
    createdBy: readText(row, 'created_by') ?? '',
    createdAt: requireText(row, 'created_at'),
    sourceRunId: readText(row, 'source_run_id'),
    verifiedRunId: readText(row, 'verified_run_id'),
    activatedAt: readText(row, 'activated_at'),
  };
}

export interface NewScriptVersion {
  mode: VersionMode;
  code: string;
  inputSchema: Record<string, unknown>;
  exampleArgs: Record<string, unknown> | null;
  changelog: string | null;
  createdBy: string;
  sourceRunId: string | null;
  /** Successful run that proved this exact code; set for exact and tested versions. */
  verifiedRunId?: string | null;
  now?: string;
}

/** Appends the next version and returns it; callers wrap this in a transaction. */
export function insertScriptVersion(
  db: DatabaseSync,
  scriptId: string,
  version: NewScriptVersion,
): ScriptVersionRecord {
  const latest = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM script_versions WHERE script_id = ?')
    .get(scriptId);
  const next = Number(latest?.['version'] ?? 0) + 1;
  const now = version.now ?? isoNow();
  db.prepare(`
    INSERT INTO script_versions (
      script_id, version, mode, code, code_bytes, code_sha256,
      input_schema_json, example_args_json, status, changelog,
      created_by, created_at, source_run_id, verified_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
  `).run(
    scriptId,
    next,
    version.mode,
    version.code,
    Buffer.byteLength(version.code, 'utf8'),
    hashCode(version.code),
    jsonText(version.inputSchema),
    version.exampleArgs === null ? null : jsonText(version.exampleArgs),
    version.changelog,
    version.createdBy,
    now,
    version.sourceRunId,
    version.verifiedRunId ?? null,
  );
  db.prepare('UPDATE scripts SET updated_at = ? WHERE script_id = ?').run(now, scriptId);
  const row = db
    .prepare('SELECT * FROM script_versions WHERE script_id = ? AND version = ?')
    .get(scriptId, next);
  if (!row) throw new DbValidationError(`script version ${scriptId}/${next} was not inserted`);
  return toVersion(row as DbRow);
}

export function getScriptVersion(
  db: DatabaseSync,
  scriptId: string,
  version: number,
): ScriptVersionRecord | null {
  const row = db
    .prepare('SELECT * FROM script_versions WHERE script_id = ? AND version = ?')
    .get(scriptId, version);
  return row ? toVersion(row as DbRow) : null;
}

export function latestScriptVersion(db: DatabaseSync, scriptId: string): ScriptVersionRecord | null {
  const row = db
    .prepare('SELECT * FROM script_versions WHERE script_id = ? ORDER BY version DESC LIMIT 1')
    .get(scriptId);
  return row ? toVersion(row as DbRow) : null;
}

export function listScriptVersions(db: DatabaseSync, scriptId: string): ScriptVersionRecord[] {
  return db
    .prepare('SELECT * FROM script_versions WHERE script_id = ? ORDER BY version ASC')
    .all(scriptId)
    .map((row) => toVersion(row as DbRow));
}

/**
 * Makes `version` the active one inside the caller's transaction: the previous
 * active becomes `superseded`, the target `active`, and the script's pointer and
 * status follow. A missing target is left to the caller to detect first.
 */
export function activateScriptVersion(
  db: DatabaseSync,
  scriptId: string,
  version: number,
  verifiedRunId: string | null,
  now = isoNow(),
): void {
  db.prepare(
    "UPDATE script_versions SET status = 'superseded' WHERE script_id = ? AND status = 'active' AND version <> ?",
  ).run(scriptId, version);
  db.prepare(`
    UPDATE script_versions
    SET status = 'active',
        activated_at = ?,
        verified_run_id = COALESCE(?, verified_run_id)
    WHERE script_id = ? AND version = ?
  `).run(now, verifiedRunId, scriptId, version);
  db.prepare(`
    UPDATE scripts
    SET active_version = ?, status = 'active', updated_at = ?
    WHERE script_id = ?
  `).run(version, now, scriptId);
}

/** Transactional create: script row plus its version 1, active or draft. */
export function createScriptWithVersion(
  db: DatabaseSync,
  script: NewScript,
  version: NewScriptVersion,
  activate: boolean,
): { script: ScriptRecord; version: ScriptVersionRecord } {
  return withTransaction(db, () => {
    insertScript(db, script);
    const inserted = insertScriptVersion(db, script.scriptId, version);
    if (activate) {
      activateScriptVersion(
        db,
        script.scriptId,
        inserted.version,
        version.verifiedRunId ?? version.sourceRunId,
        version.now,
      );
    }
    const record = getScript(db, script.scriptId);
    const stored = getScriptVersion(db, script.scriptId, inserted.version);
    if (record === null || stored === null) {
      throw new DbValidationError(`script ${script.scriptId} disappeared during creation`);
    }
    return { script: record, version: stored };
  });
}
