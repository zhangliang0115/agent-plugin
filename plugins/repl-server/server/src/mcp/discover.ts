/** Protocol discovery and legacy initialize results for the MCP endpoint. @module */

import { VERSION } from '@zhangliang0115/repl-server-core';

import { JsonRpcError, JSON_RPC_INVALID_PARAMS, JSON_RPC_INVALID_REQUEST } from './errors.ts';
import type { JsonRpcHandler } from './jsonrpc.ts';

/** Modern MCP protocol version served by `server/discover`. */
export const DISCOVER_PROTOCOL_VERSION = '2026-07-28';
/** Latest legacy revision; `initialize` falls back to it for unknown requests. */
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';
/** Versions `server/discover` reports and accepts as its `_meta` pin. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [DISCOVER_PROTOCOL_VERSION];
/** Revisions the legacy `initialize` handler accepts, legacy first. */
export const INITIALIZE_PROTOCOL_VERSIONS: readonly string[] = [
  LEGACY_PROTOCOL_VERSION,
  DISCOVER_PROTOCOL_VERSION,
];
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
export const SERVER_NAME = 'repl-server';
export const SERVER_VERSION = VERSION;
export const DISCOVER_TTL_MS = 3_600_000;
export const DISCOVER_CACHE_SCOPE = 'public';

/**
 * Prompt sent through discover/initialize `instructions`.
 * Deliberately two lines: the usage guide is a skill (`skills/list`), and the
 * per-tool rules live in the tool descriptions. Repeating either here would put
 * the same text in context twice.
 */
export const INSTRUCTIONS = [
  'repl-server executes JavaScript in a persistent sandbox with the tools available to this client.',
  'The usage guide is published as an MCP skill: call skills/list, then read the files it lists.',
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
    resources: Record<string, never>;
    extensions: {
      'io.modelcontextprotocol/tasks': Record<string, never>;
      'io.modelcontextprotocol/skills': Record<string, never>;
    };
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
      resources: {},
      extensions: { [TASKS_EXTENSION]: {}, [SKILLS_EXTENSION]: {} },
    },
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    instructions: options.instructions ?? INSTRUCTIONS,
    ttlMs: DISCOVER_TTL_MS,
    cacheScope: DISCOVER_CACHE_SCOPE,
  };
}

/**
 * Builds the legacy `initialize` result. Both accepted revisions echo back;
 * any other string falls back to the latest legacy revision, as the
 * 2025-11-25 spec requires, instead of failing the handshake.
 */
export function initializeResult(
  params: Record<string, unknown>,
  options: StaticInstructionsOptions = {},
): InitializeResult {
  const requested = params['protocolVersion'];
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, 'initialize requires a protocolVersion string');
  }
  const protocolVersion = INITIALIZE_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LEGACY_PROTOCOL_VERSION;
  return {
    protocolVersion,
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
