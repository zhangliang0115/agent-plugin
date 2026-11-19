import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type {
  Catalog,
  CatalogSnapshot,
  CatalogTool,
  RequestIdentity,
  ScriptRequest,
} from '../src/ports.ts';

const IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'test-client/1.0',
  mcp: 'mcp_test',
};

function catalogTool(
  name: string,
  kind: CatalogTool['kind'],
  tags: string[],
  server?: string,
): CatalogTool {
  const tool: CatalogTool = {
    name,
    kind,
    tags,
    inputSchema: { type: 'object', properties: {} },
    concurrency: 'parallel',
    enabled: true,
  };
  if (server !== undefined) tool.server = server;
  return tool;
}

const TOOLS: readonly CatalogTool[] = [
  catalogTool('Read', 'builtin', ['files', 'read']),
  catalogTool('Bash', 'builtin', ['shell', 'destructive']),
  catalogTool('pg.query', 'mcp', ['db', 'read'], 'pg'),
];

class FakeCatalog implements Catalog {
  private readonly tools: readonly CatalogTool[];

  constructor(tools: readonly CatalogTool[] = TOOLS) {
    this.tools = tools;
  }

  snapshot(): CatalogSnapshot {
    return { revision: 1, tools: this.tools };
  }
}

interface RecordedCall {
  tool: string;
  server?: string;
  args: Record<string, unknown>;
  evalId: number;
}

interface GatewayHarness {
  gateway: ExecGateway;
  calls: RecordedCall[];
}

function createGateway(
  t: TestContext,
  options: {
    catalog?: Catalog;
    onCall?: (call: RecordedCall) => unknown | Promise<unknown>;
  } = {},
): GatewayHarness {
  const calls: RecordedCall[] = [];
  const gatewayOptions: ExecGatewayOptions = {
    catalog: options.catalog ?? new FakeCatalog(),
    callTool: async (call) => {
      const recorded: RecordedCall = { tool: call.tool, args: call.args, evalId: call.evalId };
      if (call.server !== undefined) recorded.server = call.server;
      calls.push(recorded);
      return options.onCall === undefined ? { ok: true, tool: call.tool } : await options.onCall(recorded);
    },
  };
  const gateway = new ExecGateway(gatewayOptions);
  t.after(async () => {
    await gateway.disposeAll();
  });
  return { gateway, calls };
}

function request(code: string, extra: Partial<ScriptRequest> = {}): ScriptRequest {
  return { code, timeoutMs: 5_000, async: false, identity: IDENTITY, ...extra };
}

function canonical(call: RecordedCall): string {
  return call.server === undefined ? call.tool : `${call.server}.${call.tool}`;
}

/** White-box view of the per-eval filter registry, for the cleanup assertion. */
function filterCount(gateway: ExecGateway, workspace: string): number {
  const internals = gateway as unknown as {
    runtimes: Map<string, { record: { workspace: string }; filters: Map<number, unknown> }>;
  };
  let total = 0;
  for (const runtime of internals.runtimes.values()) {
    if (runtime.record.workspace === workspace) total += runtime.filters.size;
  }
  return total;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Bounds a wait so a broken barrier fails the assertions instead of hanging. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition stayed false past the deadline');
    await delay(10);
  }
}

test('without filters every tool call reaches the transport', async (t) => {
  const h = createGateway(t);
  const outcome = await h.gateway.runScript(request(`
    const read = await tools.Read({ path: '/tmp/a' });
    const query = await tools.mcp.pg.query({ sql: 'select 1' });
    return read.ok + '|' + query.ok;
  `));

  assert.equal(outcome.isError, false, outcome.content);
  assert.match(outcome.content, /<result>true\|true<\/result>/);
  assert.deepEqual(h.calls.map(canonical), ['Read', 'pg.query']);
});

test('visibleTools narrows one eval and rejects before the transport', async (t) => {
  const h = createGateway(t);

  const denied = await h.gateway.runScript(request(`
    let message = 'allowed';
    try {
      await tools.mcp.pg.query({ sql: 'select 1' });
    } catch (error) {
      message = error.message;
    }
    return message;
  `, { visibleTools: ['Read'] }));

  assert.equal(denied.isError, false, denied.content);
  assert.match(denied.content, /pg\.query is not visible in this call/);
  assert.deepEqual(h.calls, []);

  const allowed = await h.gateway.runScript(request(`
    const read = await tools.Read({ path: '/tmp/a' });
    const query = await tools.mcp.pg.query({ sql: 'select 1' });
    return read.ok + '|' + query.ok;
  `, { visibleTools: ['Read', 'pg.query'] }));

  assert.equal(allowed.isError, false, allowed.content);
  assert.deepEqual(h.calls.map(canonical), ['Read', 'pg.query']);
});

test('excludeTags hides every tool whose catalog tags intersect', async (t) => {
  const h = createGateway(t);
  const outcome = await h.gateway.runScript(request(`
    const results = [];
    try {
      await tools.Bash({ command: 'rm -rf /tmp/x' });
      results.push('Bash:allowed');
    } catch (error) {
      results.push('Bash:' + error.message);
    }
    const read = await tools.Read({ path: '/tmp/a' });
    results.push('Read:' + read.ok);
    return results.join(';');
  `, { excludeTags: ['destructive'] }));

  assert.equal(outcome.isError, false, outcome.content);
  assert.match(outcome.content, /Bash is not visible in this call/);
  assert.match(outcome.content, /Read:true/);
  assert.deepEqual(h.calls.map(canonical), ['Read']);
});

test('visibleTools and excludeTags intersect', async (t) => {
  const h = createGateway(t);
  const outcome = await h.gateway.runScript(request(`
    const results = [];
    for (const [name, call] of [
      ['Bash', () => tools.Bash({ command: 'ls' })],
      ['Read', () => tools.Read({ path: '/tmp/a' })],
      ['pg.query', () => tools.mcp.pg.query({ sql: 'select 1' })],
    ]) {
      try {
        await call();
        results.push(name + ':ok');
      } catch (error) {
        results.push(name + ':denied');
      }
    }
    return results.join(',');
  `, { visibleTools: ['Bash', 'Read'], excludeTags: ['destructive'] }));

  assert.equal(outcome.isError, false, outcome.content);
  assert.match(outcome.content, /Bash:denied,Read:ok,pg\.query:denied/);
  assert.deepEqual(h.calls.map(canonical), ['Read']);
});

test('concurrent async evals keep independent filters', async (t) => {
  let arrivals = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  const h = createGateway(t, {
    onCall: async (call) => {
      arrivals += 1;
      if (arrivals >= 2) release();
      await within(bothArrived, 2_000);
      return { ok: true, tool: call.tool, label: call.args['label'] };
    },
  });

  const a = await h.gateway.dispatchScript(request(`
    const allowed = await tools.Read({ label: 'a' });
    let denied = 'none';
    try {
      await tools.mcp.pg.query({ label: 'a' });
    } catch (error) {
      denied = error.message;
    }
    return 'A allowed=' + allowed.label + ' denied=' + denied;
  `, { async: true, visibleTools: ['Read'] }));

  const b = await h.gateway.dispatchScript(request(`
    const allowed = await tools.mcp.pg.query({ label: 'b' });
    let denied = 'none';
    try {
      await tools.Read({ label: 'b' });
    } catch (error) {
      denied = error.message;
    }
    return 'B allowed=' + allowed.label + ' denied=' + denied;
  `, { async: true, visibleTools: ['pg.query'] }));

  const result = (await h.gateway.waitTasks('mcp_test', [a.taskId, b.taskId], 10_000)) as {
    ok: boolean;
    timedOut: boolean;
    pending: number;
    events: Array<{ taskId: string; status: string; result?: string }>;
  };

  assert.equal(result.timedOut, false);
  assert.equal(result.pending, 0);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0]?.status, 'completed');
  assert.equal(result.events[1]?.status, 'completed');
  assert.match(result.events[0]?.result ?? '', /A allowed=a denied=pg\.query is not visible in this call/);
  assert.match(result.events[1]?.result ?? '', /B allowed=b denied=Read is not visible in this call/);

  assert.deepEqual(h.calls.map(canonical).sort(), ['Read', 'pg.query']);
  assert.equal(h.calls.find((call) => call.tool === 'Read')?.args['label'], 'a');
  assert.equal(h.calls.find((call) => call.tool === 'query')?.args['label'], 'b');
});

test('an eval filter is registered while it runs and dropped when it settles', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const h = createGateway(t, {
    onCall: async () => {
      await gate;
      return { ok: true };
    },
  });

  const dispatched = await h.gateway.dispatchScript(request(`
    const read = await tools.Read({ path: '/tmp/a' });
    return read.ok;
  `, { async: true, visibleTools: ['Read'] }));

  await waitFor(() => h.calls.length === 1);
  assert.equal(filterCount(h.gateway, '.'), 1);

  release();
  const result = (await h.gateway.waitTasks('mcp_test', [dispatched.taskId], 10_000)) as {
    timedOut: boolean;
  };
  assert.equal(result.timedOut, false);
  await waitFor(() => filterCount(h.gateway, '.') === 0);

  const followUp = await h.gateway.runScript(request(`
    const query = await tools.mcp.pg.query({ sql: 'select 1' });
    return query.ok;
  `));

  assert.equal(followUp.isError, false, followUp.content);
  assert.deepEqual(h.calls.map(canonical), ['Read', 'pg.query']);
});
