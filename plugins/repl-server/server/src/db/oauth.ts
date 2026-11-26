/** Persisted OAuth authorizations: one row per issued access token. @module */
import type { DatabaseSync } from 'node:sqlite';

export interface OAuthAuthorizationRow {
  accessHash: string;
  clientId: string;
  clientName: string;
  bindingId: string | null;
  refreshHash: string | null;
  createdAt: number;
  expiresAt: number;
  refreshExpiresAt: number | null;
}

function toRow(row: Record<string, unknown>): OAuthAuthorizationRow {
  return {
    accessHash: String(row['access_hash']),
    clientId: String(row['client_id']),
    clientName: String(row['client_name']),
    bindingId: row['binding_id'] === null ? null : String(row['binding_id']),
    refreshHash: row['refresh_hash'] === null ? null : String(row['refresh_hash']),
    createdAt: Number(row['created_at']),
    expiresAt: Number(row['expires_at']),
    refreshExpiresAt: row['refresh_expires_at'] === null ? null : Number(row['refresh_expires_at']),
  };
}

export function listOAuthAuthorizations(db: DatabaseSync): OAuthAuthorizationRow[] {
  return db
    .prepare('SELECT * FROM oauth_authorizations ORDER BY created_at')
    .all()
    .map((row) => toRow(row as Record<string, unknown>));
}

export function saveOAuthAuthorization(db: DatabaseSync, row: OAuthAuthorizationRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO oauth_authorizations
       (access_hash, client_id, client_name, binding_id, refresh_hash, created_at, expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.accessHash,
    row.clientId,
    row.clientName,
    row.bindingId,
    row.refreshHash,
    row.createdAt,
    row.expiresAt,
    row.refreshExpiresAt,
  );
}

export function deleteOAuthAuthorization(db: DatabaseSync, accessHash: string): void {
  db.prepare('DELETE FROM oauth_authorizations WHERE access_hash = ?').run(accessHash);
}

export function deleteOAuthClientAuthorizations(db: DatabaseSync, clientId: string): void {
  db.prepare('DELETE FROM oauth_authorizations WHERE client_id = ?').run(clientId);
}

/** Drops expired rows; called on startup so the table does not grow forever. */
export function pruneOAuthAuthorizations(db: DatabaseSync, now = Date.now()): number {
  const result = db
    .prepare(
      'DELETE FROM oauth_authorizations WHERE COALESCE(refresh_expires_at, expires_at) <= ?',
    )
    .run(now);
  return Number(result.changes);
}
