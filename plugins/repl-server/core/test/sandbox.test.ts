import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { serialize } from 'node:v8';
import type { Worker } from 'node:worker_threads';

import { WorkerKilledError } from '../src/errors.ts';
import type { ToolCallRequest } from '../src/types.ts';
import { readyMessage, type WorkerLogMessage } from '../src/worker/protocol.ts';
import { Sandbox, SandboxWedgedError, type SandboxOptions } from '../src/worker/sandbox.ts';

function useSandbox(t: TestContext, options: SandboxOptions = {}): Sandbox {
  const sandbox = new Sandbox(options);
  t.after(async () => {
    await sandbox.dispose();
  });
  return sandbox;
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition is still false after timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('start reports one ready epoch and keeps the worker running', async (t) => {
  const sandbox = useSandbox(t);
  const started = await sandbox.start();
  assert.deepEqual(started, { epoch: 1, stateRestored: 'none' });
  assert.equal(sandbox.running, true);
  assert.equal(sandbox.epoch, 1);
});

test('eval runs top-level await and returns the return value', async (t) => {
  const sandbox = useSandbox(t);
  const outcome = await sandbox.eval(
    `
      const base = await Promise.resolve(20);
      const noHost = typeof process === 'undefined' && typeof require === 'undefined';
      return base + (noHost ? 1 : 100);
    `,
    { evalId: 1 },
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.result, 21);
  assert.equal(outcome.stdout, '');
  assert.equal(outcome.stderr, '');
  assert.equal(outcome.contextReset, false);
  assert.equal(outcome.stateRestored, 'none');
  assert.ok(outcome.ms >= 0);
});

test('console lines are captured per eval and streamed to onLog', async (t) => {
  const logs: WorkerLogMessage[] = [];
  const sandbox = useSandbox(t, { onLog: (message) => logs.push(message) });

  const outcome = await sandbox.eval("console.log('hello', 1); console.error('oops'); return 'ok';", {
    evalId: 1,
  });

  assert.equal(outcome.result, 'ok');
  assert.equal(outcome.stdout, 'hello 1\n');
  assert.equal(outcome.stderr, 'oops\n');
  assert.deepEqual(
    logs.map((message) => message.text),
    ['hello 1\n', 'oops\n'],
  );
  assert.ok(logs.every((message) => message.stream === 'console' && message.evalId === 1));
});

test('tools calls reach the host, including tools.mcp.<server>.<tool>', async (t) => {
  const calls: ToolCallRequest[] = [];
  const sandbox = useSandbox(t, {
    onToolCall: (call) => {
      calls.push(call);
      if (call.server === 'pg') return { rows: [call.args.sql] };
      return { echo: call.args.value };
    },
  });

  const outcome = await sandbox.eval(
    `
      const a = await tools.Echo({ value: 7 });
      const b = await tools.mcp.pg.query({ sql: 'select 1' });
      return a.echo + ':' + b.rows[0];
    `,
    { evalId: 1 },
  );

  assert.equal(outcome.result, '7:select 1');
  assert.equal(calls.length, 2);
  const [first, second] = calls;
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.tool, 'Echo');
  assert.equal(first.server, undefined);
  assert.equal(first.evalId, 1);
  assert.equal(first.epoch, 1);
  assert.equal(first.callSeq, 1);
  assert.deepEqual(first.args, { value: 7 });
  assert.equal(second.tool, 'query');
  assert.equal(second.server, 'pg');
  assert.equal(second.callSeq, 2);
});

test('a failing tool call rejects inside the script and can be caught', async (t) => {
  const sandbox = useSandbox(t, {
    onToolCall: () => {
      throw new Error('boom');
    },
  });

  const outcome = await sandbox.eval(
    `
      try { await tools.Bad({}); } catch (error) { return 'caught:' + error.message; }
      return 'not-caught';
    `,
    { evalId: 1 },
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.result, 'caught:boom');
});

test('a sync infinite loop ends with layer=sync and the worker survives', async (t) => {
  const sandbox = useSandbox(t, { limits: { syncMs: 40 } });

  const stuck = await sandbox.eval('while (true) {}', { evalId: 1 });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.layer, 'sync');
  assert.match(stuck.error ?? '', /timed out/);
  assert.equal(sandbox.running, true);

  const epoch = sandbox.epoch;
  const next = await sandbox.eval('return 7;', { evalId: 2 });
  assert.equal(next.ok, true);
  assert.equal(next.result, 7);
  assert.equal(sandbox.epoch, epoch);
});

test('cancel rejects in-flight tool calls and lets the script recover', async (t) => {
  const called = deferred<void>();
  const sandbox = useSandbox(t, {
    onToolCall: () => {
      called.resolve(undefined);
      return new Promise(() => {});
    },
  });

  const running = sandbox.eval(
    `
      try { await tools.Slow({}); } catch (error) { return 'cancelled:' + error.message; }
      return 'leaked';
    `,
    { evalId: 1 },
  );
  await called.promise;
  sandbox.cancel(1);

  const outcome = await running;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result, 'cancelled:eval cancelled');
});

test('an uncaught cancel reports layer=soft', async (t) => {
  const called = deferred<void>();
  const sandbox = useSandbox(t, {
    onToolCall: () => {
      called.resolve(undefined);
      return new Promise(() => {});
    },
  });

  const running = sandbox.eval('await tools.Slow({});', { evalId: 1 });
  await called.promise;
  sandbox.cancel(1);

  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.layer, 'soft');
  assert.equal(outcome.error, 'eval cancelled');
});

test('two in-flight evals keep their own tool calls and results', async (t) => {
  const releases = new Map<string, (value: unknown) => void>();
  const sandbox = useSandbox(t, {
    onToolCall: (call) =>
      new Promise((resolve) => {
        releases.set(String(call.args.tag), resolve);
      }),
  });

  const first = sandbox.eval("const r = await tools.Wait({ tag: 'a' }); return 'first:' + r.tag;", { evalId: 1 });
  const second = sandbox.eval("const r = await tools.Wait({ tag: 'b' }); return 'second:' + r.tag;", { evalId: 2 });
  await waitFor(() => releases.size === 2);

  releases.get('b')?.({ tag: 'b' });
  releases.get('a')?.({ tag: 'a' });

  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.evalId, 1);
  assert.equal(one.result, 'first:a');
  assert.equal(two.evalId, 2);
  assert.equal(two.result, 'second:b');
});

test('state is snapshotted after done and restored on rebuild', async (t) => {
  const sandbox = useSandbox(t);

  const first = await sandbox.eval('state.cursor = 42; return Object.keys(state).length;', { evalId: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.result, 1);
  assert.equal(first.contextReset, false);
  assert.ok(sandbox.snapshotBytes !== null && sandbox.snapshotBytes > 0);

  const rebuilt = await sandbox.rebuild();
  assert.equal(rebuilt.epoch, 2);
  assert.equal(rebuilt.stateRestored, 'lastGood');
  assert.equal(sandbox.epoch, 2);

  const second = await sandbox.eval('return state.cursor;', { evalId: 2 });
  assert.equal(second.result, 42);
  assert.equal(second.contextReset, true);
  assert.equal(second.stateRestored, 'lastGood');

  const third = await sandbox.eval('return state.cursor;', { evalId: 3 });
  assert.equal(third.result, 42);
  assert.equal(third.contextReset, false);
});

test('state cannot be replaced from the script', async (t) => {
  const sandbox = useSandbox(t);
  const outcome = await sandbox.eval(
    `
      try { state = {}; } catch (error) { return error.name + ':' + error.message; }
      return 'replaced';
    `,
    { evalId: 1 },
  );
  assert.equal(outcome.result, 'TypeError:state cannot be replaced; assign fields instead');
});

test('a snapshot over the injected limit reports too-large and is not restored', async (t) => {
  const sandbox = useSandbox(t, { limits: { stateBytes: 128 } });

  const first = await sandbox.eval("state.blob = 'x'.repeat(5000); return 'grown';", { evalId: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.stateSnapshot, 'too-large');
  assert.equal(sandbox.snapshotBytes, null);

  const rebuilt = await sandbox.rebuild();
  assert.equal(rebuilt.stateRestored, 'none');

  const second = await sandbox.eval('return typeof state.blob;', { evalId: 2 });
  assert.equal(second.result, 'undefined');
});

test('an unreadable snapshot restores as none', async (t) => {
  const sandbox = useSandbox(t);
  await sandbox.eval('state.a = 1; return 1;', { evalId: 1 });

  const full = serialize({ a: 1 });
  const truncated = full.buffer.slice(full.byteOffset, full.byteOffset + 4) as ArrayBuffer;
  sandbox.seedSnapshot(truncated);

  const rebuilt = await sandbox.rebuild();
  assert.equal(rebuilt.stateRestored, 'none');

  const outcome = await sandbox.eval('return typeof state.a;', { evalId: 2 });
  assert.equal(outcome.result, 'undefined');
});

test('terminate returns false after the timeout and marks the sandbox wedged', async () => {
  const fake = {
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'message') {
        queueMicrotask(() => listener(readyMessage(1)));
      }
      return fake;
    },
    postMessage() {},
    terminate() {
      return new Promise<number>(() => {});
    },
  } as unknown as Worker;

  const sandbox = new Sandbox({ workerFactory: () => fake, limits: { terminateMs: 25 } });
  const started = await sandbox.start();
  assert.equal(started.epoch, 1);

  const begin = Date.now();
  const terminated = await sandbox.terminate();
  assert.equal(terminated, false);
  assert.equal(sandbox.wedged, true);
  assert.ok(Date.now() - begin >= 20);

  await assert.rejects(sandbox.start(), (error: unknown) => error instanceof SandboxWedgedError);
});

test('terminate rejects an in-flight eval with WorkerKilledError', async (t) => {
  const called = deferred<void>();
  const sandbox = useSandbox(t, {
    onToolCall: () => {
      called.resolve(undefined);
      return new Promise(() => {});
    },
  });

  const running = sandbox.eval('await tools.Slow({});', { evalId: 1 });
  await called.promise;
  // Attach before terminate: the rejection fires while terminate() is awaited.
  const rejected = running.catch((error: unknown) => error);

  assert.equal(await sandbox.terminate(), true);
  assert.ok((await rejected) instanceof WorkerKilledError);
  assert.equal(sandbox.running, false);
});
