import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeAgent, fakeContext } from './fake-context.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
interface Span { name: string; start: number; end: number }

/** A tool whose body takes 100 ms and records when it ran. Exclusive unless `safe` is true. */
function timedTool(spans: Span[], name: string, safe: boolean): ToolDefinition {
  return defineTool({
    name,
    description: `Tool ${name}.`,
    parameters: {},
    ...(safe ? { isConcurrencySafe: () => true } : {}),
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
function runCodeCall(code: string, id = 'root-1') {
  return { type: 'tool-call' as const, id: ToolCallId(id), name: 'run_code', arguments: JSON.stringify({ code }) };
}
function setup(tools: ToolDefinition[]) {
  const fake = fakeContext({ tools });
  return { fake, executor: new CodeModeExecutor(fake.ctx), agent: fakeAgent(fake.trace) };
}

test('F3 two exclusive calls in Promise.all run one after the other', async () => {
  const spans: Span[] = [];
  const { executor, agent } = setup([timedTool(spans, 'Bash', false)]);
  await executor.execute({ calls: [runCodeCall('await Promise.all([Bash({}), Bash({})])')], signal: new AbortController().signal, agent: agent as never });
  assert.equal(spans.length, 2);
  assert.ok(spans[1]!.start >= spans[0]!.end, `second started at ${spans[1]!.start}, first ended at ${spans[0]!.end}`);
});

test('F3 parallel-safe calls still overlap', async () => {
  const spans: Span[] = [];
  const { executor, agent } = setup([timedTool(spans, 'Read', true)]);
  await executor.execute({ calls: [runCodeCall('await Promise.all([Read({}), Read({})])')], signal: new AbortController().signal, agent: agent as never });
  assert.equal(spans.length, 2);
  assert.ok(spans[1]!.start < spans[0]!.end, 'second started before the first ended');
});

test('F3 an exclusive call is a barrier between parallel calls', async () => {
  const spans: Span[] = [];
  const { executor, agent } = setup([timedTool(spans, 'Par', true), timedTool(spans, 'Excl', false)]);
  await executor.execute({ calls: [runCodeCall('await Promise.all([Par({}), Par({}), Excl({}), Par({})])')], signal: new AbortController().signal, agent: agent as never });
  const pars = spans.filter((span) => span.name === 'Par');
  const excl = spans.find((span) => span.name === 'Excl')!;
  assert.equal(pars.length, 3);
  assert.ok(excl.start >= pars[0]!.end && excl.start >= pars[1]!.end, 'excl waits for the earlier parallel calls');
  assert.ok(pars[2]!.start >= excl.end, 'the last parallel call waits for excl');
});

test('F3 an exclusive call from another agent is not serialized with this run', async () => {
  const spans: Span[] = [];
  const { executor, agent } = setup([timedTool(spans, 'Bash', false)]);
  const other = fakeAgent([], 'session-2');
  const signal = new AbortController().signal;
  await Promise.all([
    executor.execute({ calls: [runCodeCall('await Bash({})', 'a-1')], signal, agent: agent as never }),
    executor.execute({ calls: [runCodeCall('await Bash({})', 'b-1')], signal, agent: other as never }),
  ]);
  assert.equal(spans.length, 2);
  assert.ok(spans[1]!.start < spans[0]!.end, 'the two runs overlapped');
});

test('F3 an aborted run releases queued calls', async () => {
  const spans: Span[] = [];
  const { executor, agent } = setup([timedTool(spans, 'Bash', false)]);
  const controller = new AbortController();
  const run = executor.execute({ calls: [runCodeCall('await Promise.all([Bash({}), Bash({}), Bash({})])')], signal: controller.signal, agent: agent as never });
  await sleep(30);
  controller.abort();
  await run;
  const abortedAt = Date.now();
  await sleep(250);
  assert.equal(spans.length, 1, 'queued calls never started');
  assert.ok(spans.every((span) => span.start <= abortedAt));
});
