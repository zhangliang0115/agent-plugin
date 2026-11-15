import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { CodeMode } from '@zhangliang0115/code-mode-core';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeAgent, fakeContext, readTool } from './fake-context.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function runCodeCall(code: string, id = 'root-1') {
  return { type: 'tool-call' as const, id: ToolCallId(id), name: 'run_code', arguments: JSON.stringify({ code }) };
}

function valueOf(batch: Awaited<ReturnType<CodeModeExecutor['execute']>>): string {
  const [outcome] = batch.results;
  assert.ok(outcome !== undefined);
  return (outcome.result as { value: string }).value;
}

/** A tool declared parallel-safe, so scheduling never serializes it against its siblings. */
function parallelTool(trace: string[], name: string, body?: () => Promise<string>): ToolDefinition {
  return defineTool({
    name,
    description: `Tool ${name}.`,
    parameters: {},
    isConcurrencySafe: () => true,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      trace.push(`body:${name}`);
      return body === undefined ? `${name} done` : body();
    },
  });
}

/** An approval service whose answers the test releases by hand. */
function manualApproval() {
  const pending: Array<{ toolName: string; callId: string; release(outcome: string): void }> = [];
  return {
    pending,
    service: {
      request(request: { toolName: string; callId: string }): Promise<string> {
        return new Promise((resolve) => {
          pending.push({ toolName: request.toolName, callId: String(request.callId), release: resolve });
        });
      },
    },
  };
}

async function until(condition: () => boolean, ms = 500): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(10);
  }
  return condition();
}

test('F1a an approval pending in one agent does not block run_code in another agent', async () => {
  const approval = manualApproval();
  const fake = fakeContext({ services: { approval: approval.service } });
  const agentA = fakeAgent(fake.trace, 'session-a');
  const agentB = fakeAgent(fake.trace, 'session-b');
  fake.addHook('tools/pre-execute', (payload, next) => {
    if (payload.name === 'Read' && payload.agent === agentA) return { kind: 'ask' };
    return next();
  });
  const executor = new CodeModeExecutor(fake.ctx);
  const signal = new AbortController().signal;
  const runA = executor.execute({ calls: [runCodeCall('await Read({ path: "a" })', 'a-1')], signal, agent: agentA as never });
  assert.ok(await until(() => approval.pending.length === 1), 'agent A is waiting for approval');
  const runB = executor.execute({ calls: [runCodeCall('await Read({ path: "b" })', 'b-1')], signal, agent: agentB as never });
  try {
    const settledB = await Promise.race([runB.then((batch) => valueOf(batch)), sleep(500).then(() => undefined)]);
    assert.match(settledB ?? 'run B still blocked behind agent A\'s approval', /content of b/);
  } finally {
    approval.pending[0]?.release('allowed-once');
  }
  assert.match(valueOf(await runA), /content of a/);
  await runB;
});

test('F1a a parallel-safe call is not blocked by a sibling waiting for approval', async () => {
  const approval = manualApproval();
  const trace: string[] = [];
  const fake = fakeContext({ tools: [parallelTool(trace, 'Slow'), parallelTool(trace, 'Quick')], services: { approval: approval.service } });
  const agent = fakeAgent(fake.trace);
  fake.addHook('tools/pre-execute', (payload, next) => {
    if (payload.name === 'Slow') return { kind: 'ask' };
    return next();
  });
  const executor = new CodeModeExecutor(fake.ctx);
  const run = executor.execute({
    calls: [runCodeCall('await Promise.all([Slow({}), Quick({})])')],
    signal: new AbortController().signal,
    agent: agent as never,
  });
  assert.ok(await until(() => approval.pending.length === 1), 'Slow is waiting for approval');
  try {
    assert.ok(await until(() => trace.includes('body:Quick')), 'Quick ran while Slow waits for approval');
  } finally {
    approval.pending[0]?.release('allowed-once');
  }
  assert.match(valueOf(await run), /Slow done/);
});

test('F1b approval wait does not consume the run deadline', async () => {
  const fake = fakeContext({
    services: { approval: { request: async () => { await sleep(700); return 'allowed-once'; } } },
  });
  const agent = fakeAgent(fake.trace);
  fake.addHook('tools/pre-execute', (payload, next) => (payload.name === 'Read' ? { kind: 'ask' } : next()));
  const executor = new CodeModeExecutor(fake.ctx, { mode: new CodeMode({ timeoutMs: 300, maxTimeoutMs: 300 }) });
  const batch = await executor.execute({ calls: [runCodeCall('await Read({ path: "slow" })')], signal: new AbortController().signal, agent: agent as never });
  const value = valueOf(batch);
  assert.doesNotMatch(value, /timed out/);
  assert.match(value, /content of slow/);
  executor.dispose();
});

test('F1b a tool listed in userWaitTools does not consume the run deadline', async () => {
  const sleeper = (name: string): ToolDefinition => defineTool({
    name,
    description: `Waits for the user as ${name}.`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      await sleep(700);
      return 'answered';
    },
  });
  const fake = fakeContext({ tools: [sleeper('ask_user_question'), sleeper('slow_other'), readTool([])] });
  const executor = new CodeModeExecutor(fake.ctx, { mode: new CodeMode({ timeoutMs: 300, maxTimeoutMs: 300 }) });
  const signal = new AbortController().signal;
  const listed = valueOf(await executor.execute({ calls: [runCodeCall('await ask_user_question({})')], signal }));
  assert.doesNotMatch(listed, /timed out/);
  assert.match(listed, /answered/);
  const control = valueOf(await executor.execute({ calls: [runCodeCall('await slow_other({})')], signal }));
  assert.match(control, /timed out/);
  executor.dispose();
});
