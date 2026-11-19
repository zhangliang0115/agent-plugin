/** AI apply through the real `parseCreateServer`: summary provenance is `ai`. */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseCreateServer } from '../src/admin/servers.ts';
import { createAiService, type AiService } from '../src/ai/service.ts';
import { DEFAULT_AI_SETTINGS, putAiSettings } from '../src/ai/settings.ts';
import { DbServerStore, DbSettingsStore, DbToolStore } from '../src/assembly-stores.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { getRevision } from '../src/db/meta.ts';
import { getServer } from '../src/db/servers.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));

interface Fixture {
  db: DatabaseSync;
  service: AiService;
}

async function makeFixture(
  t: TestContext,
  payload: Record<string, unknown>,
  options: { fallback?: boolean } = {},
): Promise<Fixture> {
  await chmod(FIXTURE, 0o755);
  const dir = await mkdtemp(join(tmpdir(), 'repl-ai-parse-'));
  const db = openStateDb(':memory:');
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const servers = new DbServerStore(db);
  const tools = new DbToolStore(db);
  const settings = new DbSettingsStore(db);
  putAiSettings(db, { ...DEFAULT_AI_SETTINGS, claudeBin: FIXTURE }, getRevision(db));

  const service = createAiService({
    db,
    servers,
    tools,
    settings,
    catalog: { rebuild: () => ({}) },
    dataDir: dir,
    ...(options.fallback === true ? {} : { parseCreateServer }),
    extraEnv: {
      FAKE_CLAUDE_MODE: 'payload',
      FAKE_CLAUDE_PAYLOAD: JSON.stringify(payload),
    },
  });
  return { db, service };
}

function proposalPayload(server: Record<string, unknown>): Record<string, unknown> {
  return { server, explanation: 'test', warnings: [] };
}

function serverDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    tags: ['git'],
    category: 'devtools',
    summary: 'GitHub 仓库操作 (github repository issue)',
    ...overrides,
  };
}

test('AI apply with a summary stores summary_source = ai', async (t) => {
  const fixture = await makeFixture(t, proposalPayload(serverDraft()));
  const proposal = await fixture.service.propose({ input: 'github' });
  assert.ok(proposal.proposalId !== null);

  const applied = await fixture.service.applyProposal({
    proposalId: proposal.proposalId,
    confirmStdio: true,
  });
  assert.equal(applied.server.summarySource, 'ai');
  assert.equal(getServer(fixture.db, 'github')?.summarySource, 'ai');
});

test('AI apply without a summary leaves summary_source null', async (t) => {
  const fixture = await makeFixture(
    t,
    proposalPayload(serverDraft({ summary: null })),
  );
  const proposal = await fixture.service.propose({ input: 'github' });
  assert.ok(proposal.proposalId !== null);

  const applied = await fixture.service.applyProposal({
    proposalId: proposal.proposalId,
    confirmStdio: true,
  });
  assert.equal(applied.server.summary, null);
  assert.equal(applied.server.summarySource, null);
  assert.equal(getServer(fixture.db, 'github')?.summarySource, null);
});

test('fallback apply without parseCreateServer matches the null-source rule', async (t) => {
  const withoutSummary = await makeFixture(
    t,
    proposalPayload(serverDraft({ id: 'bare', summary: null })),
    { fallback: true },
  );
  const bareProposal = await withoutSummary.service.propose({ input: 'bare' });
  assert.ok(bareProposal.proposalId !== null);
  const bare = await withoutSummary.service.applyProposal({
    proposalId: bareProposal.proposalId,
    confirmStdio: true,
  });
  assert.equal(bare.server.summary, null);
  assert.equal(bare.server.summarySource, null);
  assert.equal(getServer(withoutSummary.db, 'bare')?.summarySource, null);

  const withSummary = await makeFixture(
    t,
    proposalPayload(serverDraft({ id: 'documented' })),
    { fallback: true },
  );
  const documentedProposal = await withSummary.service.propose({ input: 'documented' });
  assert.ok(documentedProposal.proposalId !== null);
  const documented = await withSummary.service.applyProposal({
    proposalId: documentedProposal.proposalId,
    confirmStdio: true,
  });
  assert.equal(documented.server.summary, serverDraft()['summary']);
  assert.equal(documented.server.summarySource, 'ai');
  assert.equal(getServer(withSummary.db, 'documented')?.summarySource, 'ai');

  const blankSummary = await makeFixture(
    t,
    proposalPayload(serverDraft({ id: 'blank', summary: '   ' })),
    { fallback: true },
  );
  const blankProposal = await blankSummary.service.propose({ input: 'blank' });
  assert.ok(blankProposal.proposalId !== null);
  const blank = await blankSummary.service.applyProposal({
    proposalId: blankProposal.proposalId,
    confirmStdio: true,
  });
  assert.equal(blank.server.summary, null);
  assert.equal(blank.server.summarySource, null);
  assert.equal(getServer(blankSummary.db, 'blank')?.summarySource, null);
});
