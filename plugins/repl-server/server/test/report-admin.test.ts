import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { openStateDb } from '../src/db/migrate.ts';
import { createAdminReportsHandler } from '../src/admin/reports.ts';
import type { AdminHandler, AdminRequest, AdminResponse } from '../src/admin/servers.ts';
import { createReportService, type ReportService } from '../src/reports/service.ts';
import { createDbReportStore } from '../src/reports/store.ts';

interface Harness {
  db: DatabaseSync;
  service: ReportService;
  handler: AdminHandler;
  clock: { now(): number; advance(ms: number): void };
}

function harness(t: TestContext): Harness {
  const db = openStateDb(':memory:');
  t.after(() => db.close());
  let nowMs = Date.UTC(2026, 10, 18, 6, 0, 0);
  const clock = {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
  const service = createReportService({
    store: createDbReportStore(db),
    alerts: { kick: () => undefined },
    clock,
  });
  const handler = createAdminReportsHandler({ reports: service });
  return { db, service, handler, clock };
}

interface CallOptions {
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

async function call(
  handler: AdminHandler,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<AdminResponse> {
  const request: AdminRequest = {
    method,
    path,
    query: options.query === undefined ? undefined : new URLSearchParams(options.query),
    headers: options.headers,
    body: options.body,
  };
  const response = await handler(request);
  assert.ok(response !== null, `no response for ${method} ${path}`);
  return response;
}

function bodyOf(response: AdminResponse): Record<string, unknown> {
  assert.ok(response.body !== null && typeof response.body === 'object');
  return response.body as Record<string, unknown>;
}

async function create(
  h: Harness,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await call(h.handler, 'POST', '/admin/api/reports', {
    body: {
      title: 'Bash hangs',
      detail: 'npm test never returns',
      severity: 'high',
      ...overrides,
    },
  });
  assert.equal(response.status, 201);
  const report = bodyOf(response)['report'];
  assert.ok(report !== null && typeof report === 'object');
  return report as Record<string, unknown>;
}

test('POST /reports stores an admin-identity report and returns the detail view', async (t) => {
  const h = harness(t);
  const report = await create(h, { context: { workspace: '/repo/a' } });

  assert.equal(report['source'], 'admin');
  assert.equal(report['binding'], null);
  assert.equal(report['client'], 'admin');
  assert.equal(report['clientName'], 'admin');
  assert.equal(report['clientVersion'], '');
  assert.equal(report['mcp'], 'admin');
  assert.equal(report['exec'], null);
  assert.equal(report['evalId'], null);
  assert.equal(report['ownerKey'], undefined, 'internal fields are not exposed');
  assert.equal(report['fingerprint'], undefined);
  assert.deepEqual(report['context'], { workspace: '/repo/a' });
  assert.equal(report['detail'], 'npm test never returns');

  const stored = await h.service.get(report['id'] as string);
  assert.equal(stored?.source, 'admin');
  assert.equal(stored?.ownerKey, 'admin');
});

test('POST /reports rejects unknown and malformed fields', async (t) => {
  const h = harness(t);
  const unknown = await call(h.handler, 'POST', '/admin/api/reports', {
    body: { title: 't', detail: 'd', severity: 'high', extra: 1 },
  });
  assert.equal(unknown.status, 400);
  assert.equal((bodyOf(unknown)['error'] as { code: string }).code, 'UNKNOWN_FIELD');

  const missing = await call(h.handler, 'POST', '/admin/api/reports', {
    body: { title: 't', detail: 'd' },
  });
  assert.equal(missing.status, 400);
  assert.equal((bodyOf(missing)['error'] as { code: string }).code, 'INVALID_FIELD');

  const badSeverity = await call(h.handler, 'POST', '/admin/api/reports', {
    body: { title: 't', detail: 'd', severity: 'urgent' },
  });
  assert.equal(badSeverity.status, 400);

  const badContext = await call(h.handler, 'POST', '/admin/api/reports', {
    body: { title: 't', detail: 'd', severity: 'high', context: [] },
  });
  assert.equal(badContext.status, 400);
  assert.equal((bodyOf(badContext)['error'] as { code: string }).code, 'INVALID_BODY');

  const invalidJson = await call(h.handler, 'POST', '/admin/api/reports', {
    body: '{not json',
  });
  assert.equal(invalidJson.status, 400);
  assert.equal((bodyOf(invalidJson)['error'] as { code: string }).code, 'INVALID_JSON');
});

test('GET /reports filters, paginates and omits detail/context from the list', async (t) => {
  const h = harness(t);
  const created: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const report = await create(h, { title: `problem ${index}` });
    created.push(report['id'] as string);
    h.clock.advance(1_000);
  }

  const list = await call(h.handler, 'GET', '/admin/api/reports', {
    query: { limit: '2', source: 'admin' },
  });
  assert.equal(list.status, 200);
  const page = bodyOf(list);
  const items = page['items'] as Array<Record<string, unknown>>;
  assert.equal(items.length, 2);
  assert.equal('detail' in (items[0] ?? {}), false);
  assert.equal('context' in (items[0] ?? {}), false);
  assert.equal(typeof page['nextCursor'], 'string');

  const next = await call(h.handler, 'GET', '/admin/api/reports', {
    query: { limit: '2', cursor: page['nextCursor'] as string },
  });
  const nextItems = bodyOf(next)['items'] as Array<Record<string, unknown>>;
  assert.equal(nextItems.length, 1);
  assert.equal(nextItems[0]?.['id'], created[0]);

  for (const query of [{ limit: '0' }, { limit: '201' }, { limit: 'x' }]) {
    const response = await call(h.handler, 'GET', '/admin/api/reports', { query });
    assert.equal(response.status, 400);
    assert.equal((bodyOf(response)['error'] as { code: string }).code, 'INVALID_QUERY');
  }
  const badStatus = await call(h.handler, 'GET', '/admin/api/reports', {
    query: { status: 'done' },
  });
  assert.equal(badStatus.status, 400);

  const badCursor = await call(h.handler, 'GET', '/admin/api/reports', {
    query: { cursor: 'not-a-cursor' },
  });
  assert.equal(badCursor.status, 400);
  assert.equal((bodyOf(badCursor)['error'] as { code: string }).code, 'INVALID_CURSOR');

  const badTime = await call(h.handler, 'GET', '/admin/api/reports', {
    query: { from: 'yesterday' },
  });
  assert.equal(badTime.status, 400);
});

test('GET /reports/:id returns detail/context and 404s for unknown ids', async (t) => {
  const h = harness(t);
  const created = await create(h, { context: { tool: 'Bash' } });

  const detail = await call(h.handler, 'GET', `/admin/api/reports/${created['id'] as string}`);
  assert.equal(detail.status, 200);
  const report = bodyOf(detail)['report'] as Record<string, unknown>;
  assert.equal(report['detail'], 'npm test never returns');
  assert.deepEqual(report['context'], { tool: 'Bash' });

  const missing = await call(h.handler, 'GET', '/admin/api/reports/rep_missing');
  assert.equal(missing.status, 404);
  assert.equal((bodyOf(missing)['error'] as { code: string }).code, 'REPORT_NOT_FOUND');
});

test('PATCH /reports/:id enforces the state machine and rejects unknown fields', async (t) => {
  const h = harness(t);
  const created = await create(h);
  const id = created['id'] as string;

  const ack = await call(h.handler, 'PATCH', `/admin/api/reports/${id}`, {
    body: { status: 'ack' },
  });
  assert.equal(ack.status, 200);
  assert.equal((bodyOf(ack)['report'] as Record<string, unknown>)['status'], 'ack');

  const closed = await call(h.handler, 'PATCH', `/admin/api/reports/${id}`, {
    body: { status: 'closed' },
  });
  assert.equal(closed.status, 200);

  const conflict = await call(h.handler, 'PATCH', `/admin/api/reports/${id}`, {
    body: { status: 'ack' },
  });
  assert.equal(conflict.status, 409);
  const error = bodyOf(conflict)['error'] as { code: string; details: unknown };
  assert.equal(error.code, 'REPORT_STATUS_CONFLICT');
  assert.deepEqual(error.details, { from: 'closed', to: 'ack' });

  const bad = await call(h.handler, 'PATCH', `/admin/api/reports/${id}`, {
    body: { status: 'done' },
  });
  assert.equal(bad.status, 400);

  const unknown = await call(h.handler, 'PATCH', `/admin/api/reports/${id}`, {
    body: { status: 'open', note: 'x' },
  });
  assert.equal(unknown.status, 400);
  assert.equal((bodyOf(unknown)['error'] as { code: string }).code, 'UNKNOWN_FIELD');

  const missingId = await call(h.handler, 'PATCH', '/admin/api/reports/rep_missing', {
    body: { status: 'ack' },
  });
  assert.equal(missingId.status, 404);
});

test('POST /reports/:id/retry-alert resets only retryable terminal states', async (t) => {
  const h = harness(t);
  const created = await create(h);
  const id = created['id'] as string;

  const pendingConflict = await call(h.handler, 'POST', `/admin/api/reports/${id}/retry-alert`);
  assert.equal(pendingConflict.status, 409);
  const error = bodyOf(pendingConflict)['error'] as { code: string; details: unknown };
  assert.equal(error.code, 'ALERT_RETRY_CONFLICT');
  assert.deepEqual(error.details, { alertState: 'pending' });

  h.db
    .prepare("UPDATE reports SET alert_state = 'skipped', alert_error = 'ALERTS_DISABLED' WHERE id = ?")
    .run(id);
  const retried = await call(h.handler, 'POST', `/admin/api/reports/${id}/retry-alert`);
  assert.equal(retried.status, 200);
  assert.equal((bodyOf(retried)['report'] as Record<string, unknown>)['alertState'], 'pending');

  const missing = await call(h.handler, 'POST', '/admin/api/reports/rep_missing/retry-alert');
  assert.equal(missing.status, 404);
});

test('unknown report routes fall through to the next handler', async (t) => {
  const h = harness(t);
  assert.equal(await h.handler({ method: 'GET', path: '/servers' }), null);
  assert.equal(await h.handler({ method: 'DELETE', path: '/reports' }), null);
});
