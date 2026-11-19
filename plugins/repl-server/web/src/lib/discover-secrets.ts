/** Best-effort rollback for secrets imported during a failed server registration. */
import { ApiError } from './api.ts';

/**
 * Deletes the secrets written by `POST /discover/secrets` after the following
 * `POST /servers` failed. Delete errors are swallowed so the original
 * registration error stays the one the caller reports.
 *
 * `SERVER_EXISTS` is the exception: an existing server with that id may
 * already reference these names, so deleting them could break it.
 */
export async function rollbackImportedSecrets(
  api: { delete(path: string): Promise<unknown> },
  names: readonly string[] | undefined,
  error: unknown,
): Promise<void> {
  if (names === undefined || names.length === 0) return;
  if (error instanceof ApiError && error.code === 'SERVER_EXISTS') return;
  await Promise.all(
    names.map((name) =>
      api.delete(`/secrets/${encodeURIComponent(name)}`).catch(() => undefined),
    ),
  );
}
