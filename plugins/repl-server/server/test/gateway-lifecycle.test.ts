import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { Catalog, Clock, RequestIdentity, ScriptRequest } from '../src/ports.ts';

const IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'test-client/1.0',
  mcp: 'mcp_lifecycle',
};

const MINUTE = 60_000;

interface FakeClock extends Clock {
  advance(ms: number): void;
}

function fakeClock(start = 1_000_000): FakeClock {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition stayed false past the deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createGateway(t: TestContext, options: Partial<ExecGatewayOptions> = {}): ExecGateway {
  const gateway = new ExecGateway({ callTool: async () => ({ ok: true }), ...options });
  t.after(async () => {
    await gateway.disposeAll();
  });
  return gateway;
}

function request(code: string, extra: Partial<ScriptRequest> = {}): ScriptRequest {
  return { code, timeoutMs: 60_000, async: true, identity: IDENTITY, ...extra };
}

type WaitResult = { events: Array<{ taskId: string; status: string }>; pending: number };

test('an idle sweep hibernates the worker and keeps the session', async (t) => {
  const clock = fakeClock();
  const gateway = createGateway(t, { clock });

  const dispatched = await gateway.dispatchScript(request('return 1;'));
  await gateway.waitTasks(IDENTITY.mcp, [dispatched.taskId], 5_000);
  assert.equal(gateway.stats().sessions, 1);

  clock.advance(11 * MINUTE);
  const swept = await gateway.sweepIdle({
    hibernateMs: 10 * MINUTE,
    recycleMs: 60 * MINUTE,
    releaseServeMs: 60 * MINUTE,
  });
  assert.deepEqual(swept, { hibernated: 1, recycled: 0, serveReleased: 0 });
  assert.equal(gateway.stats().sessions, 1, 'the session survives hibernation');

  // The next eval respawns through the retained executor and succeeds.
  const outcome = await gateway.runScript({ ...request('return 2;'), async: false });
  assert.equal(outcome.isError, false);
  assert.match(outcome.content, /<result>2<\/result>/);
});

test('an idle sweep recycles the session after 60 minutes but keeps the task table', async (t) => {
  const clock = fakeClock();
  const closed: string[] = [];
  const gateway = createGateway(t, {
    clock,
    onSessionClosed: (_workspace, session) => {
      if (session !== undefined) closed.push(session.id);
    },
  });

  const dispatched = await gateway.dispatchScript(request('return 5;'));
  await gateway.waitTasks(IDENTITY.mcp, [dispatched.taskId], 5_000);
  const sessionId = gateway.sessions.list()[0]?.id ?? '';

  clock.advance(61 * MINUTE);
  const swept = await gateway.sweepIdle();
  assert.equal(swept.recycled, 1);
  assert.equal(gateway.stats().sessions, 0);
  assert.deepEqual(closed, [sessionId]);

  // The task is still readable inside its own TTL.
  const snapshot = await gateway.getTask(IDENTITY.mcp, dispatched.taskId);
  assert.ok(snapshot !== null);
  assert.equal(snapshot.status, 'completed');

  // A new dispatch starts a fresh execution session.
  const again = await gateway.dispatchScript(request('return 6;'));
  assert.equal(gateway.stats().sessions, 1);
  const waited = (await gateway.waitTasks(IDENTITY.mcp, [again.taskId], 5_000)) as WaitResult;
  assert.equal(waited.events[0]?.status, 'completed');
});

test('eval and tool audits carry the request id and a shared runId', async (t) => {
  const events: Array<Record<string, unknown>> = [];
  const catalog: Catalog = {
    snapshot: () => ({
      revision: 1,
      tools: [{ name: 'echo', kind: 'builtin', concurrency: 'serial', inputSchema: {}, enabled: true }],
    }),
  };
  const gateway = createGateway(t, {
    catalog,
    onAudit: (event) => {
      events.push(event as unknown as Record<string, unknown>);
    },
  });

  const outcome = await gateway.runScript({
    ...request('return await tools.echo({});'),
    async: false,
    requestId: 7,
  });
  assert.equal(outcome.isError, false);

  const start = events.find((event) => event['event'] === 'eval_start');
  const toolCall = events.find((event) => event['event'] === 'tool_call');
  const toolResult = events.find((event) => event['event'] === 'tool_result');
  const end = events.find((event) => event['event'] === 'eval_end');
  assert.equal(start?.['requestId'], 7);
  assert.equal(start?.['async'], false);
  assert.equal(start?.['timeoutMs'], 60_000);
  assert.equal(start?.['evalId'], 1);
  assert.equal(typeof start?.['epoch'], 'number');
  const runId = start?.['runId'];
  assert.equal(typeof runId, 'string');
  for (const event of [toolCall, toolResult, end]) {
    assert.equal(event?.['runId'], runId);
  }
  assert.equal(toolCall?.['exec'], start?.['exec']);
  assert.equal(typeof toolCall?.['exec'], 'string');
  assert.equal(toolCall?.['server'], '__official__');

  assert.equal(toolCall?.['seq'], 1);
  // Official tools ignore the catalog's decorative `concurrency`: `serve`
  // exports no `isConcurrencySafe`, so the row reports the mode this gateway
  // actually applied (`02 §2.4`). `echo` is neither a file writer nor Bash.
  assert.equal(toolCall?.['mode'], 'parallel');
  assert.deepEqual(toolCall?.['args'], {});
  // Byte accounting belongs to the audit runtime: it is the only layer that
  // serializes the value, so the gateway emits raw arguments only (`09 §三`).
  assert.equal('argsBytes' in (toolCall ?? {}), false);
  assert.equal(typeof toolCall?.['queuedAt'], 'number');

  assert.equal(toolResult?.['server'], '__official__');
  assert.equal(toolResult?.['seq'], 1);
  // An uncontended call can still cross a millisecond boundary under load.
  assert.equal(typeof toolResult?.['queueMs'], 'number');
  assert.ok((toolResult?.['queueMs'] as number) >= 0);
  assert.equal(typeof toolResult?.['ms'], 'number');
  assert.equal(typeof toolResult?.['startedAt'], 'number');
  assert.equal(typeof toolResult?.['endedAt'], 'number');
  assert.equal(typeof toolResult?.['outBytes'], 'number');
  assert.ok((toolResult?.['outBytes'] as number) > 0);

  assert.equal(end?.['calls'], 1);
  assert.equal(typeof end?.['resultBytes'], 'number');
  assert.ok((end?.['resultBytes'] as number) > 0);
});

test('tool_result records the thrown error code', async (t) => {
  const events: Array<Record<string, unknown>> = [];
  const gateway = createGateway(t, {
    callTool: async () => {
      throw Object.assign(new Error('boom'), { code: 'TOOL_BOOM' });
    },
    onAudit: (event) => {
      events.push(event as unknown as Record<string, unknown>);
    },
  });

  const outcome = await gateway.runScript({
    ...request('try { await tools.echo({}); } catch (error) { return String(error); }'),
    async: false,
  });
  assert.equal(outcome.isError, false);

  const toolResult = events.find((event) => event['event'] === 'tool_result');
  assert.equal(toolResult?.['ok'], false);
  assert.equal(toolResult?.['errorCode'], 'TOOL_BOOM');
});

test('a serve idle for 15 minutes is released while the session stays', async (t) => {
  const clock = fakeClock();
  const closed: Array<{ id: string; workspace: string }> = [];
  const gateway = createGateway(t, {
    clock,
    onSessionClosed: (workspace, session) => {
      if (session !== undefined) closed.push({ id: session.id, workspace });
    },
  });

  await gateway.runScript({ ...request('return 1;'), async: false });
  const sessionId = gateway.sessions.list()[0]?.id ?? '';

  clock.advance(16 * MINUTE);
  const swept = await gateway.sweepIdle({ hibernateMs: 60 * MINUTE, recycleMs: 120 * MINUTE });
  assert.deepEqual(swept, { hibernated: 0, recycled: 0, serveReleased: 1 });
  assert.equal(gateway.stats().sessions, 1);
  assert.deepEqual(closed, [{ id: sessionId, workspace: '.' }]);
});

test('repeated idle sweeps hibernate and release the serve handle only once', async (t) => {
  const clock = fakeClock();
  const audits: string[] = [];
  const closed: string[] = [];
  const gateway = createGateway(t, {
    clock,
    onAudit: (event) => {
      if (event.event === 'exec_hibernate') audits.push(String(event['execId']));
    },
    onSessionClosed: (_workspace, session) => {
      if (session !== undefined) closed.push(session.id);
    },
  });

  await gateway.runScript({ ...request('return 1;'), async: false });
  const sessionId = gateway.sessions.list()[0]?.id ?? '';
  const options = { hibernateMs: 10 * MINUTE, recycleMs: 120 * MINUTE, releaseServeMs: 15 * MINUTE };

  clock.advance(16 * MINUTE);
  const first = await gateway.sweepIdle(options);
  assert.deepEqual(first, { hibernated: 1, recycled: 0, serveReleased: 1 });
  assert.deepEqual(await gateway.sweepIdle(options), { hibernated: 0, recycled: 0, serveReleased: 0 });
  assert.deepEqual(await gateway.sweepIdle(options), { hibernated: 0, recycled: 0, serveReleased: 0 });
  assert.deepEqual(audits, [sessionId]);
  assert.deepEqual(closed, [sessionId]);

  // The next eval resets the flags, so one more idle period acts again.
  const next = await gateway.runScript({ ...request('return 2;'), async: false });
  assert.equal(next.isError, false);
  clock.advance(16 * MINUTE);
  assert.deepEqual(await gateway.sweepIdle(options), { hibernated: 1, recycled: 0, serveReleased: 1 });
  assert.deepEqual(audits, [sessionId, sessionId]);
  assert.deepEqual(closed, [sessionId, sessionId]);
});

test('an idle sweep never touches a session with an in-flight eval', async (t) => {
  const clock = fakeClock();
  let arrived = false;
  const gateway = createGateway(t, {
    clock,
    callTool: async (_call, _workspace, _binding, signal) => {
      arrived = true;
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });

  await gateway.dispatchScript(request(`
    await tools.Slow({});
    return 1;
  `));
  await waitFor(() => arrived);

  clock.advance(2 * 60 * MINUTE);
  assert.deepEqual(await gateway.sweepIdle(), { hibernated: 0, recycled: 0, serveReleased: 0 });
  assert.equal(gateway.stats().sessions, 1);
  assert.equal(gateway.stats().inFlightEvals, 1);
});

test('a disposed gateway rejects new evals with MCP_SERVER_UNAVAILABLE', async (t) => {
  const gateway = createGateway(t);
  await gateway.disposeAll();

  const isShutdown = (error: unknown): boolean => (error as { code?: string }).code === 'MCP_SERVER_UNAVAILABLE';
  await assert.rejects(gateway.runScript({ ...request('return 1;'), async: false }), isShutdown);
  await assert.rejects(gateway.dispatchScript(request('return 1;')), isShutdown);
});

test('a hard wall asks the serve hooks for this execution session', async (t) => {
  const healthyIds: string[] = [];
  const restartedIds: string[] = [];
  const gateway = createGateway(t, {
    serve: {
      healthy: (execSessionId) => {
        healthyIds.push(execSessionId);
        return false;
      },
      restart: (execSessionId) => {
        restartedIds.push(execSessionId);
      },
    },
  });

  const outcome = await gateway.runScript({ ...request('while (true) {}'), async: false, timeoutMs: 1_000 });
  assert.equal(outcome.isError, true);

  const sessionId = gateway.sessions.list()[0]?.id ?? '';
  assert.ok(sessionId !== '');
  assert.ok(healthyIds.includes(sessionId), `healthy() saw ${healthyIds.join(',')}`);
  assert.deepEqual([...new Set(restartedIds)], [sessionId]);
});
