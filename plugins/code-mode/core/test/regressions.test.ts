/** Regression tests for issues found in review. @module */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMode, parseEnvelope, noTools } from './helpers.ts';
import { escapeAndTruncate } from '../src/output.ts';

const signal = () => new AbortController().signal;
const readTool = { name: 'Read', description: 'read a file', inputSchema: {} };

test('a run aborted before it starts executes no tool body', async () => {
  const mode = newMode();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const out = parseEnvelope(await mode.run({}, {
    code: 'await Read({}); 1 + 1',
    tools: [readTool],
    invoke: async () => {
      called = true;
      return 'x';
    },
    signal: controller.signal,
  }));
  assert.equal(called, false, 'the tool body never ran');
  assert.match(out.error ?? '', /aborted/);
  mode.dispose();
});

test('declaring a built-in name does not break the sandbox for later runs', async () => {
  const mode = newMode();
  const owner = {};
  const first = parseEnvelope(await mode.run(owner, { code: 'const Object = 1;\nObject', ...noTools, signal: signal() }));
  assert.equal(first.result, '1');
  const second = parseEnvelope(await mode.run(owner, { code: '1 + 1', ...noTools, signal: signal() }));
  assert.equal(second.error, undefined, 'the bridge still installs tools');
  assert.equal(second.result, '2');
  mode.dispose();
});

test('an error thrown by a function from an earlier run reports no current-run location', async () => {
  const mode = newMode();
  const owner = {};
  await mode.run(owner, { code: 'function boom() {\n  throw new Error("kaboom");\n}', ...noTools, signal: signal() });
  const out = parseEnvelope(await mode.run(owner, { code: '// one\n// two\nboom();', ...noTools, signal: signal() }));
  assert.match(out.error ?? '', /Error: kaboom/);
  assert.doesNotMatch(out.error ?? '', /at line/, 'the frame belongs to the earlier run');
  mode.dispose();
});

test('a tool with no parameters is called with an empty object', async () => {
  const mode = newMode();
  let seen: unknown;
  const out = parseEnvelope(await mode.run({}, {
    code: 'await Ping()',
    tools: [{ name: 'Ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }],
    invoke: async (_name, args) => {
      seen = args;
      return 'pong';
    },
    signal: signal(),
  }));
  assert.deepEqual(seen, {});
  assert.equal(out.result, 'pong');
  mode.dispose();
});

test('a var declared inside a block persists across runs', async () => {
  const mode = newMode();
  const owner = {};
  await mode.run(owner, { code: 'for (var i = 0; i < 3; i++) {}', ...noTools, signal: signal() });
  const loop = parseEnvelope(await mode.run(owner, { code: 'typeof i', ...noTools, signal: signal() }));
  assert.equal(loop.result, 'number');

  await mode.run(owner, { code: 'if (true) { var y = 1 }', ...noTools, signal: signal() });
  const block = parseEnvelope(await mode.run(owner, { code: 'y', ...noTools, signal: signal() }));
  assert.equal(block.result, '1');

  await mode.run(owner, { code: 'try { throw 1 } catch { var z = 2 }', ...noTools, signal: signal() });
  const caught = parseEnvelope(await mode.run(owner, { code: 'z', ...noTools, signal: signal() }));
  assert.equal(caught.result, '2');
  mode.dispose();
});

test('a logging loop is bounded instead of exhausting the heap', async () => {
  // 4 MiB is the heap size the review used to reach an out-of-memory error.
  const mode = newMode({ memoryBytes: 4 * 1024 * 1024 });
  const out = parseEnvelope(await mode.run({}, {
    code: 'for (let i = 0; i < 200000; i++) self.log("x" + i);\n1',
    ...noTools,
    signal: signal(),
  }));
  assert.equal(out.error, undefined, 'the run finished');
  assert.equal(out.result, '1');
  assert.ok((out.log ?? '').length < 11_000, 'the log stays near the model-facing limit');
  assert.match(out.log ?? '', /\[truncated: \d+ more characters\]/);
  mode.dispose();
});

test('a parenthesized initializer keeps its meaning', async () => {
  const mode = newMode();
  const sequence = parseEnvelope(await mode.run({}, { code: 'const a = (1, 2);\na', ...noTools, signal: signal() }));
  assert.equal(sequence.result, '2');
  const pattern = parseEnvelope(await mode.run({}, { code: 'const [x = (1, 2)] = [];\nx', ...noTools, signal: signal() }));
  assert.equal(pattern.result, '2');
  mode.dispose();
});

test('a leading use strict survives a hoisted function', async () => {
  const mode = newMode();
  const out = parseEnvelope(await mode.run({}, {
    code: "'use strict'; function f(){} (function(){ return this === undefined })()",
    ...noTools,
    signal: signal(),
  }));
  assert.equal(out.result, 'true');
  mode.dispose();
});

test('escaping happens before truncation, so the limit applies to what the model sees', () => {
  const escaped = escapeAndTruncate('&'.repeat(20), 10);
  assert.ok(escaped.startsWith('&amp;&amp;'), escaped);
  assert.ok(escaped.length <= 10 + '\n[truncated: 90 more characters]'.length, escaped);
});
