/** Renders the `<repl-output>` envelope returned to the model. @module */

export interface EnvelopeParts {
  readonly evalIndex: number;
  readonly log?: string;
  readonly result?: string;
  readonly error?: string;
}

export interface EnvelopeLimits {
  readonly resultChars: number;
  readonly logChars: number;
  readonly errorChars: number;
}

/** Escapes the characters that could open or close an envelope tag. */
export function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Keeps the first `max` characters and appends a marker with the removed count. */
export function truncateText(text: string, max: number, detail?: string): string {
  if (text.length <= max) return text;
  const extra = detail === undefined || detail === '' ? '' : `. ${detail}`;
  return `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters${extra}]`;
}

/** A trailing `&` escape cut before its `;`. In escaped text every `&` starts an entity. */
const PARTIAL_ENTITY = /&(?:[a-zA-Z]*|#[xX][0-9a-fA-F]*|#[0-9]*)$/;

/** Drops a trailing entity the cut left incomplete, so the model never reads a fragment like `&a`. */
function trimPartialEntity(text: string): string {
  const match = PARTIAL_ENTITY.exec(text);
  return match === null ? text : text.slice(0, match.index);
}

/**
 * Escapes, then truncates: the limit applies to what the model receives, not to the raw text.
 * Truncating first lets `&` grow fivefold when it is escaped afterwards. The cut never leaves a
 * partial escape entity behind: the marker reports what was actually removed.
 */
export function escapeAndTruncate(text: string, max: number, detail?: string): string {
  const escaped = escapeText(text);
  if (escaped.length <= max) return escaped;
  const kept = trimPartialEntity(escaped.slice(0, max));
  const extra = detail === undefined || detail === '' ? '' : `. ${detail}`;
  const marker = escapeText(`[truncated: ${escaped.length - kept.length} more characters${extra}]`);
  return `${kept}\n${marker}`;
}

/** Builds `<repl-output eval="N">` with optional `<log>`, `<result>` and `<error>` children. */
export function renderEnvelope(parts: EnvelopeParts, limits: EnvelopeLimits, notices: { readonly result?: string } = {}): string {
  const children: string[] = [];
  if (parts.log !== undefined && parts.log !== '') {
    children.push(`<log>${escapeAndTruncate(parts.log, limits.logChars)}</log>`);
  }
  if (parts.result !== undefined) {
    children.push(`<result>${escapeAndTruncate(parts.result, limits.resultChars, notices.result)}</result>`);
  }
  if (parts.error !== undefined) {
    children.push(`<error>${escapeAndTruncate(parts.error, limits.errorChars)}</error>`);
  }
  return `<repl-output eval="${parts.evalIndex}">${children.join('')}</repl-output>`;
}
