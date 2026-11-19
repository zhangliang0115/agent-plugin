/** Audit display helpers: outcome mapping and `/audit/stream` payload tolerance. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditEventsFromStreamPayload,
  eventCancelled,
  eventStatus,
  type AuditEvent,
} from '../src/pages/audit.ts';

test('eventStatus maps ai_run outcome and keeps explicit status first', () => {
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'ai_run', outcome: 'error' }),
    'error',
  );
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'ai_run', outcome: 'ok' }),
    'ok',
  );
  assert.equal(
    eventStatus({
      ts: '2026-01-01T00:00:00.000Z',
      event: 'ai_run',
      outcome: 'error',
      status: 'timeout',
    }),
    'timeout',
  );
});

test('eventStatus keeps the frozen eval_end and tool_result mappings', () => {
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'eval_end', outcome: 'timeout' }),
    'timeout',
  );
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'eval_end', outcome: 'cancelled' }),
    'ok',
  );
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'eval_end', outcome: 'canceled' }),
    'ok',
  );
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'eval_end', outcome: 'failed' }),
    'ok',
  );
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'eval_end', outcome: 'worker_dead' }),
    'ok',
  );
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'tool_result', ok: false }),
    'error',
  );
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'tool_result', ok: true }),
    'ok',
  );
});

test('eventStatus never returns cancelled, even from an explicit status field', () => {
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'eval_end', status: 'cancelled' }),
    'ok',
  );
  assert.equal(
    eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'eval_end', status: 'canceled' }),
    'ok',
  );
  for (const status of ['ok', 'error', 'timeout']) {
    assert.equal(
      eventStatus({ ts: '2026-01-01T00:00:00.000Z', event: 'eval_end', status }),
      status,
    );
  }
});

test('eventCancelled is a display-only flag for cancelled outcomes', () => {
  const base: AuditEvent = { ts: '2026-01-01T00:00:00.000Z', event: 'eval_end' };
  assert.equal(eventCancelled({ ...base, outcome: 'cancelled' }), true);
  assert.equal(eventCancelled({ ...base, outcome: 'CANCELED' }), true);
  assert.equal(eventCancelled({ ...base, outcome: 'timeout' }), false);
  assert.equal(eventCancelled({ ...base, outcome: 'ok' }), false);
  assert.equal(eventCancelled({ ...base, outcome: 42 }), false);
});

test('auditEventsFromStreamPayload accepts one event, arrays and events wrappers', () => {
  const single: AuditEvent = {
    ts: '2026-01-01T00:00:00.000Z',
    event: 'ai_run',
    kind: 'annotate',
    serverId: 'pg',
    outcome: 'ok',
  };
  assert.deepEqual(auditEventsFromStreamPayload(single), [single]);
  assert.deepEqual(auditEventsFromStreamPayload([single, { nope: true }]), [single]);
  assert.deepEqual(auditEventsFromStreamPayload({ events: [single] }), [single]);
  assert.deepEqual(auditEventsFromStreamPayload(null), []);
  assert.deepEqual(auditEventsFromStreamPayload('not-json'), []);
});
