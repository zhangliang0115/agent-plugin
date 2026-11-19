/** `/admin/api/events` payload tolerance: aggregate snapshots and design-shaped frames. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOperationEvent, parseServerStateEvent } from '../src/pages/manage.ts';

test('parseServerStateEvent reads the aggregate entries snapshot', () => {
  assert.deepEqual(
    parseServerStateEvent({
      pool: { total: 2, ready: 1, reconnecting: 1, failed: 0 },
      entries: [
        { id: 'pg', state: 'ready', pid: 10, tools: 3, lastError: null },
        { id: 'gh', state: 'reconnecting', lastError: 'child_exit' },
        { id: '', state: 'ready' },
        'not-an-entry',
      ],
    }),
    [
      { id: 'pg', state: 'ready', lastError: null },
      { id: 'gh', state: 'reconnecting', lastError: 'child_exit' },
    ],
  );
});

test('parseServerStateEvent reads the per-server design frame', () => {
  assert.deepEqual(
    parseServerStateEvent({ id: 'pg', from: 'ready', to: 'reconnecting', reason: 'child_exit' }),
    [{ id: 'pg', state: 'reconnecting' }],
  );
  assert.deepEqual(parseServerStateEvent({ id: 'pg', to: 'failed', reason: 'spawn ENOENT' }), [
    { id: 'pg', state: 'failed', lastError: 'spawn ENOENT' },
  ]);
  assert.deepEqual(parseServerStateEvent({ to: 'ready' }), []);
  assert.deepEqual(parseServerStateEvent(null), []);
});

test('parseOperationEvent accepts operationId and id spellings', () => {
  assert.deepEqual(
    parseOperationEvent({ operationId: 'op_1', kind: 'restart', target: 'pg', state: 'ok' }),
    { operationId: 'op_1', state: 'ok' },
  );
  assert.deepEqual(parseOperationEvent({ id: 'op_2', state: 'error' }), {
    operationId: 'op_2',
    state: 'error',
  });
  assert.equal(parseOperationEvent({ state: 'ok' }), null);
  assert.equal(parseOperationEvent({ operationId: 'op_3' }), null);
  assert.equal(parseOperationEvent([]), null);
});
