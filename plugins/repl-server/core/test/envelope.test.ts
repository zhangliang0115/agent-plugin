import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeText, renderEnvelope } from '../src/envelope.ts';

const LIMITS = { resultChars: 100, logChars: 100, errorChars: 100 };

test('renders eval, log and result', () => {
  assert.equal(
    renderEnvelope({ evalId: 3, log: 'hi', result: 'ok' }, LIMITS),
    '<repl-output eval="3"><log>hi</log><result>ok</result></repl-output>',
  );
});

test('renders async, task, reset and truncation attributes', () => {
  assert.equal(
    renderEnvelope(
      { evalId: 9, async: true, evalTaskId: 't_01J', reset: true, truncated: true },
      LIMITS,
    ),
    '<repl-output eval="9" async="true" task="t_01J" reset="1" truncated="1"></repl-output>',
  );
});

test('escapes text and attributes', () => {
  assert.equal(escapeText('a & <b>'), 'a &amp; &lt;b&gt;');
  assert.equal(
    renderEnvelope({ evalId: 1, result: 'a & <b>' }, LIMITS),
    '<repl-output eval="1"><result>a &amp; &lt;b&gt;</result></repl-output>',
  );
});

test('truncates escaped text without leaving a partial entity', () => {
  const rendered = renderEnvelope({ evalId: 1, result: '&'.repeat(10) }, { ...LIMITS, resultChars: 6 });
  assert.match(rendered, /\[truncated: \d+ more characters\]/);
  assert.doesNotMatch(rendered, /&(?!amp;|lt;|gt;|quot;)/);
});

test('renders an error child', () => {
  assert.equal(
    renderEnvelope({ evalId: 2, error: 'boom' }, LIMITS),
    '<repl-output eval="2"><error>boom</error></repl-output>',
  );
});
