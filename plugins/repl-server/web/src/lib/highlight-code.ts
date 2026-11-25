/** Display-only JS syntax highlighting for the run_script code card. */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';

import { MAX_FORMAT_LENGTH } from './format-code.ts';

hljs.registerLanguage('javascript', javascript);

/**
 * Returns highlighted HTML for `code`, or null when the caller should keep
 * plain text (blank, oversized, or highlighting fails). highlight.js escapes
 * the source, so the result is safe to assign to innerHTML.
 */
export function highlightScriptCode(code: string): string | null {
  if (code.trim() === '' || code.length > MAX_FORMAT_LENGTH) return null;
  try {
    return hljs.highlight(code, { language: 'javascript', ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
