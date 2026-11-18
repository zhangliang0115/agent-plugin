/** Admin API for local environment discovery (`POST /discover`).
 *
 * Probes only the fixed list from 03 §9.1: MCP config files, `npx`/`gh`/`psql`
 * availability and credential-file presence. It never reads secret values: config files
 * are parsed only for server names, credential files are only checked for existence, and
 * secrets are checked through an injected name-only probe.
 *
 * `alreadyExists` compares the candidate `command + args` against registered servers
 * after whitespace normalization; `<workspace>` / `<url>` / `<path>` placeholders match
 * any single corresponding argument. Labels and ids are never used for the comparison.
 * @module
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  AdminApiError,
  adminHandler,
  adminJson,
  isPlainObject,
  requestSegments,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from './servers.ts';

export type DiscoverConfidence = 'high' | 'medium' | 'low';

export interface DiscoverSuggestion {
  /** Fixed id from 03 §9.1. */
  id: 'cursor-config' | 'filesystem' | 'github' | 'postgres' | 'sqlite' | 'fetch';
  label: string;
  command: string | null;
  args: string[];
  reason: string;
  confidence: DiscoverConfidence;
  alreadyExists: boolean;
  requiredSecrets: string[];
}

/** The subset of a registered server that `alreadyExists` needs. */
export interface DiscoverServerConfig {
  id: string;
  transport: string;
  command: string | null;
  args: readonly unknown[];
}

export interface DiscoverServerLookup {
  list(): Promise<readonly DiscoverServerConfig[]> | readonly DiscoverServerConfig[];
}

/** Name-only secret probe; values must never cross this boundary. */
export interface DiscoverSecretProbe {
  has(name: string): boolean | Promise<boolean>;
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

interface ConfigProbeResult {
  path: string;
  serverNames: string[];
}

function readServerNames(text: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const servers = parsed['mcpServers'];
  if (!isPlainObject(servers)) return [];
  // Only names are kept; env/header values in the file are discarded here.
  return Object.keys(servers);
}

function suggestion(
  id: DiscoverSuggestion['id'],
  label: string,
  command: string | null,
  args: string[],
  reason: string,
  confidence: DiscoverConfidence,
  requiredSecrets: string[] = [],
): DiscoverSuggestion {
  return {
    id,
    label,
    command,
    args,
    reason,
    confidence,
    alreadyExists: false,
    requiredSecrets,
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
    const configPaths = [join(home, '.cursor', 'mcp.json')];
    if (deps.workspace !== undefined && deps.workspace !== '') {
      configPaths.push(join(deps.workspace, '.mcp.json'));
    }

    const [configs, gh, psql, npx, pgpass, githubToken, databaseUrl, existingServers] =
      await Promise.all([
        (async (): Promise<ConfigProbeResult[]> => {
          const found: ConfigProbeResult[] = [];
          for (const path of configPaths) {
            const text = await io.readText(path);
            if (text === null) continue;
            const serverNames = readServerNames(text);
            if (serverNames === null) continue;
            found.push({ path, serverNames });
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

    if (configs.length > 0) {
      const names = [...new Set(configs.flatMap((config) => config.serverNames))];
      const where = configs.map((config) => config.path).join(', ');
      suggestions.push(
        suggestion(
          'cursor-config',
          '从 Cursor 导入',
          null,
          [],
          names.length > 0
            ? `在 ${where} 发现 ${names.length} 个已有 server：${names.join(', ')}`
            : `发现 ${where}，但其中没有 mcpServers 条目`,
          names.length > 0 ? 'high' : 'low',
        ),
      );
    }

    suggestions.push(
      suggestion(
        'filesystem',
        '文件系统',
        'npx',
        ['-y', '@modelcontextprotocol/server-filesystem', '<workspace>'],
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
        npx ? 'npx 可用' : '未检测到 npx；注册后可能无法启动',
        npx ? 'medium' : 'low',
      ),
    );

    for (const item of suggestions) {
      if (item.id === 'cursor-config') continue;
      item.alreadyExists = existingServers.some((server) =>
        sameCommandLine(
          { command: item.command, args: item.args },
          { command: server.command, args: server.args },
        ),
      );
    }

    return suggestions;
  }

  return adminHandler(async (request: AdminRequest): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    if (segments.length !== 1 || segments[0] !== 'discover') return null;
    if (request.method.toUpperCase() !== 'POST') return null;

    const suggestions = await withTimeout(run(), timeoutMs);
    return adminJson(200, { suggestions });
  });
}
