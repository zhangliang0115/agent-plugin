/** Opens `state.db` with WAL/foreign keys and applies schema migrations. @module */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createSchemaV1, createSchemaV2, createSchemaV4, createSchemaV6, SCHEMA_VERSION } from './schema.ts';

export interface OpenStateDbOptions {
  /** Create the parent directory (mode 0700) when it does not exist. Default true. */
  createDirectory?: boolean;
  /** chmod the database and its WAL sidecars to 0600. Default true. */
  tightenPermissions?: boolean;
}

/**
 * Opens the config store, enables WAL and foreign keys, and migrates to the
 * current schema. The caller owns the returned handle and must close it.
 */
export function openStateDb(path: string, options: OpenStateDbOptions = {}): DatabaseSync {
  const inMemory = path === ':memory:';
  if (!inMemory && options.createDirectory !== false) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path);
  try {
    if (!inMemory && options.tightenPermissions !== false) {
      chmodSync(path, 0o600);
    }
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db);
    if (!inMemory && options.tightenPermissions !== false) {
      for (const sidecar of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Applies pending migrations. Idempotent: a migrated database is left untouched. */
export function migrate(db: DatabaseSync): number {
  let current = readUserVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(`state.db schema version ${current} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (current === SCHEMA_VERSION) return current;
  withTransaction(db, () => {
    if (current < 1) {
      applyV1(db);
      current = 1;
    }
    if (current < 2) {
      applyV2(db);
      current = 2;
    }
    if (current < 3) {
      applyV3(db);
      current = 3;
    }
    if (current < 4) {
      applyV4(db);
      current = 4;
    }
    if (current < 5) {
      applyV5(db);
      current = 5;
    }
    if (current < 6) {
      applyV6(db);
      current = 6;
    }
  });
  return current;
}

/**
 * Runs `fn` inside a savepoint, rolling back when it throws. Savepoints nest,
 * so repositories can compose (for example `/tools/batch` wrapping per-tool writes).
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const name = `repl_sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const value = fn();
    db.exec(`RELEASE ${name}`);
    return value;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}

let savepointSeq = 0;

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  return row ? Number(row['user_version'] ?? 0) : 0;
}

/** Seed rows get a usable label/summary/category/tag out of the box. */
const SEED_SERVERS = [
  {
    id: '__official__',
    label: 'Claude Code 官方工具',
    summary: 'Claude Code 自带的官方工具集（Read、Write、Bash 等）。',
    category: 'devtools',
    tagsJson: '["official"]',
    previousLabel: 'Official Claude Code tools',
  },
  {
    id: '__builtin__',
    label: '内置聚合工具',
    summary: 'repl-server 自带的聚合工具（run_script、search_tools、describe_tools 等）。',
    category: 'other',
    tagsJson: '["builtin"]',
    previousLabel: 'Built-in composite tools',
  },
] as const;

function applyV1(db: DatabaseSync): void {
  createSchemaV1(db);
  const now = new Date().toISOString();
  const insertSeed = db.prepare(`
    INSERT INTO servers (
      id, label, transport, args_json, env_json, enabled, connect_mode,
      tags_json, summary, category, timeout_ms, max_concurrency,
      created_at, updated_at, revision
    ) VALUES (?, ?, 'builtin', '[]', '{}', 1, 'eager', ?, ?, ?, 60000, 8, ?, ?, 0)
  `);
  for (const seed of SEED_SERVERS) {
    insertSeed.run(seed.id, seed.label, seed.tagsJson, seed.summary, seed.category, now, now);
  }
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', '1');
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('revision', '0');
  db.exec('PRAGMA user_version = 1');
}

function applyV2(db: DatabaseSync): void {
  createSchemaV2(db);
  db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  db.exec('PRAGMA user_version = 2');
}

/** Backfills the seed rows the V1 defaults left bare; user edits are preserved. */
function applyV3(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE servers
    SET label = ?, summary = ?, category = ?, tags_json = ?, updated_at = ?
    WHERE id = ? AND label = ? AND tags_json = '[]' AND category IS NULL
  `);
  for (const seed of SEED_SERVERS) {
    update.run(
      seed.label,
      seed.summary,
      seed.category,
      seed.tagsJson,
      now,
      seed.id,
      seed.previousLabel,
    );
  }
  db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
  db.exec('PRAGMA user_version = 3');
}

/** Splits the legacy `client` label into name/version on every existing report. */
function applyV4(db: DatabaseSync): void {
  createSchemaV4(db);
  db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
  db.exec('PRAGMA user_version = 4');
}

/**
 * Rewrites the two seed rows' category keys to the closed category set. Only the
 * seed servers are migrated: a user-created server with `official`/`builtin` is
 * an administrator's own category value and is left untouched.
 */
function applyV5(db: DatabaseSync): void {
  db.prepare("UPDATE servers SET category = 'devtools' WHERE id = '__official__' AND category = 'official'").run();
  db.prepare("UPDATE servers SET category = 'other' WHERE id = '__builtin__' AND category = 'builtin'").run();
  db.prepare("UPDATE tools SET category = 'devtools' WHERE server_id = '__official__' AND category = 'official'").run();
  db.prepare("UPDATE tools SET category = 'other' WHERE server_id = '__builtin__' AND category = 'builtin'").run();
  db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
  db.exec('PRAGMA user_version = 5');
}

/** Keeps plaintext tokens locally; existing rows keep NULL until rotated. */
function applyV6(db: DatabaseSync): void {
  createSchemaV6(db);
  db.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
  db.exec('PRAGMA user_version = 6');
}
