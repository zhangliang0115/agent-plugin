import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMode, parseEnvelope } from './helpers.ts';

const tools = [{ name: 'Wait', description: 'wait', inputSchema: {} }];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The control argument is optional here so a runtime without it fails on the deadline, not on a TypeError. */
interface Control {
  holdDeadline(): () => void;
}

/** An invoker that holds the deadline while it waits `holdMs`, then sleeps `afterMs` without a hold. */
function holding(holdMs: number, afterMs = 0) {
  return async (_name: string, _args: unknown, _signal: AbortSignal, control?: Control): Promise<unknown> => {
    const release = control?.holdDeadline() ?? (() => undefined);
    try {
      await sleep(holdMs);
    } finally {
      release();
    }
    if (afterMs > 0) await sleep(afterMs);
    return 'ok';
  };
}

test('F1b held time does not count toward the run deadline', async () => {
  const mode = newMode({ timeoutMs: 200, maxTimeoutMs: 200 });
  const out = parseEnvelope(await mode.run({}, { code: 'await Wait({})', tools, invoke: holding(600), signal: new AbortController().signal }));
  assert.equal(out.error, undefined);
  assert.equal(out.result, 'ok');
  mode.dispose();
});

test('F1b the deadline resumes after the hold is released', async () => {
  const mode = newMode({ timeoutMs: 200, maxTimeoutMs: 200 });
  const started = Date.now();
  const out = parseEnvelope(await mode.run({}, { code: 'await Wait({})', tools, invoke: holding(300, 5_000), signal: new AbortController().signal }));
  assert.match(out.error ?? '', /timed out/);
  assert.ok(Date.now() - started < 4_000, 'ends at the deadline, not when the tool finishes');
  mode.dispose();
});

test('F1b an abort ends a held run without waiting', async () => {
  const mode = newMode({ timeoutMs: 200, maxTimeoutMs: 200 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const invoke = async (_name: string, _args: unknown, signal: AbortSignal, control?: Control): Promise<unknown> => {
    const release = control?.holdDeadline() ?? (() => undefined);
    try {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    } finally {
      release();
    }
    return 'late';
  };
  const out = parseEnvelope(await mode.run({}, { code: 'await Wait({})', tools, invoke, signal: controller.signal }));
  assert.match(out.error ?? '', /aborted/);
  assert.ok(Date.now() - started < 500, 'settles within 500 ms');
  mode.dispose();
});

test('F1b a guest loop still times out while a hold is active', async () => {
  const mode = newMode({ timeoutMs: 300, maxTimeoutMs: 300 });
  const slowTools = [
    { name: 'Slow', description: 'holds the deadline', inputSchema: {} },
    { name: 'Quick', description: 'returns at once', inputSchema: {} },
  ];
  const invoke = async (name: string, _args: unknown, _signal: AbortSignal, control?: Control): Promise<unknown> => {
    if (name === 'Quick') return 'quick';
    const release = control?.holdDeadline() ?? (() => undefined);
    try {
      await sleep(4_000);
    } finally {
      release();
    }
    return 'slow';
  };
  const started = Date.now();
  // Guest code runs synchronously on the host thread, so a hold must not switch off its time limit.
  const code = 'const p = Slow({}); await Quick({}); while (true) {}';
  const out = parseEnvelope(await mode.run({}, { code, tools: slowTools, invoke, signal: new AbortController().signal }));
  assert.match(out.error ?? '', /timed out/);
  assert.ok(Date.now() - started < 3_000, 'ends at the guest time limit, not when the hold is released');
  mode.dispose();
});
