import type { SecretStore } from './store.ts';

/**
 * `$secret` reference handling for server configs.
 *
 * References are allowed in `env`, `headers` and `args`. They are never allowed
 * in `url`: credentials in a URL end up in logs, proxies and `ps` output, so the
 * URL stays a plain string and authentication belongs in headers.
 * @module
 */

export interface SecretRef {
  readonly $secret: string;
}

export type SecretFieldValue = string | SecretRef;
export type SecretField = Record<string, SecretFieldValue>;

export interface ResolvableServer {
  id?: string;
  url?: string | null;
  env?: SecretField | null;
  headers?: SecretField | null;
  args?: readonly SecretFieldValue[] | null;
}

const SECRET_PLACEHOLDER_PATTERN = /^<secret:([^<>]+)>$/;

export function isSecretRef(value: unknown): value is SecretRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 1 && keys[0] === '$secret' && typeof record.$secret === 'string';
}

/** The export placeholder for an argument backed by a secret. */
export function formatSecretPlaceholder(name: string): string {
  return `<secret:${name}>`;
}

export function parseSecretPlaceholder(value: string): string | undefined {
  const match = SECRET_PLACEHOLDER_PATTERN.exec(value);
  return match === null ? undefined : match[1];
}

/** Returns the secret name behind a ref or a `<secret:name>` placeholder. */
export function secretNameOf(value: unknown): string | undefined {
  if (isSecretRef(value)) return value.$secret;
  if (typeof value === 'string') {
    const name = parseSecretPlaceholder(value);
    if (name !== undefined && name.length > 0) return name;
  }
  return undefined;
}

/** Secret names referenced by a server, deduplicated in first-seen order. */
export function collectSecretNames(server: ResolvableServer): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | undefined): void => {
    if (name === undefined || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  for (const value of Object.values(server.env ?? {})) add(secretNameOf(value));
  for (const value of Object.values(server.headers ?? {})) add(secretNameOf(value));
  for (const arg of server.args ?? []) add(secretNameOf(arg));
  return names;
}

/** Names from a list that have no value in the store. */
export async function findMissingSecretNames(
  store: SecretStore,
  names: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const name of names) {
    const value = await store.get(name);
    if (value === undefined) missing.push(name);
  }
  return missing;
}

/** Names that have no value in the store. */
export async function findMissingSecrets(
  store: SecretStore,
  server: ResolvableServer,
): Promise<string[]> {
  return findMissingSecretNames(store, collectSecretNames(server));
}

export type ServerUrlErrorCode = 'URL_INVALID' | 'URL_CREDENTIALS';

export class ServerUrlError extends Error {
  readonly code: ServerUrlErrorCode;

  constructor(code: ServerUrlErrorCode, message: string) {
    super(message);
    this.name = 'ServerUrlError';
    this.code = code;
  }
}

/**
 * Validates a remote MCP URL. Messages deliberately omit the URL so a rejected
 * credential never gets echoed back.
 */
export function assertServerUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ServerUrlError('URL_INVALID', 'server url must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ServerUrlError('URL_INVALID', 'server url is not a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServerUrlError(
      'URL_INVALID',
      `server url must use http or https, got ${parsed.protocol.replace(':', '')}`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ServerUrlError(
      'URL_CREDENTIALS',
      'server url must not embed credentials; move them to headers as $secret references',
    );
  }
  return parsed;
}

export function hasEmbeddedUrlCredentials(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

export interface ResolvedServerSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Unresolved arguments keep their `<secret:name>` placeholder. */
  args: string[];
  url: string | undefined;
  missingSecrets: string[];
}

function defineOwn(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

async function resolveFieldValue(
  store: SecretStore,
  value: SecretFieldValue,
  missing: Set<string>,
): Promise<string | undefined> {
  const name = secretNameOf(value);
  if (name === undefined) return typeof value === 'string' ? value : undefined;
  const resolved = await store.get(name);
  if (resolved === undefined) {
    missing.add(name);
    return undefined;
  }
  return resolved;
}

async function resolveArgValue(
  store: SecretStore,
  arg: SecretFieldValue,
  missing: Set<string>,
): Promise<string> {
  const name = secretNameOf(arg);
  if (name === undefined) return typeof arg === 'string' ? arg : '';
  const resolved = await store.get(name);
  if (resolved === undefined) {
    missing.add(name);
    // Never turn a missing credential into an empty argument silently.
    return formatSecretPlaceholder(name);
  }
  return resolved;
}

/**
 * Resolves every `$secret` reference for a launch.
 *
 * Missing env/header values are omitted from the result and listed in
 * `missingSecrets`; callers must check that list before connecting/spawning.
 */
export async function resolveServerSecrets(
  store: SecretStore,
  server: ResolvableServer,
): Promise<ResolvedServerSecrets> {
  const missing = new Set<string>();
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(server.env ?? {})) {
    const resolved = await resolveFieldValue(store, value, missing);
    if (resolved !== undefined) defineOwn(env, key, resolved);
  }
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    const resolved = await resolveFieldValue(store, value, missing);
    if (resolved !== undefined) defineOwn(headers, key, resolved);
  }

  const args: string[] = [];
  for (const arg of server.args ?? []) {
    args.push(await resolveArgValue(store, arg, missing));
  }

  const url =
    server.url === undefined || server.url === null
      ? undefined
      : assertServerUrl(server.url).toString();

  return { env, headers, args, url, missingSecrets: [...missing] };
}

/** Replaces secret refs in args with placeholders for export and views. */
export function redactArgs(
  args: readonly SecretFieldValue[] | null | undefined,
): string[] {
  return (args ?? []).map((arg) => {
    if (isSecretRef(arg)) return formatSecretPlaceholder(arg.$secret);
    return typeof arg === 'string' ? arg : '';
  });
}

/** Key names of an env/header map, sorted and never including values. */
export function fieldKeys(field: SecretField | null | undefined): string[] {
  return Object.keys(field ?? {}).sort();
}
