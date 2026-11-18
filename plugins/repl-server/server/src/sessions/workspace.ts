/** Workspace resolution (explicit → roots → binding default → cwd) and the per-MCP-session workspace quota. @module */
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ReplError } from '@zhangliang0115/repl-server-core/src/errors.ts';

/** Design 03 §2.6 / protocol.md §8: `maxWorkspacesPerMcpSession`. */
export const MAX_WORKSPACES_PER_MCP_SESSION = 4;

export type WorkspaceSource = 'explicit' | 'roots' | 'binding' | 'cwd';

/** A `roots/list` entry, either the raw uri or the MCP `Root` object. */
export type WorkspaceRootEntry = string | { uri: string };

export interface WorkspaceResolveInput {
  /** `run_script({ workspace })`. */
  explicit?: string | null;
  /** First `file://` entry wins; other schemes are ignored. */
  roots?: readonly WorkspaceRootEntry[] | null;
  /** `client_bindings.default_workspace`. */
  bindingDefault?: string | null;
}

export interface WorkspaceFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export interface WorkspaceResolveDeps {
  fs?: WorkspaceFileSystem;
  /** Last-resort workspace when nothing else was given; defaults to `process.cwd()`. */
  cwd?: string;
}

export interface ResolvedWorkspace {
  /** Canonical absolute path (`fs.realpath`); use it as the exec-session key and serve cwd. */
  path: string;
  source: WorkspaceSource;
}

const defaultFileSystem: WorkspaceFileSystem = { realpath, stat };

/**
 * Resolves the workspace in the frozen order: explicit argument, first `file://` root, binding
 * default, then cwd. The chosen path is canonicalized with `fs.realpath`; a missing path or a
 * non-directory throws `WS_INVALID` — there is no silent fallback to the next source.
 */
export async function resolveWorkspace(
  input: WorkspaceResolveInput,
  deps: WorkspaceResolveDeps = {},
): Promise<ResolvedWorkspace> {
  const fs = deps.fs ?? defaultFileSystem;
  const candidate = pickCandidate(input, deps.cwd ?? process.cwd());
  const path = await canonicalize(candidate.path, fs);
  return { path, source: candidate.source };
}

export interface WorkspaceRegistryOptions extends WorkspaceResolveDeps {
  /** Defaults to {@link MAX_WORKSPACES_PER_MCP_SESSION}; tests shrink it. */
  maxPerMcpSession?: number;
}

/**
 * Tracks resolved workspaces per `Mcp-Session-Id`. Re-resolving the same canonical path is free;
 * a fifth distinct workspace throws `WS_LIMIT`. The check and insertion happen after the only
 * `await`, so concurrent calls cannot overshoot the limit.
 */
export class WorkspaceRegistry {
  private readonly bySession = new Map<string, string[]>();
  private readonly deps: WorkspaceResolveDeps;
  private readonly maxPerMcpSession: number;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.deps = { fs: options.fs, cwd: options.cwd };
    this.maxPerMcpSession = options.maxPerMcpSession ?? MAX_WORKSPACES_PER_MCP_SESSION;
  }

  async resolve(mcpSessionId: string, input: WorkspaceResolveInput): Promise<ResolvedWorkspace> {
    const resolved = await resolveWorkspace(input, this.deps);
    const paths = this.bySession.get(mcpSessionId) ?? [];
    if (paths.includes(resolved.path)) return resolved;
    if (paths.length >= this.maxPerMcpSession) {
      throw new ReplError(
        'WS_LIMIT',
        `workspace limit reached for this MCP session (${this.maxPerMcpSession})`,
      );
    }
    paths.push(resolved.path);
    this.bySession.set(mcpSessionId, paths);
    return resolved;
  }

  /** Canonical workspaces already bound to the MCP session, in first-use order. */
  list(mcpSessionId: string): readonly string[] {
    return this.bySession.get(mcpSessionId) ?? [];
  }

  /** `DELETE /mcp`: forgets the session's workspace count. */
  release(mcpSessionId: string): void {
    this.bySession.delete(mcpSessionId);
  }
}

function pickCandidate(
  input: WorkspaceResolveInput,
  cwd: string,
): { path: string; source: WorkspaceSource } {
  const explicit = normalizePath(input.explicit);
  if (explicit !== null) return { path: explicit, source: 'explicit' };

  const root = pickFileRoot(input.roots);
  if (root !== null) return { path: root, source: 'roots' };

  const binding = normalizePath(input.bindingDefault);
  if (binding !== null) return { path: binding, source: 'binding' };

  return { path: cwd, source: 'cwd' };
}

function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Returns the path of the first `file://` root; non-file and malformed uris are skipped. */
function pickFileRoot(roots: readonly WorkspaceRootEntry[] | null | undefined): string | null {
  if (!roots) return null;
  for (const entry of roots) {
    const uri = typeof entry === 'string' ? entry : entry.uri;
    if (typeof uri !== 'string' || uri.length === 0) continue;
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      continue;
    }
    if (url.protocol !== 'file:') continue;
    try {
      return fileURLToPath(url);
    } catch {
      throw new ReplError('WS_INVALID', `invalid workspace root: ${uri}`);
    }
  }
  return null;
}

async function canonicalize(path: string, fs: WorkspaceFileSystem): Promise<string> {
  let resolved: string;
  try {
    resolved = await fs.realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ReplError('WS_INVALID', `workspace does not exist: ${path}`);
    }
    throw new ReplError('WS_INVALID', `workspace is not accessible: ${path}${code ? ` (${code})` : ''}`);
  }

  let info: { isDirectory(): boolean };
  try {
    info = await fs.stat(resolved);
  } catch {
    throw new ReplError('WS_INVALID', `workspace is not accessible: ${path}`);
  }
  if (!info.isDirectory()) {
    throw new ReplError('WS_INVALID', `workspace is not a directory: ${path}`);
  }
  return resolved;
}
