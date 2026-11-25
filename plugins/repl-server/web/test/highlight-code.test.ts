import assert from 'node:assert/strict';
import test from 'node:test';

import { highlightScriptCode } from '../src/lib/highlight-code.ts';

test('highlightScriptCode marks keywords, strings, comments and numbers', () => {
  const html = highlightScriptCode('// note\nconst x = "s";\nreturn 42;');
  assert.ok(html !== null);
  assert.match(html, /class="hljs-comment"/);
  assert.match(html, /class="hljs-keyword"/);
  assert.match(html, /class="hljs-string"/);
  assert.match(html, /class="hljs-number"/);
});

test('highlightScriptCode escapes HTML in the source', () => {
  const html = highlightScriptCode('const x = "<script>alert(1)</script>";');
  assert.ok(html !== null);
  assert.ok(!html.includes('<script>'), 'raw tag must not survive');
  assert.ok(html.includes('&lt;script&gt;'), 'tag is escaped');
});

test('highlightScriptCode preserves the line count', () => {
  const code = 'function f() {\n  return 1;\n}\n';
  const html = highlightScriptCode(code);
  assert.ok(html !== null);
  assert.equal(html.split('\n').length, code.split('\n').length);
});

test('highlightScriptCode returns null for blank input', () => {
  assert.equal(highlightScriptCode(''), null);
  assert.equal(highlightScriptCode('  \n\t '), null);
});

test('highlightScriptCode returns null over the size cap', () => {
  const large = 'const x = 1;\n'.repeat(20_000);
  assert.ok(large.length > 200_000);
  assert.equal(highlightScriptCode(large), null);
});

test('highlightScriptCode tolerates invalid JS without throwing', () => {
  assert.doesNotThrow(() => highlightScriptCode('const x = ;'));
});
