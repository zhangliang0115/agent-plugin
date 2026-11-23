import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { openStateDb } from '../src/db/migrate.ts';
import { createDbReportStore } from '../src/reports/store.ts';
import type { NewReportRow, ReportStore } from '../src/reports/types.ts';

function fixture(t: TestContext): { db: DatabaseSync; store: ReportStore } {
  const dir = mkdtempSync(join(tmpdir(), 'repl-server-reports-'));
  const db = openStateDb(join(dir, 'state.db'));
  t.after(() => {
    try {
      db.close();
    } catch {
      // closed by the test
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, store: createDbReportStore(db) };
}

let counter = 0;

function row(createdAt: string, overrides: Partial<NewReportRow> = {}): NewReportRow {
  counter += 1;
  return {
    id: `rep_${counter.toString(16).padStart(32, '0')}`,
    createdAt,
    updatedAt: createdAt,
    source: 'mcp',
    binding: null,
    client: 'test-client/1.0',
    mcp: 'mcp_reports',
    exec: null,
    evalId: null,
    ownerKey: 'mcp_reports',
    severity: 'low',
    title: `report ${counter}`,
    detail: 'detail',
    contextJson: null,
    fingerprint: `fp_${counter}`,
    ...overrides,
  };
}

function close(store: ReportStore, id: string, at: string): void {
  store.patchStatus(id, 'closed', at);
  store.patchAlert(id, 'pending', { state: 'sent', error: null, alertedAt: at });
}

function countRows(db: DatabaseSync): number {
  return Number(db.prepare('SELECT count(*) AS n FROM reports').get()?.['n'] ?? 0);
}

test('retention drops only closed reports older than the cutoff', (t) => {
  const { db, store } = fixture(t);
  const cutoff = '2026-06-01T00:00:00.000Z';

  const oldClosed = row('2026-01-01T00:00:00.000Z');
  const oldOpen = row('2026-01-02T00:00:00.000Z');
  const oldAck = row('2026-01-03T00:00:00.000Z');
  const recentClosed = row('2026-10-01T00:00:00.000Z');
  for (const report of [oldClosed, oldOpen, oldAck, recentClosed]) store.insert(report);

  close(store, oldClosed.id, '2026-01-05T00:00:00.000Z');
  close(store, recentClosed.id, '2026-10-05T00:00:00.000Z');
  store.patchStatus(oldAck.id, 'ack', '2026-01-04T00:00:00.000Z');

  assert.equal(store.prune({ before: cutoff, maxRows: 10_000 }), 1);
  assert.equal(countRows(db), 3);
  assert.equal(store.get(oldClosed.id), null);
  assert.notEqual(store.get(oldOpen.id), null);
  assert.notEqual(store.get(oldAck.id), null);
  assert.notEqual(store.get(recentClosed.id), null);
});

test('an unsent alert blocks retention even for a closed report', (t) => {
  const { db, store } = fixture(t);
  const report = row('2026-01-01T00:00:00.000Z');
  store.insert(report);
  // Closed by the operator before the alert left the outbox.
  store.patchStatus(report.id, 'closed', '2026-01-02T00:00:00.000Z');

  assert.equal(store.prune({ before: '2026-06-01T00:00:00.000Z', maxRows: 10_000 }), 0);
  assert.equal(countRows(db), 1);
});

test('the row cap removes the oldest closed reports first', (t) => {
  const { db, store } = fixture(t);
  const first = row('2026-01-01T00:00:00.000Z');
  const second = row('2026-02-01T00:00:00.000Z');
  const third = row('2026-03-01T00:00:00.000Z');
  for (const report of [first, second, third]) {
    store.insert(report);
    close(store, report.id, '2026-04-01T00:00:00.000Z');
  }

  assert.equal(store.prune({ before: '2020-01-01T00:00:00.000Z', maxRows: 2 }), 1);
  assert.equal(countRows(db), 2);
  assert.equal(store.get(first.id), null);
  assert.notEqual(store.get(second.id), null);
  assert.notEqual(store.get(third.id), null);
});
