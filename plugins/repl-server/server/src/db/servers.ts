/** Server configuration repository. Every write commits one catalog revision. @module */
import type { DatabaseSync } from 'node:sqlite';

import { decodeStoredDiscovery } from '../discovery/config.ts';
import { withTransaction } from './migrate.ts';
import { bumpRevision, getRevision } from './meta.ts';
import {
  DbValidationError,
  isoNow,
  jsonText,
  readFlag,
  readJsonArrayValue,
  readNullableObject,
  readNumber,
  readStringArray,
  readText,
  requireText,
} from './schema.ts';
import type { DbRow } from './schema.ts';
import { demoteDiscoveredTools, refreshServerIndex } from './tools.ts';

export const OFFICIAL_SERVER_ID = '__official__';
export const BUILTIN_SERVER_ID = '__builtin__';
export const SEED_SERVER_IDS = [OFFICIAL_SERVER_ID, BUILTIN_SERVER_ID] as const;

export type ServerTransport = 'stdio' | 'http' | 'builtin';
export type ConnectMode = 'lazy' | 'eager';

export interface ServerRecord {
  id: string;
  label: string;
  transport: ServerTransport;
  command: string | null;
  args: unknown[];
  env: Record<string, unknown>;
  cwd: string | null;
  url: string | null;
  headers: Record<string, unknown>;
  /** Normalized tool-discovery config as a JSON string; `null` means static discovery. */
  discoveryJson: string | null;
  enabled: boolean;
  connectMode: ConnectMode;
  summary: string | null;
  summarySource: string | null;
  category: string | null;
  tags: string[];
  timeoutMs: number;
  maxConcurrency: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface NewServer {
  id: string;
  label: string;
  transport: ServerTransport;
  command?: string | null;
  args?: unknown[];
  env?: Record<string, unknown>;
  cwd?: string | null;
  url?: string | null;
  headers?: Record<string, unknown>;
  discoveryJson?: string | null;
  enabled?: boolean;
  connectMode?: ConnectMode;
  summary?: string | null;
  summarySource?: string | null;
  category?: string | null;
  tags?: string[];
  timeoutMs?: number;
  maxConcurrency?: number;
}

export type ServerPatch = {
  [K in keyof Omit<NewServer, 'id'>]?: NewServer[K];
};

export interface ServerWriteResult {
  server: ServerRecord;
  revision: number;
}

export function isSeedServer(id: string): boolean {
  return (SEED_SERVER_IDS as readonly string[]).includes(id);
}

export function listServers(
  db: DatabaseSync,
  options: { enabledOnly?: boolean } = {},
): ServerRecord[] {
  const sql = options.enabledOnly
    ? 'SELECT * FROM servers WHERE enabled = 1 ORDER BY id'
    : 'SELECT * FROM servers ORDER BY id';
  return db.prepare(sql).all().map(toServer);
}

export function getServer(db: DatabaseSync, id: string): ServerRecord | null {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  return row ? toServer(row) : null;
}

export function createServer(db: DatabaseSync, input: NewServer): ServerWriteResult {
  const id = requireServerId(input.id);
  const label = requireLabel(input.label);
  const transport = requireTransport(input.transport);
  const command = input.command ?? null;
  const url = input.url ?? null;
  validateTransportShape(transport, command, url);
  const args = requireJsonArray(input.args, 'args');
  const env = requireJsonObject(input.env, 'env');
  const headers = requireJsonObject(input.headers, 'headers');
  const discoveryJson = requireDiscoveryJson(input.discoveryJson);
  const tags = requireTags(input.tags);
  const connectMode = requireConnectMode(input.connectMode ?? 'lazy');
  const timeoutMs = requirePositiveInteger(input.timeoutMs ?? 60000, 'timeoutMs');
  const maxConcurrency = requirePositiveInteger(input.maxConcurrency ?? 8, 'maxConcurrency');
  const now = isoNow();

  return withTransaction(db, () => {
    if (getServer(db, id)) {
      throw new DbValidationError(`server ${id} already exists`, 'CONFLICT');
    }
    db.prepare(`
      INSERT INTO servers (
        id, label, transport, command, args_json, env_json, cwd, url, headers_json,
        discovery_json, enabled, connect_mode, summary, summary_source, category, tags_json,
        timeout_ms, max_concurrency, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      id,
      label,
      transport,
      command,
      jsonText(args),
      jsonText(env),
      input.cwd ?? null,
      url,
      jsonText(headers),
      discoveryJson,
      (input.enabled ?? true) ? 1 : 0,
      connectMode,
      input.summary ?? null,
      input.summarySource ?? null,
      input.category ?? null,
      jsonText(tags),
      timeoutMs,
      maxConcurrency,
      now,
      now,
    );
    const revision = bumpRevision(db);
    return { server: mustGetServer(db, id), revision };
  });
}

export function updateServer(
  db: DatabaseSync,
  id: string,
  patch: ServerPatch,
): ServerWriteResult | null {
  return withTransaction(db, () => {
    const current = getServer(db, id);
    if (!current) return null;
    const next = applyServerPatch(current, patch);
    db.prepare(`
      UPDATE servers
      SET label = ?, transport = ?, command = ?, args_json = ?, env_json = ?, cwd = ?,
          url = ?, headers_json = ?, discovery_json = ?, enabled = ?, connect_mode = ?,
          summary = ?, summary_source = ?, category = ?, tags_json = ?, timeout_ms = ?,
          max_concurrency = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?
    `).run(
      next.label,
      next.transport,
      next.command,
      jsonText(next.args),
      jsonText(next.env),
      next.cwd,
      next.url,
      jsonText(next.headers),
      next.discoveryJson,
      next.enabled ? 1 : 0,
      next.connectMode,
      next.summary,
      next.summarySource,
      next.category,
      jsonText(next.tags),
      next.timeoutMs,
      next.maxConcurrency,
      isoNow(),
      id,
    );
    if (indexInputsChanged(current, next)) refreshServerIndex(db, id);
    if (isSearchDiscovery(current.discoveryJson) && !isSearchDiscovery(next.discoveryJson)) {
      // The switch back to static and the demotion are one write: a failure in
      // either rolls both back (design 07 §3.8). demoteDiscoveredTools is
      // idempotent, so the admin layer's extra call stays harmless until the
      // assembly removes it.
      demoteDiscoveredTools(db, id);
    }
    const revision = bumpRevision(db);
    return { server: mustGetServer(db, id), revision };
  });
}

/** Fixed seed rows (`__official__`, `__builtin__`) cannot be deleted. */
export function deleteServer(
  db: DatabaseSync,
  id: string,
): { deleted: boolean; revision: number } {
  return withTransaction(db, () => {
    if (isSeedServer(id)) {
      throw new DbValidationError(`server ${id} is a fixed seed row`, 'IMMUTABLE_SERVER');
    }
    const result = db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    if (Number(result.changes) === 0) {
      return { deleted: false, revision: getRevision(db) };
    }
    return { deleted: true, revision: bumpRevision(db) };
  });
}

function applyServerPatch(current: ServerRecord, patch: ServerPatch): ServerRecord {
  const next: ServerRecord = { ...current };
  if (patch.label !== undefined) next.label = requireLabel(patch.label);
  if (patch.transport !== undefined) next.transport = requireTransport(patch.transport);
  if (patch.command !== undefined) next.command = patch.command;
  if (patch.args !== undefined) next.args = requireJsonArray(patch.args, 'args');
  if (patch.env !== undefined) next.env = requireJsonObject(patch.env, 'env');
  if (patch.cwd !== undefined) next.cwd = patch.cwd;
  if (patch.url !== undefined) next.url = patch.url;
  if (patch.headers !== undefined) next.headers = requireJsonObject(patch.headers, 'headers');
  if (patch.discoveryJson !== undefined) {
    next.discoveryJson = requireDiscoveryJson(patch.discoveryJson);
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.connectMode !== undefined) next.connectMode = requireConnectMode(patch.connectMode);
  if (patch.summary !== undefined) next.summary = patch.summary;
  if (patch.summarySource !== undefined) next.summarySource = patch.summarySource;
  if (patch.category !== undefined) next.category = patch.category;
  if (patch.tags !== undefined) next.tags = requireTags(patch.tags);
  if (patch.timeoutMs !== undefined) next.timeoutMs = requirePositiveInteger(patch.timeoutMs, 'timeoutMs');
  if (patch.maxConcurrency !== undefined) {
    next.maxConcurrency = requirePositiveInteger(patch.maxConcurrency, 'maxConcurrency');
  }
  validateTransportShape(next.transport, next.command, next.url);
  return next;
}

function indexInputsChanged(before: ServerRecord, after: ServerRecord): boolean {
  return before.summary !== after.summary || before.tags.join('\u0000') !== after.tags.join('\u0000');
}

/** Stored configs are decoded with the shared validator; malformed text reads as static. */
function isSearchDiscovery(discoveryJson: string | null): boolean {
  return decodeStoredDiscovery(discoveryJson)?.mode === 'search';
}

function toServer(row: DbRow): ServerRecord {
  return {
    id: requireText(row, 'id'),
    label: requireText(row, 'label'),
    transport: requireTransport(requireText(row, 'transport')),
    command: readText(row, 'command'),
    args: readJsonArrayValue(row, 'args_json'),
    env: readNullableObject<Record<string, unknown>>(row, 'env_json') ?? {},
    cwd: readText(row, 'cwd'),
    url: readText(row, 'url'),
    headers: readNullableObject<Record<string, unknown>>(row, 'headers_json') ?? {},
    discoveryJson: readText(row, 'discovery_json'),
    enabled: readFlag(row, 'enabled'),
    connectMode: requireConnectMode(requireText(row, 'connect_mode')),
    summary: readText(row, 'summary'),
    summarySource: readText(row, 'summary_source'),
    category: readText(row, 'category'),
    tags: readStringArray(row, 'tags_json'),
    timeoutMs: readNumber(row, 'timeout_ms'),
    maxConcurrency: readNumber(row, 'max_concurrency'),
    createdAt: requireText(row, 'created_at'),
    updatedAt: requireText(row, 'updated_at'),
    revision: readNumber(row, 'revision'),
  };
}

function mustGetServer(db: DatabaseSync, id: string): ServerRecord {
  const server = getServer(db, id);
  if (!server) throw new DbValidationError(`server ${id} disappeared during write`);
  return server;
}

function requireServerId(value: string): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id.length === 0) throw new DbValidationError('server id must not be empty');
  return id;
}

function requireLabel(value: string): string {
  const label = typeof value === 'string' ? value.trim() : '';
  if (label.length === 0) throw new DbValidationError('server label must not be empty');
  return label;
}

function requireTransport(value: string): ServerTransport {
  if (value === 'stdio' || value === 'http' || value === 'builtin') return value;
  throw new DbValidationError(`unknown server transport: ${value}`);
}

function requireConnectMode(value: string): ConnectMode {
  if (value === 'lazy' || value === 'eager') return value;
  throw new DbValidationError(`unknown connect mode: ${value}`);
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DbValidationError(`${field} must be a positive integer`);
  }
  return value;
}

function requireJsonArray(value: unknown[] | undefined, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DbValidationError(`${field} must be an array`);
  return value;
}

function requireJsonObject(
  value: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DbValidationError(`${field} must be an object`);
  }
  return value;
}

/**
 * Discovery config is stored as JSON text because the repository never
 * interprets it; callers parse and validate the shape.
 */
function requireDiscoveryJson(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new DbValidationError('discoveryJson must be a JSON string');
  }
  try {
    JSON.parse(value);
  } catch {
    throw new DbValidationError('discoveryJson must be valid JSON');
  }
  return value;
}

function requireTags(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DbValidationError('tags must be an array');
  return value.map((tag) => {
    if (typeof tag !== 'string') throw new DbValidationError('tags must contain strings only');
    return tag;
  });
}

function validateTransportShape(
  transport: ServerTransport,
  command: string | null,
  url: string | null,
): void {
  if (transport === 'stdio' && (command === null || command.trim() === '')) {
    throw new DbValidationError('stdio servers require a command');
  }
  if (transport === 'http' && (url === null || url.trim() === '')) {
    throw new DbValidationError('http servers require a url');
  }
}
