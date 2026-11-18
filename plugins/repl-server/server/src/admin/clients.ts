/** Admin API for client bindings and one-time tokens.
 *
 * Routes:
 * - `GET /clients` — bindings (never token hashes) plus active MCP sessions
 * - `POST /clients` — create a binding; the plaintext token is returned exactly once
 * - `PUT /clients/:id` — update workspace/visibility/quota and destroy its execution sessions
 * - `DELETE /clients/:id` — delete the binding, invalidate the token and destroy sessions
 *
 * Token rotation and deletion both re-check `client_bindings` on every `/mcp` request;
 * the callback here is the eager cleanup of execution sessions that belong to the binding.
 * @module
 */

import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';

import {
  AdminApiError,
  adminHandler,
  adminJson,
  expectInteger,
  expectString,
  expectStringArray,
  invalidField,
  isPlainObject,
  requestSegments,
  requireObjectBody,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from './servers.ts';

/** Per-binding quotas from 03 §2.6; absent keys fall back to the global defaults. */
export const CLIENT_QUOTA_KEYS = [
  'maxExecSessionsPerBinding',
  'maxInFlightEvalsPerBinding',
  'maxInFlightCallsPerBindingPerServer',
  'maxQueuedCallsPerBindingPerServer',
] as const;

export type ClientQuotaKey = (typeof CLIENT_QUOTA_KEYS)[number];
export type ClientQuota = Partial<Record<ClientQuotaKey, number>>;

/** API-safe binding row. It deliberately has no `tokenHash` field. */
export interface ClientBinding {
  id: string;
  label: string;
  defaultWorkspace: string | null;
  /** `null` means every server; an array means any-of. */
  allowedServers: string[] | null;
  /** `null` means every tag; an array means any-of. */
  allowedTags: string[] | null;
  quota: ClientQuota | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface ClientBindingInput {
  label: string;
  defaultWorkspace: string | null;
  allowedServers: string[] | null;
  allowedTags: string[] | null;
  quota: ClientQuota | null;
}

export interface ClientBindingPatch {
  label?: string;
  defaultWorkspace?: string | null;
  allowedServers?: string[] | null;
  allowedTags?: string[] | null;
  quota?: ClientQuota | null;
}

/** Persistence contract implemented by RS-02. The store hashes `token`; only the hash is kept. */
export interface ClientBindingStore {
  list(): Promise<ClientBinding[]>;
  get(id: string): Promise<ClientBinding | null>;
  create(input: ClientBindingInput & { token: string }): Promise<ClientBinding>;
  update(id: string, patch: ClientBindingPatch): Promise<ClientBinding>;
  /** Returns false when the row was already gone. */
  remove(id: string): Promise<boolean>;
}

export interface McpSessionRecord {
  mcpSessionId: string;
  bindingId: string | null;
  client: string;
  connectedAt?: string;
  lastRequestAt?: string;
  execSessionIds?: string[];
}

/** Live transport-session view supplied by the MCP layer. */
export interface SessionRegistry {
  list(): Promise<McpSessionRecord[]>;
}

export type BindingChange = 'updated' | 'deleted';

export interface AdminClientsDeps {
  bindings: ClientBindingStore;
  /** Destroys every live execution session of the binding; returns how many were removed. */
  onBindingChanged: (bindingId: string, change: BindingChange) => Promise<number> | number;
  sessions?: SessionRegistry;
  /** Test hook; defaults to 32 random bytes as base64url. */
  tokenFactory?: () => string;
}

const CLIENT_FIELDS: ReadonlySet<string> = new Set([
  'label',
  'defaultWorkspace',
  'allowedServers',
  'allowedTags',
  'quota',
]);

const QUOTA_KEY_SET: ReadonlySet<string> = new Set(CLIENT_QUOTA_KEYS);

function readNullableWorkspace(value: unknown, field: string): string | null {
  if (value === null) return null;
  const text = expectString(value, field, { max: 4096 });
  if (!isAbsolute(text)) throw invalidField(field, 'must be an absolute path');
  return text;
}

function readNullableStringList(value: unknown, field: string): string[] | null {
  if (value === null) return null;
  return expectStringArray(value, field, { maxItems: 256, maxLength: 256 });
}

function readQuota(value: unknown, field: string): ClientQuota | null {
  if (value === null) return null;
  if (!isPlainObject(value)) throw invalidField(field, 'must be an object or null');

  const quota: ClientQuota = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!QUOTA_KEY_SET.has(key)) {
      throw new AdminApiError(422, 'UNKNOWN_QUOTA_KEY', `unknown quota key ${key}`, { key });
    }
    quota[key as ClientQuotaKey] = expectInteger(entry, `${field}.${key}`, {
      min: 0,
      max: 1_000_000,
    });
  }
  return quota;
}

function parseCreateInput(body: Record<string, unknown>): ClientBindingInput {
  if (!('label' in body) || typeof body['label'] !== 'string') {
    throw invalidField('label', 'is required and must be a string');
  }

  return {
    label: expectString(body['label'], 'label', { max: 128 }),
    defaultWorkspace:
      'defaultWorkspace' in body ? readNullableWorkspace(body['defaultWorkspace'], 'defaultWorkspace') : null,
    allowedServers:
      'allowedServers' in body ? readNullableStringList(body['allowedServers'], 'allowedServers') : null,
    allowedTags:
      'allowedTags' in body ? readNullableStringList(body['allowedTags'], 'allowedTags') : null,
    quota: 'quota' in body ? readQuota(body['quota'], 'quota') : null,
  };
}

function parsePatch(body: Record<string, unknown>): ClientBindingPatch {
  const patch: ClientBindingPatch = {};

  if ('label' in body) patch.label = expectString(body['label'], 'label', { max: 128 });
  if ('defaultWorkspace' in body) {
    patch.defaultWorkspace = readNullableWorkspace(body['defaultWorkspace'], 'defaultWorkspace');
  }
  if ('allowedServers' in body) {
    patch.allowedServers = readNullableStringList(body['allowedServers'], 'allowedServers');
  }
  if ('allowedTags' in body) {
    patch.allowedTags = readNullableStringList(body['allowedTags'], 'allowedTags');
  }
  if ('quota' in body) patch.quota = readQuota(body['quota'], 'quota');

  if (Object.keys(patch).length === 0) {
    throw new AdminApiError(422, 'EMPTY_PATCH', 'patch does not change any field');
  }
  return patch;
}

function generateToken(factory: (() => string) | undefined): string {
  const token = factory === undefined ? randomBytes(32).toString('base64url') : factory();
  if (typeof token !== 'string' || token.length < 16) {
    throw new AdminApiError(500, 'INTERNAL_ERROR', 'token factory returned an invalid token');
  }
  return token;
}

/** `client_bindings.token_hash` matches the auth layer's SHA-256 encoding. */

/**
 * Explicit projection: even if a store returns extra columns (for example `token_hash`),
 * only these fields cross the admin boundary.
 */
function publicBinding(binding: ClientBinding): ClientBinding {
  return {
    id: binding.id,
    label: binding.label,
    defaultWorkspace: binding.defaultWorkspace,
    allowedServers:
      binding.allowedServers === null ? null : [...binding.allowedServers],
    allowedTags: binding.allowedTags === null ? null : [...binding.allowedTags],
    quota: binding.quota === null ? null : { ...binding.quota },
    createdAt: binding.createdAt,
    lastSeenAt: binding.lastSeenAt,
  };
}

function publicSession(session: McpSessionRecord): McpSessionRecord {
  const view: McpSessionRecord = {
    mcpSessionId: session.mcpSessionId,
    bindingId: session.bindingId,
    client: session.client,
  };
  if (session.connectedAt !== undefined) view.connectedAt = session.connectedAt;
  if (session.lastRequestAt !== undefined) view.lastRequestAt = session.lastRequestAt;
  if (session.execSessionIds !== undefined) view.execSessionIds = [...session.execSessionIds];
  return view;
}

interface BindingChangeResult {
  affectedSessions: number;
  warning?: string;
}

async function notifyBindingChanged(
  deps: AdminClientsDeps,
  bindingId: string,
  change: BindingChange,
): Promise<BindingChangeResult> {
  try {
    const affected = await deps.onBindingChanged(bindingId, change);
    return {
      affectedSessions:
        typeof affected === 'number' && Number.isFinite(affected) && affected > 0
          ? Math.trunc(affected)
          : 0,
    };
  } catch (error) {
    // The binding change is already committed; the per-request identity re-check still
    // rejects the old token. Report the cleanup failure instead of hiding it.
    return {
      affectedSessions: 0,
      warning: `failed to destroy execution sessions: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * `GET/POST /clients`, `PUT/DELETE /clients/:id`. Binding writes are committed
 * synchronously; `onBindingChanged` then removes that binding's execution sessions.
 */
export function createAdminClientsHandler(deps: AdminClientsDeps): AdminHandler {
  async function listClients(): Promise<AdminResponse> {
    const [bindings, sessions] = await Promise.all([
      deps.bindings.list(),
      deps.sessions === undefined ? Promise.resolve<McpSessionRecord[]>([]) : deps.sessions.list(),
    ]);

    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (session.bindingId === null) continue;
      counts.set(session.bindingId, (counts.get(session.bindingId) ?? 0) + 1);
    }

    return adminJson(200, {
      clients: bindings.map((binding) => ({
        ...publicBinding(binding),
        activeSessions: counts.get(binding.id) ?? 0,
      })),
      sessions: sessions.map(publicSession),
    });
  }

  async function createClient(request: AdminRequest): Promise<AdminResponse> {
    const body = requireObjectBody(request);
    const unknown = Object.keys(body).filter((key) => !CLIENT_FIELDS.has(key));
    if (unknown.length > 0) {
      throw new AdminApiError(400, 'UNKNOWN_FIELD', `unknown field(s): ${unknown.join(', ')}`, {
        fields: unknown,
      });
    }

    const input = parseCreateInput(body);
    const token = generateToken(deps.tokenFactory);
    const binding = await deps.bindings.create({ ...input, token });

    return adminJson(
      201,
      { client: publicBinding(binding), token },
      { 'cache-control': 'no-store' },
    );
  }

  async function updateClient(id: string, request: AdminRequest): Promise<AdminResponse> {
    const existing = await deps.bindings.get(id);
    if (existing === null) {
      throw new AdminApiError(404, 'CLIENT_NOT_FOUND', `client binding ${id} does not exist`, {
        bindingId: id,
      });
    }

    const body = requireObjectBody(request);
    const unknown = Object.keys(body).filter((key) => !CLIENT_FIELDS.has(key));
    if (unknown.length > 0) {
      throw new AdminApiError(400, 'UNKNOWN_FIELD', `unknown field(s): ${unknown.join(', ')}`, {
        fields: unknown,
      });
    }

    const binding = await deps.bindings.update(id, parsePatch(body));
    const changed = await notifyBindingChanged(deps, id, 'updated');

    const response: Record<string, unknown> = {
      client: publicBinding(binding),
      affectedSessions: changed.affectedSessions,
    };
    if (changed.warning !== undefined) response['warning'] = changed.warning;
    return adminJson(200, response);
  }

  async function deleteClient(id: string): Promise<AdminResponse> {
    const existing = await deps.bindings.get(id);
    if (existing === null) {
      throw new AdminApiError(404, 'CLIENT_NOT_FOUND', `client binding ${id} does not exist`, {
        bindingId: id,
      });
    }

    const removed = await deps.bindings.remove(id);
    if (!removed) {
      throw new AdminApiError(404, 'CLIENT_NOT_FOUND', `client binding ${id} does not exist`, {
        bindingId: id,
      });
    }

    const changed = await notifyBindingChanged(deps, id, 'deleted');
    const response: Record<string, unknown> = {
      id,
      deleted: true,
      affectedSessions: changed.affectedSessions,
    };
    if (changed.warning !== undefined) response['warning'] = changed.warning;
    return adminJson(200, response);
  }

  return adminHandler(async (request): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    if (segments[0] !== 'clients') return null;

    const method = request.method.toUpperCase();
    if (segments.length === 1) {
      if (method === 'GET') return listClients();
      if (method === 'POST') return createClient(request);
      return null;
    }

    if (segments.length === 2) {
      const id = segments[1];
      if (id === undefined) return null;
      if (method === 'PUT') return updateClient(id, request);
      if (method === 'DELETE') return deleteClient(id);
      return null;
    }

    return null;
  });
}
