/** Protocol discovery and legacy initialize results for the MCP endpoint. @module */

import { VERSION } from '@zhangliang0115/repl-server-core';

import { JsonRpcError, JSON_RPC_INVALID_PARAMS, JSON_RPC_INVALID_REQUEST } from './errors.ts';
import type { JsonRpcHandler } from './jsonrpc.ts';

/** MCP protocol version served by this build. */
export const PROTOCOL_VERSION = '2026-07-28';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION];
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export const SERVER_NAME = 'repl-server';
export const SERVER_VERSION = VERSION;
export const DISCOVER_TTL_MS = 3_600_000;
export const DISCOVER_CACHE_SCOPE = 'public';

/**
 * Full prompt sent through discover/initialize `instructions`.
 * The text mirrors the template in design doc 01 §10.7; `run_script.description`
 * carries only the short summary, so the two do not repeat each other.
 */
export const INSTRUCTIONS = [
  'Execute JavaScript to read, write, edit files and run shell commands.',
  '',
  'The code runs in a persistent JavaScript context. Variables declared in one',
  'call are visible in later calls in the same session. Top-level await works.',
  'If a call\'s result carries reset="1", the context was rebuilt: previous',
  'variables are gone. Keep anything you need across a rebuild in `state`, a',
  'plain object that survives rebuilds: `state.cursor = 42`.',
  '',
  'The optional `workspace` argument selects the directory the tools run in.',
  'Changing it starts a fresh execution session — variables and state from the',
  'old workspace are not carried over.',
  '',
  '## Tools',
  '',
  'Call tools as async functions. All return a Promise.',
  '',
  "  await tools.Bash({ command: 'ls -la', timeout: 120000 })",
  "  await tools.Read({ file_path: '/abs/path', offset: 0, limit: 2000 })",
  "  await tools.Write({ file_path: '/abs/path', content: '...' })",
  "  await tools.Edit({ file_path: '/abs/path', old_string: 'a', new_string: 'b' })",
  '',
  'MCP tools are namespaced: tools.mcp.<server>.<tool>(args).',
  'Use search_tools({ query }) to find tools not listed here, and',
  'describe_tools({ names }) for its full schema.',
  '',
  '## Return values',
  '',
  '- Bash returns { stdout, stderr, exitCode }. A non-zero exitCode is NOT an',
  '  exception — check it explicitly. grep returning 1 just means "no match";',
  '  when exitCode is null, read returnCodeInterpretation instead.',
  '- Read returns the file content with line numbers.',
  '- Edit returns a short summary of what changed.',
  '- A built-in tool that fails returns { error: string }. It does NOT throw.',
  '  Check it: const r = await tools.Read(...); if (r.error) ...',
  '- An MCP tool that fails throws. Catch it; e.detail carries the parsed',
  '  error body; e.retryAfterMs may tell you how long to back off.',
  '',
  '## Long jobs',
  '',
  'By default a call waits for the script to finish, up to 600000 ms. For jobs',
  'that may take longer — long builds, test suites, migrations — pass',
  '`async: true` and an explicit `timeout` (default 7200000 ms, the maximum).',
  'The call returns at once with an envelope carrying async="true" and',
  'task="<id>". Collect the result with wait_tasks({ taskIds: ["<id>"] }).',
  'Calling wait_tasks() with no taskIds waits for every background script in',
  'this execution session and returns them all; it waits up to 270000 ms by',
  'default and reports the ones still pending. Results are consumed once: a',
  'second call for the same task returns ALREADY_CONSUMED.',
  '',
  '## Budget',
  '',
  '- 30000 ms default per script; pass timeout to raise it to 600000 (sync) or 7200000 (async).',
  '- At most 50000 tool calls per script.',
  '- Results are truncated at 30000 chars per field and about 20000 estimated',
  '  tokens total (CJK counts as roughly one token per character).',
  '',
  '## Guidance',
  '',
  '- Prefer one script that does the whole job over many small calls.',
  '- Read a file before editing it. Edit fails otherwise.',
  '- Use rg through Bash for searching; do not assume a Grep tool exists.',
  '- Do not console.log data you do not need; it costs context.',
  '- Return a short summary, not raw dumps.',
].join('\n');

export interface ServerInfo {
  name: string;
  version: string;
}

export interface DiscoverResult {
  resultType: 'complete';
  supportedVersions: string[];
  capabilities: {
    tools: Record<string, never>;
    extensions: { 'io.modelcontextprotocol/tasks': Record<string, never> };
  };
  _meta: { 'io.modelcontextprotocol/serverInfo': ServerInfo };
  instructions: string;
  ttlMs: number;
  cacheScope: 'public';
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: { tools: Record<string, never> };
  serverInfo: ServerInfo;
  instructions: string;
}

export interface DiscoverOptions {
  instructions?: string;
}

export function serverInfo(): ServerInfo {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Builds the `server/discover` result frozen in protocol.md §3.1. */
export function discoverResult(options: DiscoverOptions = {}): DiscoverResult {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: {
      tools: {},
      extensions: { [TASKS_EXTENSION]: {} },
    },
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    instructions: options.instructions ?? INSTRUCTIONS,
    ttlMs: DISCOVER_TTL_MS,
    cacheScope: DISCOVER_CACHE_SCOPE,
  };
}

/**
 * Builds the legacy `initialize` result. Only versions this build serves are
 * accepted; anything else is `-32600` with the supported list in `data`.
 */
export function initializeResult(
  params: Record<string, unknown>,
  options: DiscoverOptions = {},
): InitializeResult {
  const requested = params['protocolVersion'];
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, 'initialize requires a protocolVersion string');
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    throw new JsonRpcError(JSON_RPC_INVALID_REQUEST, `Unsupported protocol version: ${requested}`, {
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    });
  }
  return {
    protocolVersion: requested,
    capabilities: { tools: {} },
    serverInfo: serverInfo(),
    instructions: options.instructions ?? INSTRUCTIONS,
  };
}

export function createDiscoverHandler<Context = undefined>(
  options: DiscoverOptions = {},
): JsonRpcHandler<Context> {
  return () => discoverResult(options);
}

export function createInitializeHandler<Context = undefined>(
  options: DiscoverOptions = {},
): JsonRpcHandler<Context> {
  return (params) => initializeResult(params, options);
}
