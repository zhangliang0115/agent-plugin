/** Pure row helpers for the server env/header key-value editor. @module */

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

export type EnvHeaderKind = 'env' | 'headers';
export type EnvHeaderSource = 'literal' | 'secret';
export type EnvHeaderValue = string | { $secret: string };

/** One editable row: a literal plain-config value or a secret reference name. */
export interface EnvHeaderRow {
  key: string;
  source: EnvHeaderSource;
  value: string;
}

/** The `ServerView` fields the editor reads back. */
export interface EnvHeaderView {
  envKeys?: readonly string[];
  headerKeys?: readonly string[];
  envSecrets?: Readonly<Record<string, string>>;
  headerSecrets?: Readonly<Record<string, string>>;
  envLiterals?: Readonly<Record<string, string>>;
  headerLiterals?: Readonly<Record<string, string>>;
}

export function emptyRow(): EnvHeaderRow {
  return { key: '', source: 'literal', value: '' };
}

/** Rows for an existing server: literal values from `envLiterals`, the rest from secrets. */
export function rowsFromServer(server: EnvHeaderView, kind: EnvHeaderKind): EnvHeaderRow[] {
  const keys = (kind === 'env' ? server.envKeys : server.headerKeys) ?? [];
  const secrets = (kind === 'env' ? server.envSecrets : server.headerSecrets) ?? {};
  const literals = (kind === 'env' ? server.envLiterals : server.headerLiterals) ?? {};
  return keys.map((key) => {
    const secret = secrets[key];
    if (secret !== undefined) return { key, source: 'secret', value: secret };
    return { key, source: 'literal', value: literals[key] ?? '' };
  });
}

/** Rows the user actually filled; a blank added row is ignored. */
export function filledRows(rows: readonly EnvHeaderRow[]): EnvHeaderRow[] {
  return rows.filter((row) => row.key.trim() !== '' || row.value.trim() !== '');
}

function assign<T>(values: Record<string, T>, key: string, value: T): void {
  // `__proto__` passes the key patterns but would set the prototype.
  if (key === '__proto__') throw new Error('__proto__ is not accepted as an env/header key');
  values[key] = value;
}

/** Validates the filled rows; returns the first user-facing problem or `null`. */
export function rowsProblem(
  rows: readonly EnvHeaderRow[],
  kind: EnvHeaderKind,
  options: { secretNameMustMatchKey?: boolean } = {},
): string | null {
  const pattern = kind === 'env' ? ENV_KEY_PATTERN : HEADER_KEY_PATTERN;
  const noun = kind === 'env' ? 'env 键名' : 'header 名';
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row.key.trim() === '' && row.value.trim() === '') continue;
    const key = row.key.trim();
    const value = row.value.trim();
    if (key === '') return `第 ${index + 1} 行：${noun}不能为空`;
    if (key === '__proto__' || !pattern.test(key)) {
      return kind === 'env'
        ? `第 ${index + 1} 行：env 键名 ${key} 不合法：需以字母或下划线开头，只含字母、数字与下划线`
        : `第 ${index + 1} 行：header 名 ${key} 不合法：只能包含字母、数字、点、下划线与短横线`;
    }
    if (seen.has(key)) return `第 ${index + 1} 行：${noun} ${key} 重复`;
    seen.add(key);
    if (row.source === 'secret') {
      if (value === '') return `第 ${index + 1} 行：密钥名不能为空`;
      if (options.secretNameMustMatchKey === true && value !== key) {
        return `第 ${index + 1} 行：AI 草稿的密钥名必须与键名一致（${key}）`;
      }
    }
  }
  return null;
}

/** Wire value for `POST`/`PATCH /servers`: literals stay strings, secrets become refs. */
export function rowsToValues(rows: readonly EnvHeaderRow[]): Record<string, EnvHeaderValue> {
  const values: Record<string, EnvHeaderValue> = {};
  for (const row of filledRows(rows)) {
    const key = row.key.trim();
    assign(values, key, row.source === 'secret' ? { $secret: row.value.trim() } : row.value);
  }
  return values;
}

/** Literal subset for the AI draft, whose `env`/`headers` accept plain strings only. */
export function rowsToLiterals(rows: readonly EnvHeaderRow[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const row of filledRows(rows)) {
    if (row.source !== 'literal') continue;
    assign(values, row.key.trim(), row.value);
  }
  return values;
}

/** Secret-backed key names for the AI draft's `envKeys`/`headerKeys`. */
export function rowsToSecretKeys(rows: readonly EnvHeaderRow[]): string[] {
  return filledRows(rows)
    .filter((row) => row.source === 'secret')
    .map((row) => row.key.trim());
}
