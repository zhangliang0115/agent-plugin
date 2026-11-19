/** Admin AI route layer: paths, If-Match translation, status codes and Retry-After. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminAiHandler } from '../src/admin/ai.ts';
import {
  AdminApiError,
  type AdminRequest,
  type AdminResponse,
  type AdminHandler,
  type ServerView,
} from '../src/admin/servers.ts';
import type { AiRunAuditEvent, AiService } from '../src/ai/service.ts';
import type { EffectiveAiSettings } from '../src/ai/settings.ts';

const EFFECTIVE: EffectiveAiSettings = {
  enabled: true,
  autoAnnotate: true,
  claudeBin: null,
  model: null,
  timeoutMs: 60_000,
  effectiveClaudeBin: 'claude',
  claudeBinSource: 'default',
};

const SERVER_VIEW: ServerView = {
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
  summary: null,
  summarySource: 'ai',
  category: null,
  tags: [],
  timeoutMs: 60_000,
  maxConcurrency: 8,
  createdAt: '2026-11-18T09:00:00.000Z',
  updatedAt: '2026-11-18T09:00:00.000Z',
  revision: 1,
  state: 'idle',
};

interface Calls {
  putConfig: Array<{ body: unknown; expected: number }>;
  annotateApply: Array<{ serverId: string; apply: unknown; expected: number }>;
  propose: unknown[];
}

function makeHandler(
  overrides: Partial<AiService> = {},
): { handler: AdminHandler; calls: Calls; audits: AiRunAuditEvent[] } {
  const calls: Calls = { putConfig: [], annotateApply: [], propose: [] };
  const audits: AiRunAuditEvent[] = [];
  const ai: AiService = {
    getConfig: async () => ({
      ai: EFFECTIVE,
      prompts: { propose: 1, annotate: 1 },
      revision: 7,
    }),
    putConfig: async (body, expected) => {
      calls.putConfig.push({ body, expected });
      return { ai: EFFECTIVE, revision: expected + 1 };
    },
    propose: async (body) => {
      calls.propose.push(body);
      return {
        proposalId: 'prop_abc',
        server: null,
        explanation: '',
        warnings: ['w'],
        idConflict: false,
        meta: {
          model: null,
          durationMs: 1,
          promptVersion: 1,
          costUsd: null,
          expiresAt: null,
        },
      };
    },
    applyProposal: async () => ({ server: SERVER_VIEW, revision: 8 }),
    annotatePreview: async (serverId) => ({
      serverId,
      current: { summary: null, summarySource: null, category: null, tags: [] },
      proposed: {
        summary: 's',
        category: 'database',
        categorySuggestion: null,
        tags: ['db'],
        tagSuggestions: [],
        toolOverrides: [],
      },
      warnings: [],
      omittedTools: 0,
      meta: { model: null, durationMs: 1, promptVersion: 1, costUsd: null },
    }),
    annotateApply: async (serverId, apply, expected) => {
      calls.annotateApply.push({ serverId, apply, expected });
      return { server: SERVER_VIEW, tools: [], revision: expected + 1, changed: ['server.summary'] };
    },
    pendingAnnotations: async () => ({
      items: [
        {
          serverId: 'pg',
          proposed: {
            summary: 's',
            category: null,
            categorySuggestion: null,
            tags: [],
            tagSuggestions: [],
            toolOverrides: [],
          },
          warnings: [],
          omittedTools: 0,
          createdAt: 'x',
        },
      ],
    }),
    onServerCreated: () => undefined,
    onToolsIndexed: async () => undefined,
    onServerMutated: () => undefined,
    close: async () => undefined,
    ...overrides,
  };
  return { handler: createAdminAiHandler({ ai }), calls, audits };
}

function request(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): AdminRequest {
  const req: AdminRequest = { method, path };
  if (options.body !== undefined) req.body = options.body;
  if (options.headers !== undefined) req.headers = options.headers;
  return req;
}

function errorCode(response: AdminResponse | null): string | undefined {
  const body = response?.body as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

test('GET /ai/config and PUT /ai/config route through the service', async () => {
  const { handler, calls } = makeHandler();
  const get = await handler(request('GET', '/admin/api/ai/config'));
  assert.equal(get?.status, 200);
  assert.equal((get?.body as { revision: number }).revision, 7);

  const put = await handler(
    request('PUT', '/admin/api/ai/config', {
      body: { ai: { enabled: true } },
      headers: { 'if-match': '7' },
    }),
  );
  assert.equal(put?.status, 200);
  assert.equal(calls.putConfig.length, 1);
  assert.equal(calls.putConfig[0]?.expected, 7);
});

test('PUT /ai/config requires If-Match', async () => {
  const { handler, calls } = makeHandler();
  const response = await handler(
    request('PUT', '/admin/api/ai/config', { body: { ai: {} } }),
  );
  assert.equal(response?.status, 400);
  assert.equal(errorCode(response), 'IF_MATCH_REQUIRED');
  assert.equal(calls.putConfig.length, 0);
});

test('propose and propose/apply use 200 and 201', async () => {
  const { handler } = makeHandler();
  const preview = await handler(
    request('POST', '/admin/api/ai/propose', { body: { input: 'x' } }),
  );
  assert.equal(preview?.status, 200);
  assert.equal((preview?.body as { proposalId: string }).proposalId, 'prop_abc');

  const applied = await handler(
    request('POST', '/admin/api/ai/propose/apply', {
      body: { proposalId: 'prop_abc', confirmStdio: true },
    }),
  );
  assert.equal(applied?.status, 201);
  assert.equal((applied?.body as { revision: number }).revision, 8);
});

test('annotate preview/apply route and mode validation', async () => {
  const { handler, calls } = makeHandler();
  const preview = await handler(
    request('POST', '/admin/api/ai/annotate/pg', { body: { mode: 'preview' } }),
  );
  assert.equal(preview?.status, 200);
  assert.equal((preview?.body as { serverId: string }).serverId, 'pg');

  const missingMode = await handler(
    request('POST', '/admin/api/ai/annotate/pg', { body: {} }),
  );
  assert.equal(missingMode?.status, 400);
  assert.equal(errorCode(missingMode), 'INVALID_FIELD');

  const applyNoMatch = await handler(
    request('POST', '/admin/api/ai/annotate/pg', {
      body: { mode: 'apply', apply: { summary: 's' } },
    }),
  );
  assert.equal(applyNoMatch?.status, 400);
  assert.equal(errorCode(applyNoMatch), 'IF_MATCH_REQUIRED');

  const applied = await handler(
    request('POST', '/admin/api/ai/annotate/pg', {
      body: { mode: 'apply', apply: { summary: 's' } },
      headers: { 'if-match': '12' },
    }),
  );
  assert.equal(applied?.status, 200);
  assert.deepEqual(calls.annotateApply, [
    { serverId: 'pg', apply: { summary: 's' }, expected: 12 },
  ]);
});

test('GET /ai/annotations/pending returns the store view', async () => {
  const { handler } = makeHandler();
  const response = await handler(request('GET', '/admin/api/ai/annotations/pending'));
  assert.equal(response?.status, 200);
  assert.equal((response?.body as { items: unknown[] }).items.length, 1);
});

test('AI_BUSY renders 429 with Retry-After: 1', async () => {
  const { handler } = makeHandler({
    propose: async () => {
      throw new AdminApiError(429, 'AI_BUSY', 'busy', { running: 2, queued: 4 });
    },
  });
  const response = await handler(
    request('POST', '/admin/api/ai/propose', { body: { input: 'x' } }),
  );
  assert.equal(response?.status, 429);
  assert.equal(response?.headers?.['retry-after'], '1');
  assert.equal(errorCode(response), 'AI_BUSY');
});

test('unrelated paths and methods return null', async () => {
  const { handler } = makeHandler();
  assert.equal(await handler(request('GET', '/admin/api/servers')), null);
  assert.equal(await handler(request('DELETE', '/admin/api/ai/config')), null);
  assert.equal(await handler(request('GET', '/admin/api/ai/propose')), null);
});
