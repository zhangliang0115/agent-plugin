/**
 * Lazy `claude mcp serve` -> `tools/list` sync for the seeded `__official__`
 * server.
 *
 * The sync runs once per process from the admin tool page and on demand from
 * `POST /servers/__official__/tools/refresh`. The dedicated workspace is
 * released right after listing: this is a snapshot, and keeping the serve pair
 * alive would hold one capacity slot and a ledger session for a page view.
 *
 * Without a resolvable `claude` binary nothing is spawned; the outcome carries
 * a readable notice and the admin GET still answers 200.
 *
 * @module
 */

import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { OFFICIAL_SERVER_ID } from '../db/servers.ts';
import { upsertTool } from '../db/tools.ts';
import type { OfficialToolsSync, OfficialToolsSyncResult } from '../ports.ts';
import type { ToolListEntry } from './client.ts';

/** Structural subset of {@link ServeClient} used by the sync. */
export interface OfficialSyncClient {
  listTools(): Promise<ToolListEntry[]>;
}

/** Structural subset of the serve runtime used by the sync. */
export interface OfficialSyncRuntime {
  acquire(workspace: string): Promise<OfficialSyncClient>;
  release(workspace: string): Promise<void>;
}

export interface OfficialToolsSyncOptions {
  db: DatabaseSync;
  runtime: OfficialSyncRuntime;
  /** Dedicated cwd for the serve pair; created when missing. */
  workspace: string;
  /** Executable name/path; defaults to `REPL_CLAUDE_BIN`, then `claude`. */
  bin?: string;
  /** Test seam: resolves the executable; defaults to a PATH lookup. */
  resolveBin?: (bin: string) => string | null;
  /** Called after rows were written; assembly refreshes the catalog snapshot. */
  onSynced?: (count: number) => void;
  log?: (line: string) => void;
}

export function createOfficialToolsSync(options: OfficialToolsSyncOptions): OfficialToolsSync {
  const bin = options.bin ?? process.env['REPL_CLAUDE_BIN'] ?? 'claude';
  const resolveBin = options.resolveBin ?? defaultResolveBin;
  let cached: OfficialToolsSyncResult | null = null;
  let inflight: Promise<OfficialToolsSyncResult> | null = null;

  function failed(error: unknown): OfficialToolsSyncResult {
    const message = describe(error);
    options.log?.(`[official] tools sync failed: ${message}`);
    return {
      status: 'failed',
      count: 0,
      notice: `读取官方工具失败：${message}；可点“刷新工具”重试。`,
    };
  }

  async function run(): Promise<OfficialToolsSyncResult> {
    if (resolveBin(bin) === null) {
      return {
        status: 'unavailable',
        count: 0,
        notice: `未找到 ${bin} 可执行文件；本机安装 Claude Code CLI 后点“刷新工具”重试。`,
      };
    }
    try {
      mkdirSync(options.workspace, { recursive: true, mode: 0o700 });
    } catch (error) {
      return failed(error);
    }

    let client: OfficialSyncClient | null = null;
    try {
      client = await options.runtime.acquire(options.workspace);
      const tools = await client.listTools();
      let count = 0;
      for (const tool of tools) {
        const name = typeof tool.name === 'string' ? tool.name.trim() : '';
        if (name === '') continue;
        // upsertTool keeps description_override, enabled, concurrency, tags,
        // type, category and composite_code from an existing row.
        upsertTool(options.db, OFFICIAL_SERVER_ID, {
          name,
          description: tool.description ?? null,
          inputSchema: tool.inputSchema ?? {},
        });
        count += 1;
      }
      try {
        options.onSynced?.(count);
      } catch (error) {
        // Rows are written; a stale snapshot is not a sync failure.
        options.log?.(`[official] catalog refresh failed: ${describe(error)}`);
      }
      return { status: 'synced', count };
    } catch (error) {
      return failed(error);
    } finally {
      if (client !== null) {
        try {
          await options.runtime.release(options.workspace);
        } catch (error) {
          options.log?.(`[official] release failed: ${describe(error)}`);
        }
      }
    }
  }

  return {
    async ensure(ensureOptions = {}): Promise<OfficialToolsSyncResult> {
      if (ensureOptions.force !== true && cached !== null) return cached;
      if (inflight !== null) return inflight;
      const pending = run().then((result) => {
        cached = result;
        return result;
      });
      inflight = pending;
      void pending.then(
        () => {
          if (inflight === pending) inflight = null;
        },
        () => {
          if (inflight === pending) inflight = null;
        },
      );
      return pending;
    },
  };
}

/** `REPL_CLAUDE_BIN` may be an absolute path or a bare command on `PATH`. */
function defaultResolveBin(command: string): string | null {
  if (command.trim() === '') return null;
  if (command.includes('/') || command.includes('\\')) {
    return executable(command) ? command : null;
  }
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, command);
    if (executable(candidate)) return candidate;
  }
  return null;
}

function executable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  return 'unknown error';
}
