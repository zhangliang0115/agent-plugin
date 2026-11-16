import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { CodeModeExecutor } from '../src/executor.ts';
import { apply } from '../src/index.ts';
import { fakeAgent, fakeContext } from './fake-context.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
interface Span { name: string; start: number; end: number }

/** A tool that takes 100 ms and records its span. It declares no concurrency safety. */
function timedTool(spans: Span[], name: string, safe?: boolean): ToolDefinition {
  return defineTool({
    name,
    description: `Tool ${name}.`,
    parameters: {},
    ...(safe === undefined ? {} : { isConcurrencySafe: () => safe }),
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      const span: Span = { name, start: Date.now(), end: 0 };
      spans.push(span);
      await sleep(100);
      span.end = Date.now();
      return `${name} done`;
    },
  });
}

/** A tool that runs `onRun` when called, so a test can edit the allowlist while a program is running. */
function editingTool(name: string, onRun: () => void): ToolDefinition {
  return defineTool({
    name,
    description: `Tool ${name}.`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute() {
      onRun();
      return Promise.resolve(`${name} done`);
    },
  });
}

function runCodeCall(code: string) {
  return { type: 'tool-call' as const, id: ToolCallId('root-1'), name: 'run_code', arguments: JSON.stringify({ code }) };
}

/** True when every span overlaps every other span. */
function allOverlap(spans: readonly Span[]): boolean {
  return spans.every((a) => spans.every((b) => a === b || (a.start < b.end && b.start < a.end)));
}

async function runOnce(executor: CodeModeExecutor, code: string): Promise<void> {
  await executor.execute({ calls: [runCodeCall(code)], signal: new AbortController().signal, agent: fakeAgent([]) as never });
}

test('an allowlist edited between two runs applies to the next run', async () => {
  const spans: Span[] = [];
  const fake = fakeContext({ tools: [timedTool(spans, 'McpRead')] });
  let allowed: readonly string[] = [];
  const executor = new CodeModeExecutor(fake.ctx, { concurrentTools: () => allowed });
  await runOnce(executor, 'await Promise.all([McpRead({}), McpRead({})])');
  assert.equal(spans.length, 2);
  assert.ok(!allOverlap(spans), 'before the edit the calls must run serially');

  spans.length = 0;
  allowed = ['McpRead'];
  await runOnce(executor, 'await Promise.all([McpRead({}), McpRead({})])');
  assert.equal(spans.length, 2);
  assert.ok(allOverlap(spans), 'after the edit the next run must overlap the calls');
});

test('an allowlist edited during a run applies to the sub-calls that start after the edit', async () => {
  const spans: Span[] = [];
  const tools = [timedTool(spans, 'McpRead'), editingTool('Allow', () => { allowed = ['McpRead']; })];
  const fake = fakeContext({ tools });
  let allowed: readonly string[] = [];
  const executor = new CodeModeExecutor(fake.ctx, { concurrentTools: () => allowed });
  await runOnce(executor, 'await Allow({}); await Promise.all([McpRead({}), McpRead({})])');
  assert.equal(spans.length, 2);
  assert.ok(allOverlap(spans), 'the sub-calls started after the edit must use the new list');
});

test('a classifier service that reports a tool as parallel is honored', async () => {
  const spans: Span[] = [];
  const tools = [timedTool(spans, 'mcp__fs__read'), timedTool(spans, 'McpWrite')];
  const services = { mcpParallel: { isParallel: (name: string) => name === 'mcp__fs__read' } };
  const fake = fakeContext({ tools, services });
  const executor = new CodeModeExecutor(fake.ctx, { concurrentTools: () => [] });
  await runOnce(executor, 'await Promise.all([mcp__fs__read({}), mcp__fs__read({})])');
  assert.equal(spans.length, 2);
  assert.ok(allOverlap(spans), 'the classifier said parallel, so the calls overlap');

  spans.length = 0;
  await runOnce(executor, 'await Promise.all([McpWrite({}), McpWrite({})])');
  assert.equal(spans.length, 2);
  assert.ok(!allOverlap(spans), 'a tool the classifier does not name stays serial');
});

test('a classifier answer cannot override a tool that declares itself unsafe', async () => {
  const spans: Span[] = [];
  const fake = fakeContext({
    tools: [timedTool(spans, 'Write', false)],
    services: { mcpParallel: { isParallel: () => true } },
  });
  const executor = new CodeModeExecutor(fake.ctx, { concurrentTools: () => [] });
  await runOnce(executor, 'await Promise.all([Write({}), Write({})])');
  assert.equal(spans.length, 2);
  assert.ok(!allOverlap(spans), 'an explicit isConcurrencySafe:false wins over the classifier');
});

test('an absent classifier service leaves the static allowlist in effect', async () => {
  const spans: Span[] = [];
  const fake = fakeContext({ tools: [timedTool(spans, 'McpRead'), timedTool(spans, 'McpWrite')] });
  const executor = new CodeModeExecutor(fake.ctx, { concurrentTools: () => ['McpRead'] });
  await runOnce(executor, 'await Promise.all([McpRead({}), McpRead({})])');
  assert.ok(allOverlap(spans), 'the static list still applies');

  spans.length = 0;
  await runOnce(executor, 'await Promise.all([McpWrite({}), McpWrite({})])');
  assert.ok(!allOverlap(spans), 'with no classifier, an unlisted tool stays serial');
});

test('apply reads the volatile concurrentTools reference on every classification', async () => {
  const spans: Span[] = [];
  const fake = fakeContext({ tools: [timedTool(spans, 'McpRead')] });
  let allowed: readonly string[] = [];
  apply(fake.ctx as never, { concurrentTools: { get: () => allowed } as never });
  const executor = fake.executors[0];
  assert.ok(executor !== undefined);
  await executor.execute({ calls: [runCodeCall('await Promise.all([McpRead({}), McpRead({})])')], signal: new AbortController().signal });
  assert.ok(!allOverlap(spans), 'the empty snapshot keeps the calls serial');

  spans.length = 0;
  allowed = ['McpRead'];
  await executor.execute({ calls: [runCodeCall('await Promise.all([McpRead({}), McpRead({})])')], signal: new AbortController().signal });
  assert.ok(allOverlap(spans), 'the edited reference applies to the next run');
});
