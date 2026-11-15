/** Model-facing instructions for `run_code`. @module */
import { isGlobalToolName } from './prelude.ts';
import type { ToolDescriptor } from './types.ts';

const RULES = `Use run_code to run JavaScript that calls the tools below. Use it to batch several tool calls, to loop over results, or to combine results before answering. Only the program's result and the text passed to self.log come back to you.

- import, require or process are not available; call the listed tools instead, for files, shell commands and network access.
- The value of the program's last expression is returned as the result. Values that are not the last expression are not returned. Use self.log(...) to return anything else.
- A top-level \`return <value>\` is also returned as the result and ends the program there.
- Each tool is an async function that takes one object argument, with the fields shown in the list below. Call it with await, for example \`const result = await <tool>({ ...args });\`, using a name from the list. Results are usually objects, not strings: read their fields from the type shown after \`->\` , which describes the shape the tool resolves to. A failed tool call throws; catch it with try/catch when a failure is expected.
- Top-level const, let, var, function and class declarations persist across run_code calls in this session.
- Console output stays out of the result. Read recent console entries with console.tail(n). Use preview(value, n = 2000) to print a long value in bounded size.
- A run that does not finish within its time limit fails.`;

/** How a program calls one tool, for example `Read({ path })`. Optional fields end in `?`. */
export function toolSignature(tool: ToolDescriptor): string {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const properties = Object.keys(schema?.properties ?? {});
  const required = new Set(schema?.required ?? []);
  const fields = properties.map((field) => (required.has(field) ? field : `${field}?`));
  const args = fields.length === 0 ? '' : `{ ${fields.join(', ')} }`;
  const callee = isGlobalToolName(tool.name) ? tool.name : `tools[${JSON.stringify(tool.name)}]`;
  return `${callee}(${args})`;
}

/**
 * A valid example call, safe to copy into a program. Optional fields are omitted and required ones
 * are shown as `undefined`, so the example parses and passes argument validation.
 */
export function toolCallExample(tool: ToolDescriptor): string {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const required = new Set(schema?.required ?? []);
  const fields = Object.keys(schema?.properties ?? {}).filter((field) => required.has(field));
  const callee = isGlobalToolName(tool.name) ? tool.name : `tools[${JSON.stringify(tool.name)}]`;
  const args = fields.length === 0 ? '{}' : `{ ${fields.map((field) => `${JSON.stringify(field)}: undefined`).join(', ')} }`;
  return `await ${callee}(${args})`;
}

/** Longest return type shown after `->`. A longer type is cut and ends with an ellipsis. Sized so the DSH bash union (about 520 characters) shows in full. */
export const MAX_RETURN_CHARS = 600;
/** Fields shown per object. Extra fields are replaced by `...`. */
const MAX_FIELDS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Short type text for a JSON Schema node. Objects expand at depth 0 and 1 (the top-level
 * value and one nested level). Objects deeper than that show as `{...}`.
 */
function typeText(node: unknown, depth: number): string {
  if (!isRecord(node)) return 'unknown';
  if ('const' in node) return JSON.stringify(node.const) ?? 'unknown';
  if (Array.isArray(node.enum)) return node.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (Array.isArray(node.oneOf)) return node.oneOf.map((branch) => typeText(branch, depth)).join(' | ');
  const declared = node.type;
  const type = typeof declared === 'string'
    ? declared
    : Array.isArray(declared) ? declared.filter((item): item is string => typeof item === 'string').join(' | ') : '';
  if (type === 'array') return `${typeText(node.items, depth)}[]`;
  const properties = isRecord(node.properties) ? node.properties : undefined;
  if (type !== 'object' && properties === undefined) return type === '' ? 'unknown' : type;
  if (properties === undefined || Object.keys(properties).length === 0) return 'object';
  if (depth > 1) return '{...}';
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const names = Object.keys(properties);
  const fields = names.slice(0, MAX_FIELDS).map((name) => {
    const optional = required.has(name) ? '' : '?';
    return `${name}${optional}: ${typeText(properties[name], depth + 1)}`;
  });
  if (names.length > MAX_FIELDS) fields.push('...');
  return `{ ${fields.join(', ')} }`;
}

/** The return type of a tool as short text, or undefined when the tool declares no output schema. */
export function returnSummary(outputSchema: unknown): string | undefined {
  if (!isRecord(outputSchema)) return undefined;
  const text = typeText(outputSchema, 0);
  return text.length <= MAX_RETURN_CHARS ? text : `${text.slice(0, MAX_RETURN_CHARS - 1)}…`;
}

/** The ` -> type` suffix for a tool line. Empty when the tool has no output schema. */
export function toolReturns(tool: ToolDescriptor): string {
  const text = returnSummary(tool.outputSchema);
  return text === undefined ? '' : ` -> ${text}`;
}

/** Instructions for the step's visible tools. Each tool line shows how to call it from code and what it returns. */
export function renderInstructions(tools: readonly ToolDescriptor[]): string {
  const list = tools.length === 0
    ? 'There are no tools available in this step, so run_code can only compute values.'
    : ['Available tools (call them from inside run_code only):', ...tools.map((tool) => `- ${toolSignature(tool)}${toolReturns(tool)}: ${tool.description}`)].join('\n');
  return `${RULES}\n\n${list}`;
}
