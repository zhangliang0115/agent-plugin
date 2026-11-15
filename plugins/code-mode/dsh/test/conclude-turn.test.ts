import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeAgent, fakeContext, readTool } from './fake-context.ts';

function runCodeCall(code: string) {
  return { type: 'tool-call' as const, id: ToolCallId('root-1'), name: 'run_code', arguments: JSON.stringify({ code }) };
}
function finishTool(fail: boolean): ToolDefinition {
  return defineTool({
    name: 'finish',
    description: 'Ends the turn.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false }, render: () => [{ type: 'text', text: 'finished' }] },
    async execute(_args, exec) {
      exec.concludeTurn();
      if (fail) throw new Error('finish failed');
      return {};
    },
  });
}
async function run(code: string, fail = false) {
  const fake = fakeContext({ tools: [finishTool(fail), readTool([])] });
  const executor = new CodeModeExecutor(fake.ctx);
  return executor.execute({ calls: [runCodeCall(code)], signal: new AbortController().signal, agent: fakeAgent(fake.trace) as never });
}

test('F4 a sub-call that concludes the turn concludes the batch', async () => {
  const batch = await run('await finish({})');
  assert.equal(batch.concluded, true);
});

test('F4 a program without such a call does not conclude the turn', async () => {
  const batch = await run('await Read({ path: "a" })');
  assert.equal(batch.concluded, false);
});

test('F4 a sub-call failure after concludeTurn does not conclude', async () => {
  const batch = await run('let r; try { await finish({}) } catch (e) { r = "caught" } r', true);
  assert.equal(batch.concluded, false);
});
