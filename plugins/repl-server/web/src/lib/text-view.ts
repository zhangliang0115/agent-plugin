/**
 * Display-side helpers for large bodies (`09 §五`).
 *
 * The payload viewer never wants to hand the browser a 50 MB string: raw text
 * goes through a windowed renderer (a few thousand DOM rows at most), bodies
 * over the render cap are offered as a download only, and `Edit`-family args
 * become a line diff. Everything here is pure so `node --test` can check the
 * hard parts: the LCS, the window math and the oversized-body policy.
 */

/** Bodies above this are downloaded, not rendered. */
export const RENDER_MAX_BYTES = 5 * 1024 * 1024;
/** Externalised bodies up to this size load on mount; larger ones wait for the button. */
export const AUTO_LOAD_BYTES = 1024 * 1024;
/** One rendered row per source line; must match the CSS line-height. */
export const VIRTUAL_ROW_HEIGHT = 18;
/** Rows kept above and below the viewport so fast scrolls stay smooth. */
export const VIRTUAL_BUFFER = 20;
/**
 * A single line longer than this is clipped for display: virtualisation is
 * per line, so one mega-line without newlines would defeat it entirely.
 */
export const MAX_LINE_CHARS = 4000;
/** LCS DP cells above this fall back to the honest whole-old/whole-new view. */
const DIFF_MAX_CELLS = 4 * 1024 * 1024;

export type LineKind = 'plain' | 'ctx' | 'del' | 'add';

export interface TextLine {
  text: string;
  kind: LineKind;
}

/** Splits for display; an empty body stays one (empty) line. */
export function splitLines(text: string): string[] {
  return text.split('\n');
}

/** Clips one line for display, saying so; the full line stays in the blob. */
export function clampLine(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)} …（本行超长，已截断显示）` : text;
}

export function textLines(text: string): TextLine[] {
  return splitLines(text).map((line) => ({ text: clampLine(line), kind: 'plain' }));
}

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/** Splits one line into hit / non-hit chunks (case-insensitive). */
export function highlightParts(line: string, query: string): HighlightPart[] {
  if (query === '') return [{ text: line, hit: false }];
  const lowerLine = line.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (;;) {
    const at = lowerLine.indexOf(lowerQuery, cursor);
    if (at === -1) break;
    if (at > cursor) parts.push({ text: line.slice(cursor, at), hit: false });
    parts.push({ text: line.slice(at, at + query.length), hit: true });
    cursor = at + query.length;
  }
  if (cursor < line.length) parts.push({ text: line.slice(cursor), hit: false });
  return parts.length === 0 ? [{ text: line, hit: false }] : parts;
}

/** Indices of lines matching `query`; drives the match counter. */
export function matchLineIndices(lines: TextLine[], query: string): number[] {
  if (query === '') return [];
  const lowerQuery = query.toLowerCase();
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.text.toLowerCase().includes(lowerQuery)) hits.push(index);
  }
  return hits;
}

export interface VirtualWindow {
  start: number;
  end: number;
}

/**
 * The slice of lines a viewport should render. Never returns more than
 * `ceil(viewport / row) + 2 * buffer` rows, so a 10 MB body costs the same
 * DOM as a 10 KB one.
 */
export function virtualWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
): VirtualWindow {
  const height = Math.max(1, rowHeight);
  const rows = Math.ceil(Math.max(0, viewportHeight) / height) + 2 * VIRTUAL_BUFFER;
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / height) - VIRTUAL_BUFFER);
  const start = Math.min(first, Math.max(0, total - rows));
  const end = Math.min(total, start + rows);
  return { start, end };
}

/**
 * Classic LCS line diff. Returns del / add / ctx rows in unified order. When
 * the input is too large for the DP table it degrades honestly: all old lines
 * as deletions, all new lines as additions — never a silently wrong diff.
 */
export function lineDiff(oldText: string, newText: string): TextLine[] {
  // An empty string has no lines; treating it as one empty line would paint a
  // phantom deletion on every all-add diff (Write, NotebookEdit).
  const oldLines = oldText === '' ? [] : splitLines(oldText);
  const newLines = newText === '' ? [] : splitLines(newText);
  if (oldLines.length * newLines.length > DIFF_MAX_CELLS) {
    return [
      ...oldLines.map((text) => ({ text: clampLine(text), kind: 'del' as LineKind })),
      { text: '—— 行数过大，未做逐行匹配 ——', kind: 'ctx' as LineKind },
      ...newLines.map((text) => ({ text: clampLine(text), kind: 'add' as LineKind })),
    ];
  }

  const width = newLines.length + 1;
  const table = new Int32Array(width * (oldLines.length + 1));
  const at = (row: number, column: number): number => table[row * width + column] ?? 0;
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const out: TextLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push({ text: clampLine(oldLines[i] ?? ''), kind: 'ctx' });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ text: clampLine(oldLines[i] ?? ''), kind: 'del' });
      i += 1;
    } else {
      out.push({ text: clampLine(newLines[j] ?? ''), kind: 'add' });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    out.push({ text: clampLine(oldLines[i] ?? ''), kind: 'del' });
    i += 1;
  }
  while (j < newLines.length) {
    out.push({ text: clampLine(newLines[j] ?? ''), kind: 'add' });
    j += 1;
  }
  return out;
}

export interface ToolDiff {
  /** What the header should call it, usually the file path. */
  title: string;
  lines: TextLine[];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

const SEPARATOR: TextLine = { text: '—— 后续修改 ——', kind: 'ctx' };

/**
 * Builds a diff from the *full* args of a write-family tool. Only those tools:
 * their args carry both sides (`old_string`/`new_string`) or the whole new
 * content (`Write` has no old side recorded — every line shows as an add,
 * which is honest, not a guess).
 */
export function diffFromArgs(tool: string | null, args: unknown): ToolDiff | null {
  const input = asRecord(args);
  if (tool === null || input === null) return null;

  if (tool === 'Edit') {
    const oldText = asText(input['old_string']);
    const newText = asText(input['new_string']);
    if (oldText === '' && newText === '') return null;
    return { title: asText(input['file_path']) || 'Edit', lines: lineDiff(oldText, newText) };
  }

  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input['edits']) ? input['edits'] : [];
    if (edits.length === 0) return null;
    const lines: TextLine[] = [];
    for (const [index, raw] of edits.entries()) {
      const edit = asRecord(raw);
      if (edit === null) continue;
      if (index > 0) lines.push(SEPARATOR);
      lines.push(...lineDiff(asText(edit['old_string']), asText(edit['new_string'])));
    }
    if (lines.length === 0) return null;
    return { title: asText(input['file_path']) || 'MultiEdit', lines };
  }

  if (tool === 'Write') {
    const content = asText(input['content']);
    if (content === '') return null;
    // No old side is recorded for Write; an all-add view is the honest option.
    return {
      title: asText(input['file_path']) || 'Write',
      lines: lineDiff('', content),
    };
  }

  if (tool === 'NotebookEdit') {
    const source = asText(input['new_source']);
    if (source === '') return null;
    return {
      title: asText(input['notebook_path']) || 'NotebookEdit',
      lines: lineDiff('', source),
    };
  }

  return null;
}

/** True when an externalised body of `bytes` should be fetched without a click. */
export function shouldAutoLoad(bytes: number | null): boolean {
  return bytes !== null && bytes <= AUTO_LOAD_BYTES;
}

/** True when a body of `bytes` may be rendered; oversized bodies are downloads. */
export function shouldRenderBody(bytes: number | null): boolean {
  if (bytes === null) return true;
  return bytes <= RENDER_MAX_BYTES;
}
