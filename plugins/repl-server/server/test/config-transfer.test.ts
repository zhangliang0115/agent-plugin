import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  ConfigValidationError,
  ServerNotFoundError,
  createConfigAdmin,
  type ConfigAdmin,
  type ConfigDocument,
  type ConfigImportInput,
  type ConfigRepository,
  type OperationStartInput,
  type ServerConfigRecord,
} from '../src/admin/config.ts';
import { createFileSecretStore, type SecretStore } from '../src/secrets/store.ts';

class MemoryRepository implements ConfigRepository {
  servers: ServerConfigRecord[];
  applied: ConfigImportInput[] = [];

  constructor(servers: readonly ServerConfigRecord[]) {
    this.servers = servers.map((server) => structuredClone(server));
  }

  listServers(): readonly ServerConfigRecord[] {
    return this.servers;
  }

  getServer(id: string): ServerConfigRecord | null {
    return this.servers.find((server) => server.id === id) ?? null;
  }

  applyImport(input: ConfigImportInput): void {
    this.applied.push(structuredClone(input));
    const byId = new Map(this.servers.map((server) => [server.id, server]));
    for (const id of input.removals) byId.delete(id);
    for (const server of input.upserts) byId.set(server.id, structuredClone(server));
    this.servers = [...byId.values()];
  }
}

interface Harness {
  repository: MemoryRepository;
  secrets: SecretStore;
  admin: ConfigAdmin;
}

async function setup(
  t: TestContext,
  servers: readonly ServerConfigRecord[],
  secretValues: Record<string, string> = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'repl-config-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new MemoryRepository(servers);
  const secrets = createFileSecretStore(directory);
  for (const [name, value] of Object.entries(secretValues)) {
    await secrets.set(name, value);
  }
  const admin = createConfigAdmin({
    repository,
    importTarget: repository,
    secrets,
    newOperationId: () => 'op_test',
  });
  return { repository, secrets, admin };
}

function pgServer(overrides: Partial<ServerConfigRecord> = {}): ServerConfigRecord {
  return {
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@mcp/pg'],
    env: { DATABASE_URL: { $secret: 'pg_db_url' } },
    enabled: true,
    connectMode: 'lazy',
    summary: 'database',
    tags: ['db'],
    timeoutMs: 60_000,
    maxConcurrency: 8,
    ...overrides,
  };
}

function githubServer(overrides: Partial<ServerConfigRecord> = {}): ServerConfigRecord {
  return {
    id: 'github',
    label: 'GitHub',
    transport: 'http',
    url: 'https://api.example.com/mcp',
    headers: { Authorization: { $secret: 'github_pat' } },
    enabled: true,
    connectMode: 'lazy',
    summary: 'git hosting',
    tags: ['git'],
    timeoutMs: 60_000,
    maxConcurrency: 8,
    ...overrides,
  };
}

function oldServer(): ServerConfigRecord {
  return {
    id: 'old',
    label: 'Old',
    transport: 'stdio',
    command: 'node',
    enabled: false,
    connectMode: 'eager',
    tags: [],
    timeoutMs: 60_000,
    maxConcurrency: 8,
  };
}

function officialServer(): ServerConfigRecord {
  return {
    id: '__official__',
    label: 'Official',
    transport: 'builtin',
    enabled: true,
    tags: [],
  };
}

function requireServer<T>(items: readonly T[], predicate: (item: T) => boolean): T {
  const item = items.find(predicate);
  assert.ok(item !== undefined, 'expected item to exist');
  return item;
}

test('GET /servers view exposes key names and placeholders only', async (t) => {
  const { admin } = await setup(
    t,
    [
      pgServer({
        args: ['-y', '@mcp/pg', '--token', { $secret: 'internal_token' }],
      }),
      githubServer(),
      officialServer(),
    ],
    {
      pg_db_url: 'postgres://db-secret',
      github_pat: 'ghp_secret',
      internal_token: 'tok_secret',
    },
  );

  const views = await admin.listServers();
  assert.deepEqual(
    views.map((view) => view.id),
    ['__official__', 'github', 'pg'],
  );

  const serialized = JSON.stringify(views);
  for (const forbidden of ['db-secret', 'ghp_secret', 'tok_secret', '$secret']) {
    assert.equal(serialized.includes(forbidden), false);
  }

  const pg = requireServer(views, (view) => view.id === 'pg');
  assert.deepEqual(pg.envKeys, ['DATABASE_URL']);
  assert.deepEqual(pg.headerKeys, []);
  assert.deepEqual(pg.args, ['-y', '@mcp/pg', '--token', '<secret:internal_token>']);
  assert.equal('env' in pg, false);
  assert.equal('headers' in pg, false);
  assert.deepEqual(pg.missingSecrets, []);

  const github = requireServer(views, (view) => view.id === 'github');
  assert.deepEqual(github.headerKeys, ['Authorization']);
  assert.deepEqual(github.envKeys, []);
  assert.equal(github.url, 'https://api.example.com/mcp');
});

test('config export strips $secret refs and all values, and skips built-ins', async (t) => {
  const { admin } = await setup(
    t,
    [
      pgServer({
        args: ['-y', '@mcp/pg', '--token', { $secret: 'internal_token' }],
        env: {
          DATABASE_URL: { $secret: 'pg_db_url' },
          NODE_ENV: 'production',
        },
      }),
      githubServer(),
      officialServer(),
    ],
    {
      pg_db_url: 'postgres://db-secret',
      github_pat: 'ghp_secret',
      internal_token: 'tok_secret',
    },
  );

  const document = await admin.exportConfig();
  assert.equal(document.version, 1);
  assert.deepEqual(
    document.servers.map((server) => server.id),
    ['github', 'pg'],
  );

  const pg = requireServer(document.servers, (server) => server.id === 'pg');
  assert.equal(pg.transport, 'stdio');
  assert.equal(pg.command, 'npx');
  assert.deepEqual(pg.env, {
    DATABASE_URL: '<secret:pg_db_url>',
    NODE_ENV: null,
  });
  assert.deepEqual(pg.args, ['-y', '@mcp/pg', '--token', '<secret:internal_token>']);
  assert.equal('envKeys' in pg, false);
  assert.equal('headerKeys' in pg, false);

  const github = requireServer(document.servers, (server) => server.id === 'github');
  assert.deepEqual(github.headers, { Authorization: '<secret:github_pat>' });
  assert.equal(github.url, 'https://api.example.com/mcp');

  const serialized = JSON.stringify(document);
  for (const forbidden of [
    'db-secret',
    'ghp_secret',
    'tok_secret',
    'production',
    '$secret',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('secrets endpoint lists names and PUT writes values', async (t) => {
  const { admin } = await setup(t, [pgServer(), githubServer()], {
    pg_db_url: 'postgres://db-secret',
  });

  const before = await admin.listSecrets();
  assert.deepEqual(before, [
    { name: 'github_pat', configured: false },
    { name: 'pg_db_url', configured: true },
  ]);
  assert.equal(JSON.stringify(before).includes('db-secret'), false);

  const written = await admin.putSecret('github_pat', 'ghp_new_secret');
  assert.deepEqual(written, { name: 'github_pat', configured: true });

  const after = await admin.listSecrets();
  assert.deepEqual(after, [
    { name: 'github_pat', configured: true },
    { name: 'pg_db_url', configured: true },
  ]);
  assert.equal(JSON.stringify(after).includes('ghp_new_secret'), false);

  await assert.rejects(admin.putSecret('bad name', 'value'), /invalid secret name/);
  await assert.rejects(admin.putSecret('valid_name', ''), /non-empty strings/);
});

test('POST /servers/:id/test preflight reports missingSecrets and resolves values', async (t) => {
  const { admin } = await setup(
    t,
    [githubServer(), pgServer({ args: ['--token', { $secret: 'internal_token' }] })],
    { pg_db_url: 'postgres://db-secret' },
  );

  const missingGithub = await admin.checkServerSecrets('github');
  assert.deepEqual(missingGithub, {
    ok: false,
    missingSecrets: ['github_pat'],
  });

  const missingArg = await admin.checkServerSecrets('pg');
  assert.deepEqual(missingArg, {
    ok: false,
    missingSecrets: ['internal_token'],
  });

  await admin.putSecret('github_pat', 'ghp_new_secret');
  await admin.putSecret('internal_token', 'tok_new_secret');

  const ready = await admin.checkServerSecrets('github');
  assert.equal(ready.ok, true);
  if (ready.ok) {
    assert.deepEqual(ready.resolved.headers, { Authorization: 'ghp_new_secret' });
    assert.equal(ready.resolved.url, 'https://api.example.com/mcp');
  }

  const pgReady = await admin.checkServerSecrets('pg');
  assert.equal(pgReady.ok, true);
  if (pgReady.ok) {
    assert.deepEqual(pgReady.resolved.env, { DATABASE_URL: 'postgres://db-secret' });
    assert.deepEqual(pgReady.resolved.args, ['--token', 'tok_new_secret']);
  }

  await assert.rejects(
    admin.checkServerSecrets('missing'),
    (error: unknown) => error instanceof ServerNotFoundError,
  );
});

test('dry-run reports {valid, diff} and does not write', async (t) => {
  const { admin, repository } = await setup(
    t,
    [pgServer(), githubServer(), oldServer(), officialServer()],
    { pg_db_url: 'postgres://db-secret', github_pat: 'ghp_secret' },
  );

  const document = await admin.exportConfig();
  document.servers = document.servers.filter((server) => server.id !== 'old');
  document.servers.push({
    id: 'new',
    label: 'New',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'new-server'],
    enabled: true,
    connectMode: 'lazy',
    tags: [],
    timeoutMs: 60_000,
    maxConcurrency: 8,
  });

  const result = await admin.importConfig(document, { dryRun: true });
  assert.deepEqual(result, {
    valid: true,
    diff: { added: ['new'], changed: [], removed: ['old'] },
  });
  assert.equal(repository.applied.length, 0);
});

test('dry-run flags changed servers by id', async (t) => {
  const { admin } = await setup(t, [pgServer(), githubServer()], {
    pg_db_url: 'postgres://db-secret',
    github_pat: 'ghp_secret',
  });

  const document = await admin.exportConfig();
  const pg = requireServer(document.servers, (server) => server.id === 'pg');
  pg.label = 'PostgreSQL (edited)';

  const result = await admin.importConfig(document, { dryRun: true });
  assert.deepEqual(result, {
    valid: true,
    diff: { added: [], changed: ['pg'], removed: [] },
  });
});

test('import warns about missing secrets but still applies and returns operationId', async (t) => {
  const { admin, repository } = await setup(t, [pgServer(), githubServer(), oldServer()], {
    pg_db_url: 'postgres://db-secret',
    github_pat: 'ghp_secret',
  });

  const document = {
    version: 1,
    servers: [
      {
        id: 'new',
        label: 'New',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'new-server'],
        envKeys: ['NEW_TOKEN'],
      },
    ],
  };

  const dryRun = await admin.importConfig(document, { dryRun: true });
  assert.ok('diff' in dryRun);
  assert.equal(dryRun.valid, true);
  assert.deepEqual(dryRun.diff, {
    added: ['new'],
    changed: [],
    removed: ['github', 'old', 'pg'],
  });
  assert.deepEqual(dryRun.missingSecrets, ['NEW_TOKEN']);
  assert.equal(dryRun.errors, undefined);

  const started = await admin.importConfig(document);
  assert.deepEqual(started, { operationId: 'op_test' });
  assert.equal(repository.applied.length, 1);

  const applied = repository.applied[0];
  assert.ok(applied !== undefined);
  assert.deepEqual(applied.removals, ['github', 'old', 'pg']);
  assert.equal(applied.upserts.length, 1);
  const upsert = applied.upserts[0];
  assert.ok(upsert !== undefined);
  assert.equal(upsert.id, 'new');
  assert.deepEqual(upsert.env, { NEW_TOKEN: { $secret: 'NEW_TOKEN' } });
  assert.deepEqual(upsert.args, ['-y', 'new-server']);
});

test('an operation registry receives the import as a deferred run', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'repl-config-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new MemoryRepository([pgServer()]);
  const secrets = createFileSecretStore(directory);
  await secrets.set('pg_db_url', 'postgres://db-secret');
  const started: OperationStartInput[] = [];

  const admin = createConfigAdmin({
    repository,
    importTarget: repository,
    secrets,
    operations: {
      start(input: OperationStartInput): string {
        started.push(input);
        return 'op_async';
      },
    },
  });

  const result = await admin.importConfig({
    version: 1,
    servers: [
      {
        id: 'next',
        label: 'Next',
        transport: 'stdio',
        command: 'node',
      },
    ],
  });
  assert.deepEqual(result, { operationId: 'op_async' });
  assert.equal(repository.applied.length, 0);

  const operation = started[0];
  assert.ok(operation !== undefined);
  assert.equal(operation.kind, 'config_import');
  await operation.run();
  assert.equal(repository.applied.length, 1);
});

test('import restores <secret:name> placeholders and accepts the object-map form', async (t) => {
  const { admin, repository } = await setup(t, [pgServer()], {
    pg_db_url: 'postgres://mapped-secret',
    internal_token: 'tok_secret',
  });

  const document = {
    servers: {
      pg: {
        label: 'PostgreSQL',
        command: 'npx',
        args: ['-y', '@mcp/pg', '--token', '<secret:internal_token>'],
        env: { DATABASE_URL: '<secret:pg_db_url>' },
        summary: 'database',
        tags: ['db'],
      },
    },
  };

  const dryRun = await admin.importConfig(document, { dryRun: true });
  assert.ok('diff' in dryRun);
  assert.equal(dryRun.valid, true);
  assert.deepEqual(dryRun.diff, { added: [], changed: ['pg'], removed: [] });
  assert.equal(dryRun.missingSecrets, undefined);

  await admin.importConfig(document);
  const applied = repository.applied[0];
  assert.ok(applied !== undefined);
  assert.deepEqual(applied.removals, []);
  const upsert = applied.upserts[0];
  assert.ok(upsert !== undefined);
  assert.deepEqual(upsert.env, { DATABASE_URL: { $secret: 'pg_db_url' } });
  assert.deepEqual(upsert.args, [
    '-y',
    '@mcp/pg',
    '--token',
    { $secret: 'internal_token' },
  ]);
});

test('invalid imports are rejected with errors and never applied', async (t) => {
  const { admin, repository } = await setup(t, [pgServer()], {
    pg_db_url: 'postgres://db-secret',
  });

  const document = {
    version: 1,
    servers: [
      {
        id: 'bad-url',
        label: 'Bad URL',
        transport: 'http',
        url: 'https://user:pw@api.example.com/mcp',
      },
      { id: 'dup', label: 'One', transport: 'stdio', command: 'node' },
      { id: 'dup', label: 'Two', transport: 'stdio', command: 'node' },
      { id: '__official__', label: 'Reserved', transport: 'stdio', command: 'node' },
      {
        id: 'mixed',
        label: 'Mixed',
        transport: 'stdio',
        command: 'node',
        url: 'https://api.example.com/mcp',
      },
    ],
  };

  const dryRun = await admin.importConfig(document, { dryRun: true });
  assert.ok('diff' in dryRun);
  assert.equal(dryRun.valid, false);
  assert.ok(dryRun.errors !== undefined);
  assert.ok(dryRun.errors.length >= 4);

  await assert.rejects(
    admin.importConfig(document),
    (error: unknown) =>
      error instanceof ConfigValidationError && error.errors.length >= 4,
  );
  assert.equal(repository.applied.length, 0);
});
