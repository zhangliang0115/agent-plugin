/** `tools/call` routing: argument validation, run_script dispatch and the three sync tools. @module */

import type { Catalog, ExecutionGateway, RequestIdentity, ScriptRequest } from '../ports.ts';
import { JsonRpcError, JSON_RPC_INVALID_PARAMS } from '../mcp/errors.ts';
import type { ReportService } from '../reports/service.ts';
import { describeTools, type DescribeToolsInput } from './describe.ts';
import { reportProblemCall } from './report.ts';
import {
  getToolDefinition,
  toCallToolResult,
  validateToolArguments,
  type CallToolResult,
  type ToolDefinition,
} from './registry.ts';
import { searchTools, type SearchToolsInput, type ToolVisibility } from './search.ts';
import {
  McpTaskStore,
  ownerOf,
  resolveDispatchMode,
  type CreateTaskResult,
} from '../tasks/mcp-tasks.ts';

const WAIT_TASKS_DEFAULT_MS = 270_000;

export interface ToolCallContext {
  identity: RequestIdentity;
  gateway: ExecutionGateway;
  catalog: Catalog;
  tasks: McpTaskStore;
  /** JSON-RPC id of the enclosing `tools/call`; stamped into eval audits. */
  requestId?: string | number | null;
  /** True when this request declared `io.modelcontextprotocol/tasks`. */
  tasksDeclared?: boolean;
  /** Wired by assembly; absent in focused tests, which makes report_problem fail closed. */
  reports?: ReportService;
  /** Binding allow lists applied to search_tools and describe_tools for this request. */
  visibility?: ToolVisibility;
  /** This request's search_tools definition, carrying the catalog-derived enums. */
  searchToolsDefinition?: ToolDefinition;
}

export type ToolCallResponse = CallToolResult | CreateTaskResult;

/** Unknown tool names are invalid params at the JSON-RPC layer, not a tool-layer error. */
export class UnknownToolError extends JsonRpcError {
  readonly toolName: string;

  constructor(toolName: string) {
    super(JSON_RPC_INVALID_PARAMS, `unknown tool: ${toolName}`);
    this.name = 'UnknownToolError';
    this.toolName = toolName;
  }
}

interface RunScriptArguments {
  code: string;
  timeout?: number;
  async?: boolean;
  workspace?: string;
  visibleTools?: string[];
  excludeTags?: string[];
}

interface WaitTasksArguments {
  taskIds?: string[];
  timeoutMs?: number;
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(text: string): string {
  return escapeXml(text).replaceAll('"', '&quot;');
}

function jsonResult(value: unknown, isError: boolean): CallToolResult {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }],
    isError,
  };
}

function toolFailure(code: string, message: string): CallToolResult {
  return jsonResult({ ok: false, error: { code, message } }, true);
}

/**
 * Pre-execution failures have no evalId yet; `eval="0"` keeps the attribute set frozen by
 * docs/protocol.md §7 while making it obvious that no script ran.
 */
function runScriptFailure(code: string, message: string): CallToolResult {
  return {
    resultType: 'complete',
    content: [
      {
        type: 'text',
        text: `<repl-output eval="0"><error>${escapeXml(`${code}: ${message}`)}</error></repl-output>`,
      },
    ],
    isError: true,
  };
}

function asyncAcknowledgement(evalId: number, evalTaskId: string): CallToolResult {
  return {
    resultType: 'complete',
    content: [
      {
        type: 'text',
        text: `<repl-output eval="${evalId}" async="true" task="${escapeXmlAttribute(evalTaskId)}"></repl-output>`,
      },
    ],
    isError: false,
  };
}

/** Reads a string error code from the error itself or from its JSON-RPC `data`. */
function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const data = (error as { data?: unknown }).data;
  if (typeof data === 'object' && data !== null) {
    const nested = (data as { code?: unknown }).code;
    if (typeof nested === 'string') return nested;
  }
  return undefined;
}

function errorCode(error: unknown): string {
  return readErrorCode(error) ?? 'INTERNAL_ERROR';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureFromError(error: unknown): CallToolResult {
  return runScriptFailure(errorCode(error), errorMessage(error));
}

async function runScriptCall(input: unknown, ctx: ToolCallContext): Promise<ToolCallResponse> {
  const validation = validateToolArguments('run_script', input);
  if (!validation.ok) return runScriptFailure(validation.code, validation.message);

  const args = validation.value as unknown as RunScriptArguments;
  const mode = resolveDispatchMode('run_script', args, ctx.tasksDeclared === true);

  const request: ScriptRequest = {
    code: args.code,
    ...(args.timeout === undefined ? {} : { timeoutMs: args.timeout }),
    async: mode !== 'sync',
    identity: ctx.identity,
    ...(ctx.requestId === undefined || ctx.requestId === null ? {} : { requestId: ctx.requestId }),
  };
  if (args.workspace !== undefined) request.workspace = args.workspace;
  if (args.visibleTools !== undefined) request.visibleTools = args.visibleTools;
  if (args.excludeTags !== undefined) request.excludeTags = args.excludeTags;

  if (mode === 'sync') {
    try {
      return toCallToolResult(await ctx.gateway.runScript(request));
    } catch (error) {
      return failureFromError(error);
    }
  }

  try {
    const dispatched = await ctx.gateway.dispatchScript(request);
    if (mode === 'task') return ctx.tasks.create(ownerOf(ctx.identity), dispatched.taskId);
    return asyncAcknowledgement(dispatched.evalId, dispatched.taskId);
  } catch (error) {
    return failureFromError(error);
  }
}

async function searchToolsCall(input: unknown, ctx: ToolCallContext): Promise<CallToolResult> {
  const definition = ctx.searchToolsDefinition ?? getToolDefinition('search_tools');
  const validation = validateToolArguments('search_tools', input, definition);
  if (!validation.ok) return toolFailure(validation.code, validation.message);
  const items = searchTools(ctx.catalog.snapshot(), {
    ...(validation.value as SearchToolsInput),
    ...(ctx.visibility ?? {}),
  });
  return jsonResult(items, false);
}

async function describeToolsCall(input: unknown, ctx: ToolCallContext): Promise<CallToolResult> {
  const validation = validateToolArguments('describe_tools', input);
  if (!validation.ok) return toolFailure(validation.code, validation.message);
  const args = validation.value as unknown as DescribeToolsInput;
  const result = describeTools(ctx.catalog.snapshot(), args.names, ctx.visibility);
  if (result.unknown !== undefined) {
    return toolFailure(
      'UNKNOWN_TOOL',
      `unknown or invisible tool names: ${result.unknown.join(', ')}; use search_tools to find canonical names`,
    );
  }
  return jsonResult({ tools: result.tools }, false);
}

function waitTasksFailure(error: unknown): { ok: false; error: Record<string, unknown> } | undefined {
  const code = readErrorCode(error);
  if (code === undefined) return undefined;

  const detail: Record<string, unknown> = { code };
  const record = error as { unknownIds?: unknown; data?: unknown };
  if (Array.isArray(record.unknownIds)) {
    detail.unknownIds = record.unknownIds;
  } else if (typeof record.data === 'object' && record.data !== null) {
    const nested = (record.data as { unknownIds?: unknown }).unknownIds;
    if (Array.isArray(nested)) detail.unknownIds = nested;
  }
  return { ok: false, error: detail };
}

function isWaitTasksFailure(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

async function waitTasksCall(input: unknown, ctx: ToolCallContext): Promise<CallToolResult> {
  const validation = validateToolArguments('wait_tasks', input);
  if (!validation.ok) return toolFailure(validation.code, validation.message);

  const args = validation.value as unknown as WaitTasksArguments;
  const owner = ownerOf(ctx.identity);
  let value: unknown;
  try {
    value = await ctx.gateway.waitTasks(owner, args.taskIds, args.timeoutMs ?? WAIT_TASKS_DEFAULT_MS);
  } catch (error) {
    const failure = waitTasksFailure(error);
    if (failure === undefined) return toolFailure(errorCode(error), errorMessage(error));
    value = failure;
  }
  return jsonResult(value, isWaitTasksFailure(value));
}

export async function callTool(
  name: string,
  input: unknown,
  ctx: ToolCallContext,
): Promise<ToolCallResponse> {
  // MCP makes `arguments` optional for a call with no fields (search_tools, wait_tasks).
  const args = input === undefined ? {} : input;
  switch (name) {
    case 'run_script':
      return runScriptCall(args, ctx);
    case 'search_tools':
      return searchToolsCall(args, ctx);
    case 'describe_tools':
      return describeToolsCall(args, ctx);
    case 'wait_tasks':
      return waitTasksCall(args, ctx);
    case 'report_problem':
      return reportProblemCall(args, ctx);
    default:
      throw new UnknownToolError(name);
  }
}
