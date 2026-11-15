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

/**
 * Escapes, then truncates: the limit applies to what the model receives, not to the raw text.
 * Truncating first lets `&` grow fivefold when it is escaped afterwards.
 */
export function escapeAndTruncate(text: string, max: number, detail?: string): string {
  const escaped = escapeText(text);
  if (escaped.length <= max) return escaped;
  const extra = detail === undefined || detail === '' ? '' : `. ${detail}`;
  const marker = escapeText(`[truncated: ${escaped.length - max} more characters${extra}]`);
  return `${escaped.slice(0, max)}\n${marker}`;
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
