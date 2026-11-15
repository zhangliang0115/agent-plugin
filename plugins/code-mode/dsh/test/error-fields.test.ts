import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { ToolNotFoundError, defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallError } from '@zhangliang0115/code-mode-core';
import { CodeModeExecutor } from '../src/executor.ts';
import { RunScheduler } from '../src/run-scheduler.ts';
import { fakeAgent, fakeContext, readTool } from './fake-context.ts';

function runCodeCall(code: string) {
  return { type: 'tool-call' as const, id: ToolCallId('root-1'), name: 'run_code', arguments: JSON.stringify({ code }) };
}
function valueOf(batch: Awaited<ReturnType<CodeModeExecutor['execute']>>): string {
  const [outcome] = batch.results;
  assert.ok(outcome !== undefined);
  return (outcome.result as { value: string }).value;
}
function unescape(text: string): string {
  return text.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
function resultOf(envelope: string): unknown {
  const match = /<result>([\s\S]*?)<\/result>/.exec(envelope);
  assert.ok(match !== null, envelope);
  return JSON.parse(unescape(match[1]!));
}

test('F5 a denied approval exposes APPROVAL_UNAVAILABLE and ApprovalError', async () => {
  const fake = fakeContext();
  fake.addHook('tools/pre-execute', (payload, next) => (payload.name === 'Read' ? { kind: 'ask' } : next()));
  const executor = new CodeModeExecutor(fake.ctx);
  const batch = await executor.execute({
    calls: [runCodeCall('let r; try { await Read({ path: "a" }) } catch (e) { r = [e.code, e.errorName, e.message] } r')],
    signal: new AbortController().signal,
    agent: fakeAgent(fake.trace) as never,
  });
  assert.deepEqual(resultOf(valueOf(batch)), ['APPROVAL_UNAVAILABLE', 'ApprovalError', 'tool "Read" requires approval (not yet supported)']);
});

test('F5 a tool body failure exposes the pipeline error identity', async () => {
  const failing = defineTool({
    name: 'Boom',
    description: 'Fails.',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '' }] },
    async execute() { throw new ToolNotFoundError('Missing'); },
  });
  const fake = fakeContext({ tools: [failing] });
  const executor = new CodeModeExecutor(fake.ctx);
  const batch = await executor.execute({
    calls: [runCodeCall('let r; try { await Boom({}) } catch (e) { r = [e.code ?? null, e.errorName ?? null] } r')],
    signal: new AbortController().signal,
    agent: fakeAgent(fake.trace) as never,
  });
  assert.deepEqual(resultOf(valueOf(batch)), ['UNKNOWN_TOOL', 'ToolNotFoundError']);
});

test('F5 a sub-call aborted before dispatch exposes ABORTED_BEFORE_DISPATCH', async () => {
  const scheduler = new RunScheduler();
  const controller = new AbortController();
  const first = await scheduler.acquire(() => 'exclusive', controller.signal);
  const queued = scheduler.acquire(() => 'exclusive', controller.signal);
  controller.abort();
  await assert.rejects(queued, (error: unknown) => {
    assert.ok(error instanceof ToolCallError);
    assert.equal(error.code, 'ABORTED_BEFORE_DISPATCH');
    assert.equal(error.errorName, 'AbortError');
    return true;
  });
  first();
});
