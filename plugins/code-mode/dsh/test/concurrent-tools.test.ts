import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { CodeModeExecutor } from '../src/executor.ts';
import { allowsConcurrency } from '../src/config.ts';
import { fakeAgent, fakeContext } from './fake-context.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
interface Span { name: string; start: number; end: number }

/** A tool that takes 100 ms, records its span, and declares concurrency safety only when asked. */
function timedTool(spans: Span[], name: string, safe?: boolean): ToolDefinition {
  const body = async (): Promise<string> => {
    const span: Span = { name, start: Date.now(), end: 0 };
    spans.push(span);
    await sleep(100);
    span.end = Date.now();
    return `${name} done`;
  };
  return defineTool({
    name,
    description: `Tool ${name}.`,
    parameters: {},
    ...(safe === undefined ? {} : { isConcurrencySafe: () => safe }),
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: body,
  });
}

function runCodeCall(code: string) {
  return { type: 'tool-call' as const, id: ToolCallId('root-1'), name: 'run_code', arguments: JSON.stringify({ code }) };
}

function setup(tools: ToolDefinition[], concurrentTools: readonly string[]) {
  const fake = fakeContext({ tools });
  return { fake, executor: new CodeModeExecutor(fake.ctx, { concurrentTools: () => concurrentTools }), agent: fakeAgent(fake.trace) };
}

async function run(executor: CodeModeExecutor, agent: unknown, code: string): Promise<void> {
  await executor.execute({ calls: [runCodeCall(code)], signal: new AbortController().signal, agent: agent as never });
}

/** True when every span overlaps every other span (started before the other ended). */
function allOverlap(spans: readonly Span[]): boolean {
  return spans.every((a) => spans.every((b) => a === b || (a.start < b.end && b.start < a.end)));
}

test('allowsConcurrency matches exact names and trailing-wildcard prefixes only', () => {
  assert.equal(allowsConcurrency('jev_classify', ['jev_classify']), true);
  assert.equal(allowsConcurrency('jev_classify', ['jev_']), false, 'a prefix without * is a literal name');
  assert.equal(allowsConcurrency('mcp__jev__jev_classify', ['mcp__jev__*']), true);
  assert.equal(allowsConcurrency('mcp__other__x', ['mcp__jev__*']), false);
  assert.equal(allowsConcurrency('jev_classify', []), false);
});

test('a listed tool without its own declaration overlaps', async () => {
  const spans: Span[] = [];
  const { executor, agent } = setup([timedTool(spans, 'McpRead')], ['McpRead']);
  await run(executor, agent, 'await Promise.all([McpRead({}), McpRead({})])');
  assert.equal(spans.length, 2);
  assert.ok(allOverlap(spans), 'both calls should be in flight at once');
});

test('an unlisted tool without a declaration stays serial', async () => {
  const spans: Span[] = [];
  const { executor, agent } = setup([timedTool(spans, 'McpWrite')], ['McpRead']);
  await run(executor, agent, 'await Promise.all([McpWrite({}), McpWrite({})])');
  assert.equal(spans.length, 2);
  assert.ok(!allOverlap(spans), 'the calls must not overlap');
});

test('the allowlist cannot make a tool that declares itself unsafe concurrent', async () => {
  const spans: Span[] = [];
  const { executor, agent } = setup([timedTool(spans, 'Write', false)], ['Write']);
  await run(executor, agent, 'await Promise.all([Write({}), Write({})])');
  assert.equal(spans.length, 2);
  assert.ok(!allOverlap(spans), 'an explicit isConcurrencySafe:false wins over the allowlist');
});

test('a wildcard entry covers a whole MCP server namespace', async () => {
  const spans: Span[] = [];
  const tools = [timedTool(spans, 'mcp__jev__a'), timedTool(spans, 'mcp__jev__b')];
  const { executor, agent } = setup(tools, ['mcp__jev__*']);
  await run(executor, agent, 'await Promise.all([mcp__jev__a({}), mcp__jev__b({})])');
  assert.equal(spans.length, 2);
  assert.ok(allOverlap(spans), 'both namespace tools should overlap');
});

test('a listed tool is still exclusive against an unlisted one', async () => {
  const spans: Span[] = [];
  const tools = [timedTool(spans, 'McpRead'), timedTool(spans, 'Bash')];
  const { executor, agent } = setup(tools, ['McpRead']);
  await run(executor, agent, 'await Promise.all([McpRead({}), Bash({})])');
  assert.equal(spans.length, 2);
  assert.ok(!allOverlap(spans), 'the barrier around the exclusive call must hold');
});
