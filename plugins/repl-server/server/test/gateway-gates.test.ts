/**
 * Gateway-level proof for the resource gates.
 *
 * `keyed-gate.test.ts` proves the primitive and `bash-classify.test.ts` proves
 * the classifier; neither proves the *gateway* hands the right key down. These
 * cases drive real scripts through `ExecGateway` and watch the transport to see
 * what actually ran in parallel.
 *
 * The transport blocks on a deferred per call, so "did B start before A
 * finished" is decided by the test, not by timing luck.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { ToolCallRequest } from '@zhangliang0115/repl-server-core';

import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { Catalog, RequestIdentity, ScriptRequest } from '../src/ports.ts';

const IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'test-client/1.0',
  mcp: 'mcp_gates',
};

/** Official tools carry no authoritative concurrency, so the value is noise. */
const CATALOG: Catalog = {
  snapshot: () => ({
    revision: 1,
    tools: ['Edit', 'Write', 'Bash'].map((name) => ({
      name,
      kind: 'builtin' as const,
      concurrency: 'serial' as const,
      inputSchema: {},
      enabled: true,
    })),
  }),
};

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Harness {
  readonly gateway: ExecGateway;
  /** Call sequence numbers in arrival order at the transport. */
  readonly arrivals: number[];
  readonly events: Array<Record<string, unknown>>;
  release(seq: number): void;
  waitForArrivals(count: number): Promise<void>;
}

function harness(t: TestContext, options: Partial<ExecGatewayOptions> = {}): Harness {
  const arrivals: number[] = [];
  const events: Array<Record<string, unknown>> = [];
  const gates = new Map<number, Deferred>();

  const gateway = new ExecGateway({
    catalog: CATALOG,
    onAudit: (event) => {
      events.push(event as unknown as Record<string, unknown>);
    },
    callTool: async (call: ToolCallRequest) => {
      arrivals.push(call.callSeq);
      const gate = deferred();
      gates.set(call.callSeq, gate);
      await gate.promise;
      return { ok: true };
    },
    ...options,
  });

  t.after(async () => {
    // Never leave a test hanging on an unreleased call.
    for (const gate of gates.values()) gate.resolve();
    await gateway.disposeAll();
  });

  return {
    gateway,
    arrivals,
    events,
    release(seq) {
      const gate = gates.get(seq);
      assert.ok(gate !== undefined, `no pending call for seq ${String(seq)}`);
      gate.resolve();
    },
    async waitForArrivals(count) {
      await waitFor(() => arrivals.length >= count);
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition stayed false past the deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function request(code: string): ScriptRequest {
  return { code, timeoutMs: 60_000, async: false, identity: IDENTITY };
}

function resultOf(events: Array<Record<string, unknown>>, seq: number): Record<string, unknown> {
  const found = events.find((event) => event['event'] === 'tool_result' && event['seq'] === seq);
  assert.ok(found !== undefined, `no tool_result for seq ${String(seq)}`);
  return found;
}

test('two Edits to the same file serialise and the second reports waiting', async (t) => {
  const h = harness(t);

  const running = h.gateway.runScript(
    request(
      "return await Promise.all([tools.Edit({ file_path: '/tmp/same.ts' }), tools.Edit({ file_path: '/tmp/same.ts' })]);",
    ),
  );

  await h.waitForArrivals(1);
  await settle();
  assert.equal(h.arrivals.length, 1, 'the second call must wait for the first to finish');

  h.release(1);
  await h.waitForArrivals(2);
  h.release(2);

  const outcome = await running;
  assert.equal(outcome.isError, false, outcome.content);

  const first = resultOf(h.events, 1);
  const second = resultOf(h.events, 2);
  // An uncontended call still shows a millisecond or two of scheduling between
  // "the script asked" and "the gate let it in"; only the gate can say whether
  // it actually queued.
  assert.ok(Number(first['queueMs']) < 50, `unexpected wait ${String(first['queueMs'])}`);
  assert.equal('waitReason' in first, false, 'the first call never queued');
  assert.ok(Number(second['queueMs']) > 0, `expected a measured wait, got ${String(second['queueMs'])}`);
  assert.equal(second['waitReason'], 'keyed-gate');
});

test('two Edits to different files run in parallel', async (t) => {
  const h = harness(t);

  const running = h.gateway.runScript(
    request(
      "return await Promise.all([tools.Edit({ file_path: '/tmp/a.ts' }), tools.Edit({ file_path: '/tmp/b.ts' })]);",
    ),
  );

  // Both reach the transport before either is released: the lane key is the
  // path, not the tool.
  await h.waitForArrivals(2);
  h.release(1);
  h.release(2);

  const outcome = await running;
  const second = resultOf(h.events, 2);
  assert.equal(outcome.isError, false, outcome.content);
  assert.ok(Number(second['queueMs']) < 50, `unexpected wait ${String(second['queueMs'])}`);
  assert.equal('waitReason' in second, false);
});

test('a write-mode Bash takes one lane while a read-only Bash runs in parallel', async (t) => {
  const writer = harness(t);
  const writing = writer.gateway.runScript(
    request(
      "return await Promise.all([tools.Bash({ command: 'rm -rf /tmp/x' }), tools.Bash({ command: 'rm -rf /tmp/y' })]);",
    ),
  );
  await writer.waitForArrivals(1);
  await settle();
  assert.equal(writer.arrivals.length, 1, 'two writes must not overlap');
  writer.release(1);
  await writer.waitForArrivals(2);
  writer.release(2);
  assert.equal((await writing).isError, false);
  assert.equal(resultOf(writer.events, 2)['waitReason'], 'keyed-gate');

  const reader = harness(t);
  const reading = reader.gateway.runScript(
    request("return await Promise.all([tools.Bash({ command: 'ls' }), tools.Bash({ command: 'ls -la' })]);"),
  );
  await reader.waitForArrivals(2);
  reader.release(1);
  reader.release(2);
  assert.equal((await reading).isError, false);
  const readSecond = resultOf(reader.events, 2);
  assert.ok(Number(readSecond['queueMs']) < 50, `unexpected wait ${String(readSecond['queueMs'])}`);
  assert.equal('waitReason' in readSecond, false);
});

test('a call cancelled while queued never reaches the transport', async (t) => {
  const h = harness(t);
  const dispatched = await h.gateway.dispatchScript({
    code: "return await Promise.all([tools.Edit({ file_path: '/tmp/q.ts' }), tools.Edit({ file_path: '/tmp/q.ts' })]);",
    timeoutMs: 60_000,
    async: true,
    identity: IDENTITY,
  });

  await h.waitForArrivals(1);
  await settle();
  assert.equal(h.arrivals.length, 1);

  assert.equal(await h.gateway.cancelTask(IDENTITY.mcp, dispatched.taskId), true);
  // Releasing the running call lets the eval settle; the queued one must be
  // gone from the lane instead of starting a call nobody waits for.
  h.release(1);
  await settle(120);
  assert.equal(h.arrivals.length, 1, 'the queued call must not start after cancellation');
});

test('sequential calls on the same lane do not deadlock', async (t) => {
  let calls = 0;
  const gateway = new ExecGateway({
    catalog: CATALOG,
    callTool: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  t.after(async () => {
    await gateway.disposeAll();
  });

  // Three waits on one lane in a row: if a release ever failed to hand the slot
  // on, the third call would hang until the eval timeout.
  const outcome = await gateway.runScript(
    request(
      "await tools.Edit({ file_path: '/tmp/n.ts' }); await tools.Edit({ file_path: '/tmp/n.ts' }); return await tools.Edit({ file_path: '/tmp/n.ts' });",
    ),
  );
  assert.equal(outcome.isError, false, outcome.content);
  assert.equal(calls, 3);
});
