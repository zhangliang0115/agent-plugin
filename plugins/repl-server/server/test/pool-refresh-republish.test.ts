/** Pool refresh/restart must republish tools even when the names are unchanged. */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProcessLedger } from '../src/ports.ts';
import type {
  PoolClient,
  PoolClientFactory,
  PoolServerSpec,
  PoolToolInfo,
  PoolTransport,
  PoolTransportFactory,
} from '../src/pool/pool.ts';
import {
  createPoolRuntime,
  type PoolRuntime,
  type PoolRuntimeServerRecord,
} from '../src/pool/runtime.ts';

class FakeTransport implements PoolTransport {
  readonly kind = 'stdio' as const;
  readonly pid = 1_000;
  readonly pgid = 1_000;
  readonly lstart = 'Mon Nov 17 14:31:58 2026';
  onStderr(): void {}
  onClose(): void {}
  close(): void {}
}

class FakeClient implements PoolClient {
  async connect(): Promise<void> {}
  async listTools(): Promise<readonly PoolToolInfo[]> {
    // Deliberately stable: only a forced republish can reach `onTools` again.
    return [{ name: 'echo' }, { name: 'write_row' }];
  }
  async callTool(): Promise<unknown> {
    return {};
  }
  async ping(): Promise<void> {}
  close(): void {}
}

class FakeServers {
  readonly records = new Map<string, PoolRuntimeServerRecord>();

  async get(id: string): Promise<PoolRuntimeServerRecord | null> {
    return this.records.get(id) ?? null;
  }

  async list(): Promise<readonly PoolRuntimeServerRecord[]> {
    return [...this.records.values()];
  }
}

class FakeSecrets {
  async get(): Promise<string | undefined> {
    return undefined;
  }
}

class FakeLedger implements ProcessLedger {
  async recordPool(): Promise<void> {}
  async removePool(): Promise<void> {}
}

function makeRuntime(
  onTools: (serverId: string, tools: readonly PoolToolInfo[]) => Promise<void>,
): { runtime: PoolRuntime; servers: FakeServers } {
  const servers = new FakeServers();
  servers.records.set('pg', {
    id: 'pg',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: {},
    cwd: null,
    url: null,
    headers: {},
    enabled: true,
    revision: 1,
  });
  const transportFactory: PoolTransportFactory = {
    stdio: () => new FakeTransport(),
    http: () => new FakeTransport(),
  };
  const clientFactory: PoolClientFactory = {
    create: (_spec: PoolServerSpec) => new FakeClient(),
  };
  const runtime = createPoolRuntime({
    servers,
    secrets: new FakeSecrets(),
    transportFactory,
    clientFactory,
    ledger: new FakeLedger(),
    onTools,
    health: false,
    autoReconnect: false,
  });
  return { runtime, servers };
}

test('refreshTools and restart republish a tool set with unchanged names', async (t) => {
  const publishes: Array<{ serverId: string; names: string[] }> = [];
  const { runtime } = makeRuntime(async (serverId, tools) => {
    publishes.push({ serverId, names: tools.map((tool) => tool.name) });
  });
  t.after(() => runtime.dispose());

  await runtime.control.connect('pg');
  assert.deepEqual(publishes, [{ serverId: 'pg', names: ['echo', 'write_row'] }]);

  await runtime.control.refreshTools('pg');
  assert.equal(publishes.length, 2);
  assert.deepEqual(publishes[1], { serverId: 'pg', names: ['echo', 'write_row'] });

  await runtime.control.restart('pg');
  assert.equal(publishes.length, 3);
  assert.deepEqual(publishes[2], { serverId: 'pg', names: ['echo', 'write_row'] });
});
