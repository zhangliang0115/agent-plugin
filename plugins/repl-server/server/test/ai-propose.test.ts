/** AI config and proposal flow: preview, validation, apply, expiry and audit. */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AdminApiError } from '../src/admin/servers.ts';
import { createAiService, type AiRunAuditEvent, type AiService } from '../src/ai/service.ts';
import { DEFAULT_AI_SETTINGS, getAiSettings, putAiSettings } from '../src/ai/settings.ts';
import { DbServerStore, DbSettingsStore, DbToolStore } from '../src/assembly-stores.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { getRevision } from '../src/db/meta.ts';
import { createServer, getServer } from '../src/db/servers.ts';
import type { Clock } from '../src/ports.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));

class MutableClock implements Clock {
  private current: number;

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

interface Fixture {
  db: DatabaseSync;
  servers: DbServerStore;
  tools: DbToolStore;
  settings: DbSettingsStore;
  service: AiService;
  rebuilds: string[][];
  audits: AiRunAuditEvent[];
  clock: MutableClock;
}

async function makeFixture(
  t: TestContext,
  options: {
    useFixture?: boolean;
    extraEnv?: Record<string, string>;
    settings?: Partial<typeof DEFAULT_AI_SETTINGS>;
  } = {},
): Promise<Fixture> {
  await chmod(FIXTURE, 0o755);
  const dir = await mkdtemp(join(tmpdir(), 'repl-ai-propose-'));
  const db = openStateDb(':memory:');
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const servers = new DbServerStore(db);
  const tools = new DbToolStore(db);
  const settings = new DbSettingsStore(db);
  const clock = new MutableClock(Date.UTC(2026, 10, 18, 9, 0, 0));
  const rebuilds: string[][] = [];
  const audits: AiRunAuditEvent[] = [];
  const catalog = {
    rebuild(changedServers: readonly string[] = []): unknown {
      rebuilds.push([...changedServers]);
      return {};
    },
  };

  if (options.useFixture !== false) {
    putAiSettings(
      db,
      { ...DEFAULT_AI_SETTINGS, claudeBin: FIXTURE, ...options.settings },
      getRevision(db),
    );
  } else if (options.settings !== undefined) {
    putAiSettings(db, { ...DEFAULT_AI_SETTINGS, ...options.settings }, getRevision(db));
  }

  const service = createAiService({
    db,
    servers,
    tools,
    catalog,
    settings,
    clock,
    dataDir: dir,
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    onAiRun: (event) => audits.push(event),
  });

  return { db, servers, tools, settings, service, rebuilds, audits, clock };
}

async function expectApiError(
  promise: Promise<unknown>,
  code: string,
  status?: number,
): Promise<AdminApiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AdminApiError, `expected AdminApiError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  if (status !== undefined) assert.equal(caught.status, status);
  return caught;
}

function okServer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'github',
    label: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    cwd: null,
    url: null,
    envKeys: ['GITHUB_TOKEN'],
    headerKeys: [],
    enabled: true,
    connectMode: 'lazy',
    tags: ['git', 'github'],
    category: 'devtools',
    summary: 'GitHub 仓库与 issue 操作 (github git repository issue pull-request)',
    ...overrides,
  };
}

function proposalPayload(server: Record<string, unknown> | null, warnings = ['w']): string {
  return JSON.stringify({ server, explanation: 'explanation', warnings });
}

function configBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ai: {
      enabled: true,
      autoAnnotate: true,
      claudeBin: FIXTURE,
      model: null,
      timeoutMs: 60_000,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('GET /ai/config returns defaults and prompt versions', async (t) => {
  const saved = process.env['REPL_AI_CLAUDE_BIN'];
  delete process.env['REPL_AI_CLAUDE_BIN'];
  t.after(() => {
    if (saved !== undefined) process.env['REPL_AI_CLAUDE_BIN'] = saved;
  });

  const fixture = await makeFixture(t, { useFixture: false });
  const response = await fixture.service.getConfig();
  assert.equal(response.ai.enabled, true);
  assert.equal(response.ai.autoAnnotate, true);
  assert.equal(response.ai.claudeBin, null);
  assert.equal(response.ai.effectiveClaudeBin, 'claude');
  assert.equal(response.ai.claudeBinSource, 'default');
  assert.deepEqual(response.prompts, { propose: 7, annotate: 7 });
  assert.equal(response.revision, 0);
});

test('effective claudeBin prefers settings over the environment', async (t) => {
  const saved = process.env['REPL_AI_CLAUDE_BIN'];
  process.env['REPL_AI_CLAUDE_BIN'] = '/opt/claude-from-env';
  t.after(() => {
    if (saved === undefined) delete process.env['REPL_AI_CLAUDE_BIN'];
    else process.env['REPL_AI_CLAUDE_BIN'] = saved;
  });

  const envOnly = await makeFixture(t, { useFixture: false });
  const envConfig = await envOnly.service.getConfig();
  assert.equal(envConfig.ai.effectiveClaudeBin, '/opt/claude-from-env');
  assert.equal(envConfig.ai.claudeBinSource, 'env');

  const withSettings = await makeFixture(t, { settings: { claudeBin: FIXTURE } });
  const settingsConfig = await withSettings.service.getConfig();
  assert.equal(settingsConfig.ai.effectiveClaudeBin, FIXTURE);
  assert.equal(settingsConfig.ai.claudeBinSource, 'settings');
});

test('PUT /ai/config replaces all five fields and bumps the revision', async (t) => {
  const fixture = await makeFixture(t, { useFixture: false });
  const response = await fixture.service.putConfig(
    configBody({ claudeBin: '/usr/local/bin/claude', timeoutMs: 90_000 }),
    getRevision(fixture.db),
  );
  assert.equal(response.ai.effectiveClaudeBin, '/usr/local/bin/claude');
  assert.equal(response.ai.claudeBinSource, 'settings');
  assert.equal(response.revision, 1);
  assert.deepEqual(getAiSettings(fixture.db), {
    enabled: true,
    autoAnnotate: true,
    claudeBin: '/usr/local/bin/claude',
    model: null,
    timeoutMs: 90_000,
  });
});

test('PUT /ai/config validation and revision conflict', async (t) => {
  const fixture = await makeFixture(t, { useFixture: false });
  const revision = getRevision(fixture.db);

  await expectApiError(
    fixture.service.putConfig({ ai: { enabled: true } }, revision),
    'INVALID_FIELD',
    400,
  );
  await expectApiError(
    fixture.service.putConfig({ ...configBody(), extra: 1 }, revision),
    'UNKNOWN_FIELD',
    400,
  );
  await expectApiError(
    fixture.service.putConfig(configBody({ timeoutMs: 1000 }), revision),
    'INVALID_FIELD',
    400,
  );
  await expectApiError(
    fixture.service.putConfig(configBody({ model: '-x' }), revision),
    'INVALID_FIELD',
    400,
  );
  await expectApiError(
    fixture.service.putConfig(configBody({ autoAnnotate: 'yes' }), revision),
    'INVALID_FIELD',
    400,
  );
  await expectApiError(
    fixture.service.putConfig(configBody(), revision + 5),
    'REVISION_CONFLICT',
    409,
  );
});

test('a corrupt ai setting row falls back to defaults', async (t) => {
  const fixture = await makeFixture(t, { useFixture: false });
  fixture.db
    .prepare("INSERT INTO settings(key, value) VALUES ('ai', ?)")
    .run('not-json');
  const response = await fixture.service.getConfig();
  assert.equal(response.ai.enabled, true);
  assert.equal(response.ai.timeoutMs, 60_000);
});

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

test('propose previews a draft without writing servers or revision', async (t) => {
  const fixture = await makeFixture(t);
  const before = getRevision(fixture.db);
  const response = await fixture.service.propose({ input: '配一个 github mcp，需要 GITHUB_TOKEN' });
  assert.match(response.proposalId ?? '', /^prop_[0-9a-f]+$/);
  assert.equal((response.server as { id: string }).id, 'github');
  assert.equal(response.idConflict, false);
  assert.equal(response.meta.promptVersion, 7);
  assert.ok(typeof response.meta.expiresAt === 'string');
  assert.equal(getRevision(fixture.db), before);
  assert.equal(getServer(fixture.db, 'github'), null);
  assert.equal(fixture.rebuilds.length, 0);
});

test('a proposal without connectMode defaults to eager', async (t) => {
  const server = okServer();
  delete server['connectMode'];
  const fixture = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: proposalPayload(server),
    },
  });

  const response = await fixture.service.propose({ input: 'x' });
  assert.equal((response.server as { connectMode: string }).connectMode, 'eager');

  const applied = await fixture.service.applyProposal({
    proposalId: response.proposalId,
    confirmStdio: true,
  });
  assert.equal(getServer(fixture.db, 'github')?.connectMode, 'eager');
  assert.equal(applied.server.connectMode, 'eager');
});

test('propose is disabled without touching config reads', async (t) => {
  const fixture = await makeFixture(t, { settings: { enabled: false } });
  await expectApiError(fixture.service.propose({ input: 'x' }), 'AI_DISABLED', 409);
  const config = await fixture.service.getConfig();
  assert.equal(config.ai.enabled, false);
  assert.deepEqual(await fixture.service.pendingAnnotations(), { items: [] });
});

test('a CLI missing required flags surfaces as 503 AI_RUNNER_UNAVAILABLE', async (t) => {
  const fixture = await makeFixture(t, {
    extraEnv: { FAKE_CLAUDE_HELP_MISSING: '--safe-mode' },
  });
  const error = await expectApiError(
    fixture.service.propose({ input: 'x' }),
    'AI_RUNNER_UNAVAILABLE',
    503,
  );
  const details = error.details as { reason?: string; missing?: string[] };
  assert.equal(details.reason, 'missing_flags');
  assert.deepEqual(details.missing, ['--safe-mode']);
});

test('propose input byte and empty checks', async (t) => {
  const fixture = await makeFixture(t);
  await expectApiError(fixture.service.propose({ input: '   ' }), 'AI_INPUT_EMPTY', 422);
  const huge = '中'.repeat(6000); // 18 KiB in UTF-8
  const error = await expectApiError(
    fixture.service.propose({ input: huge }),
    'AI_INPUT_TOO_LARGE',
    422,
  );
  const details = error.details as { maxBytes: number; actualBytes: number };
  assert.equal(details.maxBytes, 16 * 1024);
  assert.ok(details.actualBytes > details.maxBytes);
});

test('propose warns when the input looks like it contains a secret', async (t) => {
  const fixture = await makeFixture(t);
  const response = await fixture.service.propose({
    input: 'use token={{SECRET_r3cgdyg9}} for github',
  });
  assert.equal(response.inputWarning, true);
  assert.ok(response.warnings.some((warning) => warning.includes('$secret')));
});

test('propose rejects shell syntax, non-loopback http and literal credentials', async (t) => {
  const commandInjection = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: proposalPayload(okServer({ command: 'npx\nrm -rf /' })),
    },
  });
  await expectApiError(
    commandInjection.service.propose({ input: 'x' }),
    'AI_PROPOSAL_INVALID',
    422,
  );

  const remoteHttp = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: proposalPayload(
        okServer({
          transport: 'http',
          command: null,
          args: [],
          url: 'http://example.com/mcp',
          envKeys: [],
        }),
      ),
    },
  });
  await expectApiError(remoteHttp.service.propose({ input: 'x' }), 'AI_PROPOSAL_INVALID', 422);

  const loopbackHttp = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: proposalPayload(
        okServer({
          transport: 'http',
          command: null,
          args: [],
          cwd: null,
          url: 'http://127.0.0.1:3000/mcp',
          envKeys: [],
        }),
      ),
    },
  });
  const loopback = await loopbackHttp.service.propose({ input: 'x' });
  assert.equal((loopback.server as { url: string }).url, 'http://127.0.0.1:3000/mcp');

  const secretArgs = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: proposalPayload(
        okServer({ args: ['--token=abcdefghijklmnopqrstuvwxyz'] }),
      ),
    },
  });
  await expectApiError(
    secretArgs.service.propose({ input: 'x' }),
    'AI_SECRET_LITERAL',
    422,
  );

  const secretRef = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: proposalPayload(
        okServer({ args: ['-y', 'server', { $secret: 'DATABASE_URL' }] }),
      ),
    },
  });
  const withRef = await secretRef.service.propose({ input: 'x' });
  assert.deepEqual((withRef.server as { args: unknown[] }).args[2], { $secret: 'DATABASE_URL' });
});

test('provider token prefixes in args are rejected', async (t) => {
  const tokens = [
    `ghp_${'a'.repeat(36)}`,
    `github_pat_${'A'.repeat(22)}`,
    `sk-${'a'.repeat(20)}`,
    `xoxb-${'a'.repeat(10)}`,
    `AKIA${'A'.repeat(16)}`,
  ];
  for (const token of tokens) {
    const fixture = await makeFixture(t, {
      extraEnv: {
        FAKE_CLAUDE_MODE: 'payload',
        FAKE_CLAUDE_PAYLOAD: proposalPayload(okServer({ args: ['-y', 'server', token] })),
      },
    });
    await expectApiError(fixture.service.propose({ input: 'x' }), 'AI_SECRET_LITERAL', 422);
  }
});

test('url with embedded credentials is rejected by code', async (t) => {
  const fixture = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: proposalPayload(
        okServer({
          transport: 'http',
          command: null,
          args: [],
          cwd: null,
          envKeys: [],
          url: 'https://user:{{PASSWORD_abc123}}@example.com/mcp',
        }),
      ),
    },
  });
  await expectApiError(fixture.service.propose({ input: 'x' }), 'URL_HAS_CREDENTIALS', 422);
});

test('propose with server:null returns no proposalId and cannot be applied', async (t) => {
  const fixture = await makeFixture(t, {
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: proposalPayload(null, ['missing command']),
    },
  });
  const response = await fixture.service.propose({ input: 'x' });
  assert.equal(response.proposalId, null);
  assert.equal(response.server, null);
  await expectApiError(
    fixture.service.applyProposal({ proposalId: null, confirmStdio: true }),
    'AI_PROPOSAL_INVALID',
    422,
  );
});

test('proposal expires after ten minutes', async (t) => {
  const fixture = await makeFixture(t);
  const response = await fixture.service.propose({ input: 'x' });
  fixture.clock.advance(11 * 60_000);
  const error = await expectApiError(
    fixture.service.applyProposal({
      proposalId: response.proposalId,
      confirmStdio: true,
    }),
    'AI_PROPOSAL_EXPIRED',
    409,
  );
  assert.ok(typeof (error.details as { expiresAt?: string }).expiresAt === 'string');
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

test('apply requires stdio confirmation, creates the server and consumes the proposal', async (t) => {
  const fixture = await makeFixture(t);
  const proposal = await fixture.service.propose({ input: 'x' });
  const proposalId = proposal.proposalId ?? '';

  await expectApiError(
    fixture.service.applyProposal({ proposalId }),
    'STDIO_CONFIRM_REQUIRED',
    422,
  );

  const before = getRevision(fixture.db);
  const applied = await fixture.service.applyProposal({ proposalId, confirmStdio: true });
  assert.equal(applied.server.id, 'github');
  assert.equal(applied.server.summarySource, 'ai');
  assert.deepEqual(applied.server.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.deepEqual(applied.server.envKeys, ['GITHUB_TOKEN']);
  assert.equal(applied.revision, before + 1);
  assert.deepEqual(fixture.rebuilds, [['github']]);

  const stored = getServer(fixture.db, 'github');
  assert.ok(stored !== null);
  assert.equal(stored.summarySource, 'ai');
  assert.deepEqual(stored.env, { GITHUB_TOKEN: { $secret: 'GITHUB_TOKEN' } });

  await expectApiError(
    fixture.service.applyProposal({ proposalId, confirmStdio: true }),
    'AI_PROPOSAL_NOT_FOUND',
    404,
  );
});

test('apply rejects an id that already exists', async (t) => {
  const fixture = await makeFixture(t);
  createServer(fixture.db, {
    id: 'github',
    label: 'Existing',
    transport: 'stdio',
    command: 'npx',
  });
  const proposal = await fixture.service.propose({ input: 'x' });
  await expectApiError(
    fixture.service.applyProposal({ proposalId: proposal.proposalId, confirmStdio: true }),
    'SERVER_EXISTS',
    409,
  );
  assert.equal(getServer(fixture.db, 'github')?.label, 'Existing');
});

test('apply revalidates a client-edited server', async (t) => {
  const fixture = await makeFixture(t);
  const proposal = await fixture.service.propose({ input: 'x' });
  const countBefore = fixture.db.prepare('SELECT count(*) AS n FROM servers').get()?.['n'];

  await expectApiError(
    fixture.service.applyProposal({
      proposalId: proposal.proposalId,
      confirmStdio: true,
      server: okServer({ command: 'npx $(whoami)' }),
    }),
    'AI_PROPOSAL_INVALID',
    422,
  );
  assert.equal(
    fixture.db.prepare('SELECT count(*) AS n FROM servers').get()?.['n'],
    countBefore,
  );

  await expectApiError(
    fixture.service.applyProposal({
      proposalId: proposal.proposalId,
      confirmStdio: true,
      server: okServer({ env: { GITHUB_TOKEN: 'plain-value' } }),
    }),
    'AI_PROPOSAL_INVALID',
    422,
  );

  await expectApiError(
    fixture.service.applyProposal({
      proposalId: proposal.proposalId,
      confirmStdio: true,
      server: okServer({ env: { GITHUB_TOKEN: 'Bearer abcdefghijklmnop' } }),
    }),
    'AI_SECRET_LITERAL',
    422,
  );

  // The failed applies did not consume the proposal.
  const applied = await fixture.service.applyProposal({
    proposalId: proposal.proposalId,
    confirmStdio: true,
  });
  assert.equal(applied.server.id, 'github');
});

test('propose emits one ai_run audit event without prompt or result text', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.service.propose({ input: 'build a github mcp' });
  assert.equal(fixture.audits.length, 1);
  const event = fixture.audits[0];
  assert.ok(event !== undefined);
  assert.equal(event.event, 'ai_run');
  assert.equal(event.kind, 'propose');
  assert.equal(event.trigger, 'manual');
  assert.equal(event.template, 'propose');
  assert.equal(event.identity, 'unbound');
  assert.equal(event.client, 'admin');
  assert.equal(event.outcome, 'ok');
  assert.equal(event.code, null);
  assert.match(event.proposalId ?? '', /^prop_/);
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes('build a github mcp'));
  assert.ok(!serialized.includes('GITHUB_TOKEN'));
});
