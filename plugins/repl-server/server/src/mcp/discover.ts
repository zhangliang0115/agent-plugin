/** Protocol discovery and legacy initialize results for the MCP endpoint. @module */

import { VERSION } from '@zhangliang0115/repl-server-core';

import { JsonRpcError, JSON_RPC_INVALID_PARAMS, JSON_RPC_INVALID_REQUEST } from './errors.ts';
import type { JsonRpcHandler } from './jsonrpc.ts';
import { clipText, type McpServerOverview } from './overview.ts';

/** MCP protocol version served by this build. */
export const PROTOCOL_VERSION = '2026-07-28';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION];
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export const SERVER_NAME = 'repl-server';
export const SERVER_VERSION = VERSION;
export const DISCOVER_TTL_MS = 3_600_000;
/**
 * `instructions` is built from the servers visible to the requesting client
 * binding, so the discover result is not shareable across authorization
 * contexts (protocol 2026-07-28 §Caching).
 */
export const DISCOVER_CACHE_SCOPE = 'private' as const;

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
  '## Top-level MCP tools (not available inside run_script)',
  '',
  '  report_problem({ title, detail, severity, context? })',
  '',
  'Call it as an MCP tool, not as tools.report_problem: it is not exposed',
  'inside run_script. Use it to report a problem with repl-server or the tools',
  'it exposes. Describe the failure, expected vs actual behavior, and',
  'reproduction steps. Never include credentials or secret values.',
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

/** The static MCP paragraph; `buildInstructions` replaces it with a per-client list. */
const MCP_PARAGRAPH = [
  'MCP tools are namespaced: tools.mcp.<server>.<tool>(args).',
  'Use search_tools({ query }) to find tools not listed here, and',
  'describe_tools({ names }) for its full schema.',
].join('\n');

/** One visible server inside the discover `instructions` MCP section. */
function formatServerDetail(server: McpServerOverview): string {
  const id = clipText(server.id, 48);
  const category = clipText(server.category, 24) || 'other';
  const count = `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
  const summary = clipText(server.summary, 80);
  return summary === ''
    ? `- ${id} [${category}] ${count}`
    : `- ${id} [${category}] ${count} — ${summary}`;
}

/**
 * Fills the template's MCP paragraph with the servers visible to this client.
 * The instructions are not limited to 2KB, so each server carries its category,
 * tool count and summary. The category/tag filter values live in the
 * `search_tools` schema; repeating the whole vocabulary here would only bloat
 * the prompt (design 01 §10.2 #10).
 */
export function buildInstructions(
  base: string,
  servers: readonly McpServerOverview[],
): string {
  const lines = servers.map(formatServerDetail);
  const section =
    lines.length === 0
      ? 'No MCP servers are visible to this client.'
      : ['MCP servers visible to this client:', ...lines].join('\n');
  const paragraph = [
    'MCP tools are namespaced: tools.mcp.<server>.<tool>(args).',
    section,
    'Use search_tools({ query }) to find tools not listed here, and',
    'describe_tools({ names }) for their full schemas. The search_tools schema lists',
    'the available server, category and tag filter values.',
  ].join('\n');
  return base.includes(MCP_PARAGRAPH) ? base.replace(MCP_PARAGRAPH, paragraph) : `${base}\n\n${paragraph}`;
}

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
  cacheScope: typeof DISCOVER_CACHE_SCOPE;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: { tools: Record<string, never> };
  serverInfo: ServerInfo;
  instructions: string;
}

export interface DiscoverOptions<Context = undefined> {
  /** Static text, or a per-request provider resolved with the transport context. */
  instructions?: string | ((context: Context) => string);
}

/** Options that produce one concrete result (no context available). */
export interface StaticInstructionsOptions {
  instructions?: string;
}

function resolveInstructions<Context>(
  options: DiscoverOptions<Context>,
  context: Context,
): string {
  const provider = options.instructions;
  if (typeof provider === 'function') return provider(context);
  return provider ?? INSTRUCTIONS;
}

export function serverInfo(): ServerInfo {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Builds the `server/discover` result frozen in protocol.md §3.1. */
export function discoverResult(options: StaticInstructionsOptions = {}): DiscoverResult {
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
  options: StaticInstructionsOptions = {},
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
  options: DiscoverOptions<Context> = {},
): JsonRpcHandler<Context> {
  return (params, context) => {
    // A client may pin the version in `_meta`; an unsupported pin is refused
    // before any result is built (same -32600 shape as legacy initialize).
    const meta = params['_meta'];
    if (typeof meta === 'object' && meta !== null) {
      const requested = (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'];
      if (requested !== undefined) {
        if (typeof requested !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
          throw new JsonRpcError(
            JSON_RPC_INVALID_REQUEST,
            `Unsupported protocol version: ${String(requested)}`,
            { supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
          );
        }
      }
    }
    return discoverResult({ instructions: resolveInstructions(options, context) });
  };
}

export function createInitializeHandler<Context = undefined>(
  options: DiscoverOptions<Context> = {},
): JsonRpcHandler<Context> {
  return (params, context) =>
    initializeResult(params, { instructions: resolveInstructions(options, context) });
}
