import assert from 'node:assert/strict';
import test from 'node:test';

import { eventWindow, isAsyncResponse, isProtocolFrame } from '../src/lib/request-detail.ts';

test('isProtocolFrame recognizes only the two protocol directions', () => {
  assert.equal(isProtocolFrame({ event: 'proto_in' }), true);
  assert.equal(isProtocolFrame({ event: 'proto_out' }), true);
  assert.equal(isProtocolFrame({ event: 'eval_start' }), false);
  assert.equal(isProtocolFrame(null), false);
  assert.equal(isProtocolFrame('proto_in'), false);
});

test('isAsyncResponse reads the async attribute from the envelope', () => {
  const content = (text: string) => ({ result: { content: [{ type: 'text', text }] } });
  assert.equal(isAsyncResponse(content('<repl-output eval="3" async="true" task="t1"></repl-output>')), true);
  assert.equal(isAsyncResponse(content('<repl-output eval="3"><result>ok</result></repl-output>')), false);
  assert.equal(isAsyncResponse(null), false);
  assert.equal(isAsyncResponse({ result: { content: [] } }), false);
});

test('eventWindow pads both request and response timestamps', () => {
  assert.deepEqual(
    eventWindow('2026-11-20T10:00:00.000Z', '2026-11-20T10:00:05.000Z'),
    { from: '2026-11-20T09:59:58.000Z', to: '2026-11-20T10:00:07.000Z' },
  );
  assert.deepEqual(eventWindow(undefined, '2026-11-20T10:00:05.000Z'), {
    from: '2026-11-20T10:00:03.000Z',
    to: '2026-11-20T10:00:07.000Z',
  });
  assert.deepEqual(eventWindow('bad', null), {});
});

test('eventWindow drops the upper bound for async evals', () => {
  assert.deepEqual(eventWindow('2026-11-20T10:00:00.000Z', '2026-11-20T10:00:00.500Z', true), {
    from: '2026-11-20T09:59:58.000Z',
  });
});
