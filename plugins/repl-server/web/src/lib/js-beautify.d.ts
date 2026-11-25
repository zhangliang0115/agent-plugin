/** js-beautify 2.x ships no declarations; only the options this app passes are typed. */
declare module 'js-beautify' {
  export interface JsBeautifyOptions {
    indent_size?: number;
    indent_char?: string;
    preserve_newlines?: boolean;
    end_with_newline?: boolean;
    wrap_line_length?: number;
  }

  export function js(source: string, options?: JsBeautifyOptions): string;

  const beautify: typeof js;
  export default beautify;
}
