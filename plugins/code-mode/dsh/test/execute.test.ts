import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeContext } from './fake-context.ts';

function call(id: string, code: string) {
  return { type: 'tool-call' as const, id: ToolCallId(id), name: 'run_code', arguments: JSON.stringify({ code }) };
}

test('execute returns one outcome per call in input order, each carrying its envelope', async () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const batch = await executor.execute({
    calls: [call('a', '1 + 1'), call('b', 'self.log("second"); "two"')],
    signal: new AbortController().signal,
  });
  assert.deepEqual(batch.results.map((entry) => entry.callId), [ToolCallId('a'), ToolCallId('b')]);
  const [first, second] = batch.results.map((entry) => (entry.result as { value: string }).value);
  assert.match(first ?? '', /<result>2<\/result>/);
  assert.match(second ?? '', /<log>second<\/log><result>two<\/result>/);
  assert.equal(batch.concluded, false);
});

test('a program error is returned in the envelope, not as a failed tool call', async () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const batch = await executor.execute({ calls: [call('e', 'null.x')], signal: new AbortController().signal });
  const [outcome] = batch.results;
  assert.equal(outcome?.result.isError, false);
  assert.match((outcome?.result as { value: string }).value, /<error>TypeError/);
});
