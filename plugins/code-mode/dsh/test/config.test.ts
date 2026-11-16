/** Deployment config: schema defaults, validation, and the wiring into the sandbox. @module */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_LIMITS } from '@zhangliang0115/code-mode-core';
import { Config } from '../src/config.ts';
import { apply, setupCodeModeExecutor } from '../src/index.ts';
import { fakeContext } from './fake-context.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function runCodeCall(code: string) {
  return { type: 'tool-call' as const, id: ToolCallId('root-1'), name: 'run_code', arguments: JSON.stringify({ code }) };
}

function slowTool() {
  return defineTool({
    name: 'Slow',
    description: 'Waits longer than the configured deadline.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      await sleep(1_000);
      return 'slow';
    },
  });
}

test('an empty config resolves to the core defaults', () => {
  assert.deepEqual(Config({}), {
    timeoutMs: DEFAULT_LIMITS.timeoutMs,
    maxTimeoutMs: DEFAULT_LIMITS.maxTimeoutMs,
    memoryBytes: DEFAULT_LIMITS.memoryBytes,
    maxSubCallsPerRun: DEFAULT_LIMITS.maxSubCallsPerRun,
    maxParallelSubCalls: DEFAULT_LIMITS.maxParallelSubCalls,
    resultChars: DEFAULT_LIMITS.resultChars,
    logChars: DEFAULT_LIMITS.logChars,
    errorChars: DEFAULT_LIMITS.errorChars,
  });
});

test('a deployment config overrides only the fields it names', () => {
  const resolved = Config({ timeoutMs: 300, maxParallelSubCalls: 2 });
  assert.equal(resolved.timeoutMs, 300);
  assert.equal(resolved.maxParallelSubCalls, 2);
  assert.equal(resolved.maxTimeoutMs, DEFAULT_LIMITS.maxTimeoutMs);
  assert.equal(resolved.resultChars, DEFAULT_LIMITS.resultChars);
});

test('an invalid limit is rejected with the field name', () => {
  assert.throws(() => Config({ timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => Config({ memoryBytes: -1 }), /memoryBytes/);
  assert.throws(() => Config({ resultChars: 1.5 }), /resultChars/);
  assert.throws(() => Config({ logChars: 'many' as never }), /logChars/);
});

test('the configured timeout reaches the sandbox', async () => {
  const fake = fakeContext({ tools: [slowTool()] });
  const executor = setupCodeModeExecutor(fake.ctx, { timeoutMs: 300, maxTimeoutMs: 300 });
  const batch = await executor.execute({ calls: [runCodeCall('await Slow()')], signal: new AbortController().signal });
  const [outcome] = batch.results;
  assert.ok(outcome !== undefined);
  assert.match((outcome.result as { value: string }).value, /Code run timed out after 300 ms/);
  executor.dispose();
});

test('apply forwards the config it is given', async () => {
  const fake = fakeContext({ tools: [slowTool()] });
  apply(fake.ctx as never, { timeoutMs: 250, maxTimeoutMs: 250 });
  const executor = fake.executors[0];
  assert.ok(executor !== undefined);
  const batch = await executor.execute({ calls: [runCodeCall('await Slow()')], signal: new AbortController().signal });
  const [outcome] = batch.results;
  assert.ok(outcome !== undefined);
  assert.match((outcome.result as { value: string }).value, /Code run timed out after 250 ms/);
  (executor as unknown as { dispose(): void }).dispose();
});

test('a config whose timeout exceeds its own maximum fails activation', () => {
  assert.throws(
    () => setupCodeModeExecutor(fakeContext().ctx, { timeoutMs: 900_000, maxTimeoutMs: 600_000 }),
    /maxTimeoutMs/,
  );
});
