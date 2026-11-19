/**
 * Client-reported `clientInfo` parsing.
 *
 * The client chooses these values, so they are display/audit data only and are
 * never used for authentication. Inputs are trimmed, stripped of control
 * characters and bounded before they reach an audit line or the database.
 *
 * @module
 */

/** Upper bound for `clientInfo.name`; longer names are truncated. */
export const MAX_CLIENT_NAME_LENGTH = 128;
/** Upper bound for `clientInfo.version`; longer versions are truncated. */
export const MAX_CLIENT_VERSION_LENGTH = 64;

export interface ParsedClientInfo {
  /** Empty when the client did not report a usable name. */
  name: string;
  /** Empty when no version was reported. */
  version: string;
  /** Compatibility label: `name/version`, or just `name`. */
  label: string;
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return [...stripped].slice(0, max).join('');
}

/** Rebuilds the legacy single-string label from its parts. */
export function clientLabel(name: string, version: string): string {
  return version === '' ? name : `${name}/${version}`;
}

/** Reads `_meta['io.modelcontextprotocol/clientInfo']` (or legacy `params.clientInfo`). */
export function parseClientInfo(message: unknown): ParsedClientInfo {
  const empty: ParsedClientInfo = { name: '', version: '', label: '' };
  if (typeof message !== 'object' || message === null) return empty;
  const params = (message as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return empty;
  const record = params as Record<string, unknown>;
  const meta = record['_meta'];
  const info =
    typeof meta === 'object' && meta !== null
      ? (meta as Record<string, unknown>)['io.modelcontextprotocol/clientInfo']
      : undefined;
  const source = info ?? record['clientInfo'];
  if (typeof source !== 'object' || source === null) return empty;
  const { name, version } = source as { name?: unknown; version?: unknown };
  const cleanName = clean(name, MAX_CLIENT_NAME_LENGTH);
  if (cleanName === '') return empty;
  const cleanVersion = clean(version, MAX_CLIENT_VERSION_LENGTH);
  return { name: cleanName, version: cleanVersion, label: clientLabel(cleanName, cleanVersion) };
}

/** Splits a legacy `name/version` label at the first `/`; no slash means no version. */
export function splitClientLabel(label: string): { name: string; version: string } {
  const slash = label.indexOf('/');
  if (slash <= 0) return { name: label, version: '' };
  return { name: label.slice(0, slash), version: label.slice(slash + 1) };
}
