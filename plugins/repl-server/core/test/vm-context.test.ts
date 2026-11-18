import assert from 'node:assert/strict';
import test from 'node:test';

import { createVmContext, runEvalScript, wrapEvalSource } from '../src/worker/vm-context.ts';

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
