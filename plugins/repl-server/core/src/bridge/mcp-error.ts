/** Maps third-party MCP failures to the single McpToolError shape scripts catch. @module */
import { McpToolError, ReplError } from '../errors.ts';
import { isRecord, normalizeContent, parseJsonText, type ServeToolResult } from './normalize-result.ts';

export interface McpTarget {
  readonly server: string;
  readonly tool: string;
}

/** Bridge-owned codes. A server-reported code stays in `detail`, not here. */
export const MCP_TOOL_ERROR_CODES = {
  result: 'MCP_TOOL_ERROR',
  timeout: 'MCP_CALL_TIMEOUT',
  cancelled: 'MCP_CALL_CANCELLED',
  transport: 'MCP_CALL_FAILED',
} as const;

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  return 'tool call failed';
}

/** A tool that answered with `isError: true`. The parsed body is `detail`. */
export function mcpToolErrorFromResult(target: McpTarget, result: ServeToolResult): McpToolError {
  const text = normalizeContent(result.content).text;
  const parsed = parseJsonText(text);
  const detail: unknown = parsed.ok ? parsed.value : text.trim() === '' ? undefined : text;
  const record = isRecord(detail) ? detail : undefined;
  const retryAfterMs = readRetryAfterMs(record);
  const message = record !== undefined && typeof record.message === 'string' && record.message !== ''
    ? record.message
    : text.trim() !== '' ? text : `tool ${target.server}.${target.tool} failed`;

  return new McpToolError(message, {
    code: MCP_TOOL_ERROR_CODES.result,
    server: target.server,
    tool: target.tool,
    retryable: record?.retryable === true || retryAfterMs !== undefined,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    detail,
  });
}

/** The bridge's own L1 deadline. The call may be retried once the server recovers. */
export function mcpToolErrorFromTimeout(target: McpTarget, timeoutMs: number): McpToolError {
  return new McpToolError(`${target.server}.${target.tool} timed out after ${timeoutMs}ms`, {
    code: MCP_TOOL_ERROR_CODES.timeout,
    server: target.server,
    tool: target.tool,
    retryable: true,
    detail: { timeoutMs },
  });
}

/** The eval was cancelled. Retrying the same call is not useful. */
export function mcpToolErrorFromAbort(target: McpTarget, reason?: unknown): McpToolError {
  return new McpToolError(`${target.server}.${target.tool} was cancelled`, {
    code: MCP_TOOL_ERROR_CODES.cancelled,
    server: target.server,
    tool: target.tool,
    retryable: false,
    ...(reason === undefined ? {} : { detail: { reason: describeReason(reason) } }),
  });
}

/** Any other rejection from the MCP client: transport, queue, auth or a raw AbortError. */
export function mcpToolErrorFromThrown(target: McpTarget, error: unknown): McpToolError {
  if (error instanceof McpToolError) return error;
  if (isAbortError(error)) return mcpToolErrorFromAbort(target, error);

  const message = errorMessageOf(error);
  if (error instanceof ReplError) {
    const detail = readDetail(error);
    return new McpToolError(message, {
      code: error.code,
      server: target.server,
      tool: target.tool,
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  const retryAfterMs = readRetryAfterMs(error);
  return new McpToolError(message, {
    code: MCP_TOOL_ERROR_CODES.transport,
    server: target.server,
    tool: target.tool,
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    detail: readDetail(error) ?? describeError(error),
  });
}

function readRetryAfterMs(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value.retryAfterMs;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct;
  return readRetryAfterMs(value.data);
}

function readDetail(error: unknown): unknown {
  if (!isRecord(error)) return undefined;
  if ('data' in error && error.data !== undefined) return error.data;
  if ('detail' in error && error.detail !== undefined) return error.detail;
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
  };
}

function describeReason(reason: unknown): unknown {
  if (reason instanceof Error) return { name: reason.name, message: reason.message };
  return reason;
}
