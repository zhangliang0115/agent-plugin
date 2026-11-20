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
 * Prompt sent through discover/initialize `instructions`.
 * Kept short because clients truncate instructions (Kiro at 2048 characters);
 * the per-request server list lives only in `run_script`'s description.
 */
export const INSTRUCTIONS = [
  'repl-server executes JavaScript in a persistent sandbox with the tools available to this client.',
  '',
  'Execution:',
  '- Top-level await works. Declarations persist across calls in the same workspace.',
  '- Changing workspace starts a new session. reset="1" means the context was rebuilt; keep cross-rebuild data in state.',
  '- Tools are async: await tools.<name>(args); MCP tools: await tools.mcp.<server>.<tool>(args).',
  '',
  'Workflow:',
  '- search_tools finds canonical names; describe_tools returns schemas; run_script executes.',
  '- Long jobs: pass async:true and collect with wait_tasks.',
  '- Do not guess tool names. Unknown names fail.',
  '',
  'Errors:',
  '- Built-in tool failures return { error }; MCP tool failures throw. Check exitCode explicitly.',
  '- Return a short result; use log() only for needed output.',
  '',
  "Visible MCP servers are listed in run_script's description.",
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
