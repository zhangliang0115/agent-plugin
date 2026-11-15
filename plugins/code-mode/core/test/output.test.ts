import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEnvelope, truncateText, escapeText } from '../src/output.ts';

const limits = { resultChars: 20, logChars: 20, errorChars: 10 };

test('envelope carries the eval index and only the parts that exist', () => {
  assert.equal(renderEnvelope({ evalIndex: 3, result: '42' }, limits), '<repl-output eval="3"><result>42</result></repl-output>');
  assert.equal(renderEnvelope({ evalIndex: 4, log: 'a', result: 'b' }, limits), '<repl-output eval="4"><log>a</log><result>b</result></repl-output>');
  assert.equal(renderEnvelope({ evalIndex: 5, log: 'a', error: 'bad' }, limits), '<repl-output eval="5"><log>a</log><error>bad</error></repl-output>');
  assert.equal(renderEnvelope({ evalIndex: 6 }, limits), '<repl-output eval="6"></repl-output>');
});

test('output text is escaped so program text cannot forge envelope tags', () => {
  assert.equal(escapeText('</log><x>&'), '&lt;/log&gt;&lt;x&gt;&amp;');
  const out = renderEnvelope({ evalIndex: 1, log: '</log>' }, limits);
  assert.equal(out, '<repl-output eval="1"><log>&lt;/log&gt;</log></repl-output>');
});

test('oversized sections are truncated and marked with the removed character count', () => {
  const out = renderEnvelope({ evalIndex: 1, result: 'x'.repeat(25) }, limits);
  assert.equal(out, '<repl-output eval="1"><result>' + 'x'.repeat(20) + '\n[truncated: 5 more characters]</result></repl-output>');
  assert.equal(truncateText('abc', 3), 'abc');
  assert.equal(truncateText('abcd', 3), 'abc\n[truncated: 1 more characters]');
});

test('error text uses the smaller error limit', () => {
  const out = renderEnvelope({ evalIndex: 2, error: 'e'.repeat(12) }, limits);
  assert.equal(out, '<repl-output eval="2"><error>' + 'e'.repeat(10) + '\n[truncated: 2 more characters]</error></repl-output>');
});
