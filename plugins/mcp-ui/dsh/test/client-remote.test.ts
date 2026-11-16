import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MANAGER_NAMESPACE,
  PARALLEL_NAMESPACE,
  readSettings,
  settingsFailureMessage,
  serverChangeOps,
  writeDisabledTools,
  writeParallelTools,
  type SettingsRemoteLike,
} from '../src/client/remote.ts';

function fakeSettings(describeValue: unknown, mutateResult: unknown = { ok: true, value: {} }) {
  const mutations: Array<{ ns: string; ops: unknown; revision: number | undefined }> = [];
  const remote: SettingsRemoteLike = {
    describe: async () => ({ ok: true, value: describeValue as never }),
    mutate: async (ns, ops, revision) => {
      mutations.push({ ns, ops, revision });
      return mutateResult as never;
    },
  };
  return { remote, mutations };
}

const DESCRIBE = {
  writable: true,
  hasDocument: true,
  namespaces: [
    {
      ns: MANAGER_NAMESPACE,
      revision: 7,
      value: { servers: { fs: { transport: 'stdio', command: 'npx', enabled: true } } },
    },
    {
      ns: PARALLEL_NAMESPACE,
      revision: 3,
      value: { parallelTools: ['mcp__fs__read'] },
    },
  ],
};

test('reads the server entries and the parallel list with their revisions', async () => {
  // Arrange
  const { remote } = fakeSettings(DESCRIBE);

  // Act
  const snapshot = await readSettings(remote);

  // Assert
  assert.deepEqual(snapshot, {
    ok: true,
    value: {
      writable: true,
      servers: { fs: { transport: 'stdio', command: 'npx', enabled: true } },
      serversRevision: 7,
      parallelTools: ['mcp__fs__read'],
      disabledTools: [],
      parallelRevision: 3,
    },
  });
});

test('reads the disabled list from the same mcp-ui namespace', async () => {
  // Arrange
  const { remote } = fakeSettings({
    writable: true,
    hasDocument: true,
    namespaces: [
      DESCRIBE.namespaces[0],
      { ns: PARALLEL_NAMESPACE, revision: 4, value: { parallelTools: [], disabledTools: ['mcp__fs__*'] } },
    ],
  });

  // Act
  const snapshot = await readSettings(remote);

  // Assert
  assert.equal(snapshot.ok && snapshot.value.disabledTools.join(','), 'mcp__fs__*');
});

test('writes the disabled list to the mcp-ui namespace with its revision fence', async () => {
  // Arrange
  const { remote, mutations } = fakeSettings(DESCRIBE);

  // Act
  const result = await writeDisabledTools(remote, 3, ['mcp__fs__read']);

  // Assert
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(mutations, [{
    ns: PARALLEL_NAMESPACE,
    ops: [{ op: 'set', path: ['disabledTools'], value: ['mcp__fs__read'] }],
    revision: 3,
  }]);
});

test('reports a read as failed when the mcp-ui namespace is missing', async () => {
  // Arrange
  const { remote } = fakeSettings({ writable: true, hasDocument: true, namespaces: [] });

  // Act
  const snapshot = await readSettings(remote);

  // Assert
  assert.equal(snapshot.ok, false);
});

test('builds one set op for an upsert and one unset op for a removal on the manager namespace', () => {
  // Arrange
  const entry = {
    transport: 'stdio' as const,
    command: 'npx',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    enabled: true,
    startupTimeoutMs: 30000,
  };

  // Act & Assert
  assert.deepEqual(serverChangeOps({ kind: 'upsert', name: 'fs', entry }), [
    { op: 'set', path: ['servers', 'fs'], value: entry },
  ]);
  assert.deepEqual(serverChangeOps({ kind: 'remove', name: 'fs' }), [
    { op: 'unset', path: ['servers', 'fs'] },
  ]);
  assert.deepEqual(serverChangeOps({ kind: 'enabled', name: 'fs', enabled: false }), [
    { op: 'set', path: ['servers', 'fs', 'enabled'], value: false },
  ]);
});

test('writes the parallel list to the mcp-ui namespace with its revision fence', async () => {
  // Arrange
  const { remote, mutations } = fakeSettings(DESCRIBE);

  // Act
  const result = await writeParallelTools(remote, 3, ['mcp__fs__*']);

  // Assert
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(mutations, [{
    ns: PARALLEL_NAMESPACE,
    ops: [{ op: 'set', path: ['parallelTools'], value: ['mcp__fs__*'] }],
    revision: 3,
  }]);
});

test('turns a settings conflict into a message that asks the user to reload', () => {
  // Act & Assert
  assert.match(settingsFailureMessage({ code: 'settings/conflict', message: 'stale' }), /已在别处修改/);
  assert.equal(settingsFailureMessage({ code: 'settings/refused', message: '被拒绝' }), '被拒绝');
});


