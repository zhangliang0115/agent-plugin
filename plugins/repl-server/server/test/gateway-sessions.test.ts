import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ReplError } from '@zhangliang0115/repl-server-core';

import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { RequestIdentity, ScriptRequest } from '../src/ports.ts';

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return { identity: 'unbound', binding: null, client: 'test-client/1.0', mcp: 'mcp_a', ...overrides };
}

function createGateway(t: TestContext, options: Partial<ExecGatewayOptions> = {}): ExecGateway {
  const gateway = new ExecGateway({ callTool: async () => ({ ok: true }), ...options });
  t.after(async () => {
    await gateway.disposeAll();
  });
  return gateway;
}

function request(code: string, extra: Partial<ScriptRequest> = {}): ScriptRequest {
  return { code, timeoutMs: 10_000, async: false, identity: identity(), ...extra };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition stayed false past the deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Fake filesystem seam: every path is an existing directory. */
const virtualFs = {
  realpath: async (path: string): Promise<string> => path,
  stat: async (): Promise<{ isDirectory(): boolean }> => ({ isDirectory: () => true }),
};

test('explicit workspaces canonicalize: trailing slash, dot-dot and symlink share one session', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'repl-gw-ws-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const sub = join(repo, 'sub');
  await mkdir(sub, { recursive: true });
  const link = join(base, 'link');
  await symlink(repo, link, 'dir');

  const gateway = createGateway(t);
  const first = await gateway.runScript(
    request(`state.marker = 'shared'; return 1;`, { workspace: repo }),
  );
  assert.equal(first.isError, false, first.content);

  for (const variant of [`${repo}/`, join(sub, '..'), link]) {
    const outcome = await gateway.runScript(
      request(`return state.marker ?? 'missing';`, { workspace: variant }),
    );
    assert.equal(outcome.isError, false, outcome.content);
    assert.match(outcome.content, /<result>shared<\/result>/, `variant ${variant} must reuse the session`);
  }
  assert.equal(gateway.stats().sessions, 1);
});

test('a missing workspace or a file path is WS_INVALID', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'repl-gw-ws-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, 'note.txt');
  await writeFile(file, 'not a directory');
  const gateway = createGateway(t);

  await assert.rejects(
    gateway.runScript(request('return 1;', { workspace: join(base, 'missing') })),
    (error: unknown) => error instanceof ReplError && error.code === 'WS_INVALID',
  );
  await assert.rejects(
    gateway.runScript(request('return 1;', { workspace: file })),
    (error: unknown) => error instanceof ReplError && error.code === 'WS_INVALID',
  );
  assert.equal(gateway.stats().sessions, 0);
});

test('a fifth workspace for one MCP session is WS_LIMIT', async (t) => {
  const gateway = createGateway(t, { workspaceFs: virtualFs });
  for (let index = 0; index < 4; index += 1) {
    const outcome = await gateway.runScript(request('return 1;', { workspace: `/ws/${index}` }));
    assert.equal(outcome.isError, false, outcome.content);
  }
  await assert.rejects(
    gateway.runScript(request('return 1;', { workspace: '/ws/4' })),
    (error: unknown) =>
      (error as { code?: string }).code === 'WS_LIMIT' &&
      (error as { limit?: number }).limit === 4,
  );
  assert.equal(gateway.stats().sessions, 4);

  // Another MCP session has its own four-workspace budget.
  const other = await gateway.runScript(
    request('return 1;', { workspace: '/ws/4', identity: identity({ mcp: 'mcp_b' }) }),
  );
  assert.equal(other.isError, false, other.content);
});

test('per-binding and global execution-session quotas raise CAPACITY_EXCEEDED', async (t) => {
  const gateway = createGateway(t, { workspaceFs: virtualFs });
  for (let index = 0; index < 4; index += 1) {
    const outcome = await gateway.runScript(
      request('return 1;', {
        workspace: `/binding/${index}`,
        identity: identity({ identity: 'bound', binding: 'cb_work', mcp: `mcp_binding_${index}` }),
      }),
    );
    assert.equal(outcome.isError, false, outcome.content);
  }
  await assert.rejects(
    gateway.runScript(
      request('return 1;', {
        workspace: '/binding/4',
        identity: identity({ identity: 'bound', binding: 'cb_work', mcp: 'mcp_binding_4' }),
      }),
    ),
    (error: unknown) =>
      (error as { code?: string }).code === 'CAPACITY_EXCEEDED' &&
      (error as { resource?: string }).resource === 'exec_sessions_per_binding',
  );

  const global = createGateway(t, { workspaceFs: virtualFs, limits: { maxExecSessions: 8 } });
  for (let index = 0; index < 8; index += 1) {
    const outcome = await global.runScript(
      request('return 1;', { workspace: `/global/${index}`, identity: identity({ mcp: `mcp_${index}` }) }),
    );
    assert.equal(outcome.isError, false, outcome.content);
  }
  await assert.rejects(
    global.runScript(request('return 1;', { workspace: '/global/8', identity: identity({ mcp: 'mcp_8' }) })),
    (error: unknown) =>
      (error as { code?: string }).code === 'CAPACITY_EXCEEDED' &&
      (error as { resource?: string }).resource === 'exec_sessions',
  );
});

test('maxInFlightEvalsPerExecSession above 8 applies to new execution sessions', async (t) => {
  const hang = async (
    _call: unknown,
    _workspace?: string,
    _binding?: string | null,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  const dispatchNine = async (gateway: ExecGateway): Promise<void> => {
    for (let index = 0; index < 9; index += 1) {
      await gateway.dispatchScript(request(`await tools.Slow({ index: ${index} }); return ${index};`));
    }
    assert.equal(gateway.stats().sessions, 1);
    assert.equal(gateway.stats().inFlightEvals, 9);
  };

  // Constructor path: the core default of 8 must not cap the configured quota.
  await dispatchNine(
    createGateway(t, {
      limits: { maxInFlightEvalsPerExecSession: 16, maxInFlightEvalsPerBinding: 16 },
      callTool: hang,
    }),
  );

  // Hot update path: a session created after updateLimits uses the new value.
  const updated = createGateway(t, { callTool: hang });
  updated.updateLimits({ maxInFlightEvalsPerExecSession: 16, maxInFlightEvalsPerBinding: 16 });
  await dispatchNine(updated);
});

test('different clients never share one JS context', async (t) => {
  const gateway = createGateway(t);

  const written = await gateway.runScript(
    request(`state.marker = 'client-a'; return 1;`, { identity: identity({ mcp: 'mcp_a' }) }),
  );
  assert.equal(written.isError, false, written.content);

  const isolated = await gateway.runScript(
    request(`return state.marker ?? 'missing';`, { identity: identity({ mcp: 'mcp_b' }) }),
  );
  assert.equal(isolated.isError, false, isolated.content);
  assert.match(isolated.content, /<result>missing<\/result>/);

  const reread = await gateway.runScript(
    request(`return state.marker;`, { identity: identity({ mcp: 'mcp_a' }) }),
  );
  assert.equal(reread.isError, false, reread.content);
  assert.match(reread.content, /<result>client-a<\/result>/);
  assert.equal(gateway.stats().sessions, 2);
});

test('idle LRU eviction recycles past evictIdleMs and closes the serve handle', async (t) => {
  let now = 1_000_000;
  const closed: string[] = [];
  const gateway = createGateway(t, {
    workspaceFs: virtualFs,
    now: () => now,
    limits: { maxExecSessions: 1, evictIdleMs: 60_000 },
    onSessionClosed: (workspace) => {
      closed.push(workspace);
    },
  });

  await gateway.runScript(request('return 1;', { workspace: '/a' }));
  now += 60_001;
  const second = await gateway.runScript(request('return 2;', { workspace: '/b' }));
  assert.equal(second.isError, false, second.content);
  assert.equal(gateway.stats().sessions, 1);
  await waitFor(() => closed.includes('/a'));
  assert.deepEqual(closed, ['/a']);
  assert.equal((gateway.sessions.find('mcp_a', '/a', null)), undefined);
  assert.ok(gateway.sessions.find('mcp_a', '/b', null) !== undefined);
});
