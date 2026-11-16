import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CodeMode } from '@zhangliang0115/code-mode-core';
import { CodeModeExecutor } from '../src/executor.ts';
import { fakeAgent, fakeContext } from './fake-context.ts';

interface Captured { readonly names: readonly string[] }

/** A tool whose body records that it ran. The body is never reached when the tool is hidden. */
function bodyTool(ran: string[], name: string): ToolDefinition {
  return defineTool({
    name,
    description: `Tool ${name}.`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute() {
      ran.push(name);
      return Promise.resolve(`${name} done`);
    },
  });
}

function plainTool(name: string): ToolDefinition {
  return bodyTool([], name);
}

/** A stand-in for CodeMode that records the tool list each program receives. */
function recordingMode(captured: Captured[]): CodeMode {
  return {
    run(_owner: unknown, options: { readonly tools: ReadonlyArray<{ readonly name: string }> }) {
      captured.push({ names: options.tools.map((tool) => tool.name) });
      return Promise.resolve('<repl-output/>');
    },
    release: () => undefined,
    dispose: () => undefined,
  } as unknown as CodeMode;
}

function runCodeCall(code: string) {
  return { type: 'tool-call' as const, id: ToolCallId('root-1'), name: 'run_code', arguments: JSON.stringify({ code }) };
}

async function runOnce(executor: CodeModeExecutor, code: string): Promise<void> {
  await executor.execute({ calls: [runCodeCall(code)], signal: new AbortController().signal, agent: fakeAgent([]) as never });
}

/** The executor's only section, rendered for a visible tool list. */
function sectionText(executor: CodeModeExecutor, visible: readonly ToolDefinition[]): string {
  const section = executor.sections[0];
  assert.ok(section !== undefined, 'the executor contributes its instructions section');
  return typeof section.text === 'function' ? section.text(visible) : section.text;
}

/** Service with the same exact-or-trailing-`*` matching as the parallel list. */
function disabledService(list: () => readonly string[]) {
  return {
    isDisabled(name: string): boolean {
      return list().some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
    },
  };
}

const VISIBLE = ['McpRead', 'McpWrite'].map(plainTool);

test('section text omits a tool the user disabled', () => {
  const fake = fakeContext({ tools: VISIBLE, services: { mcpDisabled: disabledService(() => ['McpWrite']) } });
  const executor = new CodeModeExecutor(fake.ctx, { mode: recordingMode([]) as never });
  const text = sectionText(executor, VISIBLE);
  assert.ok(text.includes('McpRead'), 'the enabled tool stays in the instructions');
  assert.ok(!text.includes('McpWrite'), 'the disabled tool is hidden from the instructions');
});

test('run_code description omits a tool the user disabled', () => {
  const fake = fakeContext({ tools: VISIBLE, services: { mcpDisabled: disabledService(() => ['McpWrite']) } });
  const executor = new CodeModeExecutor(fake.ctx, { mode: recordingMode([]) as never });
  const output = executor.describe(VISIBLE);
  const serialized = JSON.stringify(output.schemas);
  assert.ok(serialized.includes('McpRead'), 'the enabled tool stays in the run_code description');
  assert.ok(!serialized.includes('McpWrite'), 'the disabled tool is hidden from the run_code description');
});

test('a disabled tool stays bound in the sandbox so a call reaches the pipeline and its denial', async () => {
  // Arrange: hiding is only about what the model reads; the refusal is mcp-ui's pre-execute listener.
  const captured: Captured[] = [];
  const fake = fakeContext({ tools: VISIBLE, services: { mcpDisabled: disabledService(() => ['McpWrite']) } });
  const executor = new CodeModeExecutor(fake.ctx, { mode: recordingMode(captured) });

  // Act
  await runOnce(executor, 'McpRead({})');

  // Assert
  assert.deepEqual(captured[0]?.names, ['McpRead', 'McpWrite']);
});

test('a call to a disabled tool reaches tools/pre-execute, where mcp-ui refuses it', async () => {
  // Arrange: a stand-in for mcp-ui's gate, registered on the same event.
  const ran: string[] = [];
  const tools = [bodyTool(ran, 'McpRead'), bodyTool(ran, 'McpWrite')];
  const fake = fakeContext({ tools, services: { mcpDisabled: disabledService(() => ['McpWrite']) } });
  fake.ctx.on('tools/pre-execute', ((exec: { readonly name: string }, next: () => Promise<unknown>) => (
    exec.name === 'McpWrite' ? Promise.resolve({ kind: 'deny', reason: '工具 McpWrite 已被用户在 MCP 设置里禁用。' }) : next()
  )) as never);
  const executor = new CodeModeExecutor(fake.ctx);

  // Act
  await runOnce(executor, 'await McpRead({}); try { await McpWrite({}); } catch (error) {}');

  // Assert: the allowed tool ran, the disabled one was refused before its body.
  assert.deepEqual(ran, ['McpRead']);
});

test('a list edited between two instruction renderings applies to the next rendering', () => {
  let disabled: readonly string[] = [];
  const fake = fakeContext({ tools: VISIBLE, services: { mcpDisabled: disabledService(() => disabled) } });
  const executor = new CodeModeExecutor(fake.ctx, { mode: recordingMode([]) as never });
  assert.ok(sectionText(executor, VISIBLE).includes('McpWrite'));

  disabled = ['McpWrite'];
  assert.ok(!sectionText(executor, VISIBLE).includes('McpWrite'));
});

test('a trailing * in the service list hides every tool with that prefix', async () => {
  const captured: Captured[] = [];
  const tools = ['mcp__jev__read', 'mcp__jev__write', 'McpRead'].map(plainTool);
  const fake = fakeContext({ tools, services: { mcpDisabled: disabledService(() => ['mcp__jev__*']) } });
  const executor = new CodeModeExecutor(fake.ctx, { mode: recordingMode(captured) });
  const text = sectionText(executor, tools);
  assert.ok(!text.includes('mcp__jev__read') && !text.includes('mcp__jev__write'), 'the prefix hides both jev tools');
  assert.ok(text.includes('McpRead'));
  // The program still gets every tool bound; only what the model reads is filtered.
  await runOnce(executor, 'null');
  assert.deepEqual(captured[0]?.names, ['mcp__jev__read', 'mcp__jev__write', 'McpRead']);
});

test('an absent service hides nothing', async () => {
  const captured: Captured[] = [];
  const fake = fakeContext({ tools: VISIBLE });
  const executor = new CodeModeExecutor(fake.ctx, { mode: recordingMode(captured) });
  assert.ok(sectionText(executor, VISIBLE).includes('McpWrite'));
  assert.ok(JSON.stringify(executor.describe(VISIBLE).schemas).includes('McpWrite'));
  await runOnce(executor, 'null');
  assert.deepEqual(captured[0]?.names, ['McpRead', 'McpWrite']);
});

test('a service whose isDisabled throws hides nothing and does not throw', async () => {
  const captured: Captured[] = [];
  const throwing = { isDisabled(): boolean { throw new Error('boom'); } };
  const fake = fakeContext({ tools: VISIBLE, services: { mcpDisabled: throwing } });
  const executor = new CodeModeExecutor(fake.ctx, { mode: recordingMode(captured) });
  assert.ok(sectionText(executor, VISIBLE).includes('McpWrite'));
  assert.ok(JSON.stringify(executor.describe(VISIBLE).schemas).includes('McpWrite'));
  await runOnce(executor, 'null');
  assert.deepEqual(captured[0]?.names, ['McpRead', 'McpWrite']);
});

test('a context whose get throws hides nothing and does not throw', async () => {
  const captured: Captured[] = [];
  const fake = fakeContext({ tools: VISIBLE });
  const ctx = { ...fake.ctx, get: () => { throw new Error('no such service'); } } as unknown as Context;
  const executor = new CodeModeExecutor(ctx, { mode: recordingMode(captured) });
  assert.ok(sectionText(executor, VISIBLE).includes('McpWrite'));
  await runOnce(executor, 'null');
  assert.deepEqual(captured[0]?.names, ['McpRead', 'McpWrite']);
});

test('an empty disabled list leaves every output unchanged', async () => {
  const withService: Captured[] = [];
  const withoutService: Captured[] = [];
  const empty = fakeContext({ tools: VISIBLE, services: { mcpDisabled: disabledService(() => []) } });
  const none = fakeContext({ tools: VISIBLE });
  const executorWith = new CodeModeExecutor(empty.ctx, { mode: recordingMode(withService) });
  const executorWithout = new CodeModeExecutor(none.ctx, { mode: recordingMode(withoutService) });
  assert.equal(sectionText(executorWith, VISIBLE), sectionText(executorWithout, VISIBLE));
  assert.deepEqual(executorWith.describe(VISIBLE), executorWithout.describe(VISIBLE));
  await runOnce(executorWith, 'null');
  await runOnce(executorWithout, 'null');
  assert.deepEqual(withService, withoutService);
});
