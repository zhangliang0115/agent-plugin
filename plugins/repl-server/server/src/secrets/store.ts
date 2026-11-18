import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Secret storage for `$secret` references in server configs.
 *
 * The baseline backend is a 0600 JSON file. A keychain adapter can be layered on
 * top; when it is unavailable (or fails), reads and writes fall back to the file.
 * @module
 */

const SECRET_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
export const SECRETS_FILE_NAME = 'secrets.json';

export type SecretStoreErrorCode =
  | 'SECRET_NAME_INVALID'
  | 'SECRET_VALUE_INVALID'
  | 'SECRETS_CONFIG_INVALID'
  | 'SECRETS_READ_FAILED'
  | 'SECRETS_CORRUPTED'
  | 'SECRETS_PERMISSIONS'
  | 'SECRETS_WRITE_FAILED';

export class SecretStoreError extends Error {
  readonly code: SecretStoreErrorCode;
  readonly path: string | undefined;

  constructor(
    code: SecretStoreErrorCode,
    message: string,
    options?: { cause?: unknown; path?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SecretStoreError';
    this.code = code;
    this.path = options?.path;
  }
}

/** Secret names are flat keys shared by env, headers and args. */
export function isValidSecretName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    SECRET_NAME_PATTERN.test(name) &&
    !RESERVED_SECRET_NAMES.has(name)
  );
}

export function assertSecretName(name: string): void {
  if (!isValidSecretName(name)) {
    throw new SecretStoreError(
      'SECRET_NAME_INVALID',
      `invalid secret name ${JSON.stringify(name)}; use letters, digits, "_", "." or "-"`,
    );
  }
}

function assertSecretValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SecretStoreError(
      'SECRET_VALUE_INVALID',
      'secret values must be non-empty strings',
    );
  }
}

export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  listNames(): Promise<string[]>;
}

/** Writes a JSON object without ever touching the prototype chain. */
function defineOwn(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `secrets.json` backend.
 *
 * Reads tolerate an absent file (empty store). Writes are serialized within the
 * instance and atomic (temp file + rename), so concurrent `set` calls cannot
 * lose updates. The file is always 0600; a pre-existing looser mode is tightened
 * on the next read.
 */
export class FileSecretStore implements SecretStore {
  readonly filePath: string;

  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async get(name: string): Promise<string | undefined> {
    if (!isValidSecretName(name)) return undefined;
    const data = await this.readData();
    return Object.hasOwn(data, name) ? data[name] : undefined;
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    assertSecretValue(value);
    await this.mutate((data) => {
      data[name] = value;
      return true;
    });
  }

  async delete(name: string): Promise<void> {
    assertSecretName(name);
    await this.mutate((data) => {
      if (!Object.hasOwn(data, name)) return false;
      delete data[name];
      return true;
    });
  }

  async listNames(): Promise<string[]> {
    return Object.keys(await this.readData()).sort();
  }

  private async mutate(change: (data: Record<string, string>) => boolean): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const data = await this.readData();
      if (change(data)) await this.writeData(data);
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async readData(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return {};
      throw new SecretStoreError(
        'SECRETS_READ_FAILED',
        `cannot read secrets file ${this.filePath}: ${messageOf(error)}`,
        { cause: error, path: this.filePath },
      );
    }

    await this.tightenPermissions();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new SecretStoreError(
        'SECRETS_CORRUPTED',
        `secrets file ${this.filePath} is not valid JSON`,
        { cause: error, path: this.filePath },
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SecretStoreError(
        'SECRETS_CORRUPTED',
        `secrets file ${this.filePath} must contain a JSON object`,
        { path: this.filePath },
      );
    }

    const data: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!isValidSecretName(name) || typeof value !== 'string') {
        throw new SecretStoreError(
          'SECRETS_CORRUPTED',
          `secrets file ${this.filePath} contains an invalid entry ${JSON.stringify(name)}`,
          { path: this.filePath },
        );
      }
      defineOwn(data, name, value);
    }
    return data;
  }

  private async tightenPermissions(): Promise<void> {
    try {
      const info = await stat(this.filePath);
      if ((info.mode & 0o077) !== 0) await chmod(this.filePath, FILE_MODE);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw new SecretStoreError(
        'SECRETS_PERMISSIONS',
        `cannot enforce 0600 on secrets file ${this.filePath}: ${messageOf(error)}`,
        { cause: error, path: this.filePath },
      );
    }
  }

  private async writeData(data: Record<string, string>): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: DIRECTORY_MODE });
    } catch (error) {
      throw new SecretStoreError(
        'SECRETS_WRITE_FAILED',
        `cannot create secrets directory for ${this.filePath}: ${messageOf(error)}`,
        { cause: error, path: this.filePath },
      );
    }

    const sorted: Record<string, string> = {};
    for (const [name, value] of Object.entries(data).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      defineOwn(sorted, name, value);
    }

    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(sorted, null, 2)}\n`, {
        encoding: 'utf8',
        mode: FILE_MODE,
        flag: 'wx',
      });
      await chmod(temporaryPath, FILE_MODE);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, FILE_MODE);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new SecretStoreError(
        'SECRETS_WRITE_FAILED',
        `cannot write secrets file ${this.filePath}: ${messageOf(error)}`,
        { cause: error, path: this.filePath },
      );
    }
  }
}

/** Creates the baseline store at `<directory>/secrets.json`. */
export function createFileSecretStore(directory: string): FileSecretStore {
  return new FileSecretStore(join(directory, SECRETS_FILE_NAME));
}

/**
 * Optional keychain backend. Implementations are injected; nothing in this
 * module shells out to `security` or depends on a platform keychain.
 */
export interface KeychainAdapter {
  available(): Promise<boolean> | boolean;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  listNames(): Promise<string[]>;
}

/**
 * Keychain-first store with a file fallback.
 *
 * A value written while the keychain is available lives only in the keychain.
 * When it is unavailable, operations use the file directly so the server keeps
 * working. `listNames()` is a union so the admin UI can still report file-backed
 * keys.
 */
export class FallbackSecretStore implements SecretStore {
  readonly primary: KeychainAdapter;
  readonly fallback: SecretStore;

  constructor(primary: KeychainAdapter, fallback: SecretStore) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async get(name: string): Promise<string | undefined> {
    if (await this.primaryAvailable()) {
      try {
        const value = await this.primary.get(name);
        if (value !== undefined) return value;
      } catch {
        // Fall through to the file backend.
      }
    }
    return this.fallback.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    if (await this.primaryAvailable()) {
      try {
        await this.primary.set(name, value);
        return;
      } catch {
        // Fall through to the file backend.
      }
    }
    await this.fallback.set(name, value);
  }

  async delete(name: string): Promise<void> {
    if (await this.primaryAvailable()) {
      try {
        await this.primary.delete(name);
      } catch {
        // The fallback delete below is still attempted.
      }
    }
    await this.fallback.delete(name);
  }

  async listNames(): Promise<string[]> {
    const names = new Set<string>();
    if (await this.primaryAvailable()) {
      try {
        for (const name of await this.primary.listNames()) names.add(name);
      } catch {
        // Only file-backed names remain visible.
      }
    }
    for (const name of await this.fallback.listNames()) names.add(name);
    return [...names].sort();
  }

  private async primaryAvailable(): Promise<boolean> {
    try {
      return await this.primary.available();
    } catch {
      return false;
    }
  }
}

export interface CreateSecretStoreOptions {
  /** Directory that holds `secrets.json`. Ignored when `file` is set. */
  directory?: string;
  /** Explicit `secrets.json` path. */
  file?: string;
  /** Optional keychain adapter used before the file. */
  keychain?: KeychainAdapter;
}

export function createSecretStore(options: CreateSecretStoreOptions): SecretStore {
  let fileStore: SecretStore;
  if (options.file !== undefined) {
    fileStore = new FileSecretStore(options.file);
  } else if (options.directory !== undefined) {
    fileStore = createFileSecretStore(options.directory);
  } else {
    throw new SecretStoreError(
      'SECRETS_CONFIG_INVALID',
      'createSecretStore requires either `directory` or `file`',
    );
  }
  return options.keychain === undefined
    ? fileStore
    : new FallbackSecretStore(options.keychain, fileStore);
}
