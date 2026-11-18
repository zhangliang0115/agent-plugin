/** `meta` and `settings` repositories. `meta.revision` is the catalog revision. @module */
import type { DatabaseSync } from 'node:sqlite';

import { withTransaction } from './migrate.ts';
import { DbValidationError, jsonText, readText } from './schema.ts';

export const META_SCHEMA_VERSION = 'schema_version';
export const META_REVISION = 'revision';

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? readText(row, 'value') : null;
}

export function listMeta(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM meta ORDER BY key').all();
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = readText(row, 'key');
    const value = readText(row, 'value');
    if (key !== null && value !== null) out[key] = value;
  }
  return out;
}

export function getRevision(db: DatabaseSync): number {
  const raw = getMeta(db, META_REVISION);
  if (raw === null) return 0;
  const revision = Number(raw);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new DbValidationError(`meta.${META_REVISION} is not a non-negative integer: ${raw}`);
  }
  return revision;
}

/**
 * Increments the catalog revision. Must run inside the same transaction as the
 * write it describes, so a failed write rolls the revision back with it.
 */
export function bumpRevision(db: DatabaseSync, by = 1): number {
  const next = getRevision(db) + by;
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(META_REVISION, String(next));
  return next;
}

export interface SettingsWriteResult {
  settings: Record<string, unknown>;
  revision: number;
}

export function getSetting<T = unknown>(db: DatabaseSync, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return undefined;
  return parseSettingValue(readText(row, 'value'), key) as T;
}

export function listSettings(db: DatabaseSync): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = readText(row, 'key');
    if (key === null) continue;
    out[key] = parseSettingValue(readText(row, 'value'), key);
  }
  return out;
}

/** Validates and stores values as JSON so booleans and nested capacity objects round-trip. */
export function patchSettings(
  db: DatabaseSync,
  patch: Record<string, unknown>,
): SettingsWriteResult {
  return withTransaction(db, () => {
    const statement = db.prepare(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(patch)) {
      if (key.length === 0) throw new DbValidationError('setting key must not be empty');
      if (value === undefined) throw new DbValidationError(`setting ${key} is undefined`);
      statement.run(key, jsonText(value));
    }
    const revision = bumpRevision(db);
    return { settings: listSettings(db), revision };
  });
}

export function setSetting(
  db: DatabaseSync,
  key: string,
  value: unknown,
): SettingsWriteResult {
  return patchSettings(db, { [key]: value });
}

export function deleteSetting(
  db: DatabaseSync,
  key: string,
): { deleted: boolean; revision: number } {
  return withTransaction(db, () => {
    const result = db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    if (Number(result.changes) === 0) {
      return { deleted: false, revision: getRevision(db) };
    }
    return { deleted: true, revision: bumpRevision(db) };
  });
}

function parseSettingValue(raw: string | null, key: string): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new DbValidationError(`setting ${key} is not valid JSON`);
  }
}
