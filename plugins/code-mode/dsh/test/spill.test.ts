import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeAgent, fakeContext } from './fake-context.ts';

const program = '"x".repeat(60000)';
function runCodeCall(code: string) {
  return { type: 'tool-call' as const, id: ToolCallId('root-1'), name: 'run_code', arguments: JSON.stringify({ code }) };
}
function valueOf(batch: Awaited<ReturnType<CodeModeExecutor['execute']>>): string {
  const [outcome] = batch.results;
  assert.ok(outcome !== undefined);
  return (outcome.result as { value: string }).value;
}
function spillStore(saved: unknown[], fail = false) {
  return {
    async saveText(input: unknown) {
      saved.push(input);
      if (fail) throw new Error('disk full');
      return { locator: '/spill/run_code.txt', bytes: 60_000, retrievalHint: 'Read it with the read tool.' };
    },
  };
}

test('F6 run_code spills an oversized result to the spill store and the model sees the locator and a preview', async () => {
  const saved: any[] = [];
  const fake = fakeContext({ services: { spillStore: spillStore(saved) } });
  const executor = new CodeModeExecutor(fake.ctx);
  const value = valueOf(await executor.execute({ calls: [runCodeCall(program)], signal: new AbortController().signal, agent: fakeAgent(fake.trace, 'session-9') as never }));
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].owner, { sessionId: 'session-9' });
  assert.deepEqual(saved[0].source, { kind: 'tool', toolName: 'run_code', callId: 'root-1', label: 'result' });
  assert.equal(saved[0].suggestedName, 'run_code.txt');
  assert.equal(saved[0].content, 'x'.repeat(60_000));
  assert.ok(value.includes('x'.repeat(10_000)), 'the preview is kept');
  assert.match(value, /Full result stored at: \/spill\/run_code\.txt\. Read it with the read tool\./);
});

test('F6 without a spill store the result keeps the plain truncation marker', async () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const value = valueOf(await executor.execute({ calls: [runCodeCall(program)], signal: new AbortController().signal, agent: fakeAgent(fake.trace) as never }));
  assert.match(value, /\[truncated: 50000 more characters\]/);
});

test('F6 a failing spill store falls back to the marker and warns', async () => {
  const warnings: string[] = [];
  const saved: unknown[] = [];
  const fake = fakeContext({ warnings, services: { spillStore: spillStore(saved, true) } });
  const executor = new CodeModeExecutor(fake.ctx);
  const value = valueOf(await executor.execute({ calls: [runCodeCall(program)], signal: new AbortController().signal, agent: fakeAgent(fake.trace) as never }));
  assert.match(value, /\[truncated: 50000 more characters\]/);
  assert.equal(saved.length, 1);
  assert.ok(warnings.length > 0);
});

test('F6 without an agent nothing is spilled', async () => {
  const saved: unknown[] = [];
  const fake = fakeContext({ services: { spillStore: spillStore(saved) } });
  const executor = new CodeModeExecutor(fake.ctx);
  const value = valueOf(await executor.execute({ calls: [runCodeCall(program)], signal: new AbortController().signal }));
  assert.equal(saved.length, 0);
  assert.match(value, /\[truncated: 50000 more characters\]/);
});
