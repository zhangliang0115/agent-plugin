import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeAgent, fakeContext } from './fake-context.ts';

function runCodeCall(code: string, id = 'root-1') {
  return { type: 'tool-call' as const, id: ToolCallId(id), name: 'run_code', arguments: JSON.stringify({ code }) };
}

function valueOf(batch: Awaited<ReturnType<CodeModeExecutor['execute']>>): string {
  const [outcome] = batch.results;
  assert.ok(outcome !== undefined);
  assert.equal(outcome.result.isError, false, JSON.stringify(outcome.result));
  return (outcome.result as { value: string }).value;
}

test('F2 a sub-call writes tool/ptc-dispatch-start then tool/ptc-dispatch around the pipeline stages', async () => {
  const fake = fakeContext();
  const agent = fakeAgent(fake.trace);
  const executor = new CodeModeExecutor(fake.ctx);
  await executor.execute({ calls: [runCodeCall('await Read({ path: "a.txt" })', 'root-1')], signal: new AbortController().signal, agent: agent as never });
  const stages = fake.trace.filter((entry) => entry.endsWith(':Read'));
  assert.deepEqual(stages, [
    'session:tool/ptc-dispatch-start:Read',
    'tools/pre-execute:Read',
    'guard:Read',
    'tools/execute:Read',
    'body:Read',
    'tools/post-execute:Read',
    'tools/ptc-dispatch-log:Read',
    'session:tool/ptc-dispatch:Read',
  ]);
  const [start, settle] = agent.session.appended;
  assert.equal(start?.type, 'tool/ptc-dispatch-start');
  assert.deepEqual(start?.data, {
    rootCallId: 'root-1',
    parentCallId: 'root-1',
    subCallId: 'root-1:ptc:1',
    name: 'Read',
    arguments: { path: 'a.txt' },
  });
  assert.equal(settle?.type, 'tool/ptc-dispatch');
  assert.deepEqual(settle?.data, {
    rootCallId: 'root-1',
    parentCallId: 'root-1',
    subCallId: 'root-1:ptc:1',
    name: 'Read',
    arguments: { path: 'a.txt' },
    isError: false,
    content: [{ type: 'text', text: 'content of a.txt' }],
  });
});

test('F2 the pipeline sees the same sub-call id the events carry', async () => {
  const fake = fakeContext();
  const agent = fakeAgent(fake.trace);
  const seen: string[] = [];
  fake.addHook('tools/pre-execute', (payload, next) => {
    if (payload.name === 'Read') seen.push(String(payload.callId));
    return next();
  });
  const executor = new CodeModeExecutor(fake.ctx);
  await executor.execute({ calls: [runCodeCall('await Read({ path: "a" }); await Read({ path: "b" })', 'root-9')], signal: new AbortController().signal, agent: agent as never });
  assert.deepEqual(seen, ['root-9:ptc:1', 'root-9:ptc:2']);
  const ids = agent.session.appended.filter((event) => event.type === 'tool/ptc-dispatch').map((event) => event.data.subCallId);
  assert.deepEqual(ids, seen);
});

test('F2 a denied sub-call still settles with isError and the error identity', async () => {
  const fake = fakeContext();
  const agent = fakeAgent(fake.trace);
  fake.addHook('tools/pre-execute', (payload, next) => (payload.name === 'Read'
    ? { kind: 'deny', reason: 'blocked by policy', info: { name: 'PolicyError', code: 'POLICY_DENIED' } }
    : next()));
  const executor = new CodeModeExecutor(fake.ctx);
  const code = 'let out; try { await Read({ path: "x" }); out = "no"; } catch (e) { out = e.message; } out';
  const batch = await executor.execute({ calls: [runCodeCall(code)], signal: new AbortController().signal, agent: agent as never });
  assert.match(valueOf(batch), /blocked by policy/);
  const settle = agent.session.appended.find((event) => event.type === 'tool/ptc-dispatch');
  assert.equal(settle?.data.isError, true);
  assert.deepEqual(settle?.data.error, { name: 'PolicyError', code: 'POLICY_DENIED' });
});

test('F2 a tools/ptc-dispatch-log listener may replace the logged content without changing the program value', async () => {
  const fake = fakeContext();
  const agent = fakeAgent(fake.trace);
  fake.addHook('tools/ptc-dispatch-log', async () => [{ type: 'text', text: 'preview only' }]);
  const executor = new CodeModeExecutor(fake.ctx);
  const batch = await executor.execute({ calls: [runCodeCall('await Read({ path: "a.txt" })')], signal: new AbortController().signal, agent: agent as never });
  assert.match(valueOf(batch), /content of a\.txt/);
  const settle = agent.session.appended.find((event) => event.type === 'tool/ptc-dispatch');
  assert.deepEqual(settle?.data.content, [{ type: 'text', text: 'preview only' }]);
});

test('F2 no agent means no session events and no failure', async () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const batch = await executor.execute({ calls: [runCodeCall('await Read({ path: "a.txt" })')], signal: new AbortController().signal });
  assert.match(valueOf(batch), /content of a\.txt/);
  assert.ok(!fake.trace.some((entry) => entry.startsWith('session:')));
  assert.ok(!fake.trace.some((entry) => entry.startsWith('tools/ptc-dispatch-log')));
});

test('F2 a failing session append does not fail the program', async () => {
  const warnings: string[] = [];
  const fake = fakeContext({ warnings });
  const agent = fakeAgent(fake.trace, 'session-1', { failAppend: true });
  const executor = new CodeModeExecutor(fake.ctx);
  const batch = await executor.execute({ calls: [runCodeCall('await Read({ path: "a.txt" })')], signal: new AbortController().signal, agent: agent as never });
  assert.match(valueOf(batch), /content of a\.txt/);
  assert.ok(warnings.length > 0, 'the failure is logged as a warning');
});
