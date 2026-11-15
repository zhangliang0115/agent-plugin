/** Regression tests for issues found in review. @module */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { CodeMode } from '@agent-plugin/code-mode-core';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeAgent, fakeContext, readTool } from './fake-context.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function call(code: string, id = 'root-1') {
  return { type: 'tool-call' as const, id: ToolCallId(id), name: 'run_code', arguments: JSON.stringify({ code }) };
}

function valueOf(batch: Awaited<ReturnType<CodeModeExecutor['execute']>>): string {
  const [outcome] = batch.results;
  assert.ok(outcome !== undefined);
  return (outcome.result as { value: string }).value;
}

function fastMode(limits: { timeoutMs: number }): CodeMode {
  return new CodeMode({ timeoutMs: limits.timeoutMs, maxTimeoutMs: limits.timeoutMs });
}

function namedTool(trace: string[], name: string, body: () => Promise<string>): ToolDefinition {
  return defineTool({
    name,
    description: `${name}.`,
    parameters: {},
    isConcurrencySafe: () => true,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      trace.push(`body:${name}`);
      return body();
    },
  });
}

test('a pre-execute hook that never resolves still ends at the deadline', async () => {
  const fake = fakeContext();
  // Only the sub-call hangs; hanging `run_code` itself would test the host's scheduler, not this executor.
  fake.addHook('tools/pre-execute', (payload, next) => (payload.name === 'Read' ? new Promise(() => {}) : next()));
  const executor = new CodeModeExecutor(fake.ctx, { mode: fastMode({ timeoutMs: 300 }) });
  const started = Date.now();
  const batch = await executor.execute({ calls: [call('await Read({ path: "x" })')], signal: new AbortController().signal });
  assert.match(valueOf(batch), /timed out/);
  assert.ok(Date.now() - started < 6_000, 'the run reports instead of hanging');
  executor.dispose();
});

test('a dispatch-log listener that never resolves does not hold run_code open', async () => {
  const fake = fakeContext();
  const agent = fakeAgent(fake.trace);
  fake.addHook('tools/ptc-dispatch-log', () => new Promise(() => {}));
  const executor = new CodeModeExecutor(fake.ctx);
  const started = Date.now();
  const batch = await executor.execute({ calls: [call('await Read({ path: "a" })')], signal: new AbortController().signal, agent: agent as never });
  assert.match(valueOf(batch), /content of a/);
  assert.ok(Date.now() - started < 6_000, 'the run reports instead of hanging');
  executor.dispose();
});

test('a tool that outlives the deadline does not run post-execute afterwards', async () => {
  const trace: string[] = [];
  const slow = namedTool(trace, 'Slow', async () => {
    await sleep(500);
    return 'late';
  });
  const fake = fakeContext({ tools: [slow] });
  const agent = fakeAgent(fake.trace);
  const executor = new CodeModeExecutor(fake.ctx, { mode: fastMode({ timeoutMs: 100 }) });
  const batch = await executor.execute({ calls: [call('await Slow({})')], signal: new AbortController().signal, agent: agent as never });
  assert.match(valueOf(batch), /timed out/);
  await sleep(700);
  assert.ok(!fake.trace.includes('tools/post-execute:Slow'), 'post-execute is skipped for the abandoned call');
  assert.ok(!agent.session.appended.some((event) => event.type === 'tool/ptc-dispatch'), 'no settle event after the result');
  executor.dispose();
});

test('an image returned by a tool reaches the model as deferred context', async () => {
  const image = { type: 'image', attachment: { id: 'a1' } };
  const shot = defineTool({
    name: 'Shot',
    description: 'Take a screenshot.',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [image as never] },
    async execute() {
      return 'shot';
    },
  });
  const fake = fakeContext({ tools: [shot] });
  const agent = fakeAgent(fake.trace);
  const executor = new CodeModeExecutor(fake.ctx);
  const batch = await executor.execute({ calls: [call('await Shot({})')], signal: new AbortController().signal, agent: agent as never });
  const deferred = batch.additionalContexts.flatMap((message) => [...message.content] as ReadonlyArray<{ type: string }>);
  assert.ok(deferred.some((block) => block.type === 'image'), 'the image block is deferred');
  executor.dispose();
});

test('settle events follow submission order even when the second body finishes first', async () => {
  const trace: string[] = [];
  const slow = namedTool(trace, 'Slow', async () => {
    await sleep(200);
    return 'slow';
  });
  const quick = namedTool(trace, 'Quick', async () => 'quick');
  const fake = fakeContext({ tools: [slow, quick, readTool(trace)] });
  const agent = fakeAgent(fake.trace);
  const executor = new CodeModeExecutor(fake.ctx);
  await executor.execute({
    calls: [call('await Promise.all([Slow({}), Quick({})])')],
    signal: new AbortController().signal,
    agent: agent as never,
  });
  const post = fake.trace.filter((entry) => entry === 'tools/post-execute:Slow' || entry === 'tools/post-execute:Quick');
  assert.deepEqual(post, ['tools/post-execute:Slow', 'tools/post-execute:Quick']);
  const settled = agent.session.appended.filter((event) => event.type === 'tool/ptc-dispatch').map((event) => event.data.name);
  assert.deepEqual(settled, ['Slow', 'Quick']);
  executor.dispose();
});

test('dispose aborts a running program and its tool bodies', async () => {
  let aborted = false;
  const waiter = defineTool({
    name: 'Wait',
    description: 'Wait for cancellation.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await new Promise<void>((resolve) => {
        exec.signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
      return 'stopped';
    },
  });
  const fake = fakeContext({ tools: [waiter] });
  const executor = new CodeModeExecutor(fake.ctx);
  const running = executor.execute({ calls: [call('await Wait({})')], signal: new AbortController().signal });
  await sleep(100);
  executor.dispose();
  const batch = await running;
  assert.equal(aborted, true, 'the tool body saw the abort');
  assert.match(valueOf(batch), /aborted/);
});
