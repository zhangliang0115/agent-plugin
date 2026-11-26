/** Frozen MCP tool surface: the seven tool definitions, argument validation and result shapes. @module */

import type { CatalogTool, ScriptOutcome } from '../ports.ts';

export type ToolName =
  | 'run_script'
  | 'search_tools'
  | 'describe_tools'
  | 'wait_tasks'
  | 'report_problem'
  | 'save_script'
  | 'search_scripts';

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
  /** Shown to the calling model in tools/list; affects nothing in validation. */
  readonly description?: string;
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
 * The visible MCP server list is appended per request by
 * `buildRunScriptDescription`, so no server or built-in example is hardcoded here.
 */
export const RUN_SCRIPT_DESCRIPTION = `Run JavaScript in a persistent sandbox against the tools available to this client. Batch independent calls with Promise.all; return only what the answer needs.

- Tools are async: await tools.<name>(args); MCP tools: await tools.mcp.<server>.<tool>(args).
- Top-level await works. Declarations persist across calls in the same workspace; changing workspace starts a new session.
- Pass async: true for long jobs: with MCP tasks support the client polls the task; otherwise collect it with wait_tasks.
- timeout is milliseconds, not seconds; omit it for no deadline. One MCP tool call usually takes tens to hundreds of milliseconds.
- Instead of code, pass scriptName (plus scriptVersion/args for saved scripts) to rerun a script; use search_scripts to find one.
- Results carry a run="<id>" attribute; save_script turns a successful run into a reusable script.
- visibleTools and excludeTags narrow this call only; they cannot widen access.
- Results: official tool JSON is parsed automatically; MCP tools return { text, images?, documents? } with raw text, so call JSON.parse(result.text) when the payload is JSON.
- Use the MCP tools search_tools/describe_tools (outside the script) to find canonical names and input schemas. Do not guess tool names.`;

const SEARCH_TOOLS_DESCRIPTION =
  'Search this client\'s visible tools and return canonical names for run_script or describe_tools. An empty query without server returns the server overview plus the __official__ group of bare-name tools; an empty query with server (including __official__) returns that group\'s tools. A non-empty query matches tool names, effective tags and descriptions; server, category and tags only narrow, and tags is all-of. Filter values must come from this request\'s schema enums.';

const DESCRIBE_TOOLS_DESCRIPTION =
  'Return full input schemas for 1 to 10 canonical tool names. Unknown or invisible names are listed in unknown; known tools still return. More than 10 names fails validation. Get names from search_tools.';

const WAIT_TASKS_DESCRIPTION =
  'Wait until the given tasks started by run_script with async: true finish, consume their results, and return events plus a pending count. taskIds is required: pass the taskId values returned by run_script; the call never collects other tasks of the session.';

const REPORT_PROBLEM_DESCRIPTION =
  'Record a problem report about repl-server or the tools it exposes. The server stores it and may notify the administrator. Describe the failure, expected vs actual behavior, and reproduction steps. Never include credentials or secret values.';

const SAVE_SCRIPT_DESCRIPTION =
  'Save a successful run_script execution as a reusable script, or update an existing one. Pass runId plus mode=exact to store that run\'s code as an active zero-argument script. Pass mode=parameterized with rewritten code and an inputSchema to store a draft; test it with run_script({ scriptName, scriptVersion, args }) and activate on success. With scriptName, the existing script\'s name/description/tags update in place; code, inputSchema or mode changes need baseVersion and append a draft.';

const SEARCH_SCRIPTS_DESCRIPTION =
  'Find saved scripts in the global library. Returns each script\'s scriptName, active version, inputSchema and exampleArgs; execute one with run_script({ scriptName, args }). Only active scripts are returned. Use save_script to create or update.';

const RUN_SCRIPT_SCHEMA: ToolInputSchema = deepFreeze({
  type: 'object',
  properties: {
    code: { type: 'string' },
    scriptName: { type: 'string' },
    scriptVersion: { type: 'integer', minimum: 1 },
    args: { type: 'object' },
    activateOnSuccess: { type: 'boolean' },
    timeout: {
      type: 'integer',
      minimum: 1,
      description:
        'Deadline in milliseconds, not seconds. Omit it to run without a deadline. Values above the cap are clamped, not rejected: 600000 for a synchronous call and 7200000 with async: true. Values below 1000 are almost always a mistake, because one MCP tool call usually takes tens to hundreds of milliseconds.',
    },
    async: { type: 'boolean', default: false },
    workspace: { type: 'string' },
    visibleTools: { type: 'array', items: { type: 'string' } },
    excludeTags: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
});

const SEARCH_TOOLS_SCHEMA: ToolInputSchema = deepFreeze({
  type: 'object',
  properties: {
    query: { type: 'string', maxLength: 200 },
    server: { type: 'string' },
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
    taskIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
    timeoutMs: { type: 'integer', minimum: 1_000, maximum: 600_000, default: 270_000 },
  },
  required: ['taskIds'],
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

const SAVE_SCRIPT_SCHEMA: ToolInputSchema = deepFreeze({
  type: 'object',
  properties: {
    runId: { type: 'string' },
    scriptName: { type: 'string' },
    baseVersion: { type: 'integer', minimum: 1 },
    mode: { type: 'string', enum: ['exact', 'parameterized'] },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    code: { type: 'string' },
    inputSchema: { type: 'object' },
    exampleArgs: { type: 'object' },
    changelog: { type: 'string', maxLength: 1000 },
  },
  additionalProperties: false,
});

const SEARCH_SCRIPTS_SCHEMA: ToolInputSchema = deepFreeze({
  type: 'object',
  properties: {
    query: { type: 'string', maxLength: 200 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
  },
  additionalProperties: false,
});

/**
 * `tools/list` order is frozen: run_script, search_tools, describe_tools, wait_tasks,
 * report_problem, save_script, search_scripts. `run_script` carries no annotations because
 * scripts write files and run commands; marking it read-only would let plan mode through and
 * duplicate a retried call (docs/protocol.md §3.3). `report_problem` also carries none: it
 * writes a row and does not promise idempotency (06 §3.1). `wait_tasks` is read-only but
 * **not** idempotent: it consumes results, so a retried call answers `ALREADY_CONSUMED`
 * instead of the same payload (01 §4.2). `save_script` writes rows and carries none;
 * `search_scripts` is a pure read (10 §7.1).
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
    annotations: { readOnlyHint: true },
  },
  {
    name: 'report_problem',
    description: REPORT_PROBLEM_DESCRIPTION,
    inputSchema: REPORT_PROBLEM_SCHEMA,
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: 'save_script',
    description: SAVE_SCRIPT_DESCRIPTION,
    inputSchema: SAVE_SCRIPT_SCHEMA,
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: 'search_scripts',
    description: SEARCH_SCRIPTS_DESCRIPTION,
    inputSchema: SEARCH_SCRIPTS_SCHEMA,
    _meta: { 'anthropic/alwaysLoad': true },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
]);

export const TOOL_ORDER: readonly ToolName[] = Object.freeze(TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * Builds this request's `search_tools` definition. The `server` enum carries the
 * visible MCP server ids, including idle/0-tool servers; category and tag enums
 * carry only values present in the visible tool set. Absent sets publish no enum.
 */
export function buildSearchToolsDefinition(
  categories: readonly string[],
  tags: readonly string[],
  servers: readonly string[] = [],
): ToolDefinition {
  const server: JsonSchemaProperty =
    servers.length === 0 ? { type: 'string' } : { type: 'string', enum: [...servers] };
  const category: JsonSchemaProperty =
    categories.length === 0 ? { type: 'string' } : { type: 'string', enum: [...categories] };
  const tagItems: JsonSchemaProperty =
    tags.length === 0 ? { type: 'string' } : { type: 'string', enum: [...tags] };
  const inputSchema = deepFreeze<ToolInputSchema>({
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 200 },
      server,
      category,
      tags: { type: 'array', items: tagItems },
      max: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    additionalProperties: false,
  });
  return deepFreeze({
    name: 'search_tools',
    description: SEARCH_TOOLS_DESCRIPTION,
    inputSchema,
    _meta: { 'anthropic/alwaysLoad': true },
    annotations: { readOnlyHint: true, idempotentHint: true },
  });
}

const BY_NAME = new Map<string, ToolDefinition>(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

/** Per-request overrides; omitted fields keep the frozen shared definition. */
export interface ListToolsOptions {
  runScriptDescription?: string;
  searchToolsDescription?: string;
  searchToolsSchema?: ToolInputSchema;
  /** False for clients that declared MCP tasks: they collect via tasks/get, not wait_tasks. */
  includeWaitTasks?: boolean;
}

/**
 * `tools/list` entries. `run_script` and `search_tools` can be rebuilt for the
 * request; every other definition stays the frozen shared one.
 */
export function listTools(options: ListToolsOptions = {}): readonly ToolDefinition[] {
  const { runScriptDescription, searchToolsDescription, searchToolsSchema } = options;
  const definitions =
    options.includeWaitTasks === false
      ? TOOL_DEFINITIONS.filter((tool) => tool.name !== 'wait_tasks')
      : TOOL_DEFINITIONS;
  if (
    (runScriptDescription === undefined || runScriptDescription === RUN_SCRIPT_DESCRIPTION)
    && searchToolsDescription === undefined
    && searchToolsSchema === undefined
    && definitions === TOOL_DEFINITIONS
  ) {
    return definitions;
  }
  return Object.freeze(
    definitions.map((tool) => {
      if (tool.name === 'run_script' && runScriptDescription !== undefined) {
        return Object.freeze({ ...tool, description: runScriptDescription });
      }
      if (
        tool.name === 'search_tools'
        && (searchToolsDescription !== undefined || searchToolsSchema !== undefined)
      ) {
        return Object.freeze({
          ...tool,
          ...(searchToolsDescription === undefined ? {} : { description: searchToolsDescription }),
          ...(searchToolsSchema === undefined ? {} : { inputSchema: searchToolsSchema }),
        });
      }
      return tool;
    }),
  );
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
 * Validates arguments against the frozen schema, or against `definition` when a
 * per-request definition (the enum-carrying `search_tools`) has been built.
 * Defaults are intentionally not applied here: run_script's timeout default
 * depends on the dispatch mode (sync vs async).
 */
export function validateToolArguments(
  toolName: string,
  input: unknown,
  definition: ToolDefinition | undefined = getToolDefinition(toolName),
): ArgumentValidation {
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
    // `constructor`/`toString` are not schema properties; hasOwn keeps the
    // prototype chain out of the lookup.
    const property = Object.hasOwn(schema.properties, key)
      ? schema.properties[key]
      : undefined;
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

/** A tool-layer result whose payload is JSON text. */
export function jsonResult(value: unknown, isError: boolean): CallToolResult {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }],
    isError,
  };
}

export function toolFailure(code: string, message: string): CallToolResult {
  return jsonResult({ ok: false, error: { code, message } }, true);
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
