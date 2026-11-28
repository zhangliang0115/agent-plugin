import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileEvalScript,
  createVmContext,
  formatUserError,
  runEvalScript,
  wrapEvalSource,
} from '../src/worker/vm-context.ts';

const SYNC_MS = 1_000;

test('the eval body supports top-level await and return', async () => {
  const { context } = createVmContext({ tools: {}, console: {} });
  assert.match(wrapEvalSource('await 1'), /^\(async \(\) => \{/);

  const value = await runEvalScript(
    context,
    'const base = await Promise.resolve(20);\nreturn base + 1;',
    1,
    SYNC_MS,
  );
  assert.equal(value, 21);
});

test('formatUserError shifts V8 syntax-error lines past the async wrapper', () => {
  let stack = '';
  try {
    compileEvalScript('const x = ;', 7);
  } catch (error) {
    stack = (error as Error).stack ?? '';
  }
  assert.match(stack, /repl-eval-7\.js:2/);
  assert.equal(formatUserError('Unexpected token', stack), 'Unexpected token (line 1)');
});

test('formatUserError keeps columns, ignores non-eval stacks and already-located messages', () => {
  const stack = 'Error: boom\n    at repl-eval-9.js:3:7\n    at repl-eval-9.js:4:3';
  assert.equal(formatUserError('boom', stack), 'boom (line 2, column 7)');
  assert.equal(formatUserError('MCP failed', 'Error: x\n    at gateway.ts:10:1'), 'MCP failed');
  assert.equal(formatUserError('already (line 4)', stack), 'already (line 4)');
  assert.equal(formatUserError('plain', undefined), 'plain');
});

test('state allows field assignment but rejects replacement', async () => {
  const { context, state } = createVmContext({ tools: {}, console: {}, state: { seed: 1 } });

  assert.equal(await runEvalScript(context, 'state.cursor = 42; return state.seed + state.cursor;', 1, SYNC_MS), 43);
  assert.deepEqual(state, { seed: 1, cursor: 42 });

  await assert.rejects(
    async () => {
      await runEvalScript(context, 'state = {}; return 1;', 2, SYNC_MS);
    },
    /state cannot be replaced; assign fields instead/,
  );

  // The rejected assignment did not disturb the snapshot source.
  assert.equal(await runEvalScript(context, 'return state.cursor;', 3, SYNC_MS), 42);
});

test('dangerous globals are removed and string code generation is blocked', async () => {
  const { context } = createVmContext({ tools: {}, console: {} });

  const types = await runEvalScript(
    context,
    `return [typeof WebAssembly, typeof SharedArrayBuffer, typeof ShadowRealm,
             typeof process, typeof require, typeof module].join(',');`,
    1,
    SYNC_MS,
  );
  assert.equal(types, 'undefined,undefined,undefined,undefined,undefined,undefined');

  await assert.rejects(
    async () => {
      await runEvalScript(context, `return new Function('return 1')();`, 2, SYNC_MS);
    },
    /Code generation from strings disallowed/,
  );

  await assert.rejects(
    async () => {
      await runEvalScript(context, `return eval('1 + 1');`, 3, SYNC_MS);
    },
    /Code generation from strings disallowed/,
  );

  // Note: `this.constructor.constructor('return process')()` is NOT blocked by
  // this context. On Node 24 it reaches the host realm's Function through the
  // contextified sandbox object, which is the escape documented in learn-ai 02
  // §5.6 ("不要声称 vm 是安全边界"). It is not asserted as blocked here.
});

test('import statements are syntax errors', () => {
  const { context } = createVmContext({ tools: {}, console: {} });
  assert.throws(() => runEvalScript(context, `import fs from 'node:fs';`, 1, SYNC_MS), SyntaxError);
});

test('L0 timeout stops a sync loop and leaves the context usable', async () => {
  const { context } = createVmContext({ tools: {}, console: {} });

  assert.throws(
    () => runEvalScript(context, 'while (true) {}', 1, 25),
    (error: unknown) => (error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT',
  );

  assert.equal(await runEvalScript(context, 'return 6;', 2, SYNC_MS), 6);
});

test('tools and console are callable from the script', async () => {
  const lines: string[] = [];
  const tools = { echo: (value: unknown) => ({ echoed: value }) };
  const { context } = createVmContext({
    tools,
    console: { log: (text: string) => lines.push(text) },
  });

  const result = await runEvalScript(
    context,
    `console.log('hi');\nconst r = tools.echo(7);\nreturn r.echoed;`,
    1,
    SYNC_MS,
  );
  assert.equal(result, 7);
  assert.deepEqual(lines, ['hi']);
});

test('timers are available for delays and can be cleared', async () => {
  const { context } = createVmContext({ tools: {}, console: {} });

  const delayed = await runEvalScript(
    context,
    'await new Promise((resolve) => setTimeout(resolve, 20));\nreturn "slept";',
    1,
    SYNC_MS,
  );
  assert.equal(delayed, 'slept');

  const cleared = await runEvalScript(
    context,
    `let fired = false;
     const handle = setTimeout(() => { fired = true }, 5);
     clearTimeout(handle);
     await new Promise((resolve) => setTimeout(resolve, 30));
     return fired;`,
    2,
    SYNC_MS,
  );
  assert.equal(cleared, false);

  const interrupted = await runEvalScript(
    context,
    `let ticks = 0;
     const handle = setInterval(() => { ticks += 1 }, 5);
     await new Promise((resolve) => setTimeout(resolve, 25));
     clearInterval(handle);
     return ticks > 0;`,
    3,
    SYNC_MS,
  );
  assert.equal(interrupted, true);
});

test('pure data globals are available; I/O globals are not', async () => {
  const { context } = createVmContext({ tools: {}, console: {} });
  const result = await runEvalScript(
    context,
    `return [
      new URL('https://a.b/c?d=1').searchParams.get('d'),
      new URLSearchParams({ x: '1' }).toString(),
      new TextDecoder().decode(new TextEncoder().encode('hi')),
      structuredClone({ n: 1 }).n,
      atob(btoa('ok')),
      typeof fetch, typeof Buffer,
    ].join(',');`,
    1,
    SYNC_MS,
  );
  assert.equal(result, '1,x=1,hi,1,ok,undefined,undefined');
});
