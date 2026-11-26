import assert from 'node:assert/strict';
import test from 'node:test';

import {
  eventDedupeKey,
  eventWindow,
  isAsyncResponse,
  isProtocolFrame,
  matchesDetailKeys,
  requestDetailKeys,
  requestRowKey,
  requestRunIds,
  sameRequest,
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

test('toolCallOutcome falls back to resultIsError when the result body is externalised', () => {
  assert.deepEqual(
    toolCallOutcome({ result: { content: [{ type: 'text', text: 'ok' }], isError: false } }),
    { ok: true },
    'inline result still wins',
  );
  assert.deepEqual(toolCallOutcome({ ok: true, resultIsError: false }), { ok: true });
  assert.deepEqual(toolCallOutcome({ ok: true, resultIsError: true }), { ok: false });
  assert.equal(toolCallOutcome({ ok: true }), null, 'neither result nor resultIsError');
});

test('requestDetailKeys links an async dispatch through evalTaskId', () => {
  const events = [
    { event: 'eval_start', requestId: 7, runId: 'r-1' },
    { event: 'async_dispatch', requestId: 7, evalTaskId: 'task_a' },
    { event: 'async_dispatch', requestId: '7', evalTaskId: 'task_b' },
    { event: 'async_dispatch', requestId: 8, evalTaskId: 'task_other' },
    // `async_dispatch` carries no runId, so this must not be the only link.
    { event: 'tool_call', requestId: 7, runId: 'r-1' },
  ];
  assert.deepEqual(requestDetailKeys(events, 7), { runIds: ['r-1'], taskIds: ['task_a', 'task_b'] });
  assert.deepEqual(requestDetailKeys(events, null), { runIds: [], taskIds: [] });
});

test('matchesDetailKeys follows the open panel by runId or task id', () => {
  const keys = { runIds: ['r-1'], taskIds: ['task_a'] };
  assert.equal(matchesDetailKeys({ event: 'tool_result', runId: 'r-1' }, keys), true);
  assert.equal(matchesDetailKeys({ event: 'eval_end', runId: 'r-2' }, keys), false);
  assert.equal(matchesDetailKeys({ event: 'task_cancel', taskId: 'task_a' }, keys), true);
  assert.equal(matchesDetailKeys({ event: 'task_settle', evalTaskId: 'task_a' }, keys), true);
  assert.equal(matchesDetailKeys({ event: 'tool_result', runId: 'r-1' }, { runIds: [], taskIds: [] }), false);
  assert.equal(matchesDetailKeys(null, keys), false);
});

test('requestRowKey survives a reload and separates reused ids by request time', () => {
  const at = '2026-11-20T10:00:00.000Z';
  const pair = { mcp: 'default', id: 7, request: { ts: at }, response: null };
  const reloaded = {
    ...pair,
    response: { ts: '2026-11-20T10:00:00.300Z' },
  };
  assert.equal(requestRowKey(pair), requestRowKey(reloaded), 'same frame, later response');
  assert.notEqual(
    requestRowKey(pair),
    requestRowKey({ ...pair, request: { ts: '2026-11-20T10:05:00.000Z' } }),
    'reused JSON-RPC id in a later session',
  );
  assert.notEqual(requestRowKey(pair), requestRowKey({ ...pair, mcp: 'other' }));
  assert.notEqual(
    requestRowKey(pair),
    requestRowKey({ ...pair, id: '7' }),
    'string and number ids are typed differently',
  );
  assert.equal(
    requestRowKey({ mcp: 'default', id: null, request: { ts: at }, response: null }),
    requestRowKey({ mcp: 'default', id: null, request: { ts: at }, response: null }),
    'notifications have no id but still a timestamp',
  );
});

test('sameRequest separates a refresh from opening another request', () => {
  const at = '2026-11-20T10:00:00.000Z';
  const pair = { mcp: 'default', id: 7, request: { ts: at }, response: null };
  assert.equal(sameRequest(pair, { ...pair, response: { ts: at } }), true);
  assert.equal(sameRequest(pair, { ...pair, request: { ts: '2026-11-20T10:05:00.000Z' } }), false);
  assert.equal(sameRequest(pair, { ...pair, id: 8 }), false);
  assert.equal(sameRequest(null, pair), false);
  assert.equal(sameRequest(pair, null), false);
});

test('eventDedupeKey is stable for copies and distinct per audit row', () => {
  const event = { event: 'tool_call', ts: '2026-11-20T10:00:00.000Z', exec: 'e1', evalId: 1, seq: 1 };
  assert.equal(eventDedupeKey({ ...event }), eventDedupeKey(event));
  assert.notEqual(eventDedupeKey({ ...event, seq: 2 }), eventDedupeKey(event));
  assert.notEqual(
    eventDedupeKey({ ...event, ts: '2026-11-20T10:00:00.001Z' }),
    eventDedupeKey(event),
  );
  assert.notEqual(eventDedupeKey({ ...event, mcp: 'fs' }), eventDedupeKey(event));
});
