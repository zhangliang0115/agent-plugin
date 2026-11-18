import { randomUUID } from 'node:crypto';

import {
  canonicalToolDiscovery,
  parseToolDiscoveryConfig,
} from '../discovery/config.ts';
import {
  DiscoveryConfigError,
  type ToolDiscoveryConfig,
} from '../discovery/types.ts';
import { SecretStoreError, assertSecretName, type SecretStore } from '../secrets/store.ts';
import {
  assertServerUrl,
  collectSecretNames,
  fieldKeys,
  findMissingSecrets,
  formatSecretPlaceholder,
  isSecretRef,
  parseSecretPlaceholder,
  redactArgs,
  resolveServerSecrets,
  type SecretRef,
  type SecretField,
} from '../secrets/resolve.ts';

/**
 * Admin-side secrets and config transfer, independent of any HTTP framework.
 *
 * Every read shape here is safe to serialize: env/header values are represented
 * by key names only, secret-backed args use `<secret:name>` placeholders, and
 * exports never contain `$secret` references or plaintext values. Secrets are
 * written only through `PUT /secrets/:name` (mapped by the caller to
 * `putSecret`).
 * @module
 */

export type ServerTransport = 'stdio' | 'http' | 'builtin';
export type ImportableTransport = 'stdio' | 'http';
export type ConnectMode = 'lazy' | 'eager';

/** Server row as exposed by the repository port (values decoded, refs intact). */
export interface ServerConfigRecord {
  id: string;
  label: string;
  transport: ServerTransport;
  command?: string | null;
  args?: readonly (string | SecretRef)[] | null;
  env?: SecretField | null;
  headers?: SecretField | null;
  cwd?: string | null;
  url?: string | null;
  enabled?: boolean;
  connectMode?: ConnectMode;
  summary?: string | null;
  category?: string | null;
  tags?: readonly string[] | null;
  timeoutMs?: number;
  maxConcurrency?: number;
  /** Decoded discovery config; absent or null means static. */
  toolDiscovery?: ToolDiscoveryConfig | null;
}

/** `GET /servers` row: names and placeholders only, never values. */
export interface ServerView {
  id: string;
  label: string;
  transport: ServerTransport;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  connectMode: ConnectMode;
  summary?: string;
  category?: string;
  tags: string[];
  timeoutMs: number;
  maxConcurrency: number;
  toolDiscovery?: ToolDiscoveryConfig;
  missingSecrets: string[];
}

export interface SecretStatus {
  name: string;
  configured: boolean;
}

export interface ConfigServerEntry {
  id: string;
  label: string;
  transport: ImportableTransport;
  command?: string;
  args?: string[];
  /**
   * Key name -> `<secret:name>` placeholder, or null when the value is a
   * (non-secret) literal. Literals never leave the process.
   */
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
  cwd?: string;
  url?: string;
  enabled: boolean;
  connectMode: ConnectMode;
  summary?: string;
  category?: string;
  tags: string[];
  timeoutMs: number;
  maxConcurrency: number;
  /** Present only for lazy-discovery servers; absent means static. */
  toolDiscovery?: ToolDiscoveryConfig;
}

export interface ConfigDocument {
  version: 1;
  servers: ConfigServerEntry[];
}

export interface ConfigDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/** One validation finding, including the discovery code when applicable. */
export interface ConfigImportIssue {
  path: string;
  message: string;
  code?: string;
  details?: unknown;
}

export interface ConfigImportDryRun {
  valid: boolean;
  diff: ConfigDiff;
  /** Present only when the document has validation errors. */
  errors?: string[];
  /** Structured form of `errors` (discovery issues carry their 422 code). */
  issues?: ConfigImportIssue[];
  /** Referenced secrets without a stored value. Warnings, not blockers. */
  missingSecrets?: string[];
}

export interface ConfigImportStarted {
  operationId: string;
}

export interface ConfigImportInput {
  upserts: ServerConfigRecord[];
  removals: string[];
}

export interface ConfigRepository {
  listServers():
    | Promise<readonly ServerConfigRecord[]>
    | readonly ServerConfigRecord[];
  getServer(
    id: string,
  ): Promise<ServerConfigRecord | null> | ServerConfigRecord | null;
}

export interface ConfigImportTarget {
  applyImport(input: ConfigImportInput): Promise<void> | void;
}

export interface OperationStartInput {
  kind: string;
  target?: string;
  run: () => Promise<void>;
}

export interface OperationStarter {
  start(input: OperationStartInput): string;
}

export interface ConfigAdminDeps {
  repository: ConfigRepository;
  importTarget: ConfigImportTarget;
  secrets: SecretStore;
  /** Optional 202-operation registry; without it imports run inline. */
  operations?: OperationStarter;
  newOperationId?: () => string;
}

export interface ResolvedLaunchConfig {
  env: Record<string, string>;
  headers: Record<string, string>;
  args: string[];
  url?: string;
}

export type ServerSecretCheck =
  | { ok: true; resolved: ResolvedLaunchConfig }
  | { ok: false; missingSecrets: string[] };

export interface ConfigAdmin {
  listServers(): Promise<ServerView[]>;
  getServer(id: string): Promise<ServerView | null>;
  listSecrets(): Promise<SecretStatus[]>;
  putSecret(name: string, value: string): Promise<SecretStatus>;
  /**
   * Preflight for `POST /servers/:id/test`. When a value is missing the caller
   * answers 422 with `missingSecrets` and does not attempt a connection.
   */
  checkServerSecrets(id: string): Promise<ServerSecretCheck>;
  exportConfig(): Promise<ConfigDocument>;
  importConfig(
    input: unknown,
    options?: { dryRun?: boolean },
  ): Promise<ConfigImportDryRun | ConfigImportStarted>;
}

export class ConfigValidationError extends Error {
  readonly code = 'CONFIG_INVALID';
  readonly errors: readonly string[];
  readonly issues: readonly ConfigImportIssue[];

  constructor(errors: readonly string[], issues: readonly ConfigImportIssue[] = []) {
    super(`config import rejected: ${errors.join('; ')}`);
    this.name = 'ConfigValidationError';
    this.errors = [...errors];
    this.issues = [...issues];
  }
}

export class ServerNotFoundError extends Error {
  readonly code = 'SERVER_NOT_FOUND';
  readonly serverId: string;

  constructor(serverId: string) {
    super(`server ${JSON.stringify(serverId)} not found`);
    this.name = 'ServerNotFoundError';
    this.serverId = serverId;
  }
}

const INTERNAL_SERVER_IDS: ReadonlySet<string> = new Set(['__official__', '__builtin__']);
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENCY = 8;
const MAX_TIMEOUT_MS = 7_200_000;
const MAX_CONCURRENCY = 1_024;

interface RawServerEntry {
  key?: string;
  value: unknown;
  where: string;
}

interface ImportPlan {
  valid: boolean;
  servers: ServerConfigRecord[];
  errors: string[];
  issues: ConfigImportIssue[];
  diff: ConfigDiff;
  dryRun: ConfigImportDryRun;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkSecretName(name: string, path: string, errors: string[]): boolean {
  try {
    assertSecretName(name);
    return true;
  } catch (error) {
    errors.push(`${path}: ${messageOf(error)}`);
    return false;
  }
}

function readOptionalString(
  value: unknown,
  path: string,
  errors: string[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string`);
    return undefined;
  }
  return value;
}

function readOptionalBoolean(
  value: unknown,
  path: string,
  errors: string[],
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    errors.push(`${path} must be a boolean`);
    return undefined;
  }
  return value;
}

function readConnectMode(
  value: unknown,
  path: string,
  errors: string[],
): ConnectMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'lazy' || value === 'eager') return value;
  errors.push(`${path} must be "lazy" or "eager"`);
  return undefined;
}

function readOptionalInteger(
  value: unknown,
  path: string,
  fallback: number,
  minimum: number,
  maximum: number,
  errors: string[],
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    errors.push(`${path} must be an integer between ${minimum} and ${maximum}`);
    return fallback;
  }
  return value;
}

function readStringArray(value: unknown, path: string, errors: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of strings`);
    return [];
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      errors.push(`${path}[${index}] must be a string`);
      continue;
    }
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

function normalizeSecretField(
  rawValue: unknown,
  rawKeys: unknown,
  valuePath: string,
  keysPath: string,
  errors: string[],
): Record<string, string | SecretRef> {
  const field: Record<string, string | SecretRef> = {};

  if (rawValue !== undefined && rawValue !== null) {
    if (!isRecord(rawValue)) {
      errors.push(`${valuePath} must be an object`);
    } else {
      for (const [key, value] of Object.entries(rawValue)) {
        if (!checkSecretName(key, `${valuePath}.${key}`, errors)) continue;
        if (value === null) {
          // Export uses null for non-secret literal values; they never travel.
          continue;
        }
        if (typeof value === 'string') {
          const placeholder = parseSecretPlaceholder(value);
          if (placeholder === undefined) {
            field[key] = value;
          } else if (checkSecretName(placeholder, `${valuePath}.${key}`, errors)) {
            field[key] = { $secret: placeholder };
          }
        } else if (isSecretRef(value)) {
          if (checkSecretName(value.$secret, `${valuePath}.${key}`, errors)) {
            field[key] = { $secret: value.$secret };
          }
        } else {
          errors.push(`${valuePath}.${key} must be a string or { "$secret": name }`);
        }
      }
    }
  }

  if (rawKeys !== undefined && rawKeys !== null) {
    if (!Array.isArray(rawKeys)) {
      errors.push(`${keysPath} must be an array of key names`);
    } else {
      for (const [index, key] of rawKeys.entries()) {
        if (typeof key !== 'string') {
          errors.push(`${keysPath}[${index}] must be a string`);
          continue;
        }
        if (!checkSecretName(key, `${keysPath}[${index}]`, errors)) continue;
        if (!Object.hasOwn(field, key)) field[key] = { $secret: key };
      }
    }
  }

  return field;
}

function normalizeArgs(
  rawValue: unknown,
  path: string,
  errors: string[],
): Array<string | SecretRef> {
  if (rawValue === undefined || rawValue === null) return [];
  if (!Array.isArray(rawValue)) {
    errors.push(`${path} must be an array`);
    return [];
  }

  const args: Array<string | SecretRef> = [];
  for (const [index, arg] of rawValue.entries()) {
    if (typeof arg === 'string') {
      const placeholder = parseSecretPlaceholder(arg);
      if (placeholder === undefined) {
        args.push(arg);
      } else if (checkSecretName(placeholder, `${path}[${index}]`, errors)) {
        args.push({ $secret: placeholder });
      }
    } else if (isSecretRef(arg)) {
      if (checkSecretName(arg.$secret, `${path}[${index}]`, errors)) {
        args.push({ $secret: arg.$secret });
      }
    } else {
      errors.push(`${path}[${index}] must be a string or { "$secret": name }`);
    }
  }
  return args;
}

function normalizeServerEntry(
  raw: RawServerEntry,
  errors: string[],
  issues: ConfigImportIssue[],
): ServerConfigRecord | null {
  const where = raw.where;
  const value = raw.value;
  if (!isRecord(value)) {
    errors.push(`${where} must be an object`);
    return null;
  }

  const id = typeof value.id === 'string' ? value.id : raw.key;
  if (id === undefined || id === '') {
    errors.push(`${where}: id is required`);
    return null;
  }
  if (!SERVER_ID_PATTERN.test(id)) {
    errors.push(`${where}: invalid id ${JSON.stringify(id)}`);
    return null;
  }
  if (id.startsWith('__')) {
    errors.push(`${where}: id ${JSON.stringify(id)} is reserved for built-in servers`);
    return null;
  }

  const rawTransport = value.transport;
  let transport: ImportableTransport;
  if (rawTransport === 'builtin') {
    errors.push(`${where}: built-in servers cannot be imported`);
    return null;
  }
  if (rawTransport === 'stdio' || rawTransport === 'http') {
    transport = rawTransport;
  } else if (rawTransport !== undefined) {
    errors.push(`${where}.transport must be "stdio" or "http"`);
    return null;
  } else if (typeof value.url === 'string' && value.url !== '') {
    transport = 'http';
  } else if (typeof value.command === 'string' && value.command !== '') {
    transport = 'stdio';
  } else {
    errors.push(`${where}: transport is required when neither command nor url is set`);
    return null;
  }

  const command = readOptionalString(value.command, `${where}.command`, errors);
  const cwd = readOptionalString(value.cwd, `${where}.cwd`, errors);
  const summary = readOptionalString(value.summary, `${where}.summary`, errors);
  const category = readOptionalString(value.category, `${where}.category`, errors);
  const rawLabel = readOptionalString(value.label, `${where}.label`, errors);
  const label = rawLabel !== undefined && rawLabel.trim() !== '' ? rawLabel : id;

  const urlProvided = value.url !== undefined && value.url !== null;
  let url: string | undefined;
  if (urlProvided) {
    if (typeof value.url !== 'string') {
      errors.push(
        `${where}.url must be a plain string; put credentials in headers as $secret references`,
      );
    } else {
      try {
        url = assertServerUrl(value.url).toString();
      } catch (error) {
        errors.push(`${where}.url: ${messageOf(error)}`);
      }
    }
  }

  if (transport === 'stdio') {
    if (command === undefined || command.trim() === '') {
      errors.push(`${where}.command is required for stdio servers`);
    }
    if (urlProvided) errors.push(`${where}.url is not allowed for stdio servers`);
  } else {
    if (!urlProvided) errors.push(`${where}.url is required for http servers`);
    if (command !== undefined && command.trim() !== '') {
      errors.push(`${where}.command is not allowed for http servers`);
    }
  }

  const args = normalizeArgs(value.args, `${where}.args`, errors);
  const env = normalizeSecretField(
    value.env,
    value.envKeys,
    `${where}.env`,
    `${where}.envKeys`,
    errors,
  );
  const headers = normalizeSecretField(
    value.headers,
    value.headerKeys,
    `${where}.headers`,
    `${where}.headerKeys`,
    errors,
  );

  // The discovery config must go through the same §2.2 validator as PATCH;
  // silently dropping it would make export → import lose lazy mode (07 §2.3).
  let toolDiscovery: ToolDiscoveryConfig | undefined;
  if (value.toolDiscovery !== undefined && value.toolDiscovery !== null) {
    try {
      const parsed = parseToolDiscoveryConfig(value.toolDiscovery, {
        field: `${where}.toolDiscovery`,
      });
      if (parsed !== null) toolDiscovery = parsed;
    } catch (error) {
      if (!(error instanceof DiscoveryConfigError)) throw error;
      errors.push(`${where}.toolDiscovery: ${error.message}`);
      issues.push({
        path: `${where}.toolDiscovery`,
        message: error.message,
        code: error.code,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }
  }

  return {
    id,
    label,
    transport,
    command,
    args,
    env,
    headers,
    cwd,
    url,
    enabled: readOptionalBoolean(value.enabled, `${where}.enabled`, errors) ?? true,
    connectMode: readConnectMode(value.connectMode, `${where}.connectMode`, errors) ?? 'lazy',
    summary,
    category,
    tags: readStringArray(value.tags, `${where}.tags`, errors),
    ...(toolDiscovery === undefined ? {} : { toolDiscovery }),
    timeoutMs: readOptionalInteger(
      value.timeoutMs,
      `${where}.timeoutMs`,
      DEFAULT_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS,
      errors,
    ),
    maxConcurrency: readOptionalInteger(
      value.maxConcurrency,
      `${where}.maxConcurrency`,
      DEFAULT_MAX_CONCURRENCY,
      1,
      MAX_CONCURRENCY,
      errors,
    ),
  };
}

function normalizeDocument(
  input: unknown,
  errors: string[],
  issues: ConfigImportIssue[],
): ServerConfigRecord[] {
  if (!isRecord(input)) {
    errors.push('config must be a JSON object');
    return [];
  }
  if (input.version !== undefined && input.version !== 1) {
    errors.push(`unsupported config version ${JSON.stringify(input.version)}`);
  }

  const rawServers = input.servers;
  const entries: RawServerEntry[] = [];
  if (Array.isArray(rawServers)) {
    for (const [index, value] of rawServers.entries()) {
      entries.push({ value, where: `servers[${index}]` });
    }
  } else if (isRecord(rawServers)) {
    for (const [key, value] of Object.entries(rawServers)) {
      entries.push({ key, value, where: `servers.${key}` });
    }
  } else {
    errors.push('config.servers must be an array or an object keyed by server id');
    return [];
  }

  const servers: ServerConfigRecord[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (!isRecord(raw.value)) {
      errors.push(`${raw.where} must be an object`);
      continue;
    }
    const server = normalizeServerEntry(
      { key: raw.key, value: raw.value, where: raw.where },
      errors,
      issues,
    );
    if (server === null) continue;
    if (seen.has(server.id)) {
      errors.push(`duplicate server id ${JSON.stringify(server.id)}`);
      continue;
    }
    seen.add(server.id);
    servers.push(server);
  }
  return servers;
}

function isManagedServer(server: ServerConfigRecord): boolean {
  return (
    server.transport !== 'builtin' &&
    !INTERNAL_SERVER_IDS.has(server.id) &&
    !server.id.startsWith('__')
  );
}

function canonicalField(field: SecretField | null | undefined): Array<[string, string]> {
  return Object.entries(field ?? {})
    .map(([key, value]): [string, string] => [
      key,
      isSecretRef(value) ? `secret:${value.$secret}` : `literal:${value}`,
    ])
    .sort(([left], [right]) => left.localeCompare(right));
}

function canonicalArg(arg: string | SecretRef): string {
  return typeof arg === 'string' ? `literal:${arg}` : `secret:${arg.$secret}`;
}

function canonicalServer(server: ServerConfigRecord): string {
  return JSON.stringify({
    id: server.id,
    label: server.label,
    transport: server.transport,
    command: server.command ?? '',
    args: (server.args ?? []).map(canonicalArg),
    env: canonicalField(server.env),
    headers: canonicalField(server.headers),
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    enabled: server.enabled ?? true,
    connectMode: server.connectMode ?? 'lazy',
    summary: server.summary ?? '',
    category: server.category ?? '',
    tags: [...(server.tags ?? [])].map((tag) => tag.trim()).filter(Boolean).sort(),
    timeoutMs: server.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxConcurrency: server.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    toolDiscovery: canonicalToolDiscovery(server.toolDiscovery),
  });
}

function diffServers(
  current: readonly ServerConfigRecord[],
  next: readonly ServerConfigRecord[],
): ConfigDiff {
  const currentById = new Map<string, ServerConfigRecord>();
  for (const server of current) {
    if (isManagedServer(server)) currentById.set(server.id, server);
  }
  const nextById = new Map<string, ServerConfigRecord>();
  for (const server of next) nextById.set(server.id, server);

  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [id, server] of nextById) {
    const existing = currentById.get(id);
    if (existing === undefined) added.push(id);
    else if (canonicalServer(existing) !== canonicalServer(server)) changed.push(id);
  }
  for (const id of currentById.keys()) {
    if (!nextById.has(id)) removed.push(id);
  }

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
  };
}

async function buildImportPlan(
  input: unknown,
  current: readonly ServerConfigRecord[],
  secrets: SecretStore,
): Promise<ImportPlan> {
  const errors: string[] = [];
  const issues: ConfigImportIssue[] = [];
  const servers = normalizeDocument(input, errors, issues);
  const diff = diffServers(current, servers);

  const referenced = new Set<string>();
  for (const server of servers) {
    for (const name of collectSecretNames(server)) referenced.add(name);
  }
  const missingSecrets: string[] = [];
  for (const name of [...referenced].sort()) {
    if ((await secrets.get(name)) === undefined) missingSecrets.push(name);
  }

  const dryRun: ConfigImportDryRun = { valid: errors.length === 0, diff };
  if (errors.length > 0) dryRun.errors = errors;
  if (issues.length > 0) dryRun.issues = issues;
  if (missingSecrets.length > 0) dryRun.missingSecrets = missingSecrets;

  return { valid: errors.length === 0, servers, errors, issues, diff, dryRun };
}

function toServerView(
  server: ServerConfigRecord,
  missingSecrets: string[],
): ServerView {
  const view: ServerView = {
    id: server.id,
    label: server.label,
    transport: server.transport,
    args: redactArgs(server.args),
    envKeys: fieldKeys(server.env),
    headerKeys: fieldKeys(server.headers),
    enabled: server.enabled ?? true,
    connectMode: server.connectMode ?? 'lazy',
    tags: [...(server.tags ?? [])],
    timeoutMs: server.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxConcurrency: server.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    missingSecrets,
  };
  if (server.command !== undefined && server.command !== null) {
    view.command = server.command;
  }
  if (server.cwd !== undefined && server.cwd !== null) view.cwd = server.cwd;
  if (server.url !== undefined && server.url !== null) view.url = server.url;
  if (server.summary !== undefined && server.summary !== null) {
    view.summary = server.summary;
  }
  if (server.category !== undefined && server.category !== null) {
    view.category = server.category;
  }
  if (server.toolDiscovery !== undefined && server.toolDiscovery !== null) {
    view.toolDiscovery = server.toolDiscovery;
  }
  return view;
}

function toConfigEntry(server: ServerConfigRecord): ConfigServerEntry {
  if (server.transport === 'builtin') {
    throw new Error(`built-in server ${JSON.stringify(server.id)} cannot be exported`);
  }
  const entry: ConfigServerEntry = {
    id: server.id,
    label: server.label,
    transport: server.transport,
    enabled: server.enabled ?? true,
    connectMode: server.connectMode ?? 'lazy',
    tags: [...(server.tags ?? [])],
    timeoutMs: server.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxConcurrency: server.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
  };
  if (server.command !== undefined && server.command !== null) {
    entry.command = server.command;
  }
  const args = redactArgs(server.args);
  if (args.length > 0) entry.args = args;
  const env = placeholderField(server.env);
  if (Object.keys(env).length > 0) entry.env = env;
  const headers = placeholderField(server.headers);
  if (Object.keys(headers).length > 0) entry.headers = headers;
  if (server.cwd !== undefined && server.cwd !== null) entry.cwd = server.cwd;
  if (server.url !== undefined && server.url !== null) entry.url = server.url;
  if (server.summary !== undefined && server.summary !== null) {
    entry.summary = server.summary;
  }
  if (server.category !== undefined && server.category !== null) {
    entry.category = server.category;
  }
  if (server.toolDiscovery !== undefined && server.toolDiscovery !== null) {
    entry.toolDiscovery = server.toolDiscovery;
  }
  return entry;
}

/**
 * Export form of an env/header map: key names plus `<secret:name>` placeholders
 * for refs. Literal values become null so no value ever leaves the process.
 */
function placeholderField(
  field: SecretField | null | undefined,
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(field ?? {})) {
    result[key] = isSecretRef(value) ? formatSecretPlaceholder(value.$secret) : null;
  }
  return result;
}

function defaultNewOperationId(): string {
  return `op_${randomUUID()}`;
}

export function createConfigAdmin(deps: ConfigAdminDeps): ConfigAdmin {
  const { repository, importTarget, secrets } = deps;
  const newOperationId = deps.newOperationId ?? defaultNewOperationId;

  return {
    async listServers(): Promise<ServerView[]> {
      const servers = [...(await repository.listServers())].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      const views: ServerView[] = [];
      for (const server of servers) {
        views.push(toServerView(server, await findMissingSecrets(secrets, server)));
      }
      return views;
    },

    async getServer(id: string): Promise<ServerView | null> {
      const server = await repository.getServer(id);
      if (server === null) return null;
      return toServerView(server, await findMissingSecrets(secrets, server));
    },

    async listSecrets(): Promise<SecretStatus[]> {
      const referenced = new Set<string>();
      for (const server of await repository.listServers()) {
        for (const name of collectSecretNames(server)) referenced.add(name);
      }
      const stored = new Set(await secrets.listNames());
      const names = [...new Set([...stored, ...referenced])].sort();
      return names.map((name) => ({ name, configured: stored.has(name) }));
    },

    async putSecret(name: string, value: string): Promise<SecretStatus> {
      assertSecretName(name);
      if (typeof value !== 'string' || value.length === 0) {
        throw new SecretStoreError(
          'SECRET_VALUE_INVALID',
          'secret values must be non-empty strings',
        );
      }
      await secrets.set(name, value);
      return { name, configured: true };
    },

    async checkServerSecrets(id: string): Promise<ServerSecretCheck> {
      const server = await repository.getServer(id);
      if (server === null) throw new ServerNotFoundError(id);
      const resolved = await resolveServerSecrets(secrets, server);
      if (resolved.missingSecrets.length > 0) {
        return { ok: false, missingSecrets: resolved.missingSecrets };
      }
      const launch: ResolvedLaunchConfig = {
        env: resolved.env,
        headers: resolved.headers,
        args: resolved.args,
      };
      if (resolved.url !== undefined) launch.url = resolved.url;
      return { ok: true, resolved: launch };
    },

    async exportConfig(): Promise<ConfigDocument> {
      const servers = [...(await repository.listServers())]
        .filter(isManagedServer)
        .map(toConfigEntry)
        .sort((left, right) => left.id.localeCompare(right.id));
      return { version: 1, servers };
    },

    async importConfig(
      input: unknown,
      options: { dryRun?: boolean } = {},
    ): Promise<ConfigImportDryRun | ConfigImportStarted> {
      const plan = await buildImportPlan(input, await repository.listServers(), secrets);
      if (options.dryRun === true) return plan.dryRun;
      if (!plan.valid) throw new ConfigValidationError(plan.errors, plan.issues);

      const run = async (): Promise<void> => {
        await importTarget.applyImport({
          upserts: plan.servers,
          removals: plan.diff.removed,
        });
      };

      if (deps.operations !== undefined) {
        return {
          operationId: deps.operations.start({
            kind: 'config_import',
            target: 'config',
            run,
          }),
        };
      }

      await run();
      return { operationId: newOperationId() };
    },
  };
}
