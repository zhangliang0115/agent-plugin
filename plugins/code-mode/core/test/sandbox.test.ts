import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMode, parseEnvelope } from './helpers.ts';

const tools = [{ name: 'Read', description: 'read', inputSchema: {} }, { name: 'Write', description: 'write', inputSchema: {} }];

function invokeEcho(): (name: string, args: unknown) => Promise<unknown> {
  return async (name, args) => ({ name, args });
}

test('declarations and values persist across runs for one owner', async () => {
  const mode = newMode();
  const owner = {};
  await mode.run(owner, { code: 'const base = 40;', tools: [], invoke: invokeEcho(), signal: new AbortController().signal });
  const out = await mode.run(owner, { code: 'base + 2', tools: [], invoke: invokeEcho(), signal: new AbortController().signal });
  assert.equal(parseEnvelope(out).result, '42');
  mode.dispose();
});

test('owners are isolated from each other', async () => {
  const mode = newMode();
  await mode.run({}, { code: 'globalThis.secret = 1;', tools: [], invoke: invokeEcho(), signal: new AbortController().signal });
  const out = await mode.run({}, { code: 'typeof secret', tools: [], invoke: invokeEcho(), signal: new AbortController().signal });
  assert.equal(parseEnvelope(out).result, 'undefined');
  mode.dispose();
});

test('release clears an owner context', async () => {
  const mode = newMode();
  const owner = {};
  await mode.run(owner, { code: 'const kept = 7;', tools: [], invoke: invokeEcho(), signal: new AbortController().signal });
  mode.release(owner);
  const out = await mode.run(owner, { code: 'typeof kept', tools: [], invoke: invokeEcho(), signal: new AbortController().signal });
  assert.equal(parseEnvelope(out).result, 'undefined');
  mode.dispose();
});

test('process, require and import are unavailable with a Code Mode message', async () => {
  const mode = newMode();
  const signal = new AbortController().signal;
  const proc = parseEnvelope(await mode.run({}, { code: 'process.env.HOME', tools: [], invoke: invokeEcho(), signal }));
  assert.match(proc.error ?? '', /process is not available in Code Mode; use the listed tools/);
  const req = parseEnvelope(await mode.run({}, { code: 'require("fs")', tools: [], invoke: invokeEcho(), signal }));
  assert.match(req.error ?? '', /require is not available in Code Mode; use the listed tools/);
  const dyn = parseEnvelope(await mode.run({}, { code: 'await import("fs")', tools: [], invoke: invokeEcho(), signal }));
  assert.match(dyn.error ?? '', /import is not available in Code Mode; use the listed tools/);
  mode.dispose();
});

test('a run that never settles times out and reports it in <error>', async () => {
  const mode = newMode({ timeoutMs: 200 });
  const started = Date.now();
  const out = parseEnvelope(await mode.run({}, { code: 'while (true) {}', tools: [], invoke: invokeEcho(), signal: new AbortController().signal, timeoutMs: 200 }));
  assert.match(out.error ?? '', /timed out after 200 ms/);
  assert.ok(Date.now() - started < 5000, 'returns without hanging');
  mode.dispose();
});

test('a pending tool call that never settles ends at the deadline', async () => {
  const mode = newMode();
  const hang = () => new Promise<never>(() => {});
  const started = Date.now();
  const out = parseEnvelope(await mode.run({}, { code: 'await Read({})', tools, invoke: async () => hang(), signal: new AbortController().signal, timeoutMs: 150 }));
  assert.match(out.error ?? '', /timed out/);
  assert.ok(Date.now() - started < 5000);
  mode.dispose();
});

test('aborting the caller signal interrupts running sub-calls and the run', async () => {
  const mode = newMode();
  const controller = new AbortController();
  let subSignal: AbortSignal | undefined;
  const invoke = async (_name: string, _args: unknown, signal: AbortSignal) => {
    subSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
  };
  setTimeout(() => controller.abort(), 50);
  const out = parseEnvelope(await mode.run({}, { code: 'await Read({})', tools, invoke, signal: controller.signal }));
  assert.match(out.error ?? '', /aborted/);
  assert.equal(subSignal?.aborted, true);
  mode.dispose();
});

test('runs for one owner execute one at a time in arrival order', async () => {
  const mode = newMode();
  const owner = {};
  const log: string[] = [];
  const invoke = async (name: string, args: unknown) => {
    log.push(`start ${String((args as { id: string }).id)}`);
    await new Promise((r) => setTimeout(r, 30));
    log.push(`end ${String((args as { id: string }).id)}`);
    return name;
  };
  const first = mode.run(owner, { code: 'await Read({ id: "a" })', tools, invoke, signal: new AbortController().signal });
  const second = mode.run(owner, { code: 'await Read({ id: "b" })', tools, invoke, signal: new AbortController().signal });
  await Promise.all([first, second]);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b']);
  mode.dispose();
});

test('Promise.all runs sub-calls in parallel up to the limit and keeps result order', async () => {
  const mode = newMode({ maxParallelSubCalls: 2 });
  let active = 0;
  let peak = 0;
  const invoke = async (_name: string, args: unknown) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return (args as { n: number }).n * 10;
  };
  const code = 'const xs = await Promise.all([1,2,3,4].map((n) => Read({ n }))); xs';
  const out = parseEnvelope(await mode.run({}, { code, tools, invoke, signal: new AbortController().signal }));
  assert.equal(out.result, '[\n  10,\n  20,\n  30,\n  40\n]');
  assert.equal(peak, 2);
  mode.dispose();
});

test('exceeding maxSubCallsPerRun rejects the extra call inside the program', async () => {
  const mode = newMode({ maxSubCallsPerRun: 2 });
  const code = 'const out = []; for (let i = 0; i < 3; i++) { try { out.push(await Read({ i })); } catch (e) { out.push("limit:" + e.message); } } out';
  const out = parseEnvelope(await mode.run({}, { code, tools, invoke: invokeEcho(), signal: new AbortController().signal }));
  assert.match(out.result ?? '', /limit: ?sub-call limit/i);
  mode.dispose();
});

test('a tool rejection is catchable inside the program', async () => {
  const mode = newMode();
  const invoke = async () => { throw new Error('disk full'); };
  const code = 'let out; try { await Write({}); out = "no"; } catch (e) { out = "caught " + e.message; } out';
  const out = parseEnvelope(await mode.run({}, { code, tools, invoke, signal: new AbortController().signal }));
  assert.equal(out.result, 'caught disk full');
  mode.dispose();
});

test('the memory limit stops a runaway allocation', async () => {
  const mode = newMode({ memoryBytes: 4 * 1024 * 1024 });
  const out = parseEnvelope(await mode.run({}, { code: 'const xs = []; for (let i = 0; i < 1e7; i++) xs.push("x" + i); xs.length', tools: [], invoke: invokeEcho(), signal: new AbortController().signal }));
  assert.ok(out.error !== undefined, 'memory failure is reported');
  mode.dispose();
});
