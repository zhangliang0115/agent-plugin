/** Normalizes serve and third-party MCP results into the objects scripts consume. @module */

/** One content block as returned by serve or an MCP server. */
export interface ServeContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly resource?: {
    readonly uri?: string;
    readonly mimeType?: string;
    readonly text?: string;
    readonly blob?: string;
  };
}

/** A `tools/call` result from serve or a third-party MCP server. */
export interface ServeToolResult {
  readonly content: readonly ServeContentBlock[];
  readonly isError?: boolean;
}

export interface ResultImage {
  base64: string;
  mediaType: string;
}

export interface ResultDocument {
  base64: string;
}

/** Text plus media after MCP content blocks are flattened. */
export interface NormalizedContent {
  text: string;
  images: ResultImage[];
  documents: ResultDocument[];
}

/** Script-facing shape of one Read call. */
export interface ReadToolResult {
  content: string;
  file_path?: string;
  numLines: number;
  startLine: number;
}

/** Script-facing shape of one Edit call. `patch` is serve's structuredPatch verbatim. */
export interface EditToolResult {
  file_path: string;
  ok: true;
  summary: string;
  patch?: unknown;
}

export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Formats file text the way Read shows it: six-column line numbers and `→`. */
export function formatReadContent(content: string, startLine = 1): string {
  if (content === '') return '';
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line, index) => `${String(startLine + index).padStart(6, ' ')}→${line}\n`).join('');
}

/** Flattens text, images and PDF resources. Text blocks are joined with newlines. */
export function normalizeContent(content: readonly ServeContentBlock[] | undefined): NormalizedContent {
  const blocks = Array.isArray(content) ? content : [];
  const texts: string[] = [];
  const images: ResultImage[] = [];
  const documents: ResultDocument[] = [];

  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string') texts.push(block.text);
      continue;
    }
    if (block.type === 'image') {
      if (typeof block.data !== 'string') continue;
      const mediaType = typeof block.mimeType === 'string' ? block.mimeType : 'application/octet-stream';
      if (mediaType === 'application/pdf') documents.push({ base64: block.data });
      else images.push({ base64: block.data, mediaType });
      continue;
    }
    if (block.type === 'resource') {
      const resource = block.resource;
      if (!isRecord(resource)) continue;
      if (typeof resource.text === 'string') {
        texts.push(resource.text);
        continue;
      }
      if (typeof resource.blob === 'string' && resource.mimeType === 'application/pdf') {
        documents.push({ base64: resource.blob });
      }
    }
  }

  return { text: texts.join('\n'), images, documents };
}

export function textOf(result: ServeToolResult): string {
  return normalizeContent(result.content).text;
}

export function parseJsonText(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Turns a parsed Read payload into the script-facing shape; undefined when it is not a file read. */
export function normalizeReadResult(value: unknown): ReadToolResult | undefined {
  if (!isRecord(value) || !isRecord(value.file)) return undefined;
  const file = value.file;
  if (typeof file.content !== 'string') return undefined;

  const startLine = typeof file.startLine === 'number' && Number.isFinite(file.startLine) ? file.startLine : 1;
  const numLines = typeof file.numLines === 'number' && Number.isFinite(file.numLines)
    ? file.numLines
    : countLines(file.content);
  const filePath = typeof file.filePath === 'string'
    ? file.filePath
    : typeof file.file_path === 'string' ? file.file_path : undefined;

  return {
    content: formatReadContent(file.content, startLine),
    ...(filePath === undefined ? {} : { file_path: filePath }),
    numLines,
    startLine,
  };
}

/** Turns a parsed Edit payload into the script-facing shape; undefined when the payload is not an edit. */
export function normalizeEditResult(value: unknown): EditToolResult | undefined {
  if (!isRecord(value)) return undefined;
  const filePath = typeof value.filePath === 'string'
    ? value.filePath
    : typeof value.file_path === 'string' ? value.file_path : undefined;
  if (filePath === undefined) return undefined;

  const summary = typeof value.summary === 'string' && value.summary !== ''
    ? value.summary
    : editSummary(value);
  const patch = Array.isArray(value.structuredPatch) && value.structuredPatch.length > 0
    ? value.structuredPatch
    : typeof value.patch === 'string' && value.patch !== '' ? value.patch : undefined;

  return {
    file_path: filePath,
    ok: true,
    summary,
    ...(patch === undefined ? {} : { patch }),
  };
}

/**
 * Normalizes one official serve result. Failures resolve `{ error }`; success is
 * the parsed inner JSON (Read and Edit get their dedicated shape) or the raw
 * text when the payload is not JSON. Media blocks are attached, never dropped.
 */
export function normalizeOfficialResult(tool: string, result: ServeToolResult): unknown {
  const content = normalizeContent(result.content);
  if (result.isError === true) {
    return { error: content.text.trim() === '' ? `${tool} failed` : content.text };
  }

  const parsed = parseJsonText(content.text);
  let value: unknown = parsed.ok ? parsed.value : content.text;
  if (parsed.ok && tool === 'Read') {
    const read = normalizeReadResult(parsed.value);
    if (read !== undefined) value = read;
  } else if (parsed.ok && tool === 'Edit') {
    const edit = normalizeEditResult(parsed.value);
    if (edit !== undefined) value = edit;
  }
  return attachMedia(value, content);
}

/** Third-party MCP success: text stays joined, images and PDFs stay in separate fields. */
export function normalizeMcpResult(result: ServeToolResult): NormalizedContent {
  return normalizeContent(result.content);
}

function countLines(content: string): number {
  if (content === '') return 0;
  const lines = content.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function editSummary(edit: Record<string, unknown>): string {
  if (edit.replaceAll !== true) return 'replaced 1 occurrence';
  const original = typeof edit.originalFile === 'string' ? edit.originalFile : undefined;
  const oldString = typeof edit.oldString === 'string' ? edit.oldString : '';
  const count = original === undefined || oldString === '' ? 1 : Math.max(1, countOccurrences(original, oldString));
  return `replaced ${count} ${count === 1 ? 'occurrence' : 'occurrences'}`;
}

function attachMedia(value: unknown, content: NormalizedContent): unknown {
  if (content.images.length === 0 && content.documents.length === 0) return value;
  const media: Record<string, unknown> = {};
  if (content.images.length > 0) media.images = content.images;
  if (content.documents.length > 0) media.documents = content.documents;
  if (isRecord(value)) return { ...value, ...media };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { text, ...media };
}
