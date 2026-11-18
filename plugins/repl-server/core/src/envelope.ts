/** Renders the `<repl-output>` envelope the model reads. @module */

export interface EnvelopeParts {
  evalId: number;
  log?: string;
  result?: string;
  error?: string;
  async?: boolean;
  evalTaskId?: string;
  reset?: boolean;
  restored?: 'lastGood';
  truncated?: boolean;
}

export interface EnvelopeLimits {
  resultChars: number;
  logChars: number;
  errorChars: number;
}

const PARTIAL_ENTITY = /&(?:[a-zA-Z]*|#[xX][0-9a-fA-F]*|#[0-9]*)$/;

/** Escapes text content and attribute values. */
export function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(text: string): string {
  return escapeText(text).replaceAll('"', '&quot;');
}

function truncateEscaped(text: string, max: number): string {
  const escaped = escapeText(text);
  if (escaped.length <= max) return escaped;
  const cut = PARTIAL_ENTITY.exec(escaped.slice(0, max));
  const kept = cut === null ? escaped.slice(0, max) : escaped.slice(0, cut.index);
  return `${kept}\n[truncated: ${escaped.length - kept.length} more characters]`;
}

/** Builds `<repl-output>` with the optional attributes frozen in docs/protocol.md. */
export function renderEnvelope(parts: EnvelopeParts, limits: EnvelopeLimits): string {
  const attrs: string[] = [`eval="${parts.evalId}"`];
  if (parts.async === true) attrs.push('async="true"');
  if (parts.evalTaskId !== undefined) attrs.push(`task="${escapeAttr(parts.evalTaskId)}"`);
  if (parts.reset === true) attrs.push('reset="1"');
  if (parts.restored !== undefined) attrs.push(`restored="${parts.restored}"`);
  if (parts.truncated === true) attrs.push('truncated="1"');

  const children: string[] = [];
  if (parts.log !== undefined && parts.log !== '') {
    children.push(`<log>${truncateEscaped(parts.log, limits.logChars)}</log>`);
  }
  if (parts.result !== undefined) {
    children.push(`<result>${truncateEscaped(parts.result, limits.resultChars)}</result>`);
  }
  if (parts.error !== undefined) {
    children.push(`<error>${truncateEscaped(parts.error, limits.errorChars)}</error>`);
  }

  return `<repl-output ${attrs.join(' ')}>${children.join('')}</repl-output>`;
}
