import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformProgram } from '../src/transform.ts';

test('top-level const and let become globalThis properties', () => {
  const { body, hasResult } = transformProgram('const a = 1;\nlet b = a + 1;');
  assert.match(body, /globalThis\.a = \(1\);/);
  assert.match(body, /globalThis\.b = \(a \+ 1\);/);
  assert.equal(hasResult, false);
});

test('top-level destructuring writes each bound name to globalThis', () => {
  const { body } = transformProgram('const { x, y: z = 3, ...rest } = obj;\nconst [p, , q] = arr;');
  assert.match(body, /\(\{ x: globalThis\.x, y: globalThis\.z = \(3\), \.\.\.globalThis\.rest \} = \(obj\)\);/);
  assert.match(body, /\(\[globalThis\.p, , globalThis\.q\] = \(arr\)\);/);
});

test('a declaration without initializer resets let to undefined and keeps an existing var', () => {
  const { body } = transformProgram('let n;\nvar v;');
  assert.match(body, /globalThis\.n = undefined;/);
  assert.match(body, /if \(!\("v" in globalThis\)\) globalThis\.v = undefined;/);
});

test('top-level functions and classes are hoisted and stored on globalThis', () => {
  const { body } = transformProgram('const r = f();\nfunction f() { return 2; }\nclass C { m() { return 1; } }');
  assert.ok(body.indexOf('function f()') < body.indexOf('globalThis.r = '), 'function is hoisted to the top');
  assert.match(body, /globalThis\.f = f;/);
  assert.match(body, /globalThis\.C = class C \{ m\(\) \{ return 1; \} \};/);
});

test('the last top-level expression statement becomes the returned result', () => {
  const { body, hasResult } = transformProgram('const a = 2;\na * 21;');
  assert.equal(hasResult, true);
  assert.match(body, /return \(a \* 21\);/);
});

test('declarations inside functions and blocks are left untouched', () => {
  const { body } = transformProgram('function g() { const inner = 1; return inner; }\n{ let scoped = 2; }\ng();');
  assert.match(body, /const inner = 1; return inner;/);
  assert.match(body, /\{ let scoped = 2; \}/);
  assert.doesNotMatch(body, /globalThis\.inner/);
  assert.doesNotMatch(body, /globalThis\.scoped/);
});

test('top-level await is accepted', () => {
  const { body, hasResult } = transformProgram('const v = await Promise.resolve(5);\nv;');
  assert.equal(hasResult, true);
  assert.match(body, /globalThis\.v = \(await Promise\.resolve\(5\)\);/);
});

test('static import is rejected with a Code Mode message', () => {
  assert.throws(() => transformProgram('import x from "y";'), (error: Error) => {
    assert.equal(error.name, 'SyntaxError');
    return /import/.test(error.message);
  });
});

test('syntax errors surface as SyntaxError', () => {
  assert.throws(() => transformProgram('const = ;'), (error: Error) => error.name === 'SyntaxError');
});

test('a dynamic import is rejected with the listed-tools message', () => {
  assert.throws(() => transformProgram('await import("node:fs");'), /import is not available in Code Mode; use the listed tools/);
});
