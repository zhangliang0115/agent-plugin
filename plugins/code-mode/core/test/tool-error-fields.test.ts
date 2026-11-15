import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallError } from '../src/index.ts';
import { newMode, parseEnvelope } from './helpers.ts';

const tools = [{ name: 'Read', description: 'read', inputSchema: {} }];
const signal = () => new AbortController().signal;

test('F5 a ToolCallError reaches the program as code and errorName with the message unchanged', async () => {
  const invoke = async (): Promise<never> => { throw new ToolCallError('boom', { code: 'TOOL_TIMEOUT', name: 'ToolTimeoutError' }); };
  const out = parseEnvelope(await newMode().run({}, {
    code: 'let r; try { await Read({}) } catch (e) { r = [e.code, e.errorName, e.message, e.name, String(e)] } r',
    tools, invoke, signal: signal(),
  }));
  assert.deepEqual(JSON.parse(out.result!), ['TOOL_TIMEOUT', 'ToolTimeoutError', 'boom', 'Error', 'Error: boom']);
});

test('F5 an uncaught tool error prints the same text as before', async () => {
  const invoke = async (): Promise<never> => { throw new ToolCallError('boom', { code: 'TOOL_TIMEOUT', name: 'ToolTimeoutError' }); };
  const out = parseEnvelope(await newMode().run({}, { code: 'await Read({})', tools, invoke, signal: signal() }));
  assert.match(out.error ?? '', /^Error: boom/);
  assert.doesNotMatch(out.error ?? '', /TOOL_TIMEOUT/);
});

test('F5 a plain Error from the invoker has no code', async () => {
  const invoke = async (): Promise<never> => { throw new Error('plain'); };
  const out = parseEnvelope(await newMode().run({}, {
    code: 'let r; try { await Read({}) } catch (e) { r = [e.code === undefined, e.errorName === undefined] } r',
    tools, invoke, signal: signal(),
  }));
  assert.deepEqual(JSON.parse(out.result!), [true, true]);
});
