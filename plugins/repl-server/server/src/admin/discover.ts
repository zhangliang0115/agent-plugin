/** Admin API for local environment discovery (`POST /discover`, `POST /discover/secrets`).
 *
 * Probes the fixed config list from 03 §9.1 (Claude Code, Kiro, Cursor); the
 * workspace `.mcp.json` and `.kiro/settings/mcp.json` are scanned only when
 * `deps.workspace` is provided. Built-in suggestions are appended after the scan.
 * The scan never returns secret values:
 * client configs are parsed for server names, commands and env/header key names only, and
 * credential files are only checked for existence. `POST /discover/secrets` re-reads one
 * already-scanned entry on explicit request and copies its env/header values into the
 * secret store under `disc.<serverId>.<env|header>.<key>`; `${NAME}` / `${env:NAME}`
 * placeholders are resolved from the server's own environment first, and values never
 * leave the store.
 *
 * `alreadyExists` compares the candidate `command + args` against registered servers
 * after whitespace normalization; `<workspace>` / `<url>` / `<path>` placeholders match
 * any single corresponding argument. Labels and ids are never used for the comparison.
 * @module
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { isValidSecretName } from '../secrets/store.ts';
import {
  AdminApiError,
  adminHandler,
  adminJson,
  isPlainObject,
  requestSegments,
  requireObjectBody,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from './servers.ts';

export type DiscoverConfidence = 'high' | 'medium' | 'low';

export interface DiscoverSuggestion {
  /** Slug derived from the MCP server name (or a fixed id for built-ins). */
  id: string;
  label: string;
  command: string | null;
  args: string[];
  /** HTTP endpoint for streamable servers discovered in client configs. */
  url: string | null;
  reason: string;
  confidence: DiscoverConfidence;
  alreadyExists: boolean;
  /** Declared env/header keys only; values are never returned by the scan. */
  envKeys: string[];
  headerKeys: string[];
  /** Config file this suggestion came from; `null` for built-ins. */
  sourcePath: string | null;
  /** `mcpServers` entry name in that file; `null` for built-ins. */
  serverName: string | null;
}

/** The subset of a registered server that `alreadyExists` needs. */
export interface DiscoverServerConfig {
  id: string;
  transport: string;
  command: string | null;
  args: readonly unknown[];
  url?: string | null;
}

export interface DiscoverServerLookup {
  list(): Promise<readonly DiscoverServerConfig[]> | readonly DiscoverServerConfig[];
}

/** Name-only secret probe; values must never cross this boundary. */
export interface DiscoverSecretProbe {
  has(name: string): boolean | Promise<boolean>;
  /** Writes one imported literal; absent stores make `POST /discover/secrets` unavailable. */
  set?(name: string, value: string): Promise<void>;
  /** Best-effort undo for a partially failed import; absent stores skip rollback. */
  delete?(name: string): Promise<void>;
}

export interface DiscoverIo {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
}

export interface AdminDiscoverDeps {
  servers: DiscoverServerLookup;
  /** Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Current MCP workspace, used for `.mcp.json` and the filesystem suggestion. */
  workspace?: string;
  /** Defaults to `process.env`; used for presence checks only. */
  env?: Record<string, string | undefined>;
  secrets?: DiscoverSecretProbe;
  io?: DiscoverIo;
  /** Test hook; defaults to an executable check over `PATH`. */
  commandProbe?: (command: string) => Promise<boolean> | boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_PATTERN = /^[A-Za-z0-9-]+$/;
/** A downstream merge of the response through [[Set]] would rewrite the prototype. */
const RESERVED_REF_KEYS: ReadonlySet<string> = new Set(['__proto__']);

/** Defines an own enumerable key; plain assignment of `__proto__` changes the prototype. */
function defineRef(
  target: Record<string, { $secret: string }>,
  key: string,
  name: string,
): void {
  Object.defineProperty(target, key, {
    value: { $secret: name },
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Config files the scan may read; the import route accepts only these paths. */
function configPathsFor(home: string, workspace: string | undefined): string[] {
  const paths = [
    join(home, '.claude.json'),
    join(home, '.kiro', 'settings', 'mcp.json'),
    join(home, '.cursor', 'mcp.json'),
  ];
  if (workspace !== undefined && workspace !== '') {
    paths.push(join(workspace, '.mcp.json'), join(workspace, '.kiro', 'settings', 'mcp.json'));
  }
  return paths;
}

const PLACEHOLDER_PATTERN = /\$\{([^}]*)\}/gu;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolves `${NAME}` / `${env:NAME}` placeholders against the server environment.
 * Returns the final value, or `null` when the value is not a string, has an
 * unresolved/empty placeholder, or resolves to an empty string. Only own string
 * properties of `env` resolve, so names such as `constructor` or `__proto__` cannot
 * pick up prototype members. Callers must not echo the result.
 */
function resolveImportableValue(
  value: unknown,
  env: Record<string, string | undefined>,
): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (!value.includes('${')) return value;

  // Any `${` left after removing well-formed placeholders is an invalid template.
  if (value.replace(PLACEHOLDER_PATTERN, '').includes('${')) return null;

  let missing = false;
  const resolved = value.replace(PLACEHOLDER_PATTERN, (_match, raw: string) => {
    const name = raw.startsWith('env:') ? raw.slice('env:'.length) : raw;
    const substitute =
      ENV_NAME_PATTERN.test(name) && Object.hasOwn(env, name) ? env[name] : undefined;
    if (typeof substitute !== 'string' || substitute === '') {
      missing = true;
      return '';
    }
    return substitute;
  });
  if (missing || resolved === '') return null;
  return resolved;
}

const defaultIo: DiscoverIo = {
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
};

/** POSIX-style executable lookup; repl-server targets macOS/Linux (docs/plan.md). */
async function isExecutableOnPath(
  command: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const pathValue = env['PATH'];
  if (pathValue === undefined) return false;

  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue;
    try {
      await access(join(directory, command), fsConstants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

/**
 * Normalizes one token for `alreadyExists`: trims, collapses internal whitespace and
 * renders `$secret` references as `$secret:<name>`. Non-scalar values return null.
 */
export function normalizeCommandToken(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().replace(/\s+/gu, ' ');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isPlainObject(value)) {
    const name = value['$secret'];
    if (typeof name === 'string' && name !== '') return `$secret:${name}`;
  }
  return null;
}

function isPlaceholder(token: string): boolean {
  return /^<[^<>]+>$/.test(token);
}

/** Compares `command + args` after normalization; placeholders match one argument each. */
export function sameCommandLine(
  candidate: { command: string | null; args: readonly unknown[] },
  existing: { command: string | null; args: readonly unknown[] },
): boolean {
  const candidateCommand = normalizeCommandToken(candidate.command ?? '');
  const existingCommand = normalizeCommandToken(existing.command ?? '');
  if (
    candidateCommand === null ||
    existingCommand === null ||
    candidateCommand !== existingCommand
  ) {
    return false;
  }

  if (candidate.args.length !== existing.args.length) return false;
  for (let index = 0; index < candidate.args.length; index += 1) {
    const left = normalizeCommandToken(candidate.args[index]);
    const right = normalizeCommandToken(existing.args[index]);
    if (left === null || right === null) return false;
    if (left === right) continue;
    if (isPlaceholder(left) || isPlaceholder(right)) continue;
    return false;
  }
  return true;
}

interface ConfigServerEntry {
  name: string;
  command: string | null;
  args: string[];
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
}

interface ConfigProbeResult {
  path: string;
  entries: ConfigServerEntry[];
}

/** Parses one client config; env/header values are discarded, only key names are kept. */
function readConfigEntries(text: string): ConfigServerEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const servers = parsed['mcpServers'];
  if (!isPlainObject(servers)) return [];

  const entries: ConfigServerEntry[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!isPlainObject(raw)) continue;
    const command =
      typeof raw['command'] === 'string' && raw['command'].trim() !== ''
        ? raw['command'].trim()
        : null;
    const url = typeof raw['url'] === 'string' && raw['url'].trim() !== '' ? raw['url'].trim() : null;
    if (command === null && url === null) continue;
    const args = (Array.isArray(raw['args']) ? raw['args'] : [])
      .map(normalizeCommandToken)
      .filter((token): token is string => token !== null);
    const envKeys = isPlainObject(raw['env']) ? Object.keys(raw['env']) : [];
    const headerKeys = isPlainObject(raw['headers']) ? Object.keys(raw['headers']) : [];
    entries.push({ name, command, args, url, envKeys, headerKeys });
  }
  return entries;
}

/** Builds a server id from a client-config server name, avoiding collisions. */
function slugServerId(name: string, used: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, '-')
      .replace(/^[-._]+|[-._]+$/gu, '')
      .slice(0, 48) || 'server';
  const start = /^[A-Za-z0-9]/u.test(base) ? base : `s-${base}`;
  let id = start;
  let suffix = 2;
  while (used.has(id)) {
    id = `${start}-${suffix}`.slice(0, 64);
    suffix += 1;
  }
  used.add(id);
  return id;
}

function suggestion(
  id: string,
  label: string,
  command: string | null,
  args: string[],
  url: string | null,
  reason: string,
  confidence: DiscoverConfidence,
  envKeys: string[] = [],
  headerKeys: string[] = [],
  sourcePath: string | null = null,
  serverName: string | null = null,
): DiscoverSuggestion {
  return {
    id,
    label,
    command,
    args,
    url,
    reason,
    confidence,
    alreadyExists: false,
    envKeys,
    headerKeys,
    sourcePath,
    serverName,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AdminApiError(
                503,
                'DISCOVER_TIMEOUT',
                `discover timed out after ${ms}ms`,
                { timeoutMs: ms },
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `POST /discover`; returns `{ suggestions }` in the fixed §9.1 order. */
export function createAdminDiscoverHandler(deps: AdminDiscoverDeps): AdminHandler {
  const home = deps.homeDir ?? homedir();
  const env = deps.env ?? process.env;
  const io = deps.io ?? defaultIo;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeCommand =
    deps.commandProbe === undefined
      ? (command: string) => isExecutableOnPath(command, env)
      : deps.commandProbe;

  async function hasSecret(name: string): Promise<boolean> {
    const fromEnv = env[name];
    if (fromEnv !== undefined && fromEnv !== '') return true;
    if (deps.secrets === undefined) return false;
    return await deps.secrets.has(name);
  }

  async function run(): Promise<DiscoverSuggestion[]> {
    const configPaths = configPathsFor(home, deps.workspace);

    const [configs, gh, psql, npx, pgpass, githubToken, databaseUrl, existingServers] =
      await Promise.all([
        (async (): Promise<ConfigProbeResult[]> => {
          const found: ConfigProbeResult[] = [];
          for (const path of configPaths) {
            const text = await io.readText(path);
            if (text === null) continue;
            const entries = readConfigEntries(text);
            if (entries === null || entries.length === 0) continue;
            found.push({ path, entries });
          }
          return found;
        })(),
        probeCommand('gh'),
        probeCommand('psql'),
        probeCommand('npx'),
        io.exists(join(home, '.pgpass')),
        hasSecret('GITHUB_TOKEN'),
        hasSecret('DATABASE_URL'),
        deps.servers.list(),
      ]);

    const suggestions: DiscoverSuggestion[] = [];
    const usedIds = new Set([
      'filesystem',
      'github',
      'postgres',
      'sqlite',
      'fetch',
      ...existingServers.map((server) => server.id),
    ]);
    const seen = new Set<string>();

    for (const config of configs) {
      for (const entry of config.entries) {
        const key =
          entry.url !== null
            ? `url:${entry.url}`
            : `cmd:${entry.command ?? ''}\u0000${entry.args.join('\u0000')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push(
          suggestion(
            slugServerId(entry.name, usedIds),
            entry.name,
            entry.command,
            entry.args,
            entry.url,
            `来自 ${config.path}`,
            'high',
            entry.envKeys,
            entry.headerKeys,
            config.path,
            entry.name,
          ),
        );
      }
    }

    suggestions.push(
      suggestion(
        'filesystem',
        '文件系统',
        'npx',
        ['-y', '@modelcontextprotocol/server-filesystem', '<workspace>'],
        null,
        deps.workspace === undefined
          ? npx
            ? 'npx 可用；注册时把 <workspace> 换成要暴露的绝对路径'
            : '未检测到 npx；注册后可能无法启动'
          : npx
            ? `npx 可用；工作区为 ${deps.workspace}`
            : `工作区为 ${deps.workspace}，但未检测到 npx`,
        npx ? (deps.workspace === undefined ? 'medium' : 'high') : 'low',
      ),
    );

    suggestions.push(
      suggestion(
        'github',
        'GitHub',
        'npx',
        ['-y', '@modelcontextprotocol/server-github'],
        null,
        githubToken
          ? '已检测到 GITHUB_TOKEN'
          : gh
            ? '检测到 gh CLI；还需要 GITHUB_TOKEN'
            : '未检测到 gh CLI 或 GITHUB_TOKEN',
        githubToken ? 'high' : gh ? 'medium' : 'low',
        ['GITHUB_TOKEN'],
      ),
    );

    suggestions.push(
      suggestion(
        'postgres',
        'PostgreSQL',
        'npx',
        ['-y', '@modelcontextprotocol/server-postgres', '<url>'],
        null,
        databaseUrl
          ? '已检测到 DATABASE_URL'
          : pgpass
            ? '检测到 ~/.pgpass；还需要 DATABASE_URL'
            : psql
              ? '检测到 psql；还需要 DATABASE_URL'
              : '未检测到 psql、~/.pgpass 或 DATABASE_URL',
        databaseUrl ? 'high' : pgpass || psql ? 'medium' : 'low',
        ['DATABASE_URL'],
      ),
    );

    suggestions.push(
      suggestion(
        'sqlite',
        'SQLite',
        'npx',
        ['-y', '@modelcontextprotocol/server-sqlite', '<path>'],
        null,
        npx
          ? 'npx 可用；注册时把 <path> 换成本地数据库路径'
          : '未检测到 npx；注册后可能无法启动',
        npx ? 'medium' : 'low',
      ),
    );

    suggestions.push(
      suggestion(
        'fetch',
        'Fetch',
        'npx',
        ['-y', '@modelcontextprotocol/server-fetch'],
        null,
        npx ? 'npx 可用' : '未检测到 npx；注册后可能无法启动',
        npx ? 'medium' : 'low',
      ),
    );

    for (const item of suggestions) {
      item.alreadyExists = existingServers.some((server) =>
        item.url !== null
          ? server.url === item.url
          : sameCommandLine(
              { command: item.command, args: item.args },
              { command: server.command, args: server.args },
            ),
      );
    }

    return suggestions;
  }

  /**
   * Copies literal env/header values of one scanned config entry into the secret
   * store and answers only with `$secret` references and key names. Values are
   * never echoed, logged or put into an error message.
   */
  async function importSecrets(request: AdminRequest): Promise<AdminResponse> {
    const store = deps.secrets;
    const write = store?.set;
    if (store === undefined || write === undefined) {
      throw new AdminApiError(
        503,
        'DISCOVER_SECRETS_UNAVAILABLE',
        'the secret store does not accept writes',
      );
    }

    const body = requireObjectBody(request);
    const sourcePath = body['sourcePath'];
    const serverName = body['serverName'];
    const serverId = body['serverId'];
    if (typeof sourcePath !== 'string' || sourcePath === '') {
      throw new AdminApiError(400, 'INVALID_BODY', 'sourcePath must be a non-empty string', {
        field: 'sourcePath',
      });
    }
    if (typeof serverName !== 'string' || serverName === '') {
      throw new AdminApiError(400, 'INVALID_BODY', 'serverName must be a non-empty string', {
        field: 'serverName',
      });
    }
    if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)) {
      throw new AdminApiError(
        400,
        'INVALID_BODY',
        'serverId must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}',
        { field: 'serverId' },
      );
    }

    const requested = resolve(sourcePath);
    const allowedPath = configPathsFor(home, deps.workspace)
      .map((path) => resolve(path))
      .find((path) => path === requested);
    if (allowedPath === undefined) {
      throw new AdminApiError(
        400,
        'DISCOVER_PATH_NOT_ALLOWED',
        'sourcePath is not one of the scanned config files',
        { field: 'sourcePath' },
      );
    }

    const text = await io.readText(allowedPath);
    if (text === null) {
      throw new AdminApiError(404, 'DISCOVER_SOURCE_UNREADABLE', 'source config could not be read', {
        field: 'sourcePath',
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AdminApiError(422, 'DISCOVER_SOURCE_INVALID', 'source config is not valid JSON', {
        field: 'sourcePath',
      });
    }
    const servers = isPlainObject(parsed) ? parsed['mcpServers'] : undefined;
    if (!isPlainObject(servers) || !Object.hasOwn(servers, serverName)) {
      throw new AdminApiError(
        404,
        'DISCOVER_SERVER_NOT_FOUND',
        'serverName was not found in the source config',
        { field: 'serverName' },
      );
    }
    const entry = servers[serverName];
    if (!isPlainObject(entry)) {
      throw new AdminApiError(
        404,
        'DISCOVER_SERVER_NOT_FOUND',
        'serverName was not found in the source config',
        { field: 'serverName' },
      );
    }

    // Checked before the first write so a registered id never overwrites its
    // existing `disc.*` keys.
    const registered = await deps.servers.list();
    if (registered.some((server) => server.id === serverId)) {
      throw new AdminApiError(
        409,
        'SERVER_EXISTS',
        `server ${serverId} is already registered`,
        { serverId },
      );
    }

    const envRefs: Record<string, { $secret: string }> = {};
    const headerRefs: Record<string, { $secret: string }> = {};
    const imported: string[] = [];
    /** Names that did not exist before this request; only these are rolled back. */
    const created: string[] = [];
    const skipped: string[] = [];
    const groups = [
      { field: entry['env'], kind: 'env', pattern: ENV_KEY_PATTERN, target: envRefs },
      {
        field: entry['headers'],
        kind: 'header',
        pattern: HEADER_KEY_PATTERN,
        target: headerRefs,
      },
    ] as const;

    try {
      for (const group of groups) {
        if (!isPlainObject(group.field)) continue;
        for (const [key, value] of Object.entries(group.field)) {
          // Keys outside the server API's env/header patterns cannot be declared
          // through `envKeys`/`headerKeys` either, so they are dropped silently.
          // `__proto__` only reaches here as an env key; it is reported as skipped
          // because a consumer merging the response would pollute its prototype.
          if (!group.pattern.test(key) || RESERVED_REF_KEYS.has(key)) {
            skipped.push(key);
            continue;
          }
          const name = `disc.${serverId}.${group.kind}.${key}`;
          const resolved = resolveImportableValue(value, env);
          if (resolved === null || !isValidSecretName(name)) {
            skipped.push(key);
            continue;
          }
          const existed = await store.has(name);
          await write(name, resolved);
          if (!existed) created.push(name);
          defineRef(group.target, key, name);
          imported.push(name);
        }
      }
    } catch {
      // Best effort: undo only secrets this request created. Overwritten keys keep
      // their new value, so a pre-existing secret is never deleted. The error message
      // is fixed so a store error can never echo a secret value.
      const remove = store.delete;
      if (remove !== undefined) {
        for (const name of created) {
          try {
            await remove(name);
          } catch {
            // keep rolling back the rest
          }
        }
      }
      throw new AdminApiError(
        500,
        'DISCOVER_SECRET_WRITE_FAILED',
        'an imported secret could not be stored',
      );
    }

    return adminJson(200, {
      env: envRefs,
      headers: headerRefs,
      imported,
      skipped: [...new Set(skipped)],
    });
  }

  return adminHandler(async (request: AdminRequest): Promise<AdminResponse | null> => {
    const method = request.method.toUpperCase();
    const segments = requestSegments(request);
    if (method === 'POST' && segments.length === 2 && segments[0] === 'discover' && segments[1] === 'secrets') {
      return await importSecrets(request);
    }
    if (segments.length !== 1 || segments[0] !== 'discover') return null;
    if (method !== 'POST') return null;

    const suggestions = await withTimeout(run(), timeoutMs);
    return adminJson(200, { suggestions });
  });
}
