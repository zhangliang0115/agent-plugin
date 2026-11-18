import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface LocalTokens {
  mcpToken: string;
  adminToken: string;
}

function dataRoot(): string {
  return join(process.env['AGENTS_HOME'] ?? join(homedir(), '.agents'), 'repl-server');
}

async function readOrCreate(path: string, envName: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing !== '') return existing;
  } catch {
    // fall through to creation
  }
  await mkdir(dirname(path), { recursive: true });
  const token = randomBytes(32).toString('base64url');
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}

/** Loads the local mcp/admin tokens, creating 0600 files on first start. */
export async function loadLocalTokens(root = dataRoot()): Promise<LocalTokens> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return {
    mcpToken: await readOrCreate(join(root, 'mcp-token'), 'REPL_MCP_TOKEN'),
    adminToken: await readOrCreate(join(root, 'admin-token'), 'REPL_ADMIN_TOKEN'),
  };
}

export function stateDbPath(root = dataRoot()): string {
  return join(root, 'state.db');
}
