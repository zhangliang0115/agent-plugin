/** SQLite schema v1 for the repl-server config store, plus shared row helpers. @module */
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

/**
 * DDL for schema v1. `tools` is a regular rowid table; `tools_fts` is an
 * external-content FTS5 index kept in sync by the three triggers. The
 * `index_*` columns are computed by the writers, never by the triggers.
 */
export const SCHEMA_V1_SQL = `
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http', 'builtin')),
  command TEXT,
  args_json TEXT,
  env_json TEXT,
  cwd TEXT,
  url TEXT,
  headers_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  connect_mode TEXT NOT NULL DEFAULT 'lazy',
  summary TEXT,
  summary_source TEXT,
  category TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  timeout_ms INTEGER NOT NULL DEFAULT 60000,
  max_concurrency INTEGER NOT NULL DEFAULT 8,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE client_bindings (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  default_workspace TEXT,
  allowed_servers_json TEXT,
  allowed_tags_json TEXT,
  quota_json TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE tools (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  description_override TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  concurrency TEXT NOT NULL DEFAULT 'parallel'
    CHECK (concurrency IN ('parallel', 'serial', 'exclusive')),
  type TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  index_description TEXT NOT NULL DEFAULT '',
  index_summary TEXT NOT NULL DEFAULT '',
  index_tags_json TEXT NOT NULL DEFAULT '[]',
  schema_json TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  category TEXT,
  composite_code TEXT,
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  stale_override INTEGER NOT NULL DEFAULT 0 CHECK (stale_override IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (server_id, name)
);

CREATE VIRTUAL TABLE tools_fts USING fts5(
  server_id,
  name,
  display_name,
  index_description,
  index_summary,
  index_tags_json,
  content='tools',
  content_rowid='rowid'
);

CREATE TRIGGER tools_ai AFTER INSERT ON tools BEGIN
  INSERT INTO tools_fts(rowid, server_id, name, display_name, index_description, index_summary, index_tags_json)
  VALUES (new.rowid, new.server_id, new.name, new.display_name,
          new.index_description, new.index_summary, new.index_tags_json);
END;

CREATE TRIGGER tools_ad AFTER DELETE ON tools BEGIN
  INSERT INTO tools_fts(tools_fts, rowid, server_id, name, display_name, index_description, index_summary, index_tags_json)
  VALUES ('delete', old.rowid, old.server_id, old.name, old.display_name,
          old.index_description, old.index_summary, old.index_tags_json);
END;

CREATE TRIGGER tools_au AFTER UPDATE ON tools BEGIN
  INSERT INTO tools_fts(tools_fts, rowid, server_id, name, display_name, index_description, index_summary, index_tags_json)
  VALUES ('delete', old.rowid, old.server_id, old.name, old.display_name,
          old.index_description, old.index_summary, old.index_tags_json);
  INSERT INTO tools_fts(rowid, server_id, name, display_name, index_description, index_summary, index_tags_json)
  VALUES (new.rowid, new.server_id, new.name, new.display_name,
          new.index_description, new.index_summary, new.index_tags_json);
END;
`;

export function createSchemaV1(db: DatabaseSync): void {
  db.exec(SCHEMA_V1_SQL);
}

/** Raised when repository input violates a storage invariant. */
export class DbValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'INVALID_ARGUMENT') {
    super(message);
    this.name = 'DbValidationError';
    this.code = code;
  }
}

/** Raised when a write targets a row that does not exist. */
export class DbNotFoundError extends Error {
  readonly code = 'NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'DbNotFoundError';
    this.code = 'NOT_FOUND';
  }
}

export type DbRow = Record<string, unknown>;

export function isoNow(): string {
  return new Date().toISOString();
}

export function jsonText(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new DbValidationError('value is not JSON-serializable');
  }
  return text;
}

export function readText(row: DbRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new DbValidationError(`column ${column} is not text`);
}

export function requireText(row: DbRow, column: string): string {
  const value = readText(row, column);
  if (value === null) {
    throw new DbValidationError(`column ${column} is null`);
  }
  return value;
}

export function readNumber(row: DbRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new DbValidationError(`column ${column} is not numeric`);
}

export function readFlag(row: DbRow, column: string): boolean {
  return readNumber(row, column) !== 0;
}

export function readJsonValue(row: DbRow, column: string): unknown {
  const text = readText(row, column);
  if (text === null || text === '') return null;
  return JSON.parse(text);
}

export function readJsonArrayValue(row: DbRow, column: string): unknown[] {
  const value = readJsonValue(row, column);
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new DbValidationError(`column ${column} is not a JSON array`);
  }
  return value;
}

export function readStringArray(row: DbRow, column: string): string[] {
  return readJsonArrayValue(row, column).map((item) => {
    if (typeof item !== 'string') {
      throw new DbValidationError(`column ${column} contains a non-string item`);
    }
    return item;
  });
}

export function readNullableStringArray(row: DbRow, column: string): string[] | null {
  if (readText(row, column) === null) return null;
  return readStringArray(row, column);
}

export function readNullableObject<T>(row: DbRow, column: string): T | null {
  const value = readJsonValue(row, column);
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DbValidationError(`column ${column} is not a JSON object`);
  }
  return value as T;
}
