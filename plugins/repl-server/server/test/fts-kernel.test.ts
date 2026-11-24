import assert from 'node:assert/strict';
import test from 'node:test';

import { toFtsMatch } from '../src/catalog/search.ts';
import { buildScriptsFtsQuery } from '../src/scripts/service.ts';
import {
  bm25Expression,
  buildFtsMatch,
  escapeLikeTerm,
  likeContainsPattern,
  quoteFtsTerm,
  tokenizeFts,
} from '../src/search/fts-kernel.ts';

/** Kernel rules: Han runs or letter/number runs, case kept, quotes doubled, prefix star. */

test('tokenizeFts splits mixed Han/Latin text and keeps token order', () => {
  assert.deepEqual(tokenizeFts('加法脚本 查询 文档', 32), ['加法脚本', '查询', '文档']);
  assert.deepEqual(tokenizeFts('run_script', 32), ['run', 'script']);
  assert.deepEqual(tokenizeFts('hello, "world"!', 32), ['hello', 'world']);
  assert.deepEqual(tokenizeFts('50%_off', 32), ['50', 'off']);
  assert.deepEqual(tokenizeFts('% _', 32), []);
});

test('tokenizeFts applies maxTerms after tokenizing the full text', () => {
  assert.deepEqual(tokenizeFts('a b c d', 2), ['a', 'b']);
  assert.deepEqual(tokenizeFts('a b c d', 32), ['a', 'b', 'c', 'd']);
  assert.deepEqual(tokenizeFts('', 32), []);
});

test('tokenizeFts preserves original case and duplicates', () => {
  assert.deepEqual(tokenizeFts('Foo BAR 加法 foo', 32), ['Foo', 'BAR', '加法', 'foo']);
});

test('quoteFtsTerm wraps, doubles embedded quotes, and adds a prefix star', () => {
  assert.equal(quoteFtsTerm('foo'), '"foo"*');
  assert.equal(quoteFtsTerm('foo"bar'), '"foo""bar"*');
  assert.equal(quoteFtsTerm('"'), '""""*');
});

test('buildFtsMatch joins with AND/OR and returns null for no tokens', () => {
  assert.equal(buildFtsMatch(['foo', 'bar'], 'AND'), '"foo"* "bar"*');
  assert.equal(buildFtsMatch(['foo', 'bar'], 'OR'), '"foo"* OR "bar"*');
  assert.equal(buildFtsMatch([], 'AND'), null);
  assert.equal(buildFtsMatch([], 'OR'), null);
});

test('bm25Expression renders the SQL fragment', () => {
  assert.equal(bm25Expression('tools_fts', [0, 3, 2.5, 1, 1.5, 2]), 'bm25(tools_fts, 0, 3, 2.5, 1, 1.5, 2)');
  assert.equal(bm25Expression('scripts_fts', [0, 3, 1, 2]), 'bm25(scripts_fts, 0, 3, 1, 2)');
});

test('escapeLikeTerm escapes backslash, percent and underscore in order', () => {
  assert.equal(escapeLikeTerm('plain'), 'plain');
  assert.equal(escapeLikeTerm('100%'), '100\\%');
  assert.equal(escapeLikeTerm('sql_'), 'sql\\_');
  assert.equal(escapeLikeTerm('a\\b'), 'a\\\\b');
  assert.equal(escapeLikeTerm('\\%_'), '\\\\\\%\\_');
});

test('likeContainsPattern wraps the escaped term for LIKE ... ESCAPE', () => {
  assert.equal(likeContainsPattern('100%'), '%100\\%%');
  assert.equal(likeContainsPattern('a_b\\c'), '%a\\_b\\\\c%');
});

test('scripts MATCH gold strings stay byte-identical to the old implementation', () => {
  const cases: Array<[string, string | null]> = [
    ['"', null],
    ['foo"bar', '"foo"* "bar"*'],
    ['加法脚本', '"加法脚本"*'],
    ['repor', '"repor"*'],
    ['查询 文档', '"查询"* "文档"*'],
    ['   ', null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(buildFtsMatch(tokenizeFts(input, 32), 'AND'), expected, input);
  }
});

test('catalog toFtsMatch gold strings', () => {
  assert.equal(toFtsMatch(['a', 'b']), '"a"* OR "b"*');
  assert.equal(toFtsMatch([]), '');
});

test('scripts entry buildScriptsFtsQuery keeps the old contract', () => {
  const cases: Array<[string, string | null]> = [
    ['"', null],
    ['foo"bar', '"foo"* "bar"*'],
    ['加法脚本', '"加法脚本"*'],
    ['repor', '"repor"*'],
    ['查询 文档', '"查询"* "文档"*'],
    ['   ', null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(buildScriptsFtsQuery(input), expected, input);
  }
});

test('scripts entry buildScriptsFtsQuery keeps only the first 32 tokens', () => {
  const many = Array.from({ length: 40 }, (_, index) => `w${index + 1}`).join(' ');
  const tokens = tokenizeFts(many, 32);
  assert.equal(tokens.length, 32);
  assert.equal(tokens[0], 'w1');
  assert.equal(tokens[31], 'w32');

  const query = buildScriptsFtsQuery(many);
  assert.ok(query !== null);
  const parts = query.split(' ');
  assert.equal(parts.length, 32);
  assert.equal(parts[0], '"w1"*');
  assert.equal(parts[31], '"w32"*');
  assert.ok(!query.includes('"w33"*'));
  assert.ok(!query.includes('"w40"*'));
});
