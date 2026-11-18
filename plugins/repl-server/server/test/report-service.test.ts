import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { openStateDb } from '../src/db/migrate.ts';
import {
  AlertRetryConflictError,
  ReportNotFoundError,
  ReportRateLimitError,
  ReportStatusConflictError,
  ReportValidationError,
  createReportService,
  validateReportInput,
  type ReportService,
} from '../src/reports/service.ts';
import { createDbReportStore } from '../src/reports/store.ts';
import type { ReportAuditSink, ReportInput, ReportStore } from '../src/reports/types.ts';

interface HarnessClock {
  now(): number;
  advance(ms: number): void;
}

interface Harness {
  db: DatabaseSync;
  store: ReportStore;
  service: ReportService;
  clock: HarnessClock;
  auditEvents: Array<Record<string, unknown>>;
  kicks: { count: number };
}

function harness(t: TestContext): Harness {
  const db = openStateDb(':memory:');
  t.after(() => db.close());

  let nowMs = Date.UTC(2026, 10, 18, 6, 0, 0);
  const clock: HarnessClock = {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
    },
  };
  const auditEvents: Array<Record<string, unknown>> = [];
  const kicks = { count: 0 };
  const audit: ReportAuditSink = {
    write(event) {
      auditEvents.push(event);
    },
  };
  const store = createDbReportStore(db);
  const service = createReportService({
    db,
    alerts: { kick: () => (kicks.count += 1) },
    audit,
    clock,
  });
  return { db, store, service, clock, auditEvents, kicks };
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    source: 'mcp',
    title: 'Bash hangs while running npm test',
    detail: 'run_script never returns; cancel leaves the session busy.',
    severity: 'high',
    binding: 'cb_1',
    client: 'claude-code/2.1.327',
    mcp: 'mcp_1',
    exec: null,
    evalId: null,
    ownerKey: 'cb_1',
    ...overrides,
  };
}

function decode(cursor: string | null): { createdAt: string; id: string } {
  assert.ok(cursor !== null);
  const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
    ca: string;
    id: string;
  };
  return { createdAt: parsed.ca, id: parsed.id };
}

test('create maps identity fields, trims text and audits metadata only', async (t) => {
  const h = harness(t);
  const result = await h.service.create(
    input({ title: '  Bash hangs  ', context: { tool: 'Bash' } }),
  );

  assert.equal(result.duplicate, false);
  const report = result.report;
  assert.match(report.id, /^rep_[0-9a-f]{32}$/);
  assert.equal(report.source, 'mcp');
  assert.equal(report.binding, 'cb_1');
  assert.equal(report.client, 'claude-code/2.1.327');
  assert.equal(report.mcp, 'mcp_1');
  assert.equal(report.exec, null);
  assert.equal(report.evalId, null);
  assert.equal(report.ownerKey, 'cb_1');
  assert.equal(report.title, 'Bash hangs');
  assert.deepEqual(report.context, { tool: 'Bash' });
  assert.equal(report.status, 'open');
  assert.equal(report.alertState, 'pending');
  assert.equal(report.alertAttempts, 0);
  assert.equal(h.kicks.count, 1);

  assert.equal(h.auditEvents.length, 1);
  const event = h.auditEvents[0];
  assert.ok(event !== undefined);
  assert.equal(event['event'], 'report_created');
  assert.equal(event['reportId'], report.id);
  assert.equal(event['source'], 'mcp');
  assert.equal(event['severity'], 'high');
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /Bash hangs|run_script|tool/);
});

test('MCP dedupe is per owner and includes severity in the fingerprint', async (t) => {
  const h = harness(t);
  const first = await h.service.create(input());
  const second = await h.service.create(input({ detail: 'different detail' }));
  assert.equal(second.duplicate, false, 'detail changes the fingerprint');

  const same = await h.service.create(input());
  assert.equal(same.duplicate, true);
  assert.equal(same.report.id, first.report.id);

  const otherOwner = await h.service.create(input({ binding: 'cb_2', ownerKey: 'cb_2' }));
  assert.equal(otherOwner.duplicate, false);
  assert.notEqual(otherOwner.report.id, first.report.id);

  const escalated = await h.service.create(input({ severity: 'critical' }));
  assert.equal(escalated.duplicate, false);
  assert.notEqual(escalated.report.id, first.report.id);

  assert.equal(h.store.countOwnerReports('cb_1', '2026-01-01T00:00:00.000Z'), 3);
});

test('the dedupe window expires', async (t) => {
  const h = harness(t);
  const first = await h.service.create(input());
  h.clock.advance(10 * 60 * 1000 + 1);
  const second = await h.service.create(input());
  assert.equal(second.duplicate, false);
  assert.notEqual(second.report.id, first.report.id);
});

test('MCP rate limit blocks the 21st report in an hour', async (t) => {
  const h = harness(t);
  for (let index = 0; index < 20; index += 1) {
    await h.service.create(input({ title: `failure ${index}` }));
  }
  await assert.rejects(
    h.service.create(input({ title: 'failure 20' })),
    (error: unknown) =>
      error instanceof ReportRateLimitError &&
      error.code === 'REPORT_RATE_LIMITED' &&
      error.retryAfterMs > 0,
  );
});

test('admin submissions skip dedupe and rate limiting', async (t) => {
  const h = harness(t);
  const adminInput = input({
    source: 'admin',
    binding: null,
    client: 'admin',
    mcp: 'admin',
    ownerKey: 'admin',
  });
  const ids = new Set<string>();
  for (let index = 0; index < 25; index += 1) {
    const result = await h.service.create(adminInput);
    assert.equal(result.duplicate, false);
    ids.add(result.report.id);
  }
  assert.equal(ids.size, 25);
});

test('report status follows the frozen state machine', async (t) => {
  const h = harness(t);
  const created = await h.service.create(input());

  const acked = await h.service.patchStatus(created.report.id, 'ack');
  assert.equal(acked.status, 'ack');
  const closed = await h.service.patchStatus(created.report.id, 'closed');
  assert.equal(closed.status, 'closed');
  const reopened = await h.service.patchStatus(created.report.id, 'open');
  assert.equal(reopened.status, 'open');

  await h.service.patchStatus(created.report.id, 'closed');
  await assert.rejects(
    h.service.patchStatus(created.report.id, 'ack'),
    (error: unknown) =>
      error instanceof ReportStatusConflictError &&
      error.from === 'closed' &&
      error.to === 'ack',
  );

  const unchanged = await h.service.patchStatus(created.report.id, 'closed');
  assert.equal(unchanged.status, 'closed');

  await assert.rejects(
    h.service.patchStatus('rep_missing', 'ack'),
    (error: unknown) => error instanceof ReportNotFoundError,
  );
});

test('audit records report_status transitions without text', async (t) => {
  const h = harness(t);
  const created = await h.service.create(input());
  await h.service.patchStatus(created.report.id, 'ack');
  const statusEvents = h.auditEvents.filter((event) => event['event'] === 'report_status');
  assert.equal(statusEvents.length, 1);
  assert.equal(statusEvents[0]?.['from'], 'open');
  assert.equal(statusEvents[0]?.['to'], 'ack');
  assert.doesNotMatch(JSON.stringify(statusEvents), /Bash|run_script/);
});

test('list filters, sorts by created_at DESC and paginates with a keyset cursor', async (t) => {
  const h = harness(t);
  for (let index = 0; index < 5; index += 1) {
    await h.service.create(
      input({ title: `problem ${index}`, severity: index < 2 ? 'low' : 'high' }),
    );
    h.clock.advance(1_000);
  }

  const first = await h.service.list({ limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0]?.title, 'problem 4');
  assert.equal(first.items[1]?.title, 'problem 3');
  assert.ok(first.nextCursor !== null);

  // A newer row inserted between pages must not disturb the cursor walk.
  await h.service.create(input({ title: 'problem 5' }));

  const second = await h.service.list({ limit: 2, cursor: decode(first.nextCursor) });
  assert.deepEqual(
    second.items.map((report) => report.title),
    ['problem 2', 'problem 1'],
  );
  assert.ok(second.nextCursor !== null);
  const third = await h.service.list({ limit: 2, cursor: decode(second.nextCursor) });
  assert.deepEqual(third.items.map((report) => report.title), ['problem 0']);
  assert.equal(third.nextCursor, null);

  const low = await h.service.list({ limit: 10, severity: 'low' });
  assert.deepEqual(low.items.map((report) => report.title), ['problem 1', 'problem 0']);

  const none = await h.service.list({ limit: 10, source: 'admin' });
  assert.equal(none.items.length, 0);

  const from = await h.service.list({
    limit: 10,
    from: new Date(Date.UTC(2026, 10, 18, 6, 0, 2)).toISOString(),
  });
  assert.deepEqual(
    from.items.map((report) => report.title),
    ['problem 5', 'problem 4', 'problem 3', 'problem 2'],
  );
});

test('retry-alert only resets failed/skipped/no_webhook rows', async (t) => {
  const h = harness(t);
  const created = await h.service.create(input());

  h.db
    .prepare(
      "UPDATE reports SET alert_state = 'failed', alert_error = 'ALERT_HTTP_500: upstream returned HTTP 500', alert_attempts = 2 WHERE id = ?",
    )
    .run(created.report.id);

  const retried = await h.service.retryAlert(created.report.id);
  assert.equal(retried.alertState, 'pending');
  assert.equal(retried.alertError, null);
  assert.equal(retried.alertAttempts, 2, 'attempts are preserved');

  h.db.prepare("UPDATE reports SET alert_state = 'sent' WHERE id = ?").run(created.report.id);
  await assert.rejects(
    h.service.retryAlert(created.report.id),
    (error: unknown) => error instanceof AlertRetryConflictError,
  );

  await assert.rejects(
    h.service.retryAlert('rep_missing'),
    (error: unknown) => error instanceof ReportNotFoundError,
  );
});

test('validateReportInput enforces trim, code-point and context limits', () => {
  assert.throws(() => validateReportInput(input({ title: '   ' })), ReportValidationError);
  assert.throws(
    () => validateReportInput(input({ detail: 'x'.repeat(20_001) })),
    ReportValidationError,
  );
  assert.throws(() => validateReportInput(input({ context: [] })), ReportValidationError);
  assert.throws(
    () => validateReportInput(input({ context: { blob: 'x'.repeat(8_192) } })),
    ReportValidationError,
  );
  assert.throws(
    () => validateReportInput(input({ severity: 'urgent' as never })),
    ReportValidationError,
  );
  const emoji = validateReportInput(input({ title: '😀'.repeat(200) }));
  assert.equal([...emoji.title].length, 200);
});

test('patchAlert is compare-and-set on the expected alert state', async (t) => {
  const h = harness(t);
  const created = await h.service.create(input());

  assert.equal(
    h.store.patchAlert(created.report.id, 'sending', { state: 'sent', error: null }),
    false,
    'a guard mismatch must not overwrite the row',
  );
  assert.equal(h.store.get(created.report.id)?.alertState, 'pending');

  const claimed = h.store.claimPendingAlerts('2026-11-18T06:00:00.000Z', 10);
  assert.equal(claimed.length, 1);
  assert.equal(h.store.get(created.report.id)?.alertState, 'sending');
  assert.equal(
    h.store.patchAlert(created.report.id, 'pending', { state: 'sent', error: null }),
    false,
    'the stale guard no longer matches',
  );

  assert.equal(
    h.store.patchAlert(created.report.id, 'sending', {
      state: 'sent',
      error: null,
      attempts: 1,
      alertedAt: '2026-11-18T06:00:01.000Z',
    }),
    true,
  );
  const sent = h.store.get(created.report.id);
  assert.equal(sent?.alertState, 'sent');
  assert.equal(sent?.alertAttempts, 1);
  assert.equal(sent?.alertedAt, '2026-11-18T06:00:01.000Z');
});

test('store resets only the alert states it owns', async (t) => {
  const h = harness(t);
  const now = '2026-11-18T06:00:00.000Z';
  const first = await h.service.create(input());
  const second = await h.service.create(input({ title: 'second' }));

  h.db
    .prepare("UPDATE reports SET alert_state = 'sending', alert_updated_at = ? WHERE id = ?")
    .run('2026-11-18T05:58:00.000Z', first.report.id);
  h.db
    .prepare("UPDATE reports SET alert_state = 'sending', alert_updated_at = ? WHERE id = ?")
    .run(now, second.report.id);

  assert.equal(h.store.resetStaleSending('2026-11-18T05:59:00.000Z'), 1);
  assert.equal(h.store.get(first.report.id)?.alertState, 'pending');
  assert.equal(h.store.get(second.report.id)?.alertState, 'sending');

  assert.equal(h.store.resetAllSending(now), 1);
  assert.equal(h.store.get(second.report.id)?.alertState, 'pending');

  assert.equal(h.store.failStalePending('2026-11-19T00:00:00.000Z', now), 2);
  assert.equal(h.store.get(first.report.id)?.alertState, 'failed');
  assert.equal(h.store.get(first.report.id)?.alertError, 'ALERT_STALE');
  assert.equal(h.store.get(first.report.id)?.alertAttempts, 0);
});
