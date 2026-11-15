import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeContext, readTool } from './fake-context.ts';

test('describe exposes exactly one model tool, run_code, whose only required argument is code', () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const input = executor.describe([readTool([])]);
  assert.deepEqual(input.knownNames, [RUN_CODE_NAME]);
  assert.equal(input.schemas.length, 1);
  const [schema] = input.schemas;
  assert.equal(schema?.name, 'run_code');
  const parameters = schema?.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(parameters.properties), ['code']);
  assert.deepEqual(parameters.required, ['code']);
});

test('the run_code description rules out import, require and process and names the listed tools', () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const [schema] = executor.describe([readTool([])]).schemas;
  assert.match(schema?.description ?? '', /import, require or process are not available; call the listed tools instead/);
});

test('the prompt section lists the visible tools and the run_code rules', () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const [section] = executor.sections ?? [];
  assert.ok(section !== undefined);
  const text = typeof section.text === 'function' ? section.text([readTool([])]) : section.text;
  assert.match(text, /Read\(\{ path \}\)/);
  assert.match(text, /self\.log/);
  assert.match(text, /console\.tail/);
});

test('the run_code code description names the bound tool functions and no others', () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const [schema] = executor.describe([readTool([], 'read', 'file_path')]).schemas;
  const code = JSON.stringify(schema?.parameters);
  assert.match(code, /read\(\{ file_path \}\)/);
  assert.match(code, /await read\(/);
  assert.doesNotMatch(code, /Read/);
  assert.doesNotMatch(code, /await Read\(/);
});

test('the prompt section names the bound tool functions and no others', () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const [section] = executor.sections ?? [];
  const text = typeof section?.text === 'function' ? section.text([readTool([], 'read', 'file_path')]) : '';
  assert.match(text, /read\(\{ file_path \}\)/);
  assert.doesNotMatch(text, /\bRead\(/);
});

test('the run_code code description says so when no tools are bound', () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const [schema] = executor.describe([]).schemas;
  assert.match(JSON.stringify(schema?.parameters), /No tools are available/);
});

test('the executor registers itself once with the tools service', async () => {
  const { setupCodeModeExecutor } = await import('../src/index.ts');
  const fake = fakeContext();
  setupCodeModeExecutor(fake.ctx);
  assert.equal(fake.executors.length, 1);
  assert.ok(fake.executors[0] instanceof CodeModeExecutor);
});

test('a direct model call to any tool other than run_code is rejected before its body runs', async () => {
  const fake = fakeContext();
  const executor = new CodeModeExecutor(fake.ctx);
  const batch = await executor.execute({
    calls: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'Read', arguments: '{"path":"a"}' }],
    signal: new AbortController().signal,
  });
  const [outcome] = batch.results;
  assert.equal(outcome?.result.isError, true);
  assert.ok(!fake.trace.includes('body:Read'), 'Read body did not run');
});

test('the prompt and the code description show each bound tool return shape from its DSH output schema', async () => {
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const read = defineTool({
    name: 'read',
    description: 'Read a file.',
    parameters: { file_path: { type: 'string', required: true, description: 'File path.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { number: { type: 'integer', required: true }, text: { type: 'string', required: true } },
            },
          },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return { path: 'a.txt', lines: [], totalLines: 0 };
    },
  });
  const executor = new CodeModeExecutor(fakeContext().ctx);
  const [section] = executor.sections ?? [];
  const text = typeof section?.text === 'function' ? section.text([read]) : '';
  assert.match(text, /read\(\{ file_path \}\) -> \{ path: string, lines: \{ number: integer, text: string \}\[\], totalLines: integer \}/);
  const [schema] = executor.describe([read]).schemas;
  assert.match(JSON.stringify(schema?.parameters), /-> \{ path: string, lines:/);
});
