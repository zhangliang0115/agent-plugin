/** Client binding repository: token hashing, workspace realpath and quotas. @module */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { withTransaction } from './migrate.ts';
import {
  DbValidationError,
  isoNow,
  jsonText,
  readNullableObject,
  readNullableStringArray,
  readText,
  requireText,
} from './schema.ts';
import type { DbRow } from './schema.ts';

/** `WS_INVALID` mirrors the MCP error for a workspace that does not resolve to a directory. */
export class WorkspaceError extends Error {
  readonly code = 'WS_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** Per-binding limits from design 03 §2.6; missing keys fall back to global defaults. */
export interface BindingQuota {
  [key: string]: number | undefined;
  maxExecSessionsPerBinding?: number;
  maxWorkspacesPerMcpSession?: number;
  maxInFlightEvalsPerBinding?: number;
  maxInFlightCallsPerBindingPerServer?: number;
  maxQueuedCallsPerBindingPerServer?: number;
}

export interface ClientBindingRecord {
  id: string;
  label: string;
  tokenHash: string;
  defaultWorkspace: string | null;
  allowedServers: string[] | null;
  allowedTags: string[] | null;
  quota: BindingQuota | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface CreateClientBindingInput {
  id?: string;
  label: string;
  /** Plaintext token. Generated when omitted; the caller returns it once. */
  token?: string;
  defaultWorkspace?: string | null;
  allowedServers?: string[] | null;
  allowedTags?: string[] | null;
  quota?: BindingQuota | null;
}

export interface ClientBindingPatch {
  label?: string;
  defaultWorkspace?: string | null;
  allowedServers?: string[] | null;
  allowedTags?: string[] | null;
  quota?: BindingQuota | null;
}

export interface CreatedClientBinding {
  binding: ClientBindingRecord;
  token: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Resolves `~`, relative segments and symlinks; rejects files and missing paths with `WS_INVALID`. */
export function resolveWorkspacePath(workspace: string): string {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new WorkspaceError('workspace must not be empty');
  }
  const expanded =
    workspace === '~'
      ? homedir()
      : workspace.startsWith('~/')
        ? join(homedir(), workspace.slice(2))
        : workspace;
  const absolute = resolve(expanded);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    throw new WorkspaceError(`workspace does not exist: ${workspace}`);
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(canonical);
  } catch {
    throw new WorkspaceError(`workspace is not accessible: ${workspace}`);
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceError(`workspace is not a directory: ${workspace}`);
  }
  return canonical;
}

export function listClientBindings(db: DatabaseSync): ClientBindingRecord[] {
  return db
    .prepare('SELECT * FROM client_bindings ORDER BY created_at, id')
    .all()
    .map(toBinding);
}

export function getClientBinding(db: DatabaseSync, id: string): ClientBindingRecord | null {
  const row = db.prepare('SELECT * FROM client_bindings WHERE id = ?').get(id);
  return row ? toBinding(row) : null;
}

/** Looks a token up by SHA-256; the plaintext is never stored. */
export function findBindingByToken(db: DatabaseSync, token: string): ClientBindingRecord | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const row = db.prepare('SELECT * FROM client_bindings WHERE token_hash = ?').get(hashToken(token));
  return row ? toBinding(row) : null;
}

export function createClientBinding(
  db: DatabaseSync,
  input: CreateClientBindingInput,
): CreatedClientBinding {
  const label = requireLabel(input.label);
  const token = input.token ?? randomBytes(32).toString('base64url');
  if (typeof token !== 'string' || token.length === 0) {
    throw new DbValidationError('token must not be empty');
  }
  const tokenHash = hashToken(token);
  const id = input.id === undefined ? newBindingId() : requireId(input.id);
  const defaultWorkspace =
    input.defaultWorkspace === undefined || input.defaultWorkspace === null
      ? null
      : resolveWorkspacePath(input.defaultWorkspace);
  const allowedServers = requireStringListOrNull(input.allowedServers, 'allowedServers');
  const allowedTags = requireStringListOrNull(input.allowedTags, 'allowedTags');
  const quota = requireQuota(input.quota);
  const createdAt = isoNow();

  return withTransaction(db, () => {
    const clash = db.prepare('SELECT id FROM client_bindings WHERE token_hash = ?').get(tokenHash);
    if (clash) throw new DbValidationError('token is already bound to another client', 'CONFLICT');
    db.prepare(`
      INSERT INTO client_bindings (
        id, label, token_hash, default_workspace,
        allowed_servers_json, allowed_tags_json, quota_json,
        created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id,
      label,
      tokenHash,
      defaultWorkspace,
      serializeNullableArray(allowedServers),
      serializeNullableArray(allowedTags),
      quota === null ? null : jsonText(quota),
      createdAt,
    );
    return { binding: mustGetBinding(db, id), token };
  });
}

export function updateClientBinding(
  db: DatabaseSync,
  id: string,
  patch: ClientBindingPatch,
): ClientBindingRecord | null {
  return withTransaction(db, () => {
    const current = getClientBinding(db, id);
    if (!current) return null;
    const label = patch.label !== undefined ? requireLabel(patch.label) : current.label;
    const defaultWorkspace =
      patch.defaultWorkspace === undefined
        ? current.defaultWorkspace
        : patch.defaultWorkspace === null
          ? null
          : resolveWorkspacePath(patch.defaultWorkspace);
    const allowedServers =
      patch.allowedServers === undefined
        ? current.allowedServers
        : requireStringListOrNull(patch.allowedServers, 'allowedServers');
    const allowedTags =
      patch.allowedTags === undefined
        ? current.allowedTags
        : requireStringListOrNull(patch.allowedTags, 'allowedTags');
    const quota = patch.quota === undefined ? current.quota : requireQuota(patch.quota);
    db.prepare(`
      UPDATE client_bindings
      SET label = ?, default_workspace = ?, allowed_servers_json = ?,
          allowed_tags_json = ?, quota_json = ?
      WHERE id = ?
    `).run(
      label,
      defaultWorkspace,
      serializeNullableArray(allowedServers),
      serializeNullableArray(allowedTags),
      quota === null ? null : jsonText(quota),
      id,
    );
    return mustGetBinding(db, id);
  });
}

export function deleteClientBinding(
  db: DatabaseSync,
  id: string,
): { deleted: boolean } {
  const result = db.prepare('DELETE FROM client_bindings WHERE id = ?').run(id);
  return { deleted: Number(result.changes) > 0 };
}

export function touchBinding(db: DatabaseSync, id: string, at = isoNow()): boolean {
  const result = db.prepare('UPDATE client_bindings SET last_seen_at = ? WHERE id = ?').run(at, id);
  return Number(result.changes) > 0;
}

function toBinding(row: DbRow): ClientBindingRecord {
  return {
    id: requireText(row, 'id'),
    label: requireText(row, 'label'),
    tokenHash: requireText(row, 'token_hash'),
    defaultWorkspace: readText(row, 'default_workspace'),
    allowedServers: readNullableStringArray(row, 'allowed_servers_json'),
    allowedTags: readNullableStringArray(row, 'allowed_tags_json'),
    quota: readNullableObject<BindingQuota>(row, 'quota_json'),
    createdAt: requireText(row, 'created_at'),
    lastSeenAt: readText(row, 'last_seen_at'),
  };
}

function mustGetBinding(db: DatabaseSync, id: string): ClientBindingRecord {
  const binding = getClientBinding(db, id);
  if (!binding) throw new DbValidationError(`binding ${id} disappeared during write`);
  return binding;
}

function newBindingId(): string {
  return `cb_${randomUUID().replaceAll('-', '')}`;
}

function requireId(value: string): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id.length === 0) throw new DbValidationError('binding id must not be empty');
  return id;
}

function requireLabel(value: string): string {
  const label = typeof value === 'string' ? value.trim() : '';
  if (label.length === 0) throw new DbValidationError('binding label must not be empty');
  return label;
}

function requireStringListOrNull(
  value: string[] | null | undefined,
  field: string,
): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new DbValidationError(`${field} must be an array or null`);
  return value.map((item) => {
    if (typeof item !== 'string') throw new DbValidationError(`${field} must contain strings only`);
    return item;
  });
}

function serializeNullableArray(value: string[] | null): string | null {
  return value === null ? null : jsonText(value);
}

function requireQuota(value: BindingQuota | null | undefined): BindingQuota | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DbValidationError('quota must be an object');
  }
  const copy: BindingQuota = {};
  for (const [key, limit] of Object.entries(value)) {
    if (limit === undefined) continue;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
      throw new DbValidationError(`quota ${key} must be a non-negative integer`);
    }
    copy[key] = limit;
  }
  return copy;
}
