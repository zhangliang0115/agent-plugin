import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMode, parseEnvelope } from './helpers.ts';

const signal = () => new AbortController().signal;
const invoke = async () => null;

test('self.log writes to the envelope log and console output does not', async () => {
  const mode = newMode();
  const out = parseEnvelope(await mode.run({}, { code: 'self.log("hello", 2); console.log("hidden"); 1', tools: [], invoke, signal: signal() }));
  assert.equal(out.log, 'hello 2');
  assert.equal(out.result, '1');
  mode.dispose();
});

test('console entries are kept in a ring and read back with console.tail', async () => {
  const mode = newMode({ consoleRingSize: 3 });
  const owner = {};
  await mode.run(owner, { code: 'for (let i = 0; i < 5; i++) console.log("n" + i);', tools: [], invoke, signal: signal() });
  const out = parseEnvelope(await mode.run(owner, { code: 'console.tail(10)', tools: [], invoke, signal: signal() }));
  assert.equal(out.result, '[\n  "log: n2",\n  "log: n3",\n  "log: n4"\n]');
  const two = parseEnvelope(await mode.run(owner, { code: 'console.tail(1)', tools: [], invoke, signal: signal() }));
  assert.equal(two.result, '[\n  "log: n4"\n]');
  mode.dispose();
});

test('preview formats values, defaults to 2000 characters and marks the cut', async () => {
  const mode = newMode();
  const short = parseEnvelope(await mode.run({}, { code: 'preview({ a: 1 })', tools: [], invoke, signal: signal() }));
  assert.equal(short.result, '{\n  "a": 1\n}');
  const long = parseEnvelope(await mode.run({}, { code: 'preview("x".repeat(2500))', tools: [], invoke, signal: signal() }));
  assert.equal(long.result, 'x'.repeat(2000) + '\n[preview truncated: 500 more characters]');
  const custom = parseEnvelope(await mode.run({}, { code: 'preview("abcdef", 3)', tools: [], invoke, signal: signal() }));
  assert.equal(custom.result, 'abc\n[preview truncated: 3 more characters]');
  mode.dispose();
});
