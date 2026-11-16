/**
 * Parsing of the multi-line text fields in the server form: one argument per
 * line, and `KEY=VALUE` per line for env and headers. @module
 */

/** Result of parsing `KEY=VALUE` lines. */
export interface KeyValueParse {
  readonly value: Record<string, string>;
  readonly errors: string[];
}

/**
 * Split text into trimmed, non-empty lines.
 * @param text - the textarea content.
 */
export function parseLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '');
}

/**
 * Parse `KEY=VALUE` lines. The first `=` separates key from value, so values
 * may contain `=`. A repeated key keeps its last value and is reported.
 * @param text - the textarea content.
 */
export function parseKeyValueLines(text: string): KeyValueParse {
  const value: Record<string, string> = {};
  const errors: string[] = [];
  const seen = new Set<string>();
  parseLines(text).forEach((line, index) => {
    const at = line.indexOf('=');
    const where = `第 ${String(index + 1)} 行「${line}」`;
    if (at === -1) {
      errors.push(`${where}缺少 KEY=VALUE 格式`);
      return;
    }
    const key = line.slice(0, at).trim();
    if (key === '') {
      errors.push(`${where}缺少键名`);
      return;
    }
    if (seen.has(key)) errors.push(`键「${key}」重复出现`);
    seen.add(key);
    value[key] = line.slice(at + 1).trim();
  });
  return { value, errors };
}

/**
 * Render a record as `KEY=VALUE` lines, sorted by key, for editing.
 * @param record - env or header values.
 */
export function formatKeyValueLines(record: Readonly<Record<string, string>>): string {
  return Object.keys(record).sort().map(key => `${key}=${record[key] ?? ''}`).join('\n');
}
