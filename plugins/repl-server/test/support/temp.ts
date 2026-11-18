/**
 * Temporary directories for tests.
 *
 * `AGENTS_HOME` is the data root the server reads (`docs/protocol.md` §1.1).
 * Every test that starts a daemon or a bridge should point it at a fresh
 * directory, and every directory created here must be removed in an `after`
 * hook.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/** Environment variable the server uses as its data root. */
export const AGENTS_HOME_ENV = 'AGENTS_HOME';

export interface TempDir {
  /** Canonical path (macOS resolves `/var` to `/private/var`). */
  readonly path: string;
  /** Idempotent recursive removal. */
  cleanup(): Promise<void>;
}

function assertPlainPrefix(prefix: string): void {
  if (prefix.length === 0 || prefix.includes('/') || prefix.includes('\\')) {
    throw new TypeError(`temp prefix must be a plain name, got ${JSON.stringify(prefix)}`);
  }
}

/** Creates a private directory under the OS temp root. */
export async function createTempDir(prefix = 'repl-server-test-'): Promise<TempDir> {
  assertPlainPrefix(prefix);
  const created = await mkdtemp(join(tmpdir(), prefix));
  const path = await realpath(created);
  let cleaning: Promise<void> | null = null;
  return {
    path,
    cleanup() {
      cleaning ??= rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return cleaning;
    },
  };
}

export interface TempHome {
  /** Canonical path of the temporary data root. */
  readonly path: string;
  /** Environment fragment to merge into a spawned process: `{ AGENTS_HOME }`. */
  readonly env: Readonly<Record<string, string>>;
  cleanup(): Promise<void>;
}

export interface TempHomeOptions {
  prefix?: string;
  /** When provided, `cleanup` is registered as a test `after` hook. */
  t?: TestContext;
}

/**
 * Creates a fresh `AGENTS_HOME` directory.
 *
 * Hooks run in registration order, so when a daemon also registers cleanup via
 * `startDaemon({ t })`, create the home without `t` and register its cleanup
 * after the daemon unless the daemon owns the directory itself.
 */
export async function createTempHome(options: TempHomeOptions = {}): Promise<TempHome> {
  const dir = await createTempDir(options.prefix ?? 'repl-server-home-');
  options.t?.after(() => dir.cleanup());
  return {
    path: dir.path,
    env: Object.freeze({ [AGENTS_HOME_ENV]: dir.path }),
    cleanup: dir.cleanup,
  };
}
