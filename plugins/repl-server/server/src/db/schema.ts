/** SQLite schema versions for the repl-server config store, plus shared row helpers. @module */
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 11;

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
  connect_mode TEXT NOT NULL DEFAULT 'eager',
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
  agent TEXT,
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

/**
 * DDL for schema v2. Contains both the problem-report tables (06 §2.1) and the
 * tool-discovery columns (07 §2.3); they share one migration step, so there is
 * exactly one `applyV2`.
 */
export const SCHEMA_V2_SQL = `
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mcp', 'admin')),
  binding TEXT,
  client TEXT NOT NULL DEFAULT '',
  mcp TEXT NOT NULL DEFAULT '',
  exec TEXT,
  eval_id INTEGER,
  owner_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  context_json TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'ack', 'closed')),
  alert_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (alert_state IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'no_webhook')),
  alert_error TEXT,
  alert_attempts INTEGER NOT NULL DEFAULT 0,
  alert_updated_at TEXT,
  alerted_at TEXT
);

CREATE INDEX reports_created_idx ON reports (created_at DESC, id DESC);
CREATE INDEX reports_status_idx ON reports (status, created_at DESC);
CREATE INDEX reports_owner_idx ON reports (owner_key, created_at DESC);
CREATE INDEX reports_dedupe_idx ON reports (owner_key, fingerprint, created_at DESC);
CREATE INDEX reports_alert_idx ON reports (alert_state, created_at);

ALTER TABLE servers ADD COLUMN discovery_json TEXT
  CHECK (discovery_json IS NULL OR json_valid(discovery_json));

ALTER TABLE tools ADD COLUMN discovered_via TEXT NOT NULL DEFAULT 'static'
  CHECK (discovered_via IN ('static', 'search'));

CREATE INDEX tools_discovery_idx ON tools (server_id, discovered_via);
`;

export function createSchemaV1(db: DatabaseSync): void {
  db.exec(SCHEMA_V1_SQL);
}

export function createSchemaV2(db: DatabaseSync): void {
  db.exec(SCHEMA_V2_SQL);
}

/**
 * Adds the split client identity to `reports`. Existing rows are backfilled
 * from the legacy `client` label at its first `/`; without a slash the whole
 * label is the name and the version stays empty. Column checks keep the step
 * safe when a database was reopened with an older `user_version` marker.
 */
export function createSchemaV4(db: DatabaseSync): void {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(reports)')
      .all()
      .map((row) => String(row['name'])),
  );
  if (!columns.has('client_name')) {
    db.exec("ALTER TABLE reports ADD COLUMN client_name TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('client_version')) {
    db.exec("ALTER TABLE reports ADD COLUMN client_version TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`
    UPDATE reports SET
      client_name = CASE
        WHEN instr(client, '/') > 1 THEN substr(client, 1, instr(client, '/') - 1)
        ELSE client
      END,
      client_version = CASE
        WHEN instr(client, '/') > 1 THEN substr(client, instr(client, '/') + 1)
        ELSE ''
      END;
  `);
}

/**
 * Adds the locally kept plaintext token so the admin UI can show it again.
 * The column is optional: bindings created before v6 cannot recover it.
 */
export function createSchemaV6(db: DatabaseSync): void {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(client_bindings)')
      .all()
      .map((row) => String(row['name'])),
  );
  if (!columns.has('token_plain')) {
    db.exec('ALTER TABLE client_bindings ADD COLUMN token_plain TEXT');
  }
}

/** Adds the admin-maintained resolution and the close timestamp (06 §2.6). */
export function createSchemaV7(db: DatabaseSync): void {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(reports)')
      .all()
      .map((row) => String(row['name'])),
  );
  if (!columns.has('resolution')) {
    db.exec('ALTER TABLE reports ADD COLUMN resolution TEXT');
  }
  if (!columns.has('resolved_at')) {
    db.exec('ALTER TABLE reports ADD COLUMN resolved_at TEXT');
  }
}

/**
 * DDL for schema v8: execution archive, script identity, immutable versions and
 * the P3 candidate queue, plus their FTS index and triggers (design 10 §5.5).
 * Everything the script library needs is created here; later phases add no
 * migration and only leave `script_candidates` / `scripts_fts` idle until used.
 * No foreign keys: a version's `source_run_id` may dangle once the archive row
 * expires, and consistency is kept by the repository's transactions.
 */
export const SCHEMA_V8_SQL = `
-- Execution archive for run_script itself; it is not a second execution path.
CREATE TABLE IF NOT EXISTS script_runs (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  exec_id TEXT,
  eval_id INTEGER,
  request_id TEXT,
  binding TEXT,
  client_name TEXT NOT NULL DEFAULT '',
  client_version TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL,
  entry_tool TEXT NOT NULL,
  entry_mode TEXT NOT NULL CHECK (entry_mode IN ('code', 'script')),
  script_id TEXT,
  script_version INTEGER,
  script_mode TEXT CHECK (script_mode IS NULL OR script_mode IN ('exact', 'parameterized')),
  args_json TEXT,
  args_preview TEXT,
  code TEXT,
  code_bytes INTEGER,
  code_sha256 TEXT,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error TEXT,
  result_bytes INTEGER,
  duration_ms INTEGER,
  tools_used_json TEXT NOT NULL DEFAULT '[]',
  purpose TEXT NOT NULL DEFAULT 'run' CHECK (purpose IN ('run', 'test'))
);

CREATE INDEX IF NOT EXISTS script_runs_expires_idx ON script_runs (expires_at);
CREATE INDEX IF NOT EXISTS script_runs_created_idx ON script_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS script_runs_code_idx ON script_runs (code_sha256);
CREATE INDEX IF NOT EXISTS script_runs_script_idx ON script_runs (script_id, script_version);

CREATE TABLE IF NOT EXISTS scripts (
  script_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL CHECK (mode IN ('exact', 'parameterized')),
  active_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_run_id TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS scripts_status_idx ON scripts (status);

CREATE TABLE IF NOT EXISTS script_versions (
  script_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('exact', 'parameterized')),
  code TEXT NOT NULL,
  code_bytes INTEGER NOT NULL,
  code_sha256 TEXT NOT NULL,
  input_schema_json TEXT NOT NULL,
  example_args_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'archived')),
  changelog TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  source_run_id TEXT,
  verified_run_id TEXT,
  activated_at TEXT,
  PRIMARY KEY (script_id, version)
);

CREATE INDEX IF NOT EXISTS script_versions_status_idx ON script_versions (script_id, status);
CREATE INDEX IF NOT EXISTS script_versions_source_idx ON script_versions (source_run_id);

-- P3 review queue and the P2 search index are created now so the schema does
-- not need another migration when those phases land; P1 code leaves them idle.
CREATE TABLE IF NOT EXISTS script_candidates (
  candidate_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  code TEXT NOT NULL,
  code_sha256 TEXT NOT NULL,
  workspace TEXT NOT NULL,
  source_run_ids_json TEXT NOT NULL DEFAULT '[]',
  suggested_name TEXT,
  suggested_description TEXT,
  suggested_tags_json TEXT,
  suggested_input_schema_json TEXT,
  suggested_code TEXT,
  score REAL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  script_id TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE INDEX IF NOT EXISTS script_candidates_status_idx ON script_candidates (status, created_at DESC);
CREATE INDEX IF NOT EXISTS script_candidates_code_idx ON script_candidates (code_sha256);

CREATE VIRTUAL TABLE IF NOT EXISTS scripts_fts USING fts5(
  script_id UNINDEXED,
  name,
  description,
  tags_json,
  content='scripts',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS scripts_ai AFTER INSERT ON scripts BEGIN
  INSERT INTO scripts_fts(rowid, script_id, name, description, tags_json)
  VALUES (new.rowid, new.script_id, new.name, new.description, new.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS scripts_ad AFTER DELETE ON scripts BEGIN
  INSERT INTO scripts_fts(scripts_fts, rowid, script_id, name, description, tags_json)
  VALUES ('delete', old.rowid, old.script_id, old.name, old.description, old.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS scripts_au AFTER UPDATE ON scripts BEGIN
  INSERT INTO scripts_fts(scripts_fts, rowid, script_id, name, description, tags_json)
  VALUES ('delete', old.rowid, old.script_id, old.name, old.description, old.tags_json);
  INSERT INTO scripts_fts(rowid, script_id, name, description, tags_json)
  VALUES (new.rowid, new.script_id, new.name, new.description, new.tags_json);
END;
`;

export function createSchemaV8(db: DatabaseSync): void {
  db.exec(SCHEMA_V8_SQL);
}

/**
 * DDL for schema v9: lifetime tool-call counters fed by `tool_result` audit
 * events. Deliberately no foreign key to `tools` — deleting a tool keeps its
 * history so a re-added tool shows the same totals.
 */
export const SCHEMA_V9_SQL = `
CREATE TABLE IF NOT EXISTS tool_usage (
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  last_called_at TEXT NOT NULL,
  PRIMARY KEY (server_id, name)
);
`;

export function createSchemaV9(db: DatabaseSync): void {
  db.exec(SCHEMA_V9_SQL);
}

/**
 * Adds the configured agent family to client bindings. Existing rows are
 * backfilled from their label; unmatched bindings stay NULL (standard path).
 */
export function createSchemaV10(db: DatabaseSync): void {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(client_bindings)')
      .all()
      .map((row) => String(row['name'])),
  );
  if (!columns.has('agent')) {
    db.exec('ALTER TABLE client_bindings ADD COLUMN agent TEXT');
  }
  db.exec(`
    UPDATE client_bindings SET agent = CASE
      WHEN lower(label) LIKE '%kiro%' THEN 'kiro'
      WHEN lower(label) LIKE '%claude%' THEN 'claude-code'
      ELSE NULL
    END
    WHERE agent IS NULL
  `);
}

/**
 * Persists OAuth authorizations so a daemon restart does not send every client
 * back through the consent page. One row per issued access token.
 */
export function createSchemaV11(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS oauth_authorizations (
  access_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  binding_id TEXT,
  refresh_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS oauth_authorizations_client ON oauth_authorizations(client_id);
`);
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
