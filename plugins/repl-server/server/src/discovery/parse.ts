/**
 * Pure parser for lazy-tool search results (design 07 §3.5).
 *
 * The upstream search tool may answer in any of these shapes:
 * - a `CallToolResult` wrapper whose text blocks carry the JSON payload;
 * - `{ tools: [...] }`;
 * - a bare array of tool objects;
 * - one level of `{ result: ... }` / `{ data: ... }` envelope.
 *
 * It never touches the database or the pool, never guesses, and never throws on
 * malformed upstream data: unrecognized input becomes `parsed = false` with the
 * raw text preserved for human inspection.
 *
 * @module
 */

import type { DiscoverySkippedTool } from './types.ts';

/** Upstream text larger than this is cut before parsing. */
export const DISCOVERY_TEXT_MAX_BYTES = 256 * 1024;
/** Raw text echoed to the admin preview. */
export const DISCOVERY_RAW_MAX_BYTES = 64 * 1024;
/** Per-tool description cap. */
export const DISCOVERY_DESCRIPTION_MAX_CHARS = 8192;
/** Per-tool serialized schema cap; an oversized schema is skipped, never truncated. */
export const DISCOVERY_SCHEMA_MAX_BYTES = 64 * 1024;
/** Elements considered by one scan. */
export const DISCOVERY_MAX_ELEMENTS = 2000;

export const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type DiscoveryShape =
  | 'call_result_tools'
  | 'call_result_array'
  | 'tools_object'
  | 'tool_array'
  | 'envelope_tools'
  | 'unknown';

export interface ParsedDiscoveryTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
  schemaMissing: boolean;
  descriptionTruncated: boolean;
}

export interface ParseOutcome {
  parsed: boolean;
  shape: DiscoveryShape;
  tools: ParsedDiscoveryTool[];
  skipped: DiscoverySkippedTool[];
  /** Raw elements seen in the payload, including skipped ones. */
  elements: number;
  /** Elements beyond {@link DISCOVERY_MAX_ELEMENTS}. */
  omitted: number;
  nextCursor: string | null;
  raw: string | null;
  rawTruncated: boolean;
}

export interface ParseOptions {
  /** Defaults to {@link DISCOVERY_MAX_ELEMENTS}. */
  maxElements?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  // Cut on code-unit boundaries until the UTF-8 budget fits; malformed halves
  // are still valid UTF-16, and the marker tells the admin the body was cut.
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function rawFor(text: string): { raw: string | null; rawTruncated: boolean } {
  if (text === '') return { raw: null, rawTruncated: false };
  const cut = truncateToBytes(text, DISCOVERY_RAW_MAX_BYTES);
  return { raw: cut.text, rawTruncated: cut.truncated };
}

/** Concatenates the text blocks of a `CallToolResult`; other blocks are ignored. */
function callResultText(value: Record<string, unknown>): { text: string; wrapped: boolean } | null {
  if (!Array.isArray(value['content'])) return null;
  const parts: string[] = [];
  for (const block of value['content']) {
    if (!isRecord(block)) continue;
    if (block['type'] !== 'text') continue;
    if (typeof block['text'] === 'string') parts.push(block['text']);
  }
  return { text: parts.join(''), wrapped: true };
}

function readCursor(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = value['nextCursor'] ?? value['next_cursor'];
  return typeof direct === 'string' && direct !== '' ? direct : null;
}

function normalizeName(raw: string, serverId: string): string {
  let name = raw.trim();
  const mcpPrefix = `mcp__${serverId}__`;
  if (name.startsWith(mcpPrefix)) name = name.slice(mcpPrefix.length);
  const dottedPrefix = `${serverId}.`;
  if (name.startsWith(dottedPrefix)) name = name.slice(dottedPrefix.length);
  return name;
}

function defaultSchema(): unknown {
  return { type: 'object', properties: {}, additionalProperties: true };
}

function readSchema(element: Record<string, unknown>): { schema: unknown; missing: boolean } {
  for (const key of ['inputSchema', 'parameters', 'schema'] as const) {
    const candidate = element[key];
    if (isRecord(candidate)) return { schema: candidate, missing: false };
  }
  return { schema: defaultSchema(), missing: true };
}

interface NormalizeResult {
  tool: ParsedDiscoveryTool | null;
  skipped: DiscoverySkippedTool | null;
}

function normalizeElement(element: unknown, serverId: string): NormalizeResult {
  if (!isRecord(element)) {
    return { tool: null, skipped: { reason: 'not_an_object' } };
  }
  if (typeof element['name'] !== 'string' || element['name'].trim() === '') {
    return { tool: null, skipped: { reason: 'invalid_name' } };
  }

  const rawName = element['name'];
  const name = normalizeName(rawName, serverId);
  if (!TOOL_NAME_PATTERN.test(name)) {
    return { tool: null, skipped: { name: rawName, reason: 'invalid_name' } };
  }

  let description: string | null = null;
  let descriptionTruncated = false;
  if (typeof element['description'] === 'string') {
    const text = element['description'];
    if (text.length > DISCOVERY_DESCRIPTION_MAX_CHARS) {
      description = text.slice(0, DISCOVERY_DESCRIPTION_MAX_CHARS);
      descriptionTruncated = true;
    } else {
      description = text;
    }
  }

  const { schema, missing } = readSchema(element);
  if (byteLength(JSON.stringify(schema)) > DISCOVERY_SCHEMA_MAX_BYTES) {
    return { tool: null, skipped: { name, reason: 'schema_too_large' } };
  }

  return {
    tool: {
      name,
      description,
      inputSchema: schema,
      schemaMissing: missing,
      descriptionTruncated,
    },
    skipped: null,
  };
}

/** `{ tools: [...] }` or a bare array; envelopes are unwrapped one level. */
interface PayloadShape {
  shape: Exclude<DiscoveryShape, 'unknown' | 'call_result_tools' | 'call_result_array'>;
  elements: unknown[];
  cursorSource: unknown;
}

function readPayloadShape(payload: unknown): PayloadShape | null {
  if (Array.isArray(payload)) {
    return { shape: 'tool_array', elements: payload, cursorSource: null };
  }
  if (!isRecord(payload)) return null;

  if (Array.isArray(payload['tools'])) {
    return { shape: 'tools_object', elements: payload['tools'], cursorSource: payload };
  }
  if (typeof payload['name'] === 'string') {
    return { shape: 'tool_array', elements: [payload], cursorSource: payload };
  }
  for (const key of ['result', 'data'] as const) {
    const inner = payload[key];
    if (Array.isArray(inner)) {
      return { shape: 'envelope_tools', elements: inner, cursorSource: payload };
    }
    if (isRecord(inner) && Array.isArray(inner['tools'])) {
      return { shape: 'envelope_tools', elements: inner['tools'], cursorSource: inner };
    }
  }
  return null;
}

function emptyOutcome(raw: string): ParseOutcome {
  const captured = rawFor(raw);
  return {
    parsed: false,
    shape: 'unknown',
    tools: [],
    skipped: [],
    elements: 0,
    omitted: 0,
    nextCursor: null,
    raw: captured.raw,
    rawTruncated: captured.rawTruncated,
  };
}

/**
 * Parses one upstream search result. `serverId` strips self-qualified names and
 * is only used for prefix normalization, never to reach the network.
 */
export function parseDiscoveryResult(
  result: unknown,
  serverId: string,
  options: ParseOptions = {},
): ParseOutcome {
  const maxElements = options.maxElements ?? DISCOVERY_MAX_ELEMENTS;

  let payload: unknown = result;
  let wrapped = false;
  let text: string | null = null;

  if (isRecord(result)) {
    const callResult = callResultText(result);
    if (callResult !== null) {
      wrapped = true;
      text = callResult.text;
    }
  } else if (typeof result === 'string') {
    text = result;
  }

  if (text !== null) {
    const cut = truncateToBytes(text, DISCOVERY_TEXT_MAX_BYTES);
    try {
      payload = JSON.parse(cut.text);
    } catch {
      const outcome = emptyOutcome(text);
      outcome.rawTruncated = outcome.rawTruncated || cut.truncated;
      outcome.skipped = [{ reason: 'unrecognized_shape' }];
      return outcome;
    }
  }

  const resolved = readPayloadShape(payload);
  if (resolved === null) {
    const rawText =
      text ?? (typeof payload === 'string' ? payload : JSON.stringify(payload) ?? '');
    const outcome = emptyOutcome(rawText);
    outcome.skipped = [{ reason: 'unrecognized_shape' }];
    return outcome;
  }

  const shape: DiscoveryShape =
    resolved.shape === 'tools_object'
      ? wrapped
        ? 'call_result_tools'
        : 'tools_object'
      : resolved.shape === 'tool_array'
        ? wrapped
          ? 'call_result_array'
          : 'tool_array'
        : 'envelope_tools';

  const tools: ParsedDiscoveryTool[] = [];
  const skipped: DiscoverySkippedTool[] = [];
  const seen = new Set<string>();
  const limit = Math.min(resolved.elements.length, maxElements);
  let omitted = Math.max(0, resolved.elements.length - maxElements);

  for (let index = 0; index < limit; index += 1) {
    const outcome = normalizeElement(resolved.elements[index], serverId);
    if (outcome.skipped !== null) {
      skipped.push(outcome.skipped);
      continue;
    }
    const tool = outcome.tool;
    if (tool === null) continue;
    if (seen.has(tool.name)) {
      skipped.push({ name: tool.name, reason: 'duplicate_name' });
      continue;
    }
    seen.add(tool.name);
    tools.push(tool);
  }

  const nextCursor = readCursor(resolved.cursorSource) ?? readCursor(payload);
  const rawCapture = text === null ? { raw: null, rawTruncated: false } : rawFor(text);

  return {
    parsed: true,
    shape,
    tools,
    skipped,
    elements: resolved.elements.length,
    omitted,
    nextCursor,
    raw: rawCapture.raw,
    rawTruncated: rawCapture.rawTruncated,
  };
}
