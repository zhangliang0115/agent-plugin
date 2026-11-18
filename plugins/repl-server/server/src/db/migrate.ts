/** Opens `state.db` with WAL/foreign keys and applies schema migrations. @module */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createSchemaV1, createSchemaV2, SCHEMA_VERSION } from './schema.ts';

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

function applyV1(db: DatabaseSync): void {
  createSchemaV1(db);
  const now = new Date().toISOString();
  const insertSeed = db.prepare(`
    INSERT INTO servers (
      id, label, transport, args_json, env_json, enabled, connect_mode,
      tags_json, timeout_ms, max_concurrency, created_at, updated_at, revision
    ) VALUES (?, ?, 'builtin', '[]', '{}', 1, 'lazy', '[]', 60000, 8, ?, ?, 0)
  `);
  insertSeed.run('__official__', 'Official Claude Code tools', now, now);
  insertSeed.run('__builtin__', 'Built-in composite tools', now, now);
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', '1');
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('revision', '0');
  db.exec('PRAGMA user_version = 1');
}

function applyV2(db: DatabaseSync): void {
  createSchemaV2(db);
  db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  db.exec('PRAGMA user_version = 2');
}
