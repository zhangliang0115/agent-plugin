/** `tools/call` routing: argument validation, run_script dispatch and the three sync tools. @module */

import { renderEnvelope } from '@zhangliang0115/repl-server-core/src/envelope.ts';

import type { Catalog, ExecutionGateway, RequestIdentity, ScriptRequest } from '../ports.ts';
import { JsonRpcError, JSON_RPC_INVALID_PARAMS } from '../mcp/errors.ts';
import type { ReportService } from '../reports/service.ts';
import { ScriptError, type SaveScriptInput, type ScriptService } from '../scripts/service.ts';
import { describeTools, type DescribeToolsInput } from './describe.ts';
import { reportProblemCall } from './report.ts';
import {
  getToolDefinition,
  jsonResult,
  toCallToolResult,
  toolFailure,
  validateToolArguments,
  type CallToolResult,
  type ToolDefinition,
} from './registry.ts';
import { searchTools, type SearchToolsInput, type ToolVisibility } from './search.ts';
import type { ToolTextSearch } from './search-fts.ts';
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
  /** Server-side FTS text search for non-empty queries; absent in focused tests. */
  toolTextSearch?: ToolTextSearch;
  /** Saved-script library; absent only in focused tests that never use it. */
  scripts?: ScriptService;
  /** Audit sink for top-level tool events without an eval (`script_saved`). */
  audit?: (event: Record<string, unknown> & { event: string }) => void;
  /**
   * Counts this top-level `tools/call` only. Tool calls made inside a script are
   * counted by the gateway's `tool_result` audit path, so this must not be fed from there.
   */
  onUsage?: (name: string, ok: boolean) => void;
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
  code?: string;
  scriptName?: string;
  scriptVersion?: number;
  args?: Record<string, unknown>;
  activateOnSuccess?: boolean;
  timeout?: number;
  async?: boolean;
  workspace?: string;
  visibleTools?: string[];
  excludeTags?: string[];
}

type SaveScriptArguments = Omit<SaveScriptInput, 'scriptId'> & { scriptName?: string };

interface SearchScriptsArguments {
  query?: string;
  tags?: string[];
  limit?: number;
}

interface WaitTasksArguments {
  taskIds: string[];
  timeoutMs?: number;
}

interface LegacyScriptIdSplit {
  /** The arguments minus any legacy `scriptId`, ready for schema validation. */
  readonly value: unknown;
  readonly scriptId?: string;
  readonly error?: string;
}

/**
 * `scriptId` is a system-generated id and is absent from the published schemas,
 * but old clients still send it. Splitting it off before validation keeps those
 * calls working without advertising the field to models.
 */
function splitLegacyScriptId(input: unknown): LegacyScriptIdSplit {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { value: input };
  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, 'scriptId')) return { value: input };
  const { scriptId, ...value } = record;
  if (typeof scriptId !== 'string' || scriptId === '') {
    return { value, error: 'scriptId is a legacy alias and must be a non-empty string' };
  }
  return { value, scriptId };
}

/**
 * Pre-execution failures have no evalId yet; `eval="0"` keeps the attribute set frozen by
 * docs/protocol.md §7 while making it obvious that no script ran.
 */
function runScriptFailure(code: string, message: string): CallToolResult {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: renderEnvelope({ evalId: 0, error: `${code}: ${message}` }) }],
    isError: true,
  };
}

function asyncAcknowledgement(evalId: number, evalTaskId: string, runId: string): CallToolResult {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: renderEnvelope({ evalId, runId, async: true, evalTaskId }) }],
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

function scriptFailure(error: unknown): CallToolResult {
  if (error instanceof ScriptError) return toolFailure(error.code, error.message);
  return toolFailure(errorCode(error), errorMessage(error));
}

/** Name-based calls must not echo the system id back to the model. */
function replaceScriptId(error: unknown, scriptId: string, scriptName: string): unknown {
  if (!(error instanceof ScriptError)) return error;
  return new ScriptError(
    error.code,
    error.message.replaceAll(scriptId, JSON.stringify(scriptName)),
    error.details,
  );
}

async function runScriptCall(input: unknown, ctx: ToolCallContext): Promise<ToolCallResponse> {
  const legacy = splitLegacyScriptId(input);
  if (legacy.error !== undefined) return runScriptFailure('INVALID_ARGUMENT', legacy.error);
  const validation = validateToolArguments('run_script', legacy.value);
  if (!validation.ok) return runScriptFailure(validation.code, validation.message);

  const args = validation.value as unknown as RunScriptArguments;
  const hasCode = typeof args.code === 'string';
  const hasId = legacy.scriptId !== undefined;
  const hasName = typeof args.scriptName === 'string' && args.scriptName !== '';
  if (hasId && hasName) {
    return runScriptFailure('INVALID_ARGUMENT', 'scriptId is a legacy alias; pass only scriptName');
  }
  const hasScript = hasId || hasName;
  if ([hasCode, hasScript].filter((present) => present).length !== 1) {
    return runScriptFailure(
      'INVALID_ARGUMENT',
      'exactly one of code or scriptName is required',
    );
  }
  if (!hasScript && (args.args !== undefined || args.scriptVersion !== undefined || args.activateOnSuccess !== undefined)) {
    return runScriptFailure(
      'INVALID_ARGUMENT',
      'args, scriptVersion and activateOnSuccess require scriptName',
    );
  }

  const mode = resolveDispatchMode('run_script', args, ctx.tasksDeclared === true);
  const actor = { createdBy: ctx.identity.binding ?? ctx.identity.mcp };

  let code = args.code ?? '';
  let scriptFields: Pick<
    ScriptRequest,
    'scriptId' | 'scriptVersion' | 'scriptMode' | 'args' | 'purpose'
  > = { purpose: 'run' };
  let activateOnSuccess = false;

  if (hasScript) {
    if (ctx.scripts === undefined) {
      return runScriptFailure('MCP_SERVER_UNAVAILABLE', 'the script library is not wired');
    }
    let scriptId = legacy.scriptId ?? '';
    if (hasName) {
      const name = args.scriptName as string;
      const found = ctx.scripts.resolveIdByName(name);
      if (found === null) {
        return runScriptFailure('SCRIPT_NOT_FOUND', `script named ${JSON.stringify(name)} was not found`);
      }
      scriptId = found;
    }
    let resolved;
    try {
      resolved = ctx.scripts.resolveExecution(
        {
          scriptId,
          ...(args.scriptVersion === undefined ? {} : { scriptVersion: args.scriptVersion }),
          ...(args.args === undefined ? {} : { args: args.args }),
        },
        { actor },
      );
    } catch (error) {
      return failureFromError(
        hasName ? replaceScriptId(error, scriptId, args.scriptName as string) : error,
      );
    }
    if (args.activateOnSuccess === true) {
      // The target must still be a draft before dispatch; the settle-time archive
      // re-checks it so a concurrent activation/archive wins without failing the run.
      if (resolved.version.status !== 'draft') {
        return runScriptFailure(
          'SCRIPT_VERSION_NOT_DRAFT',
          `script ${JSON.stringify(resolved.script.name)} version ${resolved.version.version} is not a draft`,
        );
      }
      activateOnSuccess = true;
    }
    code = resolved.code;
    scriptFields = {
      scriptId: resolved.script.scriptId,
      scriptVersion: resolved.version.version,
      scriptMode: resolved.version.mode,
      args: resolved.args,
      purpose: resolved.purpose,
    };
  }

  const request: ScriptRequest = {
    code,
    ...(args.timeout === undefined ? {} : { timeoutMs: args.timeout }),
    async: mode !== 'sync',
    identity: ctx.identity,
    entryMode: hasScript ? 'script' : 'code',
    actor,
    ...scriptFields,
    ...(activateOnSuccess ? { activateOnSuccess: true } : {}),
    ...(ctx.requestId === undefined || ctx.requestId === null ? {} : { requestId: ctx.requestId }),
  };
  if (args.workspace !== undefined) request.workspace = args.workspace;
  if (args.visibleTools !== undefined) request.visibleTools = args.visibleTools;
  if (args.excludeTags !== undefined) request.excludeTags = args.excludeTags;

  if (mode === 'sync') {
    try {
      const outcome = await ctx.gateway.runScript(request);
      return toCallToolResult(outcome);
    } catch (error) {
      return failureFromError(error);
    }
  }

  try {
    const dispatched = await ctx.gateway.dispatchScript(request);
    if (mode === 'task') return ctx.tasks.create(ownerOf(ctx.identity), dispatched.taskId);
    return asyncAcknowledgement(dispatched.evalId, dispatched.taskId, dispatched.runId);
  } catch (error) {
    return failureFromError(error);
  }
}

async function saveScriptCall(input: unknown, ctx: ToolCallContext): Promise<CallToolResult> {
  const legacy = splitLegacyScriptId(input);
  if (legacy.error !== undefined) return toolFailure('INVALID_ARGUMENT', legacy.error);
  const validation = validateToolArguments('save_script', legacy.value);
  if (!validation.ok) return toolFailure(validation.code, validation.message);
  if (ctx.scripts === undefined) {
    return toolFailure('MCP_SERVER_UNAVAILABLE', 'the script library is not wired');
  }
  const { scriptName, ...args } = validation.value as unknown as SaveScriptArguments;
  const hasName = typeof scriptName === 'string' && scriptName !== '';
  if (scriptName !== undefined && !hasName) {
    return toolFailure('INVALID_ARGUMENT', 'save_script.scriptName must be a non-empty string');
  }
  if (legacy.scriptId !== undefined && hasName) {
    return toolFailure('INVALID_ARGUMENT', 'scriptId is a legacy alias; pass only scriptName');
  }
  let scriptId = legacy.scriptId;
  if (hasName) {
    const found = ctx.scripts.resolveIdByName(scriptName as string);
    if (found === null) {
      return toolFailure('SCRIPT_NOT_FOUND', `script named ${JSON.stringify(scriptName)} was not found`);
    }
    scriptId = found;
  }
  const saveInput: SaveScriptInput = scriptId === undefined ? args : { ...args, scriptId };
  try {
    const result = ctx.scripts.save(
      { createdBy: ctx.identity.binding ?? ctx.identity.mcp },
      saveInput,
    );
    ctx.audit?.({
      event: 'script_saved',
      ok: true,
      scriptId: result.scriptId,
      version: result.version,
      mode: result.mode,
      name: result.name,
      sourceRunId: args.runId ?? null,
      status: result.status,
      activeVersion: result.activeVersion,
      warnings: result.warnings,
    });
    return jsonResult(
      {
        scriptName: result.name,
        version: result.version,
        status: result.status,
        activeVersion: result.activeVersion,
        mode: result.mode,
        warnings: result.warnings,
      },
      false,
    );
  } catch (error) {
    ctx.audit?.({
      event: 'script_saved',
      ok: false,
      scriptId: scriptId ?? null,
      name: args.name ?? null,
      sourceRunId: args.runId ?? null,
      error: { code: errorCode(error), message: errorMessage(error) },
    });
    return scriptFailure(
      hasName && scriptId !== undefined
        ? replaceScriptId(error, scriptId, scriptName as string)
        : error,
    );
  }
}

async function searchScriptsCall(input: unknown, ctx: ToolCallContext): Promise<CallToolResult> {
  const validation = validateToolArguments('search_scripts', input);
  if (!validation.ok) return toolFailure(validation.code, validation.message);
  if (ctx.scripts === undefined) {
    return toolFailure('MCP_SERVER_UNAVAILABLE', 'the script library is not wired');
  }
  const args = validation.value as unknown as SearchScriptsArguments;
  try {
    const items = ctx.scripts.search({
      ...(args.query === undefined ? {} : { query: args.query }),
      ...(args.tags === undefined ? {} : { tags: args.tags }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });
    const scripts = items.map(({ scriptId: _scriptId, name, ...rest }) => ({
      scriptName: name,
      ...rest,
    }));
    return jsonResult({ scripts }, false);
  } catch (error) {
    return scriptFailure(error);
  }
}

async function searchToolsCall(input: unknown, ctx: ToolCallContext): Promise<CallToolResult> {
  const definition = ctx.searchToolsDefinition ?? getToolDefinition('search_tools');
  const validation = validateToolArguments('search_tools', input, definition);
  if (!validation.ok) return toolFailure(validation.code, validation.message);
  const args = validation.value as SearchToolsInput;
  const query = (args.query ?? '').trim();
  const items =
    query !== '' && ctx.toolTextSearch !== undefined
      ? ctx.toolTextSearch(args, ctx.visibility ?? {})
      : searchTools(ctx.catalog.snapshot(), {
          ...args,
          ...(ctx.visibility ?? {}),
        });
  return jsonResult(items, false);
}

async function describeToolsCall(input: unknown, ctx: ToolCallContext): Promise<CallToolResult> {
  const validation = validateToolArguments('describe_tools', input);
  if (!validation.ok) return toolFailure(validation.code, validation.message);
  const args = validation.value as unknown as DescribeToolsInput;
  const result = describeTools(ctx.catalog.snapshot(), args.names, ctx.visibility);
  const body: Record<string, unknown> = { tools: result.tools };
  if (result.unknown !== undefined) body['unknown'] = result.unknown;
  return jsonResult(body, false);
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
  // MCP makes `arguments` optional; tools with required fields reject the empty object in validation.
  const args = input === undefined ? {} : input;
  let response: ToolCallResponse;
  switch (name) {
    case 'run_script':
      response = await runScriptCall(args, ctx);
      break;
    case 'search_tools':
      response = await searchToolsCall(args, ctx);
      break;
    case 'describe_tools':
      response = await describeToolsCall(args, ctx);
      break;
    case 'wait_tasks':
      response = await waitTasksCall(args, ctx);
      break;
    case 'report_problem':
      response = await reportProblemCall(args, ctx);
      break;
    case 'save_script':
      response = await saveScriptCall(args, ctx);
      break;
    case 'search_scripts':
      response = await searchScriptsCall(args, ctx);
      break;
    default:
      throw new UnknownToolError(name);
  }
  // A task result means the dispatch was accepted; its outcome arrives via wait_tasks.
  ctx.onUsage?.(name, response.resultType === 'task' || response.isError !== true);
  return response;
}
