/** Best-effort rollback and registration helpers for discovery suggestions. */
import { ApiError } from './api.ts';

/** What `GET /servers/:id` said about the server after a failed registration. */
export type ServerProbe = 'missing' | 'present' | 'failed';

/** Keys that a downstream `[[Set]]` merge would turn into a prototype write. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__']);

/** Matches an unreplaced `<workspace>` / `<path>` / `<url>` suggestion placeholder. */
const PLACEHOLDER = /<[^<>]+>/;

/**
 * Whether the secrets imported for a failed registration may be deleted.
 *
 * Only a definite 4xx rejection plus a `GET /servers/:id` that returned 404 proves
 * the server was never written. Network loss (status 0), a 2xx whose body could not
 * be parsed, 5xx, `SERVER_EXISTS`/`CONFLICT` and a failed probe all leave the
 * outcome uncertain, so the credentials are kept: an unreferenced secret is
 * harmless, while deleting one in use breaks the existing server.
 */
export function shouldRollbackSecrets(error: unknown, probe: ServerProbe | undefined): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === 'SERVER_EXISTS' || error.code === 'CONFLICT') return false;
  if (error.status < 400 || error.status >= 500) return false;
  return probe === 'missing';
}

/** Drops keys such as `__proto__` before they reach `envKeys`/`headerKeys`. */
export function filterDeclaredKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !RESERVED_KEYS.has(key));
}

/** True when an argument still carries a `<workspace>` style placeholder. */
export function hasPlaceholderArgs(args: readonly string[]): boolean {
  return args.some((arg) => PLACEHOLDER.test(arg));
}

/** One argument per line; surrounding whitespace and blank lines are dropped. */
export function parseArgsText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Built-in reasons say when to replace a placeholder; registration now edits it first. */
export function displayReason(reason: string, args: readonly string[]): string {
  if (!hasPlaceholderArgs(args)) return reason;
  return reason.includes('注册时')
    ? reason.replace('注册时', '注册前编辑参数，')
    : `${reason}；注册前编辑参数`;
}

/** `GET /servers/:id`; only a 404 proves the registration did not commit. */
async function probeServer(
  api: { get(path: string): Promise<unknown> },
  serverId: string,
): Promise<ServerProbe> {
  try {
    await api.get(`/servers/${encodeURIComponent(serverId)}`);
    return 'present';
  } catch (error) {
    return error instanceof ApiError && error.status === 404 ? 'missing' : 'failed';
  }
}

/**
 * Deletes the secrets written by `POST /discover/secrets` after the following
 * `POST /servers` failed, but only when {@link shouldRollbackSecrets} allows it.
 * Delete errors are swallowed so the original registration error stays reported.
 */
export async function rollbackImportedSecrets(
  api: { get(path: string): Promise<unknown>; delete(path: string): Promise<unknown> },
  serverId: string,
  names: readonly string[] | undefined,
  error: unknown,
): Promise<void> {
  if (names === undefined || names.length === 0) return;
  // Errors that are ambiguous even against a missing server (network, 5xx, 2xx
  // parse failures, CONFLICT/SERVER_EXISTS) skip the probe and keep the secrets.
  if (!shouldRollbackSecrets(error, 'missing')) return;
  const probe = await probeServer(api, serverId);
  if (!shouldRollbackSecrets(error, probe)) return;
  await Promise.all(
    names.map((name) =>
      api.delete(`/secrets/${encodeURIComponent(name)}`).catch(() => undefined),
    ),
  );
}
