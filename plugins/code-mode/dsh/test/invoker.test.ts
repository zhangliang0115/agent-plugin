import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeContext, readTool } from './fake-context.ts';

function runCodeCall(code: string, id = 'root-1') {
  return { type: 'tool-call' as const, id: ToolCallId(id), name: 'run_code', arguments: JSON.stringify({ code }) };
}

function envelopeOf(batch: Awaited<ReturnType<CodeModeExecutor['execute']>>): string {
  const [outcome] = batch.results;
  assert.ok(outcome !== undefined);
  assert.equal(outcome.result.isError, false, JSON.stringify(outcome.result));
  return (outcome.result as { value: string }).value;
}

test('each in-code tool call runs pre-execute, guard, execute, then post-execute, in that order', async () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const batch = await executor.execute({
    calls: [runCodeCall('const t = await Read({ path: "a.txt" }); t')],
    signal: new AbortController().signal,
  });
  const envelope = envelopeOf(batch);
  assert.match(envelope, /content of a\.txt/);
  const readStages = fake.trace.filter((entry) => entry.endsWith(':Read') || entry === 'body:Read');
  assert.deepEqual(readStages, [
    'tools/pre-execute:Read',
    'guard:Read',
    'tools/execute:Read',
    'body:Read',
    'tools/post-execute:Read',
  ]);
});

test('an in-code call carries the run_code call as its parent', async () => {
  const fake = fakeContext();
  const seen: Array<{ name: string; parent: symbol | undefined; token: symbol }> = [];
  fake.addHook('tools/pre-execute', (payload, next) => {
    seen.push({ name: payload.name, parent: payload.parent, token: payload.token });
    return next();
  });
  const executor = new CodeModeExecutor(fake.ctx);
  await executor.execute({ calls: [runCodeCall('await Read({ path: "b" })')], signal: new AbortController().signal });
  const root = seen.find((entry) => entry.name === 'run_code');
  const child = seen.find((entry) => entry.name === 'Read');
  assert.ok(root !== undefined && child !== undefined);
  assert.equal(root.parent, undefined, 'the model-direct call has no parent');
  assert.equal(child.parent, root.token, 'the sub-call parent is the run_code token');
});

test('a pre-execute denial reaches the program as a catchable error and the tool body does not run', async () => {
  const fake = fakeContext();
  fake.addHook('tools/pre-execute', (payload, next) => {
    if (payload.name === 'Read') return { kind: 'deny', reason: 'blocked by policy' };
    return next();
  });
  const executor = new CodeModeExecutor(fake.ctx);
  const code = 'let out; try { await Read({ path: "x" }); out = "no"; } catch (e) { out = "denied: " + e.message; } out';
  const batch = await executor.execute({ calls: [runCodeCall(code)], signal: new AbortController().signal });
  assert.match(envelopeOf(batch), /denied: blocked by policy/);
  assert.ok(!fake.trace.includes('body:Read'));
});

test('a guard denial is also surfaced inside the program and stops the body', async () => {
  const fake = fakeContext({ guardDenial: (name) => (name === 'Read' ? { reason: 'guard says no' } : undefined) });
  const executor = new CodeModeExecutor(fake.ctx);
  const code = 'let out; try { await Read({ path: "x" }); out = "no"; } catch (e) { out = "guarded: " + e.message; } out';
  const batch = await executor.execute({ calls: [runCodeCall(code)], signal: new AbortController().signal });
  assert.match(envelopeOf(batch), /guarded: guard says no/);
  assert.ok(!fake.trace.includes('body:Read'));
});

test('run_code cannot be called from inside a program', async () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const code = 'let out; try { await run_code({ code: "1" }); out = "ran"; } catch (e) { out = "refused"; } out';
  const batch = await executor.execute({ calls: [runCodeCall(code)], signal: new AbortController().signal });
  assert.match(envelopeOf(batch), /refused/);
});
