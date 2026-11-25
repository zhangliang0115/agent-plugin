import assert from 'node:assert/strict';
import test from 'node:test';

import { formatScriptCode } from '../src/lib/format-code.ts';

test('formatScriptCode indents messy valid JS with two spaces and keeps strings', () => {
  const raw = 'function  f(){const s="keep  {this}";if(s){return {a:1,b:[1,2]}}}';
  const { text, formatted } = formatScriptCode(raw);
  assert.equal(formatted, true);
  assert.ok(text.includes('\n'), 'single-line input becomes multi-line');
  assert.match(text, /^ {2}if \(s\) \{$/m);
  assert.ok(text.includes('"keep  {this}"'), 'string literals are not rewritten');

  const multiline = formatScriptCode('function g(){\nreturn 1;\n}\n');
  assert.match(multiline.text, /^ {2}return 1;$/m);
});

test('formatScriptCode leaves empty and whitespace-only input alone', () => {
  assert.deepEqual(formatScriptCode(''), { text: '', formatted: false });
  assert.deepEqual(formatScriptCode('  \n\t '), { text: '  \n\t ', formatted: false });
});

test('formatScriptCode returns invalid JS unchanged without throwing', () => {
  const invalid = 'const x = ;';
  assert.doesNotThrow(() => formatScriptCode(invalid));
  assert.deepEqual(formatScriptCode(invalid), { text: invalid, formatted: false });
});

test('formatScriptCode skips code over the size cap', () => {
  const large = 'const x = 1;'.repeat(20_000);
  assert.ok(large.length > 200_000);
  assert.deepEqual(formatScriptCode(large), { text: large, formatted: false });
});
