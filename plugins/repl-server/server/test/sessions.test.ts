import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ReplError } from '@zhangliang0115/repl-server-core/src/errors.ts';

import type { Clock } from '../src/ports.ts';
import {
  TRANSPORT_IDLE_MS,
  TransportSessionRegistry,
  type TransportCloseReason,
} from '../src/sessions/transport.ts';
import {
  MAX_WORKSPACES_PER_MCP_SESSION,
  WorkspaceRegistry,
  resolveWorkspace,
} from '../src/sessions/workspace.ts';

function createClock(start = 1_000_000): {
  clock: Clock;
  advance(ms: number): void;
  set(at: number): void;
} {
  let now = start;
  return {
    clock: { now: () => now },
    advance(ms) {
      now += ms;
    },
    set(at) {
      now = at;
    },
  };
}

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repl-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // macOS temp dirs live under /var, a symlink to /private/var; canonicalize once for comparisons.
  return realpath(dir);
}

async function makeSubdir(base: string, name: string): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir);
  return dir;
}

async function expectReplError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ReplError, `expected ReplError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

// --- transport sessions -----------------------------------------------------

test('transport: creates unique mcp ids and fixes the mode at creation', async () => {
  const registry = new TransportSessionRegistry({ clock: createClock().clock });
  const modern = registry.create('modern');
  const legacy = registry.create('legacy');

  assert.match(modern.id, /^mcp_[0-9a-f]{32}$/);
  assert.match(legacy.id, /^mcp_[0-9a-f]{32}$/);
  assert.notEqual(modern.id, legacy.id);
  assert.equal(modern.mode, 'modern');
  assert.equal(legacy.mode, 'legacy');

  const lookedUpModern = await registry.get(modern.id);
  const lookedUpLegacy = await registry.get(legacy.id);
  assert.equal(lookedUpModern?.mode, 'modern');
  assert.equal(lookedUpLegacy?.mode, 'legacy');
  assert.equal(registry.size, 2);
});

test('transport: touch refreshes lastRequestAt and keeps an active session', async () => {
  const time = createClock();
  const registry = new TransportSessionRegistry({ clock: time.clock });
  const session = registry.create('modern');

  time.advance(30 * 60_000);
  const touched = await registry.touch(session.id);
  assert.equal(touched?.lastRequestAt, time.clock.now());

  time.advance(59 * 60_000);
  const stillAlive = await registry.get(session.id);
  assert.equal(stillAlive?.id, session.id);
});

test('transport: get expires a session idle for 60 minutes and runs the cascade once', async () => {
  const time = createClock();
  const reasons: TransportCloseReason[] = [];
  const registry = new TransportSessionRegistry({ clock: time.clock });
  const session = registry.create('modern', {
    onClose: (reason) => {
      reasons.push(reason);
    },
  });

  time.advance(TRANSPORT_IDLE_MS - 1);
  assert.equal((await registry.get(session.id))?.id, session.id);

  time.advance(1);
  assert.equal(await registry.get(session.id), null);
  assert.deepEqual(reasons, ['idle']);
  assert.equal(registry.size, 0);

  assert.deepEqual(await registry.sweep(), []);
  assert.deepEqual(reasons, ['idle']);
});

test('transport: touch on an idle session destroys it instead of reviving it', async () => {
  const time = createClock();
  const reasons: TransportCloseReason[] = [];
  const registry = new TransportSessionRegistry({ clock: time.clock });
  const session = registry.create('legacy', {
    onClose: (reason) => {
      reasons.push(reason);
    },
  });

  time.advance(TRANSPORT_IDLE_MS + 1);
  assert.equal(await registry.touch(session.id), null);
  assert.deepEqual(reasons, ['idle']);
});

test('transport: sweep only destroys sessions idle at the sweep time', async () => {
  const time = createClock();
  const idle: string[] = [];
  const registry = new TransportSessionRegistry({ clock: time.clock });
  const oldSession = registry.create('modern', {
    onClose: (reason) => {
      idle.push(`old:${reason}`);
    },
  });
  const freshSession = registry.create('legacy', {
    onClose: (reason) => {
      idle.push(`fresh:${reason}`);
    },
  });

  time.advance(TRANSPORT_IDLE_MS - 1_000);
  await registry.touch(freshSession.id);
  time.advance(1_000);

  const destroyed = await registry.sweep();
  assert.deepEqual(destroyed, [oldSession.id]);
  assert.deepEqual(idle, ['old:idle']);
  assert.equal((await registry.get(freshSession.id))?.id, freshSession.id);
});

test('transport: DELETE cascades once with the delete reason and is idempotent', async () => {
  const reasons: TransportCloseReason[] = [];
  let calls = 0;
  const registry = new TransportSessionRegistry({ clock: createClock().clock });
  const session = registry.create('modern', {
    onClose: (reason) => {
      calls += 1;
      reasons.push(reason);
    },
  });

  assert.equal(await registry.delete(session.id), true);
  assert.equal(await registry.delete(session.id), false);
  assert.equal(calls, 1);
  assert.deepEqual(reasons, ['delete']);
  assert.equal(await registry.get(session.id), null);
  assert.deepEqual(await registry.sweep(), []);
});

test('transport: the close cascade is awaited before delete resolves', async () => {
  const events: string[] = [];
  const registry = new TransportSessionRegistry({ clock: createClock().clock });
  const session = registry.create('legacy', {
    onClose: async (reason) => {
      await Promise.resolve();
      events.push(`closed:${reason}`);
    },
  });

  await registry.delete(session.id);
  assert.deepEqual(events, ['closed:delete']);
});

test('transport: unknown ids are inert', async () => {
  const registry = new TransportSessionRegistry({ clock: createClock().clock });
  assert.equal(await registry.get('mcp_missing'), null);
  assert.equal(await registry.touch('mcp_missing'), null);
  assert.equal(await registry.delete('mcp_missing'), false);
  assert.equal(registry.size, 0);
});

test('transport: a failing cascade propagates and still removes the session', async () => {
  const registry = new TransportSessionRegistry({ clock: createClock().clock });
  const session = registry.create('modern', {
    onClose: () => {
      throw new Error('cascade boom');
    },
  });

  await assert.rejects(registry.delete(session.id), /cascade boom/);
  assert.equal(await registry.get(session.id), null);
  assert.equal(registry.size, 0);
});

// --- workspace resolution ---------------------------------------------------

test('workspace: explicit argument wins over roots, binding default and cwd', async (t) => {
  const base = await makeTempDir(t);
  const explicit = await makeSubdir(base, 'explicit');
  const rooted = await makeSubdir(base, 'rooted');
  const binding = await makeSubdir(base, 'binding');
  const cwd = await makeSubdir(base, 'cwd');

  const resolved = await resolveWorkspace(
    {
      explicit,
      roots: [pathToFileURL(rooted).href],
      bindingDefault: binding,
    },
    { cwd },
  );
  assert.deepEqual(resolved, { path: explicit, source: 'explicit' });
});

test('workspace: first file:// root wins and non-file roots are skipped', async (t) => {
  const base = await makeTempDir(t);
  const rooted = await makeSubdir(base, 'rooted');
  const binding = await makeSubdir(base, 'binding');
  const cwd = await makeSubdir(base, 'cwd');

  const resolved = await resolveWorkspace(
    {
      roots: ['https://example.com/repo', { uri: pathToFileURL(rooted).href }],
      bindingDefault: binding,
    },
    { cwd },
  );
  assert.deepEqual(resolved, { path: rooted, source: 'roots' });
});

test('workspace: binding default is used when no file root exists', async (t) => {
  const base = await makeTempDir(t);
  const binding = await makeSubdir(base, 'binding');
  const cwd = await makeSubdir(base, 'cwd');

  const resolved = await resolveWorkspace(
    { roots: ['https://example.com/repo'], bindingDefault: binding },
    { cwd },
  );
  assert.deepEqual(resolved, { path: binding, source: 'binding' });
});

test('workspace: cwd is the last-resort fallback', async (t) => {
  const base = await makeTempDir(t);
  const cwd = await makeSubdir(base, 'cwd');

  const resolved = await resolveWorkspace({ explicit: null, roots: null, bindingDefault: '  ' }, { cwd });
  assert.deepEqual(resolved, { path: cwd, source: 'cwd' });
});

test('workspace: a missing path is WS_INVALID and does not fall back', async (t) => {
  const base = await makeTempDir(t);
  const cwd = await makeSubdir(base, 'cwd');

  await expectReplError(
    resolveWorkspace({ explicit: join(base, 'missing') }, { cwd }),
    'WS_INVALID',
  );
});

test('workspace: a file, not a directory, is WS_INVALID', async (t) => {
  const base = await makeTempDir(t);
  const file = join(base, 'note.txt');
  await writeFile(file, 'not a workspace');

  await expectReplError(resolveWorkspace({ explicit: file }), 'WS_INVALID');
});

test('workspace: trailing slash, dot-dot and symlinks canonicalize to one path', async (t) => {
  const base = await makeTempDir(t);
  const repo = await makeSubdir(base, 'repo');
  await makeSubdir(repo, 'sub');
  const link = join(base, 'link');
  await symlink(repo, link);

  const variants = [repo, `${repo}/`, join(repo, 'sub', '..'), link];
  const resolved = await Promise.all(variants.map((path) => resolveWorkspace({ explicit: path })));

  for (const entry of resolved) {
    assert.equal(entry.path, repo);
    assert.equal(entry.source, 'explicit');
  }
});

test('workspace: a file url with a remote host is WS_INVALID', async () => {
  await expectReplError(
    resolveWorkspace({ roots: ['file://remotehost/etc'] }),
    'WS_INVALID',
  );
});

test('workspace: a fifth distinct workspace hits WS_LIMIT; repeats are free', async (t) => {
  const base = await makeTempDir(t);
  const registry = new WorkspaceRegistry();
  const dirs: string[] = [];
  for (let index = 0; index < MAX_WORKSPACES_PER_MCP_SESSION; index += 1) {
    const dir = await makeSubdir(base, `w${index}`);
    dirs.push(dir);
    const resolved = await registry.resolve('mcp_one', { explicit: dir });
    assert.equal(resolved.path, dir);
  }

  // Same canonical path in another spelling does not consume another slot.
  const again = await registry.resolve('mcp_one', { explicit: `${dirs[0]}/` });
  assert.equal(again.path, dirs[0]);

  const fifth = await makeSubdir(base, 'w4');
  await expectReplError(registry.resolve('mcp_one', { explicit: fifth }), 'WS_LIMIT');
  assert.equal(registry.list('mcp_one').length, MAX_WORKSPACES_PER_MCP_SESSION);

  // Another MCP session has its own quota.
  const otherSession = await registry.resolve('mcp_two', { explicit: fifth });
  assert.equal(otherSession.path, fifth);
});

test('workspace: release forgets the per-session quota', async (t) => {
  const base = await makeTempDir(t);
  const registry = new WorkspaceRegistry({ maxPerMcpSession: 1 });
  const first = await makeSubdir(base, 'first');
  const second = await makeSubdir(base, 'second');

  await registry.resolve('mcp_one', { explicit: first });
  const secondAttempt = registry.resolve('mcp_one', { explicit: second });
  await expectReplError(secondAttempt, 'WS_LIMIT');

  registry.release('mcp_one');
  assert.deepEqual(registry.list('mcp_one'), []);
  const afterRelease = await registry.resolve('mcp_one', { explicit: second });
  assert.equal(afterRelease.path, second);
});

test('workspace: concurrent resolutions cannot overshoot the quota', async (t) => {
  const base = await makeTempDir(t);
  const registry = new WorkspaceRegistry();
  const dirs: string[] = [];
  for (let index = 0; index < MAX_WORKSPACES_PER_MCP_SESSION + 1; index += 1) {
    dirs.push(await makeSubdir(base, `c${index}`));
  }

  const results = await Promise.allSettled(
    dirs.map((dir) => registry.resolve('mcp_one', { explicit: dir })),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, MAX_WORKSPACES_PER_MCP_SESSION);
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  const failure = rejected[0];
  assert.ok(failure !== undefined && failure.status === 'rejected');
  assert.ok(failure.reason instanceof ReplError);
  assert.equal(failure.reason.code, 'WS_LIMIT');
  assert.equal(registry.list('mcp_one').length, MAX_WORKSPACES_PER_MCP_SESSION);
});
