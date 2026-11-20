/** Injected tool bridge: official serve tools resolve failures, MCP tools throw. @module */
import { LIMITS } from '../constants.ts';
import { McpToolError, ReplError } from '../errors.ts';
import type { VisibleTools } from './catalog.ts';
import {
  errorMessageOf,
  mcpToolErrorFromAbort,
  mcpToolErrorFromResult,
  mcpToolErrorFromThrown,
  mcpToolErrorFromTimeout,
} from './mcp-error.ts';
import {
  normalizeMcpResult,
  normalizeOfficialResult,
  type ServeToolResult,
} from './normalize-result.ts';

export type { ServeContentBlock, ServeToolResult } from './normalize-result.ts';

/**
 * The single-call transport the caller injects. Official serve and each
 * third-party MCP server are both adapted to this shape, so the bridge never
 * owns a connection.
 */
export interface ServeClient {
  callTool(request: {
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly signal: AbortSignal;
  }): Promise<ServeToolResult>;
}

/**
 * L1 per-call defaults: 30s for file-class official tools and 60s for
 * third-party MCP calls. These bound one tool call, not an eval; tests shrink
 * both through {@link ServeProxyOptions}.
 */
export const DEFAULT_CALL_TIMEOUTS = {
  officialMs: 30_000,
  mcpMs: 60_000,
} as const;

export interface ServeProxyOptions {
  readonly client: ServeClient;
  /** Client for one third-party MCP server. Defaults to `client`. */
  readonly mcpClient?: (server: string) => ServeClient;
  /** Canonical names allowed in this eval. Omitted means no narrowing. */
  readonly visibleTools?: VisibleTools;
  /** L1 timeout for official serve calls. Defaults to {@link DEFAULT_CALL_TIMEOUTS}. */
  readonly officialTimeoutMs?: number;
  /** L1 timeout for third-party MCP calls. Defaults to {@link DEFAULT_CALL_TIMEOUTS}. */
  readonly mcpTimeoutMs?: number;
}

export interface ToolCall {
  /** Bare official tool name, or the bare MCP tool name when `server` is set. */
  readonly tool: string;
  readonly server?: string;
  readonly args: Record<string, unknown>;
  /** Eval-level cancellation. Aborts the signal handed to the client too. */
  readonly signal?: AbortSignal;
  /** Overrides the L1 default for this call only. */
  readonly timeoutMs?: number;
}

class ToolCallTimeout extends Error {
  readonly kind = 'timeout' as const;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'ToolCallTimeout';
    this.timeoutMs = timeoutMs;
  }
}

class ToolCallCancelled extends Error {
  readonly kind = 'cancelled' as const;
  readonly reason: unknown;

  constructor(label: string, reason: unknown) {
    super(`${label} was cancelled`);
    this.name = 'ToolCallCancelled';
    this.reason = reason;
  }
}

type CallFailure = ToolCallTimeout | ToolCallCancelled;

type CallOutcome =
  | { readonly ok: true; readonly result: ServeToolResult }
  | { readonly ok: false; readonly failure: CallFailure };

/**
 * Calls tools made from a script. Failures map by source: official tools
 * resolve `{ error }`, third-party MCP tools reject with `McpToolError`.
 * `visibleTools` is checked before any client is reached.
 */
export class ServeProxy {
  private readonly client: ServeClient;
  private readonly mcpClient: ((server: string) => ServeClient) | undefined;
  private readonly visible: Set<string> | undefined;
  private readonly officialTimeoutMs: number;
  private readonly mcpTimeoutMs: number;

  constructor(options: ServeProxyOptions) {
    this.client = options.client;
    this.mcpClient = options.mcpClient;
    this.visible = options.visibleTools === undefined ? undefined : new Set(options.visibleTools);
    this.officialTimeoutMs = assertTimeout('officialTimeoutMs', options.officialTimeoutMs ?? DEFAULT_CALL_TIMEOUTS.officialMs);
    this.mcpTimeoutMs = assertTimeout('mcpTimeoutMs', options.mcpTimeoutMs ?? DEFAULT_CALL_TIMEOUTS.mcpMs);
  }

  async call(request: ToolCall): Promise<unknown> {
    const name = canonicalToolName(request.tool, request.server);
    if (this.visible !== undefined && !this.visible.has(name)) {
      throw new ReplError('TOOL_NOT_VISIBLE', `${name} is not visible in this call`);
    }
    if (request.server === undefined) return this.callOfficial(request);
    return this.callMcp(request.server, request);
  }

  private async callOfficial(request: ToolCall): Promise<unknown> {
    const timeoutMs = assertTimeout('timeoutMs', request.timeoutMs ?? this.officialTimeoutMs);
    try {
      const outcome = await runCall(request.tool, request.signal, timeoutMs, (signal) =>
        this.client.callTool({ name: request.tool, args: request.args, signal }),
      );
      if (!outcome.ok) return { error: outcome.failure.message };
      return normalizeOfficialResult(request.tool, outcome.result);
    } catch (error) {
      // The wrapper is the last line of defense: a throwing client must not
      // turn into a script exception, because the prompt says `if (r.error)`.
      return { error: errorMessageOf(error) };
    }
  }

  private async callMcp(server: string, request: ToolCall): Promise<unknown> {
    const target = { server, tool: request.tool };
    const timeoutMs = assertTimeout('timeoutMs', request.timeoutMs ?? this.mcpTimeoutMs);
    const client = this.mcpClient?.(server) ?? this.client;

    try {
      const outcome = await runCall(canonicalToolName(request.tool, server), request.signal, timeoutMs, (signal) =>
        client.callTool({ name: request.tool, args: request.args, signal }),
      );
      if (!outcome.ok) {
        throw outcome.failure instanceof ToolCallTimeout
          ? mcpToolErrorFromTimeout(target, outcome.failure.timeoutMs)
          : mcpToolErrorFromAbort(target, outcome.failure.reason);
      }
      if (outcome.result.isError === true) {
        throw mcpToolErrorFromResult(target, outcome.result);
      }
      return normalizeMcpResult(outcome.result);
    } catch (error) {
      if (error instanceof McpToolError) throw error;
      throw mcpToolErrorFromThrown(target, error);
    }
  }
}

function canonicalToolName(tool: string, server: string | undefined): string {
  return server === undefined ? tool : `${server}.${tool}`;
}

function assertTimeout(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  return value;
}

/**
 * Races one client call against the L1 deadline and the eval-level abort.
 * Both losing promises are observed, so a late rejection never surfaces as an
 * unhandled rejection after the bridge has answered.
 */
async function runCall(
  label: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<ServeToolResult>,
): Promise<CallOutcome> {
  if (signal?.aborted === true) {
    return { ok: false, failure: new ToolCallCancelled(label, signal.reason) };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const failure = new ToolCallCancelled(label, signal?.reason);
      controller.abort(failure);
      reject(failure);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const failure = new ToolCallTimeout(label, timeoutMs);
      controller.abort(failure);
      reject(failure);
    }, timeoutMs);
  });
  void aborted.catch(() => {});

  const pending = Promise.resolve().then(() => call(controller.signal));
  void pending.catch(() => {});

  try {
    const result = await Promise.race([pending, aborted]);
    return { ok: true, result };
  } catch (error) {
    if (error instanceof ToolCallTimeout || error instanceof ToolCallCancelled) {
      return { ok: false, failure: error };
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}
