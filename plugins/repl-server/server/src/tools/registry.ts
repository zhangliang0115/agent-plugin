/** Frozen MCP tool surface: the five tool definitions, argument validation and result shapes. @module */

import type { CatalogTool, ScriptOutcome } from '../ports.ts';

export type ToolName =
  | 'run_script'
  | 'search_tools'
  | 'describe_tools'
  | 'wait_tasks'
  | 'report_problem';

export interface JsonSchemaProperty {
  readonly type: 'string' | 'integer' | 'boolean' | 'array' | 'object';
  readonly items?: JsonSchemaProperty;
  readonly enum?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  /** String length in Unicode code points (06 §3.1). */
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Object shape hint for the published schema; unknown keys are not rejected here. */
  readonly additionalProperties?: boolean;
  readonly default?: string | number | boolean;
}

export interface ToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly idempotentHint?: boolean;
}

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly _meta: { readonly 'anthropic/alwaysLoad': true };
  readonly annotations?: ToolAnnotations;
}

/** Freezes a JSON-schema tree so no caller can mutate the published tool surface. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Summary only; the full prompt lives in `server/discover` `instructions`.
 * It stays under the 2KB ceiling frozen in docs/protocol.md §3.3, and it must mention async in
 * both the schema and the description or the model never discovers the async path (01 §4.2).
 */
const RUN_SCRIPT_DESCRIPTION = `Run JavaScript in a persistent sandbox against the tools available to this client. Batch several tool calls, loop over results, or combine outputs before answering. Only the returned value and the text passed to log() come back to you, wrapped in a <repl-output> envelope.

- Tools are async functions: await Read({ path }), await Edit({...}); MCP tools are tools.mcp.<server>.<tool>(args).
- Top-level declarations persist across calls in the same workspace. Changing workspace starts a new execution session; variables and state do not carry over.
- timeout is milliseconds: sync runs default to 30000 and max out at 600000. For longer work pass async: true, which dispatches immediately, defaults to and caps at 7200000, and returns <repl-output async="true" task="...">.
- Collect an async result with wait_tasks using the task id from that envelope.
- visibleTools (bare names for built-ins, <server>.<tool> for MCP) and excludeTags narrow only this call; they cannot widen access.
- Use search_tools to find tool names and describe_tools for input schemas.`;

const SEARCH_TOOLS_DESCRIPTION =
  'Search the tool catalog by keyword, category or tags (an empty query returns the server overview) and return canonical tool names for run_script or describe_tools.';

const DESCRIBE_TOOLS_DESCRIPTION =
  'Return full input schemas for up to 10 canonical tool names; later schemas are omitted only when the batch would exceed 32000 characters.';

const WAIT_TASKS_DESCRIPTION =
  'Wait until the given eval tasks started with async: true finish (all unconsumed tasks when taskIds is omitted), consume their results, and return events plus a pending count.';

const REPORT_PROBLEM_DESCRIPTION =
  'Record a problem report about repl-server or the tools it exposes. The server stores it and may notify the administrator. Describe the failure, expected vs actual behavior, and reproduction steps. Never include credentials or secret values.';

const RUN_SCRIPT_SCHEMA: ToolInputSchema = deepFreeze({
  type: 'object',
  properties: {
    code: { type: 'string' },
    timeout: { type: 'integer', minimum: 1_000, maximum: 7_200_000, default: 30_000 },
    async: { type: 'boolean', default: false },
    workspace: { type: 'string' },
    visibleTools: { type: 'array', items: { type: 'string' } },
    excludeTags: { type: 'array', items: { type: 'string' } },
  },
  required: ['code'],
  additionalProperties: false,
});

const SEARCH_TOOLS_SCHEMA: ToolInputSchema = deepFreeze({
  type: 'object',
  properties: {
    query: { type: 'string' },
    category: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    max: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  },
  additionalProperties: false,
});

const DESCRIBE_TOOLS_SCHEMA: ToolInputSchema = deepFreeze({
  type: 'object',
  properties: {
    names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
  },
  required: ['names'],
  additionalProperties: false,
});

const WAIT_TASKS_SCHEMA: ToolInputSchema = deepFreeze({
  type: 'object',
  properties: {
    taskIds: { type: 'array', items: { type: 'string' } },
    timeoutMs: { type: 'integer', minimum: 1_000, maximum: 600_000, default: 270_000 },
  },
  additionalProperties: false,
});

/** Frozen schema from 06 §3.1; the 8 KB context limit is enforced server-side only. */
export const REPORT_PROBLEM_SCHEMA: ToolInputSchema = deepFreeze({
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    detail: { type: 'string', minLength: 1, maxLength: 20_000 },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    context: { type: 'object', additionalProperties: true },
  },
  required: ['title', 'detail', 'severity'],
  additionalProperties: false,
});

/**
 * `tools/list` order is frozen: run_script, search_tools, describe_tools, wait_tasks,
 * report_problem. `run_script` carries no annotations because scripts write files and run
 * commands; marking it read-only would let plan mode through and duplicate a retried call
 * (docs/protocol.md §3.3). `report_problem` also carries none: it writes a row and does not
 * promise idempotency (06 §3.1). protocol.md gives the other three both hints; 01 §4.2 would
 * omit idempotentHint on wait_tasks because it consumes results, but the frozen protocol is
 * the implementation source.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = deepFreeze<readonly ToolDefinition[]>([
  {
    name: 'run_script',
    description: RUN_SCRIPT_DESCRIPTION,
    inputSchema: RUN_SCRIPT_SCHEMA,
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: 'search_tools',
    description: SEARCH_TOOLS_DESCRIPTION,
    inputSchema: SEARCH_TOOLS_SCHEMA,
    _meta: { 'anthropic/alwaysLoad': true },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'describe_tools',
    description: DESCRIBE_TOOLS_DESCRIPTION,
    inputSchema: DESCRIBE_TOOLS_SCHEMA,
    _meta: { 'anthropic/alwaysLoad': true },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'wait_tasks',
    description: WAIT_TASKS_DESCRIPTION,
    inputSchema: WAIT_TASKS_SCHEMA,
    _meta: { 'anthropic/alwaysLoad': true },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'report_problem',
    description: REPORT_PROBLEM_DESCRIPTION,
    inputSchema: REPORT_PROBLEM_SCHEMA,
    _meta: { 'anthropic/alwaysLoad': true },
  },
]);

export const TOOL_ORDER: readonly ToolName[] = Object.freeze(TOOL_DEFINITIONS.map((tool) => tool.name));

const BY_NAME = new Map<string, ToolDefinition>(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export function listTools(): readonly ToolDefinition[] {
  return TOOL_DEFINITIONS;
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/** The protocol/model-layer name: built-ins use a bare name, MCP tools use `<server>.<tool>`. */
export function canonicalToolName(tool: Pick<CatalogTool, 'name' | 'kind' | 'server'>): string {
  if (tool.kind !== 'mcp' || tool.server === undefined || tool.server === '') return tool.name;
  const prefix = `${tool.server}.`;
  return tool.name.startsWith(prefix) ? tool.name : `${prefix}${tool.name}`;
}

export type ArgumentValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: 'INVALID_ARGUMENT'; message: string };

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkProperty(
  tool: string,
  key: string,
  property: JsonSchemaProperty,
  value: unknown,
): string | null {
  switch (property.type) {
    case 'string': {
      if (typeof value !== 'string') {
        return `${tool}.${key} must be a string, got ${valueType(value)}`;
      }
      if (property.enum !== undefined && !property.enum.includes(value)) {
        return `${tool}.${key} must be one of ${property.enum.map((entry) => JSON.stringify(entry)).join(', ')}`;
      }
      const length = [...value].length;
      if (property.minLength !== undefined && length < property.minLength) {
        return `${tool}.${key} must be at least ${property.minLength} character(s)`;
      }
      if (property.maxLength !== undefined && length > property.maxLength) {
        return `${tool}.${key} must be at most ${property.maxLength} character(s)`;
      }
      return null;
    }
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return `${tool}.${key} must be an integer, got ${valueType(value)}`;
      }
      if (property.minimum !== undefined && value < property.minimum) {
        return `${tool}.${key} must be >= ${property.minimum}`;
      }
      if (property.maximum !== undefined && value > property.maximum) {
        return `${tool}.${key} must be <= ${property.maximum}`;
      }
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${tool}.${key} must be a boolean`;
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? null
        : `${tool}.${key} must be an object, got ${valueType(value)}`;
    case 'array': {
      if (!Array.isArray(value)) return `${tool}.${key} must be an array, got ${valueType(value)}`;
      if (property.minItems !== undefined && value.length < property.minItems) {
        return `${tool}.${key} must contain at least ${property.minItems} item(s)`;
      }
      if (property.maxItems !== undefined && value.length > property.maxItems) {
        return `${tool}.${key} must contain at most ${property.maxItems} item(s)`;
      }
      if (property.items !== undefined) {
        for (let index = 0; index < value.length; index += 1) {
          const problem = checkProperty(tool, `${key}[${index}]`, property.items, value[index]);
          if (problem !== null) return problem;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Validates arguments against the frozen schema. Defaults are intentionally not applied here:
 * run_script's timeout default depends on the dispatch mode (sync vs async).
 */
export function validateToolArguments(toolName: string, input: unknown): ArgumentValidation {
  const definition = getToolDefinition(toolName);
  if (definition === undefined) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: `unknown tool ${JSON.stringify(toolName)}` };
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: `${toolName} arguments must be an object, got ${valueType(input)}`,
    };
  }

  const record = input as Record<string, unknown>;
  const schema = definition.inputSchema;
  for (const required of schema.required ?? []) {
    if (record[required] === undefined) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: `${toolName}.${required} is required` };
    }
  }
  for (const key of Object.keys(record)) {
    const property = schema.properties[key];
    if (property === undefined) {
      return {
        ok: false,
        code: 'INVALID_ARGUMENT',
        message: `${toolName} does not accept the argument ${JSON.stringify(key)}`,
      };
    }
    const value = record[key];
    if (value === undefined) continue;
    const problem = checkProperty(toolName, key, property, value);
    if (problem !== null) return { ok: false, code: 'INVALID_ARGUMENT', message: problem };
  }
  return { ok: true, value: { ...record } };
}

export interface TextContentBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface ImageContentBlock {
  readonly type: 'image';
  readonly data: string;
  readonly mimeType: string;
}

export interface ResourceContentBlock {
  readonly type: 'resource';
  readonly resource: {
    readonly uri: string;
    readonly mimeType: string;
    readonly blob: string;
  };
}

export type ContentBlock = TextContentBlock | ImageContentBlock | ResourceContentBlock;

/** `CallToolResult` with the frozen `resultType: "complete"` envelope. No `structuredContent`. */
export interface CallToolResult {
  readonly resultType: 'complete';
  readonly content: ContentBlock[];
  readonly isError: boolean;
}

/** Media never enters the XML envelope; it follows it as extra content blocks (protocol §3.4). */
export function toCallToolResult(outcome: ScriptOutcome): CallToolResult {
  const content: ContentBlock[] = [{ type: 'text', text: outcome.content }];
  for (const image of outcome.images ?? []) {
    content.push({ type: 'image', data: image.base64, mimeType: image.mediaType });
  }
  let documentIndex = 0;
  for (const document of outcome.documents ?? []) {
    content.push({
      type: 'resource',
      resource: {
        uri: `repl://document/${documentIndex}`,
        mimeType: 'application/pdf',
        blob: document.base64,
      },
    });
    documentIndex += 1;
  }
  return { resultType: 'complete', content, isError: outcome.isError };
}
