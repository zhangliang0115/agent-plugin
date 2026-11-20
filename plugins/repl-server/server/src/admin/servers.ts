import type { LogFn } from '../log.ts';
/** Admin API for server configuration, connection control and runtime tests.
 *
 * Each `admin/*` module exports a factory that takes its dependencies and returns a
 * framework-free {@link AdminHandler}. The HTTP shell (RS-07) authenticates the request,
 * parses the JSON body and calls the handler with a plain request descriptor. A handler
 * returns a response or `null` when the path/method is not its own, so several handlers
 * can be composed in one admin router.
 *
 * This module also owns the shared admin primitives (error class, request/response
 * shapes, If-Match parsing, field validators) imported by the other admin modules.
 * Errors always render as `{ error: { code, message, details? } }`.
 *
 * Paths may be passed either admin-relative (`/servers/pg`) or with the `/admin/api`
 * prefix; both are accepted.
 * @module
 */

import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import {
  parseToolDiscoveryConfig,
  type ParseDiscoveryOptions,
} from '../discovery/config.ts';
import {
  DiscoveryConfigError,
  type ToolDiscoveryConfig,
} from '../discovery/types.ts';
import { BUILTIN_SERVER_ID, OFFICIAL_SERVER_ID } from '../db/servers.ts';
import type { ServerToolCounts } from '../db/tools.ts';
import { systemClock, type Clock, type OfficialToolsSync } from '../ports.ts';
import { isSecretRef } from '../secrets/resolve.ts';

// ---------------------------------------------------------------------------
// Shared admin HTTP primitives
// ---------------------------------------------------------------------------

/** Status/code/details triple that {@link errorResponse} renders as the unified error body. */
export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type QueryBag = URLSearchParams | Record<string, string | string[] | undefined>;
export type HeaderBag =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

/** One admin request, already authenticated and JSON-parsed by the HTTP shell. */
export interface AdminRequest {
  method: string;
  /** Path relative to the admin API root, with or without the `/admin/api` prefix. */
  path: string;
  query?: QueryBag;
  headers?: HeaderBag;
  /** Parsed JSON body, or the raw text when the shell did not parse it. */
  body?: unknown;
}

export interface AdminResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Returns `null` when the route is not handled by this factory. */
export type AdminHandler = (request: AdminRequest) => Promise<AdminResponse | null>;

export function adminJson(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): AdminResponse {
  const response: AdminResponse = { status, body };
  if (headers !== undefined) response.headers = headers;
  return response;
}

/** Renders the unified error body: `{ error: { code, message, details? } }`. */
export function errorResponse(error: unknown): AdminResponse {
  if (error instanceof AdminApiError) {
    const body: { error: { code: string; message: string; details?: unknown } } = {
      error: { code: error.code, message: error.message },
    };
    if (error.details !== undefined) body.error.details = error.details;
    return adminJson(error.status, body);
  }

  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      const status = DEPENDENCY_STATUS[code];
      if (status !== undefined) {
        return adminJson(status, { error: { code, message: error.message } });
      }
    }
    return adminJson(500, { error: { code: 'INTERNAL_ERROR', message: error.message } });
  }

  return adminJson(500, { error: { code: 'INTERNAL_ERROR', message: String(error) } });
}

/** Wraps a route body so dependency errors become unified error responses. */
export function adminHandler(
  run: (request: AdminRequest) => Promise<AdminResponse | null> | AdminResponse | null,
): AdminHandler {
  return async (request) => {
    try {
      return await run(request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Bare error codes raised by the storage/pool layers; everything else is a 500. */
const DEPENDENCY_STATUS: Readonly<Record<string, number>> = {
  NOT_FOUND: 404,
  SERVER_NOT_FOUND: 404,
  TOOL_NOT_FOUND: 404,
  CLIENT_NOT_FOUND: 404,
  BINDING_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  CONFLICT: 409,
  SERVER_BUSY: 409,
  SERVER_EXISTS: 409,
  INVALID_ARGUMENT: 400,
  INVALID_BODY: 400,
  WS_INVALID: 400,
  CONFIG_INVALID: 422,
  INVALID_CONFIG: 422,
  IMMUTABLE_SERVER: 422,
  MCP_SERVER_UNAVAILABLE: 503,
  MCP_SERVER_STARTING: 503,
  UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  RUNTIME_UNAVAILABLE: 503,
};

const ADMIN_PREFIX = '/admin/api';

/**
 * Splits and percent-decodes the path. A leading `/admin/api` (or `/api` when the
 * shell already consumed `/admin`) is stripped; empty segments are ignored.
 */
export function requestSegments(request: AdminRequest): string[] {
  let pathname = request.path;
  const queryStart = pathname.indexOf('?');
  if (queryStart !== -1) pathname = pathname.slice(0, queryStart);

  if (pathname === ADMIN_PREFIX) pathname = '/';
  else if (pathname.startsWith(`${ADMIN_PREFIX}/`)) pathname = pathname.slice(ADMIN_PREFIX.length);
  else if (pathname === '/api') pathname = '/';
  else if (pathname.startsWith('/api/')) pathname = pathname.slice('/api'.length);

  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      throw new AdminApiError(400, 'INVALID_PATH', 'path contains an invalid percent escape');
    }
  }
  return segments;
}

export function queryValue(request: AdminRequest, name: string): string | null {
  const query = request.query;
  if (query !== undefined) {
    if (query instanceof URLSearchParams) {
      const value = query.get(name);
      if (value !== null) return value;
    } else {
      const value = query[name] ?? query[name.toLowerCase()];
      if (Array.isArray(value)) {
        if (value.length > 0) return value[0] ?? null;
      } else if (value !== undefined) {
        return value;
      }
    }
  }

  // The shell may hand over the raw path with `?force=true` and no parsed bag.
  const queryStart = request.path.indexOf('?');
  if (queryStart === -1) return null;
  return new URLSearchParams(request.path.slice(queryStart + 1)).get(name);
}

export function headerValue(request: AdminRequest, name: string): string | null {
  const headers = request.headers;
  if (headers === undefined) return null;

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value ?? null;
  }

  const bag = headers as Record<string, string | string[] | undefined>;
  const value = bag[name] ?? bag[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Parses a JSON string body when the shell passed text through; objects pass as-is. */
export function readJsonBody(request: AdminRequest): unknown {
  if (typeof request.body === 'string') {
    try {
      return JSON.parse(request.body);
    } catch {
      throw new AdminApiError(400, 'INVALID_JSON', 'request body is not valid JSON');
    }
  }
  return request.body;
}

export function requireObjectBody(request: AdminRequest): Record<string, unknown> {
  const body = readJsonBody(request);
  if (!isPlainObject(body)) {
    throw new AdminApiError(400, 'INVALID_BODY', 'request body must be a JSON object');
  }
  return body;
}

/** `If-Match` carries the global `meta.revision`; `W/"12"` and `"12"` are accepted. */
export function parseIfMatch(request: AdminRequest): number {
  const raw = headerValue(request, 'if-match');
  if (raw === null || raw.trim() === '') {
    throw new AdminApiError(
      400,
      'IF_MATCH_REQUIRED',
      'If-Match with the current revision is required for this write',
    );
  }
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(raw.trim());
  if (match === null || match[1] === undefined) {
    throw new AdminApiError(400, 'INVALID_IF_MATCH', 'If-Match must carry an integer revision', {
      ifMatch: raw,
    });
  }
  const revision = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new AdminApiError(400, 'INVALID_IF_MATCH', 'If-Match must carry an integer revision', {
      ifMatch: raw,
    });
  }
  return revision;
}

export function assertRevision(current: number, expected: number): void {
  if (current !== expected) {
    throw new AdminApiError(
      409,
      'REVISION_CONFLICT',
      `revision ${expected} does not match current revision ${current}`,
      { expected, current },
    );
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function invalidField(field: string, message: string): AdminApiError {
  return new AdminApiError(400, 'INVALID_FIELD', `${field} ${message}`, { field });
}

export function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new AdminApiError(400, 'UNKNOWN_FIELD', `unknown field(s): ${unknown.join(', ')}`, {
      fields: unknown,
    });
  }
}

export function expectString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; max?: number } = {},
): string {
  if (typeof value !== 'string') throw invalidField(field, 'must be a string');
  if (options.allowEmpty !== true && value.trim() === '') {
    throw invalidField(field, 'must not be empty');
  }
  const max = options.max ?? 4096;
  if (value.length > max) throw invalidField(field, `must be at most ${max} characters`);
  return value;
}

export function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidField(field, 'must be a boolean');
  return value;
}

export function expectInteger(
  value: unknown,
  field: string,
  options: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalidField(field, 'must be an integer');
  }
  if (value < options.min || value > options.max) {
    throw invalidField(field, `must be between ${options.min} and ${options.max}`);
  }
  return value;
}

export function expectStringArray(
  value: unknown,
  field: string,
  options: { includeEmpty?: boolean; maxItems?: number; maxLength?: number } = {},
): string[] {
  if (!Array.isArray(value)) throw invalidField(field, 'must be an array');
  const maxItems = options.maxItems ?? 256;
  if (value.length > maxItems) throw invalidField(field, `must have at most ${maxItems} items`);

  const maxLength = options.maxLength ?? 256;
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string') throw invalidField(`${field}[${index}]`, 'must be a string');
    const text = entry.trim();
    if (text === '' && options.includeEmpty !== true) {
      throw invalidField(`${field}[${index}]`, 'must not be empty');
    }
    if (text.length > maxLength) {
      throw invalidField(`${field}[${index}]`, `must be at most ${maxLength} characters`);
    }
    if (!seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Operation registry for 202 responses
// ---------------------------------------------------------------------------

export type AdminOperationState = 'running' | 'ok' | 'error';

/** Shape returned by 202 connection/refresh endpoints. */
export interface AdminOperation {
  operationId: string;
  kind: string;
  target: string;
  state: AdminOperationState;
  startedAt: string;
  finishedAt?: string;
  error?: { code: string; message: string };
}

export interface OperationLauncher {
  launch(kind: string, target: string, run: () => Promise<unknown> | unknown): AdminOperation;
  get?(operationId: string): AdminOperation | null;
}

/**
 * In-process operation registry used when the admin base does not inject one. The
 * operation runs detached; `get` (wired to `GET /operations/:id` by RS-07) exposes
 * the terminal state. At most `limit` operations are retained.
 */
export function createOperationLauncher(
  clock: Clock = systemClock,
  limit = 200,
): OperationLauncher {
  const operations = new Map<string, AdminOperation>();

  return {
    launch(kind, target, run) {
      const operation: AdminOperation = {
        operationId: `op_${randomUUID().replaceAll('-', '')}`,
        kind,
        target,
        state: 'running',
        startedAt: new Date(clock.now()).toISOString(),
      };
      operations.set(operation.operationId, operation);

      while (operations.size > limit) {
        const oldest = operations.keys().next();
        if (oldest.done === true) break;
        operations.delete(oldest.value);
      }

      void (async () => {
        await run();
      })().then(
        () => {
          operation.state = 'ok';
          operation.finishedAt = new Date(clock.now()).toISOString();
        },
        (error: unknown) => {
          operation.state = 'error';
          operation.finishedAt = new Date(clock.now()).toISOString();
          const code =
            error instanceof AdminApiError
              ? error.code
              : typeof (error as { code?: unknown })?.code === 'string'
                ? String((error as { code: string }).code)
                : 'OPERATION_FAILED';
          operation.error = {
            code,
            message: error instanceof Error ? error.message : String(error),
          };
        },
      );

      return { ...operation };
    },
    get(operationId) {
      const operation = operations.get(operationId);
      return operation === undefined ? null : { ...operation };
    },
  };
}

// ---------------------------------------------------------------------------
// Server domain types (decoded from the `servers` table of 03 §5.1)
// ---------------------------------------------------------------------------

export type SecretValue = string | { $secret: string };
export type CommandArg = string | { $secret: string };
export type ServerTransport = 'stdio' | 'http' | 'builtin';
export type ConnectMode = 'lazy' | 'eager';

export { OFFICIAL_SERVER_ID, BUILTIN_SERVER_ID };

/** API-facing server configuration. Secrets stay as `$secret` references. */
export interface ServerConfig {
  id: string;
  label: string;
  transport: ServerTransport;
  command: string | null;
  args: CommandArg[];
  env: Record<string, SecretValue>;
  cwd: string | null;
  url: string | null;
  headers: Record<string, SecretValue>;
  enabled: boolean;
  connectMode: ConnectMode;
  summary: string | null;
  summarySource: string | null;
  category: string | null;
  tags: string[];
  timeoutMs: number;
  maxConcurrency: number;
  /** Lazy-tool discovery configuration; `null`/absent means a static catalog. */
  toolDiscovery?: ToolDiscoveryConfig | null;
}

export interface ServerRecord extends ServerConfig {
  createdAt: string;
  updatedAt: string;
  /** Per-server config version used by the pool (`cfgVersion`), not the catalog revision. */
  revision: number;
}

/** A committed patch; `envKeys`/`headerKeys` are resolved by this module first. */
export interface ServerConfigPatch {
  label?: string;
  command?: string | null;
  args?: CommandArg[];
  env?: Record<string, SecretValue>;
  cwd?: string | null;
  url?: string | null;
  headers?: Record<string, SecretValue>;
  enabled?: boolean;
  connectMode?: ConnectMode;
  summary?: string | null;
  /** Provenance of `summary`; set by `parseServerPatch` whenever `summary` moves. */
  summarySource?: string | null;
  category?: string | null;
  tags?: string[];
  timeoutMs?: number;
  maxConcurrency?: number;
  /** `null` clears discovery back to static; omitted leaves it unchanged. */
  toolDiscovery?: ToolDiscoveryConfig | null;
}

export interface ServerRuntimeState {
  /** `idle | starting | ready | degraded | reconnecting | failed | disabled`. */
  state: string;
  lastError?: string;
  pid?: number;
}

/**
 * Serialized server shape. Env/header values never leave the process: only key names
 * cross the admin boundary, and secret-backed args are rendered as `<secret:name>`.
 */
export interface ServerView
  extends Omit<ServerRecord, 'args' | 'env' | 'headers'> {
  args: string[];
  envKeys: string[];
  headerKeys: string[];
  /** env key → secret name, for keys backed by a `$secret` reference. */
  envSecrets: Record<string, string>;
  /** header key → secret name. */
  headerSecrets: Record<string, string>;
  /** `args` positions backed by a `$secret` reference. */
  secretArgs: Array<{ index: number; secret: string }>;
  /** Rendered by this module's `viewServer` (`null` for static). */
  toolDiscovery?: ToolDiscoveryConfig | null;
  state: string;
  lastError?: string;
  /** Stored tool rows; present when the caller wired `toolCounts`. */
  toolCount?: number;
  enabledToolCount?: number;
}

/**
 * Persistence contract implemented by the RS-02 repository adapter. `create`/`update`/
 * `remove` bump `meta.revision` in the same transaction and throw
 * `AdminApiError(409, "REVISION_CONFLICT")` (or a coded error mapped to 409) when the
 * expected revision lost the race. They also own catalog/pool reconciliation after commit.
 */
export interface ServerStore {
  list(): Promise<ServerRecord[]>;
  get(id: string): Promise<ServerRecord | null>;
  revision(): Promise<number>;
  create(config: ServerConfig): Promise<{ server: ServerRecord; revision: number }>;
  update(
    id: string,
    patch: ServerConfigPatch,
    expectedRevision: number,
  ): Promise<{ server: ServerRecord; revision: number }>;
  remove(id: string, expectedRevision: number): Promise<{ revision: number }>;
}

/** Runtime control implemented by the connection pool. */
export interface ServerPoolControl {
  state(id: string): Promise<ServerRuntimeState | null>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  refreshTools(id: string): Promise<void>;
  /** Temporary `tools/list`; must not persist a connection or tool rows. */
  test(id: string, options: { timeoutMs: number }): Promise<{ tools: unknown[] }>;
  /** Stops accepting new calls and drains (or aborts when `force`) in-flight calls. */
  retire(id: string, options: { force: boolean }): Promise<{ drained: boolean; inFlight?: number }>;
}

/** Secret-store probe used by `POST /servers/:id/test`; values are never read here. */
export interface AdminSecrets {
  missing(names: readonly string[]): Promise<string[]> | string[];
}

export interface AdminServersDeps {
  servers: ServerStore;
  pool: ServerPoolControl;
  secrets?: AdminSecrets;
  operations?: OperationLauncher;
  clock?: Clock;
  /** Per-server stored tool counts for the list column (`{enabled}/{total}`). */
  toolCounts?: () => ReadonlyMap<string, ServerToolCounts>;
  /** `POST /servers/:id/test` budget; docs freeze 10s. */
  testTimeoutMs?: number;
  /**
   * Lazy `__official__` tool sync. When present,
   * `POST /servers/__official__/tools/refresh` lists official tools from
   * `claude mcp serve` instead of rejecting the builtin server.
   */
  official?: OfficialToolsSync;
  /**
   * Called after `POST /servers/:id/tools/refresh` and `/restart` complete, so
   * assembly can discard the server's pending AI annotation and re-run the
   * auto preview against the new tool set. Best-effort: a failing hook never
   * turns a successful refresh into a failed operation.
   */
  onToolsRefreshed?: (serverId: string) => void | Promise<void>;
  log?: LogFn;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENCY = 8;

const CREATE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'transport',
  'command',
  'args',
  'env',
  'envKeys',
  'cwd',
  'url',
  'headers',
  'headerKeys',
  'enabled',
  'connectMode',
  'summary',
  'category',
  'tags',
  'timeoutMs',
  'maxConcurrency',
  'toolDiscovery',
]);

const PATCH_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'transport',
  'label',
  'command',
  'args',
  'env',
  'envKeys',
  'cwd',
  'url',
  'headers',
  'headerKeys',
  'enabled',
  'connectMode',
  'summary',
  'category',
  'tags',
  'timeoutMs',
  'maxConcurrency',
  'toolDiscovery',
]);

function readTransport(value: unknown): Exclude<ServerTransport, 'builtin'> {
  if (value === undefined) return 'stdio';
  if (value === 'stdio' || value === 'http') return value;
  if (value === 'builtin') {
    throw new AdminApiError(
      422,
      'BUILTIN_RESERVED',
      'builtin servers are seeded by the migration and cannot be registered over the API',
    );
  }
  throw invalidField('transport', 'must be "stdio" or "http"');
}

function readConnectMode(value: unknown): ConnectMode {
  if (value === undefined) return 'eager';
  if (value === 'lazy' || value === 'eager') return value;
  throw invalidField('connectMode', 'must be "lazy" or "eager"');
}

function readSecretValue(value: unknown, field: string): SecretValue {
  if (typeof value === 'string') return value;
  if (isPlainObject(value)) {
    const name = value['$secret'];
    if (typeof name === 'string' && name !== '' && Object.keys(value).length === 1) {
      return { $secret: name };
    }
  }
  throw invalidField(field, 'must be a string or { "$secret": "<name>" }');
}

function readSecretRecord(
  value: unknown,
  field: string,
  pattern: RegExp,
): Record<string, SecretValue> {
  if (!isPlainObject(value)) throw invalidField(field, 'must be an object');
  if (Object.keys(value).length > 256) throw invalidField(field, 'must have at most 256 keys');

  const result: Record<string, SecretValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    // `key === '__proto__'` would hit the prototype setter instead of creating an own key.
    if (key === '' || key === '__proto__' || key.length > 256 || !pattern.test(key)) {
      throw invalidField(field, `contains an invalid key ${JSON.stringify(key)}`);
    }
    result[key] = readSecretValue(entry, `${field}.${key}`);
  }
  return result;
}

function readArgs(value: unknown, field: string): CommandArg[] {
  if (!Array.isArray(value)) throw invalidField(field, 'must be an array');
  if (value.length > 256) throw invalidField(field, 'must have at most 256 items');

  const args: CommandArg[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry === 'string') {
      if (entry.length > 8192) {
        throw invalidField(`${field}[${index}]`, 'must be at most 8192 characters');
      }
      args.push(entry);
      continue;
    }
    args.push(readSecretValue(entry, `${field}[${index}]`) as CommandArg);
  }
  return args;
}

function readKeyList(value: unknown, field: string, pattern: RegExp): string[] {
  if (!Array.isArray(value)) throw invalidField(field, 'must be an array');
  if (value.length > 256) throw invalidField(field, 'must have at most 256 items');
  const keys: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = value[index];
    // Reject `__proto__`: `applySecretKeys` assigns each key and would set the prototype.
    if (typeof key !== 'string' || key === '__proto__' || !pattern.test(key)) {
      throw invalidField(`${field}[${index}]`, 'is not a valid key name');
    }
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function readNullableString(value: unknown, field: string, max = 8192): string | null {
  if (value === null) return null;
  return expectString(value, field, { allowEmpty: true, max });
}

/** Whitespace-only text means "no value"; non-blank text is kept verbatim. */
export function nullIfBlank(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.trim() === '' ? null : value;
}

function readNullableAbsolutePath(value: unknown, field: string): string | null {
  const text = readNullableString(value, field, 4096);
  if (text !== null && text !== '' && !isAbsolute(text)) {
    throw invalidField(field, 'must be an absolute path');
  }
  return text === '' ? null : text;
}

/**
 * Shared validation for `toolDiscovery`. Returns `null` for static; converts
 * discovery errors to the admin 422 shape so every route reports the same code.
 */
function readToolDiscovery(
  value: unknown,
  options?: ParseDiscoveryOptions,
): ToolDiscoveryConfig | null {
  try {
    return parseToolDiscoveryConfig(value, options);
  } catch (error) {
    if (error instanceof DiscoveryConfigError) {
      throw new AdminApiError(error.status, error.code, error.message, error.details);
    }
    throw error;
  }
}

function applySecretKeys(
  base: Record<string, SecretValue>,
  keys: readonly string[],
): Record<string, SecretValue> {
  const next: Record<string, SecretValue> = { ...base };
  for (const key of keys) {
    // `envKeys`/`headerKeys` declare that the value comes from the secret store.
    // An existing `$secret` target is kept: discovery binds keys to `disc.*`
    // names, and a form edit resubmits every key. Only literals (or new keys)
    // are rebound to a same-named secret.
    if (isSecretRef(next[key])) continue;
    next[key] = { $secret: key };
  }
  return next;
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AdminApiError(422, 'INVALID_CONFIG', 'url is not a valid URL', { field: 'url' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AdminApiError(422, 'INVALID_CONFIG', 'url must use http or https', { field: 'url' });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new AdminApiError(
      422,
      'URL_HAS_CREDENTIALS',
      'url must not embed credentials; put them in headers as $secret references',
      { field: 'url' },
    );
  }
}

function assertTransportConfig(
  config: Pick<ServerConfig, 'transport' | 'command' | 'args' | 'url' | 'cwd'>,
): void {
  if (config.transport === 'stdio') {
    if (config.command === null || config.command.trim() === '') {
      throw new AdminApiError(422, 'INVALID_CONFIG', 'stdio servers require "command"', {
        field: 'command',
      });
    }
    if (config.url !== null) {
      throw new AdminApiError(422, 'INVALID_CONFIG', 'stdio servers cannot set "url"', {
        field: 'url',
      });
    }
    return;
  }

  if (config.transport === 'http') {
    if (config.url === null) {
      throw new AdminApiError(422, 'INVALID_CONFIG', 'http servers require "url"', {
        field: 'url',
      });
    }
    assertHttpUrl(config.url);
    if (config.command !== null) {
      throw new AdminApiError(422, 'INVALID_CONFIG', 'http servers cannot set "command"', {
        field: 'command',
      });
    }
    if (config.cwd !== null) {
      throw new AdminApiError(422, 'INVALID_CONFIG', 'http servers cannot set "cwd"', {
        field: 'cwd',
      });
    }
    if (config.args.length > 0) {
      throw new AdminApiError(422, 'INVALID_CONFIG', 'http servers cannot set "args"', {
        field: 'args',
      });
    }
  }
}

export interface ParseCreateServerOptions {
  /**
   * Provenance recorded when the new server carries a non-empty summary.
   * Manual registration (the default) records `manual`; AI apply passes `ai`.
   * A null summary always records a null source.
   */
  summarySource?: 'ai' | 'manual';
}

export function parseCreateServer(
  body: Record<string, unknown>,
  options: ParseCreateServerOptions = {},
): ServerConfig {
  rejectUnknownFields(body, CREATE_FIELDS);

  const rawId = body['id'];
  if (typeof rawId !== 'string' || rawId.trim() === '') {
    throw invalidField('id', 'is required and must be a string');
  }
  const id = rawId.trim();
  if (id === OFFICIAL_SERVER_ID || id === BUILTIN_SERVER_ID) {
    throw new AdminApiError(422, 'BUILTIN_RESERVED', `${id} is reserved for seeded servers`);
  }
  if (!SERVER_ID_PATTERN.test(id)) {
    throw invalidField('id', 'must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  }

  const transport = readTransport(body['transport']);
  const label =
    body['label'] === undefined
      ? id
      : expectString(body['label'], 'label', { max: 128 });

  let command: string | null = null;
  if (body['command'] !== undefined && body['command'] !== null) {
    command = expectString(body['command'], 'command', { max: 4096 });
  }

  let url: string | null = null;
  if (body['url'] !== undefined && body['url'] !== null) {
    url = expectString(body['url'], 'url', { max: 4096 });
  }

  let cwd: string | null = null;
  if (body['cwd'] !== undefined && body['cwd'] !== null) {
    cwd = readNullableAbsolutePath(body['cwd'], 'cwd');
  }

  let env: Record<string, SecretValue> =
    body['env'] === undefined || body['env'] === null
      ? {}
      : readSecretRecord(body['env'], 'env', ENV_KEY_PATTERN);
  if (body['envKeys'] !== undefined) {
    env = applySecretKeys(env, readKeyList(body['envKeys'], 'envKeys', ENV_KEY_PATTERN));
  }

  let headers: Record<string, SecretValue> =
    body['headers'] === undefined || body['headers'] === null
      ? {}
      : readSecretRecord(body['headers'], 'headers', HEADER_KEY_PATTERN);
  if (body['headerKeys'] !== undefined) {
    headers = applySecretKeys(
      headers,
      readKeyList(body['headerKeys'], 'headerKeys', HEADER_KEY_PATTERN),
    );
  }

  const summary =
    body['summary'] === undefined
      ? null
      : nullIfBlank(readNullableString(body['summary'], 'summary'));
  const category =
    body['category'] === undefined ? null : readNullableString(body['category'], 'category', 128);
  const tags = body['tags'] === undefined ? [] : expectStringArray(body['tags'], 'tags', { maxLength: 64 });
  const enabled =
    body['enabled'] === undefined ? true : expectBoolean(body['enabled'], 'enabled');
  const connectMode = readConnectMode(body['connectMode']);
  const timeoutMs =
    body['timeoutMs'] === undefined
      ? DEFAULT_TIMEOUT_MS
      : expectInteger(body['timeoutMs'], 'timeoutMs', { min: 1000, max: 7_200_000 });
  const maxConcurrency =
    body['maxConcurrency'] === undefined
      ? DEFAULT_MAX_CONCURRENCY
      : expectInteger(body['maxConcurrency'], 'maxConcurrency', { min: 1, max: 64 });
  const toolDiscovery = readToolDiscovery(body['toolDiscovery']);

  const config: ServerConfig = {
    id,
    label,
    transport,
    command,
    args: body['args'] === undefined ? [] : readArgs(body['args'], 'args'),
    env,
    cwd,
    url,
    headers,
    enabled,
    connectMode,
    summary,
    summarySource: summary === null ? null : (options.summarySource ?? 'manual'),
    category,
    tags,
    timeoutMs,
    maxConcurrency,
    toolDiscovery,
  };

  assertTransportConfig(config);
  return config;
}

function parseServerPatch(
  current: ServerRecord,
  body: Record<string, unknown>,
): ServerConfigPatch {
  rejectUnknownFields(body, PATCH_FIELDS);

  if ('id' in body) {
    throw new AdminApiError(400, 'IMMUTABLE_FIELD', 'server id cannot be changed', { field: 'id' });
  }
  if ('transport' in body && body['transport'] !== current.transport) {
    throw new AdminApiError(
      422,
      'TRANSPORT_IMMUTABLE',
      'transport cannot change; delete and re-register the server',
      { field: 'transport' },
    );
  }

  const patch: ServerConfigPatch = {};

  if ('label' in body) patch.label = expectString(body['label'], 'label', { max: 128 });
  if ('command' in body) {
    patch.command =
      body['command'] === null
        ? null
        : expectString(body['command'], 'command', { max: 4096 });
  }
  if ('url' in body) {
    patch.url =
      body['url'] === null ? null : expectString(body['url'], 'url', { max: 4096 });
  }
  if ('cwd' in body) patch.cwd = readNullableAbsolutePath(body['cwd'], 'cwd');
  if ('args' in body) patch.args = readArgs(body['args'], 'args');
  if ('enabled' in body) patch.enabled = expectBoolean(body['enabled'], 'enabled');
  if ('connectMode' in body) patch.connectMode = readConnectMode(body['connectMode']);
  if ('summary' in body) {
    patch.summary = nullIfBlank(readNullableString(body['summary'], 'summary'));
    // Only a real summary change moves its provenance: clients send every field
    // on edit, so an unchanged summary must keep an AI-authored source.
    // A manual edit owns the summary; clearing it removes the provenance too.
    if (patch.summary !== current.summary) {
      patch.summarySource = patch.summary === null ? null : 'manual';
    }
  }
  if ('category' in body) {
    patch.category = readNullableString(body['category'], 'category', 128);
  }
  if ('tags' in body) {
    patch.tags = expectStringArray(body['tags'], 'tags', { maxLength: 64 });
  }
  if ('timeoutMs' in body) {
    patch.timeoutMs = expectInteger(body['timeoutMs'], 'timeoutMs', {
      min: 1000,
      max: 7_200_000,
    });
  }
  if ('maxConcurrency' in body) {
    patch.maxConcurrency = expectInteger(body['maxConcurrency'], 'maxConcurrency', {
      min: 1,
      max: 64,
    });
  }
  if ('toolDiscovery' in body) {
    patch.toolDiscovery = readToolDiscovery(body['toolDiscovery']);
  }

  if ('env' in body) patch.env = readSecretRecord(body['env'], 'env', ENV_KEY_PATTERN);
  if ('envKeys' in body) {
    const keys = readKeyList(body['envKeys'], 'envKeys', ENV_KEY_PATTERN);
    patch.env = applySecretKeys(patch.env ?? current.env, keys);
  }
  if ('headers' in body) {
    patch.headers = readSecretRecord(body['headers'], 'headers', HEADER_KEY_PATTERN);
  }
  if ('headerKeys' in body) {
    const keys = readKeyList(body['headerKeys'], 'headerKeys', HEADER_KEY_PATTERN);
    patch.headers = applySecretKeys(patch.headers ?? current.headers, keys);
  }

  if (Object.keys(patch).length === 0) {
    throw new AdminApiError(422, 'EMPTY_PATCH', 'patch does not change any field');
  }

  const merged: ServerRecord = { ...current, ...patch };
  assertTransportConfig(merged);

  if (isBuiltinServer(current)) {
    const allowed = new Set(['label', 'enabled', 'summary', 'category', 'tags']);
    const forbidden = Object.keys(patch).filter((key) => !allowed.has(key));
    if (forbidden.length > 0) {
      throw new AdminApiError(
        422,
        'BUILTIN_RESERVED',
        `builtin servers only allow label/enabled/summary/category/tags (got ${forbidden.join(', ')})`,
        { fields: forbidden },
      );
    }
  }

  return patch;
}

function isBuiltinServer(server: ServerRecord): boolean {
  return (
    server.transport === 'builtin' ||
    server.id === OFFICIAL_SERVER_ID ||
    server.id === BUILTIN_SERVER_ID
  );
}

/** Every `$secret` name referenced by env, headers or args; sorted and deduplicated. */
export function requiredSecretNames(
  config: Pick<ServerConfig, 'env' | 'headers' | 'args'>,
): string[] {
  const names = new Set<string>();
  const collect = (value: unknown): void => {
    if (!isPlainObject(value)) return;
    const name = value['$secret'];
    if (typeof name === 'string' && name !== '') names.add(name);
  };

  for (const value of Object.values(config.env)) collect(value);
  for (const value of Object.values(config.headers)) collect(value);
  for (const arg of config.args) collect(arg);
  return [...names].sort();
}

function readForceFlag(request: AdminRequest): boolean {
  const raw = queryValue(request, 'force');
  if (raw === null || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new AdminApiError(400, 'INVALID_QUERY', 'force must be true or false', {
    parameter: 'force',
  });
}

function renderArg(arg: CommandArg): string {
  return typeof arg === 'string' ? arg : `<secret:${arg.$secret}>`;
}

/** Maps only the keys whose value is a `$secret` reference; literals stay hidden. */
function secretRefs(values: Record<string, SecretValue>): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isSecretRef(value)) refs[key] = value.$secret;
  }
  return refs;
}

/** Projects a record into the value-free admin view. */
function viewServer(
  record: ServerRecord,
  runtime: ServerRuntimeState | null,
  toolCounts?: ServerToolCounts,
): ServerView {
  const fallback = record.enabled
    ? record.transport === 'builtin'
      ? 'ready'
      : 'idle'
    : 'disabled';
  const view: ServerView = {
    id: record.id,
    label: record.label,
    transport: record.transport,
    command: record.command,
    args: record.args.map(renderArg),
    cwd: record.cwd,
    url: record.url,
    envKeys: Object.keys(record.env).sort(),
    headerKeys: Object.keys(record.headers).sort(),
    envSecrets: secretRefs(record.env),
    headerSecrets: secretRefs(record.headers),
    secretArgs: record.args.flatMap((arg, index) =>
      isSecretRef(arg) ? [{ index, secret: arg.$secret }] : [],
    ),
    enabled: record.enabled,
    connectMode: record.connectMode,
    summary: record.summary,
    summarySource: record.summarySource,
    category: record.category,
    tags: [...record.tags],
    timeoutMs: record.timeoutMs,
    maxConcurrency: record.maxConcurrency,
    toolDiscovery: record.toolDiscovery ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
    state: runtime?.state ?? fallback,
  };
  if (runtime?.lastError !== undefined) view.lastError = runtime.lastError;
  if (toolCounts !== undefined) {
    view.toolCount = toolCounts.total;
    view.enabledToolCount = toolCounts.enabled;
  }
  return view;
}

function assertConnectable(server: ServerRecord): void {
  if (isBuiltinServer(server)) {
    throw new AdminApiError(
      422,
      'NOT_CONNECTABLE',
      'builtin servers have no connection to manage',
      { serverId: server.id },
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * `GET/POST /servers`, `GET/PATCH/DELETE /servers/:id`, `POST /servers/:id/{connect,
 * disconnect,restart,test}` and `POST /servers/:id/tools/refresh`.
 *
 * Writes that touch the catalog require `If-Match: <meta.revision>`; a mismatch is a
 * 409 `REVISION_CONFLICT`. Connection/refresh routes return 202 with an operation id.
 */
export function createAdminServersHandler(deps: AdminServersDeps): AdminHandler {
  const clock = deps.clock ?? systemClock;
  const operations = deps.operations ?? createOperationLauncher(clock);
  const testTimeoutMs = deps.testTimeoutMs ?? 10_000;

  async function listServers(): Promise<AdminResponse> {
    const [records, revision] = await Promise.all([deps.servers.list(), deps.servers.revision()]);
    const counts = deps.toolCounts?.();
    const servers = await Promise.all(
      records.map(async (record) =>
        viewServer(record, await deps.pool.state(record.id), counts?.get(record.id)),
      ),
    );
    return adminJson(200, { servers, revision });
  }

  async function getServer(id: string): Promise<AdminResponse> {
    const record = await deps.servers.get(id);
    if (record === null) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${id} does not exist`, {
        serverId: id,
      });
    }
    return adminJson(200, {
      server: viewServer(record, await deps.pool.state(id), deps.toolCounts?.().get(id)),
      revision: await deps.servers.revision(),
    });
  }

  async function createServer(request: AdminRequest): Promise<AdminResponse> {
    const config = parseCreateServer(requireObjectBody(request));

    const existing = await deps.servers.get(config.id);
    if (existing !== null) {
      throw new AdminApiError(409, 'SERVER_EXISTS', `server ${config.id} already exists`, {
        serverId: config.id,
      });
    }

    const { server, revision } = await deps.servers.create(config);
    return adminJson(201, {
      server: viewServer(server, await deps.pool.state(server.id)),
      revision,
    });
  }

  async function updateServer(id: string, request: AdminRequest): Promise<AdminResponse> {
    const expected = parseIfMatch(request);
    const current = await deps.servers.get(id);
    if (current === null) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${id} does not exist`, {
        serverId: id,
      });
    }

    // Validate the patch before the precondition so malformed bodies always get 400/422.
    const patch = parseServerPatch(current, requireObjectBody(request));
    assertRevision(await deps.servers.revision(), expected);
    // A switch from search back to static demotes discovered rows inside the
    // server-store transaction; assembly refreshes the catalog snapshot after
    // the write, so no extra hook is needed here.
    const { server, revision } = await deps.servers.update(id, patch, expected);

    // Disconnect after the write: enabled=false is the gate that rejects new
    // calls, and a failed close must not turn a committed PATCH into a 500.
    if (current.enabled && !server.enabled && server.transport !== 'builtin') {
      try {
        await deps.pool.disconnect(id);
      } catch (error) {
        deps.log?.(
          `disconnect after disabling failed: ${error instanceof Error ? error.message : String(error)}`,
          { level: 'error', scope: 'admin', server: id },
        );
      }
    }

    return adminJson(200, {
      server: viewServer(server, await deps.pool.state(server.id)),
      revision,
    });
  }

  async function deleteServer(id: string, request: AdminRequest): Promise<AdminResponse> {
    const expected = parseIfMatch(request);
    const force = readForceFlag(request);

    const current = await deps.servers.get(id);
    if (current === null) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${id} does not exist`, {
        serverId: id,
      });
    }
    if (isBuiltinServer(current)) {
      throw new AdminApiError(
        422,
        'BUILTIN_RESERVED',
        'seeded servers cannot be deleted',
        { serverId: id },
      );
    }

    assertRevision(await deps.servers.revision(), expected);

    const retirement = await deps.pool.retire(id, { force });
    if (!retirement.drained && !force) {
      throw new AdminApiError(
        409,
        'SERVER_BUSY',
        `server ${id} still has in-flight calls; retry with ?force=true to abort them`,
        { serverId: id, inFlight: retirement.inFlight ?? null },
      );
    }

    const { revision } = await deps.servers.remove(id, expected);
    return adminJson(200, { deleted: true, id, revision, forced: force });
  }

  async function notifyToolsRefreshed(id: string): Promise<void> {
    const hook = deps.onToolsRefreshed;
    if (hook === undefined) return;
    try {
      await hook(id);
    } catch (error) {
      // The tools themselves are already indexed; a stale AI preview is not a
      // reason to report the refresh as failed.
      deps.log?.(
        `onToolsRefreshed failed: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn', scope: 'admin', server: id },
      );
    }
  }

  async function connect(id: string, action: 'connect' | 'disconnect' | 'restart'): Promise<AdminResponse> {
    const server = await deps.servers.get(id);
    if (server === null) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${id} does not exist`, {
        serverId: id,
      });
    }
    assertConnectable(server);
    if (!server.enabled && action !== 'disconnect') {
      throw new AdminApiError(409, 'SERVER_DISABLED', `server ${id} is disabled`, { serverId: id });
    }

    const operation =
      action === 'connect'
        ? operations.launch('connect', id, () => deps.pool.connect(id))
        : action === 'disconnect'
          ? operations.launch('disconnect', id, () => deps.pool.disconnect(id))
          : operations.launch('restart', id, async () => {
              await deps.pool.restart(id);
              await notifyToolsRefreshed(id);
            });

    return adminJson(202, { ...operation });
  }

  async function testServer(id: string): Promise<AdminResponse> {
    const server = await deps.servers.get(id);
    if (server === null) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${id} does not exist`, {
        serverId: id,
      });
    }
    assertConnectable(server);

    const required = requiredSecretNames(server);
    if (required.length > 0 && deps.secrets !== undefined) {
      const missing = await deps.secrets.missing(required);
      if (missing.length > 0) {
        // docs/plan §4.3 freezes both shapes: the unified `error` envelope and the
        // endpoint-specific `{ ok: false, missingSecrets }` body.
        return adminJson(422, {
          ok: false,
          missingSecrets: missing,
          error: {
            code: 'MISSING_SECRETS',
            message: `missing secrets: ${missing.join(', ')}`,
            details: { missingSecrets: missing },
          },
        });
      }
    }

    const startedAt = clock.now();
    let result: { tools: unknown[] };
    try {
      result = await withTimeout(
        deps.pool.test(id, { timeoutMs: testTimeoutMs }),
        testTimeoutMs,
        () =>
          new AdminApiError(503, 'RUNTIME_UNAVAILABLE', `test for server ${id} timed out`, {
            serverId: id,
            timeoutMs: testTimeoutMs,
          }),
      );
    } catch (error) {
      if (error instanceof AdminApiError) throw error;
      throw new AdminApiError(
        503,
        'SERVER_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
        { serverId: id },
      );
    }

    return adminJson(200, {
      ok: true,
      tools: result.tools,
      count: result.tools.length,
      elapsedMs: Math.max(0, clock.now() - startedAt),
    });
  }

  async function refreshTools(id: string): Promise<AdminResponse> {
    const server = await deps.servers.get(id);
    if (server === null) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${id} does not exist`, {
        serverId: id,
      });
    }
    // `__official__` is a builtin transport row with no pool connection, but its
    // tool list can be re-read from `claude mcp serve`. `__builtin__` stays
    // static and is rejected below by assertConnectable.
    if (id === OFFICIAL_SERVER_ID && deps.official !== undefined) {
      if (!server.enabled) {
        throw new AdminApiError(409, 'SERVER_DISABLED', `server ${id} is disabled`, { serverId: id });
      }
      const official = deps.official;
      const operation = operations.launch('tools_refresh', id, async () => {
        const result = await official.ensure({ force: true });
        if (result.status !== 'synced') {
          // The operation carries the readable reason; the GET path stays a 200.
          throw new Error(result.notice ?? `official tools sync ${result.status}`);
        }
      });
      return adminJson(202, { ...operation });
    }
    assertConnectable(server);
    if (!server.enabled) {
      throw new AdminApiError(409, 'SERVER_DISABLED', `server ${id} is disabled`, { serverId: id });
    }

    const operation = operations.launch('tools_refresh', id, async () => {
      await deps.pool.refreshTools(id);
      await notifyToolsRefreshed(id);
    });
    return adminJson(202, { ...operation });
  }

  return adminHandler(async (request): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    if (segments[0] !== 'servers') return null;

    const method = request.method.toUpperCase();
    if (segments.length === 1) {
      if (method === 'GET') return listServers();
      if (method === 'POST') return createServer(request);
      return null;
    }

    const id = segments[1];
    if (id === undefined) return null;

    if (segments.length === 2) {
      if (method === 'GET') return getServer(id);
      if (method === 'PATCH') return updateServer(id, request);
      if (method === 'DELETE') return deleteServer(id, request);
      return null;
    }

    if (segments.length === 3) {
      const action = segments[2];
      if (method !== 'POST' || action === undefined) return null;
      if (action === 'connect' || action === 'disconnect' || action === 'restart') {
        return connect(id, action);
      }
      if (action === 'test') return testServer(id);
      return null;
    }

    if (segments.length === 4 && method === 'POST') {
      if (segments[2] === 'tools' && segments[3] === 'refresh') return refreshTools(id);
      return null;
    }

    return null;
  });
}
