/** Stable tag colors shared by the server/tool lists and the tag pickers. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { tagColor } from '../src/lib/tag-color.ts';

const FALLBACK_COLORS = ['blue', 'geekblue', 'purple', 'cyan', 'green', 'lime', 'magenta'];

test('semantic keys keep their fixed colors', () => {
  assert.equal(tagColor('env.dev'), 'green');
  assert.equal(tagColor('env.test'), 'cyan');
  assert.equal(tagColor('env.pre'), 'gold');
  assert.equal(tagColor('env.prod'), 'red');
  assert.equal(tagColor('cross-env'), 'purple');
  assert.equal(tagColor('official'), 'gold');
  assert.equal(tagColor('builtin'), 'purple');
  assert.equal(tagColor('read'), 'blue');
  assert.equal(tagColor('write'), 'orange');
  assert.equal(tagColor('destructive'), 'red');
  assert.equal(tagColor('security'), 'volcano');
});

test('unknown keys hash into the fallback palette, not the semantic colors', () => {
  for (const key of ['db', 'database', 'cache', '搜索', '']) {
    const color = tagColor(key);
    assert.ok(FALLBACK_COLORS.includes(color), `${key} -> ${color}`);
  }
});

test('prototype member names hash into the fallback palette instead of resolving', () => {
  for (const key of ['constructor', 'toString', '__proto__']) {
    const color = tagColor(key);
    assert.ok(FALLBACK_COLORS.includes(color), `${key} -> ${String(color)}`);
  }
});

test('unknown keys are stable across calls and sessions', () => {
  assert.equal(tagColor('db'), tagColor('db'));
  assert.equal(tagColor('db'), 'cyan');
  assert.equal(tagColor('cache'), 'lime');
});
