import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  SecretStoreError,
  createFileSecretStore,
  createSecretStore,
  isValidSecretName,
  type KeychainAdapter,
  type SecretStore,
} from '../src/secrets/store.ts';
import {
  ServerUrlError,
  assertServerUrl,
  collectSecretNames,
  fieldKeys,
  findMissingSecrets,
  findMissingSecretNames,
  formatSecretPlaceholder,
  parseSecretPlaceholder,
  redactArgs,
  resolveServerSecrets,
  type ResolvableServer,
} from '../src/secrets/resolve.ts';

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'repl-secrets-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function memoryStore(initial: Record<string, string> = {}): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    async get(name: string): Promise<string | undefined> {
      return values.get(name);
    },
    async set(name: string, value: string): Promise<void> {
      values.set(name, value);
    },
    async delete(name: string): Promise<void> {
      values.delete(name);
    },
    async listNames(): Promise<string[]> {
      return [...values.keys()].sort();
    },
  };
}

test('FileSecretStore stores values in a 0600 secrets.json', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = createFileSecretStore(directory);

  assert.deepEqual(await store.listNames(), []);
  assert.equal(await store.get('github_pat'), undefined);

  await store.set('github_pat', 'ghp_secret_value');
  await store.set('DATABASE_URL', 'postgres://user:pw@localhost/db');
  assert.equal(await store.get('github_pat'), 'ghp_secret_value');
  assert.equal(await store.get('DATABASE_URL'), 'postgres://user:pw@localhost/db');
  assert.deepEqual(await store.listNames(), ['DATABASE_URL', 'github_pat']);

  const filePath = join(directory, 'secrets.json');
  const info = await stat(filePath);
  assert.equal(info.mode & 0o777, 0o600);

  const onDisk = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(onDisk, {
    DATABASE_URL: 'postgres://user:pw@localhost/db',
    github_pat: 'ghp_secret_value',
  });

  await store.delete('github_pat');
  assert.equal(await store.get('github_pat'), undefined);
  assert.deepEqual(await store.listNames(), ['DATABASE_URL']);
});

test('FileSecretStore tightens a pre-existing loose mode on read', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'secrets.json');
  await writeFile(filePath, JSON.stringify({ token: 'value' }), 'utf8');
  await chmod(filePath, 0o644);

  const store = createFileSecretStore(directory);
  assert.equal(await store.get('token'), 'value');
  const info = await stat(filePath);
  assert.equal(info.mode & 0o777, 0o600);
});

test('FileSecretStore reports corruption instead of silently dropping secrets', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'secrets.json');
  await writeFile(filePath, '{ not json', 'utf8');

  const store = createFileSecretStore(directory);
  await assert.rejects(
    store.get('token'),
    (error: unknown) =>
      error instanceof SecretStoreError && error.code === 'SECRETS_CORRUPTED',
  );

  await writeFile(filePath, JSON.stringify({ token: 42 }), 'utf8');
  await assert.rejects(
    store.get('token'),
    (error: unknown) =>
      error instanceof SecretStoreError && error.code === 'SECRETS_CORRUPTED',
  );
});

test('FileSecretStore serializes concurrent writes without losing keys', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = createFileSecretStore(directory);

  await Promise.all([
    store.set('alpha', '1'),
    store.set('beta', '2'),
    store.set('gamma', '3'),
  ]);
  assert.deepEqual(await store.listNames(), ['alpha', 'beta', 'gamma']);
  assert.equal(await store.get('beta'), '2');
});

test('FileSecretStore rejects invalid names and empty values', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = createFileSecretStore(directory);

  assert.equal(isValidSecretName('github_pat'), true);
  assert.equal(isValidSecretName('x-api-key'), true);
  assert.equal(isValidSecretName(''), false);
  assert.equal(isValidSecretName('bad name'), false);
  assert.equal(isValidSecretName('__proto__'), false);
  assert.equal(isValidSecretName('constructor'), false);

  await assert.rejects(store.set('bad name', 'value'), /invalid secret name/);
  await assert.rejects(store.set('__proto__', 'value'), /invalid secret name/);
  await assert.rejects(store.set('ok', ''), /non-empty strings/);
  assert.equal(await store.get('__proto__'), undefined);
});

test('FallbackSecretStore prefers the keychain and falls back to the file', async (t) => {
  const directory = await temporaryDirectory(t);
  const keychainValues = new Map<string, string>();
  let available = true;
  const keychain: KeychainAdapter = {
    available: () => available,
    get: async (name: string) => keychainValues.get(name),
    set: async (name: string, value: string) => {
      keychainValues.set(name, value);
    },
    delete: async (name: string) => {
      keychainValues.delete(name);
    },
    listNames: async () => [...keychainValues.keys()],
  };
  const store = createSecretStore({ directory, keychain });

  await store.set('primary_key', 'primary_value');
  assert.equal(keychainValues.get('primary_key'), 'primary_value');
  assert.deepEqual(await store.listNames(), ['primary_key']);

  available = false;
  assert.equal(await store.get('primary_key'), undefined);
  await store.set('fallback_key', 'fallback_value');

  const fileStore = createFileSecretStore(directory);
  assert.equal(await fileStore.get('fallback_key'), 'fallback_value');

  available = true;
  assert.equal(await store.get('fallback_key'), 'fallback_value');
  assert.deepEqual(await store.listNames(), ['fallback_key', 'primary_key']);

  await store.delete('primary_key');
  assert.equal(keychainValues.has('primary_key'), false);
});

test('Secret refs resolve across env, headers and args and collect missing keys', async () => {
  const store = memoryStore({
    pg_db_url: 'postgres://db',
    github_pat: 'ghp_token',
  });
  const server: ResolvableServer = {
    env: {
      DATABASE_URL: { $secret: 'pg_db_url' },
      NODE_ENV: 'production',
      OPTIONAL: { $secret: 'optional_key' },
    },
    headers: { Authorization: { $secret: 'github_pat' } },
    args: [
      '--token',
      { $secret: 'internal_token' },
      '--flag',
      '<secret:arg_key>',
      '--dup',
      { $secret: 'internal_token' },
    ],
    url: 'https://api.example.com/mcp',
  };

  assert.deepEqual(collectSecretNames(server), [
    'pg_db_url',
    'optional_key',
    'github_pat',
    'internal_token',
    'arg_key',
  ]);
  assert.deepEqual(await findMissingSecrets(store, server), [
    'optional_key',
    'internal_token',
    'arg_key',
  ]);
  assert.deepEqual(
    await findMissingSecretNames(store, ['pg_db_url', 'optional_key']),
    ['optional_key'],
  );

  const resolved = await resolveServerSecrets(store, server);
  assert.deepEqual(resolved.env, {
    DATABASE_URL: 'postgres://db',
    NODE_ENV: 'production',
  });
  assert.deepEqual(resolved.headers, { Authorization: 'ghp_token' });
  assert.deepEqual(resolved.args, [
    '--token',
    '<secret:internal_token>',
    '--flag',
    '<secret:arg_key>',
    '--dup',
    '<secret:internal_token>',
  ]);
  assert.deepEqual(resolved.missingSecrets, [
    'optional_key',
    'internal_token',
    'arg_key',
  ]);
  assert.equal(resolved.url, 'https://api.example.com/mcp');
});

test('URLs reject embedded credentials and non-http protocols', () => {
  assert.equal(assertServerUrl('https://api.example.com/mcp').host, 'api.example.com');
  assert.equal(assertServerUrl('http://127.0.0.1:8787/mcp').port, '8787');

  for (const url of [
    'https://user:pw@api.example.com/mcp',
    'https://user@api.example.com/mcp',
  ]) {
    assert.throws(
      () => assertServerUrl(url),
      (error: unknown) =>
        error instanceof ServerUrlError && error.code === 'URL_CREDENTIALS',
    );
  }

  for (const url of ['not a url', '', 'ftp://api.example.com/mcp']) {
    assert.throws(
      () => assertServerUrl(url),
      (error: unknown) => error instanceof ServerUrlError && error.code === 'URL_INVALID',
    );
  }
});

test('placeholders and redaction expose names only', () => {
  assert.equal(formatSecretPlaceholder('pg_db_url'), '<secret:pg_db_url>');
  assert.equal(parseSecretPlaceholder('<secret:pg_db_url>'), 'pg_db_url');
  assert.equal(parseSecretPlaceholder('<secret:>'), undefined);
  assert.equal(parseSecretPlaceholder('literal'), undefined);

  assert.deepEqual(redactArgs(['--token', { $secret: 'internal_token' }]), [
    '--token',
    '<secret:internal_token>',
  ]);
  assert.deepEqual(fieldKeys({ B: 'literal', A: { $secret: 'secret' } }), ['A', 'B']);
});
