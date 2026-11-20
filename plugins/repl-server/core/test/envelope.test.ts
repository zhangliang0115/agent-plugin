import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeText, renderEnvelope } from '../src/envelope.ts';

test('renders eval, log and result', () => {
  assert.equal(
    renderEnvelope({ evalId: 3, log: 'hi', result: 'ok' }),
    '<repl-output eval="3"><log>hi</log><result>ok</result></repl-output>',
  );
});

test('renders async, task, reset and truncation attributes', () => {
  assert.equal(
    renderEnvelope({ evalId: 9, async: true, evalTaskId: 't_01J', reset: true, truncated: true }),
    '<repl-output eval="9" async="true" task="t_01J" reset="1" truncated="1"></repl-output>',
  );
});

test('escapes text and attributes', () => {
  assert.equal(escapeText('a & <b>'), 'a &amp; &lt;b&gt;');
  assert.equal(
    renderEnvelope({ evalId: 1, result: 'a & <b>' }),
    '<repl-output eval="1"><result>a &amp; &lt;b&gt;</result></repl-output>',
  );
});

test('large text is not truncated', () => {
  const result = '&'.repeat(10_000);
  const rendered = renderEnvelope({ evalId: 1, result });
  assert.ok(rendered.includes('&amp;'.repeat(10_000)));
  assert.doesNotMatch(rendered, /\[truncated:/);
});

test('renders an error child', () => {
  assert.equal(
    renderEnvelope({ evalId: 2, error: 'boom' }),
    '<repl-output eval="2"><error>boom</error></repl-output>',
  );
});
