/** Renders the `<repl-output>` envelope the model reads. @module */

export interface EnvelopeParts {
  evalId: number;
  /** Execution id; rendered as `run="..."`. */
  runId?: string;
  log?: string;
  result?: string;
  error?: string;
  async?: boolean;
  evalTaskId?: string;
  reset?: boolean;
  restored?: 'lastGood';
  truncated?: boolean;
}

/** Escapes text content and attribute values. */
export function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(text: string): string {
  return escapeText(text).replaceAll('"', '&quot;');
}

/** Builds `<repl-output>` with the optional attributes frozen in docs/protocol.md. */
export function renderEnvelope(parts: EnvelopeParts): string {
  const attrs: string[] = [`eval="${parts.evalId}"`];
  if (parts.runId !== undefined) attrs.push(`run="${escapeAttr(parts.runId)}"`);
  if (parts.async === true) attrs.push('async="true"');
  if (parts.evalTaskId !== undefined) attrs.push(`task="${escapeAttr(parts.evalTaskId)}"`);
  if (parts.reset === true) attrs.push('reset="1"');
  if (parts.restored !== undefined) attrs.push(`restored="${parts.restored}"`);
  if (parts.truncated === true) attrs.push('truncated="1"');

  const children: string[] = [];
  if (parts.log !== undefined && parts.log !== '') {
    children.push(`<log>${escapeText(parts.log)}</log>`);
  }
  if (parts.result !== undefined) {
    children.push(`<result>${escapeText(parts.result)}</result>`);
  }
  if (parts.error !== undefined) {
    children.push(`<error>${escapeText(parts.error)}</error>`);
  }

  return `<repl-output ${attrs.join(' ')}>${children.join('')}</repl-output>`;
}
