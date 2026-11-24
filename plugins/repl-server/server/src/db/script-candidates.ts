/** P3 script-candidate repository: review queue over successful code runs (design 10 §5.4, §10). @module */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { newScriptId } from './scripts.ts';
import {
  DbValidationError,
  isoNow,
  jsonText,
  readJsonValue,
  readNullableStringArray,
  readNumber,
  readStringArray,
  readText,
  requireText,
} from './schema.ts';
import type { DbRow } from './schema.ts';

export type ScriptCandidateStatus = 'pending' | 'accepted' | 'rejected';

export interface ScriptCandidateRecord {
  candidateId: string;
  createdAt: string;
  code: string;
  codeSha256: string;
  workspace: string;
  sourceRunIds: string[];
  suggestedName: string | null;
  suggestedDescription: string | null;
  suggestedTags: string[] | null;
  suggestedInputSchema: Record<string, unknown> | null;
  suggestedCode: string | null;
  score: number | null;
  status: ScriptCandidateStatus;
  scriptId: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
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

function toCandidate(row: DbRow): ScriptCandidateRecord {
  return {
    candidateId: requireText(row, 'candidate_id'),
    createdAt: requireText(row, 'created_at'),
    code: requireText(row, 'code'),
    codeSha256: requireText(row, 'code_sha256'),
    workspace: requireText(row, 'workspace'),
    sourceRunIds: readStringArray(row, 'source_run_ids_json'),
    suggestedName: readText(row, 'suggested_name'),
    suggestedDescription: readText(row, 'suggested_description'),
    suggestedTags: readNullableStringArray(row, 'suggested_tags_json'),
    suggestedInputSchema: readJsonObjectOrNull(row, 'suggested_input_schema_json'),
    suggestedCode: readText(row, 'suggested_code'),
    score: readNumberOrNull(row, 'score'),
    status: requireText(row, 'status') as ScriptCandidateStatus,
    scriptId: readText(row, 'script_id'),
    reviewedAt: readText(row, 'reviewed_at'),
    reviewedBy: readText(row, 'reviewed_by'),
  };
}

/** Candidate ids share the script id shape but carry a `c_` prefix. */
export function newCandidateId(now = Date.now(), random: (size: number) => Buffer = randomBytes): string {
  return `c_${newScriptId(now, random).slice(2)}`;
}

export interface NewScriptCandidate {
  code: string;
  codeSha256: string;
  workspace: string;
  sourceRunIds: string[];
  suggestedName: string | null;
  suggestedDescription: string | null;
  suggestedTags: string[] | null;
  suggestedInputSchema: Record<string, unknown> | null;
  suggestedCode: string | null;
  score: number;
}

export function insertCandidate(
  db: DatabaseSync,
  input: NewScriptCandidate,
  now: string = isoNow(),
): ScriptCandidateRecord {
  const candidateId = newCandidateId(Date.parse(now));
  db.prepare(`
    INSERT INTO script_candidates (
      candidate_id, created_at, code, code_sha256, workspace, source_run_ids_json,
      suggested_name, suggested_description, suggested_tags_json,
      suggested_input_schema_json, suggested_code, score, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    candidateId,
    now,
    input.code,
    input.codeSha256,
    input.workspace,
    jsonText(input.sourceRunIds),
    input.suggestedName,
    input.suggestedDescription,
    input.suggestedTags === null ? null : jsonText(input.suggestedTags),
    input.suggestedInputSchema === null ? null : jsonText(input.suggestedInputSchema),
    input.suggestedCode,
    input.score,
  );
  const record = getCandidate(db, candidateId);
  if (record === null) throw new DbValidationError(`candidate ${candidateId} was not inserted`);
  return record;
}

export function getCandidate(db: DatabaseSync, candidateId: string): ScriptCandidateRecord | null {
  const row = db.prepare('SELECT * FROM script_candidates WHERE candidate_id = ?').get(candidateId);
  return row ? toCandidate(row as DbRow) : null;
}

export function findPendingCandidateByCodeSha(
  db: DatabaseSync,
  codeSha256: string,
): ScriptCandidateRecord | null {
  const row = db
    .prepare(`
      SELECT * FROM script_candidates
      WHERE code_sha256 = ? AND status = 'pending'
      ORDER BY created_at DESC, candidate_id DESC LIMIT 1
    `)
    .get(codeSha256);
  return row ? toCandidate(row as DbRow) : null;
}

/** An accepted or rejected candidate for the same source must not be reopened by a scan. */
export function findReviewedCandidateByCodeSha(
  db: DatabaseSync,
  codeSha256: string,
): ScriptCandidateRecord | null {
  const row = db
    .prepare(`
      SELECT * FROM script_candidates
      WHERE code_sha256 = ? AND status IN ('accepted', 'rejected')
      ORDER BY reviewed_at DESC, candidate_id DESC LIMIT 1
    `)
    .get(codeSha256);
  return row ? toCandidate(row as DbRow) : null;
}

export interface PendingCandidatePatch {
  sourceRunIds: string[];
  suggestedName: string | null;
  suggestedDescription: string | null;
  suggestedTags: string[] | null;
  suggestedInputSchema: Record<string, unknown> | null;
  suggestedCode: string | null;
  score: number;
}

/**
 * Refreshes a pending candidate from a new scan. AI-only fields use `COALESCE`
 * so a failed AI run keeps the previously stored suggestion instead of
 * replacing it with the deterministic `null`.
 */
export function updatePendingCandidate(
  db: DatabaseSync,
  candidateId: string,
  patch: PendingCandidatePatch,
): ScriptCandidateRecord | null {
  const result = db.prepare(`
    UPDATE script_candidates SET
      source_run_ids_json = ?,
      suggested_name = ?,
      suggested_description = ?,
      suggested_tags_json = ?,
      suggested_input_schema_json = COALESCE(?, suggested_input_schema_json),
      suggested_code = COALESCE(?, suggested_code),
      score = ?
    WHERE candidate_id = ? AND status = 'pending'
  `).run(
    jsonText(patch.sourceRunIds),
    patch.suggestedName,
    patch.suggestedDescription,
    patch.suggestedTags === null ? null : jsonText(patch.suggestedTags),
    patch.suggestedInputSchema === null ? null : jsonText(patch.suggestedInputSchema),
    patch.suggestedCode,
    patch.score,
    candidateId,
  );
  return Number(result.changes) === 0 ? null : getCandidate(db, candidateId);
}

/** Returns `null` when the row is no longer pending (another reviewer won). */
export function markCandidateAccepted(
  db: DatabaseSync,
  candidateId: string,
  scriptId: string,
  reviewedBy: string,
  now: string = isoNow(),
): ScriptCandidateRecord | null {
  const result = db.prepare(`
    UPDATE script_candidates
    SET status = 'accepted', script_id = ?, reviewed_at = ?, reviewed_by = ?
    WHERE candidate_id = ? AND status = 'pending'
  `).run(scriptId, now, reviewedBy, candidateId);
  return Number(result.changes) === 0 ? null : getCandidate(db, candidateId);
}

/** Returns `null` when the row is no longer pending. */
export function markCandidateRejected(
  db: DatabaseSync,
  candidateId: string,
  reviewedBy: string,
  now: string = isoNow(),
): ScriptCandidateRecord | null {
  const result = db.prepare(`
    UPDATE script_candidates
    SET status = 'rejected', reviewed_at = ?, reviewed_by = ?
    WHERE candidate_id = ? AND status = 'pending'
  `).run(now, reviewedBy, candidateId);
  return Number(result.changes) === 0 ? null : getCandidate(db, candidateId);
}

export interface CandidateListQuery {
  status?: ScriptCandidateStatus;
  limit: number;
  cursor?: { createdAt: string; candidateId: string } | null;
}

export function listCandidates(
  db: DatabaseSync,
  query: CandidateListQuery,
): {
  items: ScriptCandidateRecord[];
  next: { createdAt: string; candidateId: string } | null;
} {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.status !== undefined) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.cursor !== undefined && query.cursor !== null) {
    where.push('(created_at < ? OR (created_at = ? AND candidate_id < ?))');
    params.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.candidateId);
  }
  params.push(query.limit + 1);
  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const rows = db
    .prepare(
      `SELECT * FROM script_candidates ${clause} ORDER BY created_at DESC, candidate_id DESC LIMIT ?`,
    )
    .all(...params)
    .map((row) => toCandidate(row as DbRow));
  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  const next =
    rows.length > query.limit && last !== undefined
      ? { createdAt: last.createdAt, candidateId: last.candidateId }
      : null;
  return { items, next };
}

export interface CandidateSourceRun {
  runId: string;
  execId: string | null;
  workspace: string;
  code: string;
  toolsUsed: string[];
  createdAt: string;
}

/**
 * Successful, unexpired code runs from `script_runs`, newest first. `limit`
 * bounds the sample a scan analyzes, not the archive size.
 */
export function listCandidateSourceRuns(
  db: DatabaseSync,
  query: { now: string; limit: number },
): CandidateSourceRun[] {
  return db
    .prepare(`
      SELECT run_id, exec_id, workspace, code, tools_used_json, created_at
      FROM script_runs
      WHERE ok = 1
        AND entry_mode = 'code'
        AND code IS NOT NULL
        AND trim(code) <> ''
        AND expires_at > ?
      ORDER BY created_at DESC, run_id DESC
      LIMIT ?
    `)
    .all(query.now, query.limit)
    .map((row) => {
      const record = row as DbRow;
      return {
        runId: requireText(record, 'run_id'),
        execId: readText(record, 'exec_id'),
        workspace: requireText(record, 'workspace'),
        code: requireText(record, 'code'),
        toolsUsed: readStringArray(record, 'tools_used_json'),
        createdAt: requireText(record, 'created_at'),
      };
    });
}
