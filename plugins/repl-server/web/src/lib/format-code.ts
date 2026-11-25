/** Display-only JS formatting for the run_script code card. */
import beautify from 'js-beautify';

/** Above this size formatting and highlighting block the render for no visible gain. */
export const MAX_FORMAT_LENGTH = 200_000;

/**
 * Pretty-prints `code` for reading; never for execution. Returns the input
 * unchanged when it is blank, oversized, or beautifying fails. `formatted`
 * says whether the returned text differs from the input.
 */
export function formatScriptCode(code: string): { text: string; formatted: boolean } {
  if (code.trim() === '' || code.length > MAX_FORMAT_LENGTH) {
    return { text: code, formatted: false };
  }
  try {
    const text = beautify(code, {
      indent_size: 2,
      preserve_newlines: true,
      end_with_newline: false,
      wrap_line_length: 0,
    });
    if (text === '') return { text: code, formatted: false };
    return { text, formatted: text !== code };
  } catch {
    return { text: code, formatted: false };
  }
}
