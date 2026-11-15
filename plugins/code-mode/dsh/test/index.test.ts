import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { inject, name, apply } from '../src/index.ts';
import { fakeContext } from './fake-context.ts';

test('the plugin declares its name and the services it needs', () => {
  assert.equal(name, 'code-mode-dsh');
  assert.deepEqual([...inject], ['tools', 'systemPrompt']);
});

test('apply registers exactly one executor with the tools service', () => {
  const fake = fakeContext();
  apply(fake.ctx);
  assert.equal(fake.executors.length, 1);
});

test('an agent teardown releases that agent\'s context, so its variables are gone', async () => {
  const fake = fakeContext();
  apply(fake.ctx);
  const executor = fake.executors[0] as unknown as { execute(input: unknown): Promise<{ results: ReadonlyArray<{ result: { value: string } }> }> };
  const registered: Array<() => void> = [];
  const agent = {
    ctx: { effect: (fn: () => () => void) => registered.push(fn()) },
  };
  const run = (code: string) => executor.execute({
    calls: [{ type: 'tool-call', id: ToolCallId('x'), name: 'run_code', arguments: JSON.stringify({ code }) }],
    signal: new AbortController().signal,
    agent,
  });
  await run('globalThis.kept = 5; const remembered = 6;');
  const first = await run('remembered');
  assert.match(first.results[0]?.result.value ?? '', /<result>6<\/result>/);
  assert.equal(registered.length, 1, 'the agent release is registered once');
  registered[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = await run('typeof remembered');
  assert.match(after.results[0]?.result.value ?? '', /<result>undefined<\/result>/);
});

test('plugin disposal releases every sandbox', () => {
  const fake = fakeContext();
  apply(fake.ctx);
  assert.equal(fake.disposers.length, 1);
  assert.doesNotThrow(() => fake.disposers[0]?.());
});
