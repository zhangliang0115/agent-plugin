/**
 * A person is asked from inside a tool's own body, not by the pipeline's `ask` decision.
 * DSH's bash tool does this for `sandbox_permissions` (it calls `ctx.approval.request` in `execute`),
 * `write` and `edit` do the same, and tools such as the computer-use ones call `ctx.userQuestions.ask`.
 * Each wait goes through the host's `approval/request` or `user-questions/request` waterfall. The
 * run deadline must not elapse while one is pending, whichever tool asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { CodeMode } from '@agent-plugin/code-mode-core';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeAgent, fakeContext, type FakeContext } from './fake-context.ts';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function runCodeCall(code: string, id = 'root-1') {
  return { type: 'tool-call' as const, id: ToolCallId(id), name: 'run_code', arguments: JSON.stringify({ code }) };
}
function valueOf(batch: Awaited<ReturnType<CodeModeExecutor['execute']>>): string {
  const [outcome] = batch.results;
  assert.ok(outcome !== undefined);
  return (outcome.result as { value: string }).value;
}
/** The shape of the host approval request the tool bodies send. */
interface ApprovalRequestLike {
  readonly agent: unknown;
  readonly toolName: string;
  readonly callId: string;
  readonly reason: string;
  readonly signal?: AbortSignal;
}
/** Resolves after `ms`, or early with `false` when the signal aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve(false);
    const timer = setTimeout(() => resolve(true), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(false);
    }, { once: true });
  });
}
/** A tool like DSH's bash with `sandbox_permissions`: its body asks the approval service. */
function escalatingTool(approvalOf: () => { request(req: ApprovalRequestLike): Promise<string> }, name = 'Escalate'): ToolDefinition {
  return defineTool({
    name,
    description: 'Asks for approval from inside its body, like bash with sandbox_permissions.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      const outcome = await approvalOf().request({
        agent: exec.agent,
        toolName: name,
        callId: String(exec.callId),
        reason: 'escalate sandbox to workspace-write: approval test',
        signal: exec.signal,
      });
      if (outcome !== 'allowed-once') throw new Error(`approval ${outcome}`);
      return 'escalated';
    },
  });
}
/** A tool like the computer-use ones: its body asks a user question, with no call id on the request. */
function questioningTool(questionsOf: () => { ask(req: { agent: unknown; signal?: AbortSignal }): Promise<unknown> }): ToolDefinition {
  return defineTool({
    name: 'Cua',
    description: 'Asks a user question from inside its body, like the computer-use tools.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await questionsOf().ask({ agent: exec.agent, signal: exec.signal });
      return 'answered';
    },
  });
}
function hangingTool(name = 'Hang'): ToolDefinition {
  return defineTool({
    name,
    description: 'Never finishes by itself.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await wait(60_000, exec.signal);
      return 'late';
    },
  });
}
/** The host services, wired the way DSH wires them: each request runs the matching waterfall on the context. */
function hostServices(holder: { fake?: FakeContext }) {
  const dispatch = (event: string, req: { agent: unknown }, fallback: () => Promise<unknown>): Promise<unknown> => {
    const ctx = holder.fake?.ctx as unknown as { waterfall(target: unknown, event: string, ...args: unknown[]): Promise<unknown> };
    return ctx.waterfall(req.agent, event, req, fallback);
  };
  return {
    approval: { request: (req: ApprovalRequestLike) => dispatch('approval/request', req, () => Promise.resolve('unavailable')) as Promise<string> },
    userQuestions: { ask: (req: { agent: unknown; signal?: AbortSignal }) => dispatch('user-questions/request', req, () => Promise.reject(new Error('no answerer'))) },
  };
}
/** An answerer for `approval/request` that answers `allowed-once` after `ms`, or `cancelled` when the request is withdrawn. */
function approvalAnswerer(ms: number) {
  return async (req: ApprovalRequestLike): Promise<string> => ((await wait(ms, req.signal)) ? 'allowed-once' : 'cancelled');
}
function setup(tools: (services: ReturnType<typeof hostServices>) => ToolDefinition[], timeoutMs = 300) {
  const holder: { fake?: FakeContext } = {};
  const services = hostServices(holder);
  const fake = fakeContext({ tools: tools(services), services });
  holder.fake = fake;
  const executor = new CodeModeExecutor(fake.ctx, { mode: new CodeMode({ timeoutMs, maxTimeoutMs: timeoutMs }) });
  return { fake, executor };
}
test('F1c an approval requested inside a tool body does not consume the run deadline', async () => {
  const { fake, executor } = setup((services) => [escalatingTool(() => services.approval)]);
  fake.addHook('approval/request', (req) => approvalAnswerer(700)(req));
  const agent = fakeAgent(fake.trace);
  const value = valueOf(await executor.execute({ calls: [runCodeCall('await Escalate({})')], signal: new AbortController().signal, agent: agent as never }));
  assert.doesNotMatch(value, /timed out/);
  assert.match(value, /escalated/);
  executor.dispose();
});
test('F1c a user question asked inside a tool body does not consume the run deadline', async () => {
  const { fake, executor } = setup((services) => [questioningTool(() => services.userQuestions)]);
  fake.addHook('user-questions/request', async (req) => {
    await wait(700, req.signal);
    return { answers: [] };
  });
  const agent = fakeAgent(fake.trace);
  const value = valueOf(await executor.execute({ calls: [runCodeCall('await Cua({})')], signal: new AbortController().signal, agent: agent as never }));
  assert.doesNotMatch(value, /timed out/);
  assert.match(value, /answered/);
  executor.dispose();
});
test('F1c the deadline resumes once the tool-internal approval is answered', async () => {
  const { fake, executor } = setup((services) => [escalatingTool(() => services.approval), hangingTool()]);
  fake.addHook('approval/request', (req) => approvalAnswerer(500)(req));
  const agent = fakeAgent(fake.trace);
  const started = Date.now();
  const value = valueOf(await executor.execute({
    calls: [runCodeCall('await Escalate({}); await Hang({})')],
    signal: new AbortController().signal,
    agent: agent as never,
  }));
  assert.match(value, /timed out/);
  assert.ok(Date.now() - started < 3_000, 'a hung tool ends at the deadline, not after its own 60 s');
  executor.dispose();
});
test('F1c an approval pending for another agent does not extend this run\'s deadline', async () => {
  const { fake, executor } = setup((services) => [hangingTool(), escalatingTool(() => services.approval)]);
  fake.addHook('approval/request', (req) => approvalAnswerer(2_000)(req));
  const agentA = fakeAgent(fake.trace, 'session-a');
  const agentB = fakeAgent(fake.trace, 'session-b');
  const controller = new AbortController();
  const runB = executor.execute({ calls: [runCodeCall('await Escalate({})', 'b-1')], signal: controller.signal, agent: agentB as never });
  await sleep(50);
  const started = Date.now();
  const valueA = valueOf(await executor.execute({ calls: [runCodeCall('await Hang({})', 'a-1')], signal: controller.signal, agent: agentA as never }));
  assert.match(valueA, /timed out/);
  assert.ok(Date.now() - started < 1_000, 'agent A\'s hung tool ends at its own deadline while B waits');
  controller.abort();
  await runB;
  executor.dispose();
});
test('F1c a stop while a tool-internal approval is pending ends the run without waiting for the answer', async () => {
  const { fake, executor } = setup((services) => [escalatingTool(() => services.approval)], 300);
  fake.addHook('approval/request', (req) => approvalAnswerer(60_000)(req));
  const agent = fakeAgent(fake.trace);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const started = Date.now();
  const batch = await executor.execute({ calls: [runCodeCall('await Escalate({})')], signal: controller.signal, agent: agent as never });
  const [outcome] = batch.results;
  assert.ok(outcome !== undefined);
  const result = outcome.result as { isError?: boolean; error?: { message?: string } };
  assert.equal(result.isError, true, 'the stopped run is an error result');
  assert.doesNotMatch(result.error?.message ?? '', /timed out/);
  assert.ok(Date.now() - started < 1_000, 'settles within 1 s of the stop');
  executor.dispose();
});
test('F1c the listeners run ahead of the answerer and are removed when the executor is disposed', () => {
  const { fake, executor } = setup(() => []);
  const answerer = (): string => 'allowed-once';
  fake.addHook('approval/request', answerer);
  fake.addHook('user-questions/request', answerer);
  // The executor registered first-in-line, so it can wrap an answerer that never calls `next`.
  assert.equal(fake.hooks.get('approval/request')?.length, 2);
  assert.equal(fake.hooks.get('approval/request')?.[1], answerer);
  assert.equal(fake.hooks.get('user-questions/request')?.[1], answerer);
  executor.dispose();
  assert.deepEqual(fake.hooks.get('approval/request'), [answerer]);
  assert.deepEqual(fake.hooks.get('user-questions/request'), [answerer]);
});
