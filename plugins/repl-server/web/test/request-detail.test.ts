import assert from 'node:assert/strict';
import test from 'node:test';

import {
  eventWindow,
  isAsyncResponse,
  isProtocolFrame,
  requestRunIds,
  toolCallOutcome,
} from '../src/lib/request-detail.ts';

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

test('requestRunIds keeps only eval_start events for the request id', () => {
  const events = [
    { event: 'eval_start', requestId: 2, runId: 'r-a' },
    { event: 'eval_start', requestId: '2', runId: 'r-b' },
    { event: 'eval_start', requestId: 3, runId: 'r-other' },
    { event: 'tool_call', requestId: 2, runId: 'r-a' },
    { event: 'eval_start' },
  ];
  assert.deepEqual(requestRunIds(events, 2), ['r-a', 'r-b']);
  assert.deepEqual(requestRunIds(events, null), []);
  assert.deepEqual(requestRunIds(events, 9), []);
});

test('eventWindow drops the upper bound for async evals', () => {
  assert.deepEqual(eventWindow('2026-11-20T10:00:00.000Z', '2026-11-20T10:00:00.500Z', true), {
    from: '2026-11-20T09:59:58.000Z',
  });
});

test('toolCallOutcome separates protocol success from execution failure', () => {
  const text = (value: string, isError: boolean) => ({
    result: { content: [{ type: 'text', text: value }], isError },
    ok: true,
  });
  assert.deepEqual(toolCallOutcome(text('ok', false)), { ok: true });
  assert.deepEqual(
    toolCallOutcome(
      text(
        '<repl-output eval="0"><error>CAPACITY_EXCEEDED: exec_sessions_per_binding quota exceeded</error></repl-output>',
        true,
      ),
    ),
    {
      ok: false,
      code: 'CAPACITY_EXCEEDED',
      message: 'CAPACITY_EXCEEDED: exec_sessions_per_binding quota exceeded',
    },
  );
  assert.deepEqual(
    toolCallOutcome(text('{"ok":false,"error":{"code":"UNKNOWN_TOOL","message":"nope"}}', true)),
    {
      ok: false,
      code: 'UNKNOWN_TOOL',
      message: '{"ok":false,"error":{"code":"UNKNOWN_TOOL","message":"nope"}}',
    },
  );
  assert.equal(toolCallOutcome({ error: { code: 'INTERNAL' } }), null, 'JSON-RPC errors are not tool results');
  assert.equal(toolCallOutcome(null), null);
  assert.equal(toolCallOutcome({ result: {} }), null, 'no isError means no tool result');
});
