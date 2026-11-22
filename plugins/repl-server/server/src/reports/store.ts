/** SQLite repository for the `reports` outbox table (schema v2). @module */

import type { DatabaseSync } from 'node:sqlite';

import { withTransaction } from '../db/migrate.ts';
import { readNumber, readText, type DbRow } from '../db/schema.ts';
import type {
  AlertPatch,
  AlertState,
  NewReportRow,
  ReportCursor,
  ReportFilter,
  ReportListPage,
  ReportSource,
  ReportStatus,
  ReportStore,
  Severity,
  StoredReport,
} from './types.ts';

const RETRYABLE_ALERT_STATES: readonly AlertState[] = Object.freeze([
  'failed',
  'skipped',
  'no_webhook',
]);

function nullableText(row: DbRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return String(value);
}

function nullableNumber(row: DbRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseContext(raw: string | null): unknown {
  if (raw === null || raw === '') return null;
  return JSON.parse(raw);
}

/** Maps one `reports` row to the service-facing shape. */
export function rowToReport(row: DbRow): StoredReport {
  return {
    id: readText(row, 'id') ?? '',
    createdAt: readText(row, 'created_at') ?? '',
    updatedAt: readText(row, 'updated_at') ?? '',
    source: (readText(row, 'source') ?? 'admin') as ReportSource,
    binding: nullableText(row, 'binding'),
    client: readText(row, 'client') ?? '',
    clientName: readText(row, 'client_name') ?? '',
    clientVersion: readText(row, 'client_version') ?? '',
    mcp: readText(row, 'mcp') ?? '',
    exec: nullableText(row, 'exec'),
    evalId: nullableNumber(row, 'eval_id'),
    ownerKey: readText(row, 'owner_key') ?? '',
    severity: (readText(row, 'severity') ?? 'low') as Severity,
    title: readText(row, 'title') ?? '',
    detail: readText(row, 'detail') ?? '',
    context: parseContext(nullableText(row, 'context_json')),
    fingerprint: readText(row, 'fingerprint') ?? '',
    status: (readText(row, 'status') ?? 'open') as ReportStatus,
    alertState: (readText(row, 'alert_state') ?? 'pending') as AlertState,
    alertError: nullableText(row, 'alert_error'),
    alertAttempts: readNumber(row, 'alert_attempts'),
    alertUpdatedAt: nullableText(row, 'alert_updated_at'),
    alertedAt: nullableText(row, 'alerted_at'),
    resolution: nullableText(row, 'resolution'),
    resolvedAt: nullableText(row, 'resolved_at'),
  };
}

/** `nextCursor` from 06 §5.2: standard base64 of `{ v: 1, ca, id }`. */
export function encodeReportCursor(cursor: ReportCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, ca: cursor.createdAt, id: cursor.id }),
    'utf8',
  ).toString('base64');
}

/** Returns `null` for anything that is not a valid v1 cursor. */
export function decodeReportCursor(raw: string): ReportCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== 1) return null;
  const createdAt = record['ca'];
  const id = record['id'];
  if (typeof createdAt !== 'string' || createdAt === '') return null;
  if (typeof id !== 'string' || id === '') return null;
  return { createdAt, id };
}

/** Builds the SQL store over an open `state.db` handle. */
export function createDbReportStore(db: DatabaseSync): ReportStore {
  const insertStatement = db.prepare(`
    INSERT INTO reports (
      id, created_at, updated_at, source, binding, client, client_name, client_version,
      mcp, exec, eval_id, owner_key, severity, title, detail, context_json, fingerprint,
      status, alert_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'pending')
  `);

  function get(id: string): StoredReport | null {
    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    return row === undefined ? null : rowToReport(row);
  }

  function insert(row: NewReportRow): StoredReport {
    insertStatement.run(
      row.id,
      row.createdAt,
      row.updatedAt,
      row.source,
      row.binding,
      row.client,
      row.clientName ?? '',
      row.clientVersion ?? '',
      row.mcp,
      row.exec,
      row.evalId,
      row.ownerKey,
      row.severity,
      row.title,
      row.detail,
      row.contextJson,
      row.fingerprint,
    );
    const stored = get(row.id);
    if (stored === null) throw new Error(`report ${row.id} disappeared after insert`);
    return stored;
  }

  function list(filter: ReportFilter): ReportListPage {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filter.cursor !== undefined) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(filter.cursor.createdAt, filter.cursor.createdAt, filter.cursor.id);
    }
    if (filter.status !== undefined) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.severity !== undefined) {
      where.push('severity = ?');
      params.push(filter.severity);
    }
    if (filter.source !== undefined) {
      where.push('source = ?');
      params.push(filter.source);
    }
    if (filter.from !== undefined) {
      where.push('created_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('created_at <= ?');
      params.push(filter.to);
    }

    // The WHERE fragments are fixed strings; every user value is bound below.
    const sql = `SELECT * FROM reports${
      where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    } ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, filter.limit + 1);

    const items = rows.slice(0, filter.limit).map(rowToReport);
    const hasMore = rows.length > filter.limit;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeReportCursor({ createdAt: last.createdAt, id: last.id })
        : null;
    return { items, nextCursor };
  }

  function patchStatus(id: string, status: ReportStatus, at: string): StoredReport | null {
    // Entering `closed` stamps the resolution time; reopening clears it (06 §2.3).
    const resolvedAt = status === 'closed' ? at : null;
    const result = db
      .prepare('UPDATE reports SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
      .run(status, resolvedAt, at, id);
    if (Number(result.changes) === 0) return null;
    return get(id);
  }

  function patchResolution(
    id: string,
    resolution: string | null,
    at: string,
  ): StoredReport | null {
    const result = db
      .prepare('UPDATE reports SET resolution = ?, updated_at = ? WHERE id = ?')
      .run(resolution, at, id);
    if (Number(result.changes) === 0) return null;
    return get(id);
  }

  function claimPendingAlerts(now: string, limit: number): StoredReport[] {
    if (limit <= 0) return [];
    return withTransaction(db, () => {
      const rows = db
        .prepare(
          "SELECT * FROM reports WHERE alert_state = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?",
        )
        .all(limit);
      const update = db.prepare(
        "UPDATE reports SET alert_state = 'sending', alert_updated_at = ? WHERE id = ? AND alert_state = 'pending'",
      );
      const claimed: StoredReport[] = [];
      for (const row of rows) {
        const id = readText(row, 'id');
        if (id === null) continue;
        const result = update.run(now, id);
        if (Number(result.changes) === 0) continue;
        claimed.push({ ...rowToReport(row), alertState: 'sending', alertUpdatedAt: now });
      }
      return claimed;
    });
  }

  function patchAlert(id: string, expected: AlertState, patch: AlertPatch): boolean {
    const sets = ['alert_state = ?', 'alert_error = ?', 'alert_updated_at = ?'];
    const params: Array<string | number | null> = [
      patch.state,
      patch.error,
      patch.updatedAt ?? new Date().toISOString(),
    ];
    if (patch.attempts !== undefined) {
      sets.push('alert_attempts = ?');
      params.push(patch.attempts);
    }
    if (patch.alertedAt !== undefined) {
      sets.push('alerted_at = ?');
      params.push(patch.alertedAt);
    }
    params.push(id, expected);
    const result = db
      .prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id = ? AND alert_state = ?`)
      .run(...params);
    return Number(result.changes) > 0;
  }

  function findDuplicate(
    ownerKey: string,
    fingerprint: string,
    since: string,
  ): StoredReport | null {
    const row = db
      .prepare(
        'SELECT * FROM reports WHERE owner_key = ? AND fingerprint = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(ownerKey, fingerprint, since);
    return row === undefined ? null : rowToReport(row);
  }

  function countOwnerReports(ownerKey: string, since: string): number {
    const row = db
      .prepare('SELECT count(*) AS n FROM reports WHERE owner_key = ? AND created_at >= ?')
      .get(ownerKey, since);
    return Number(row?.['n'] ?? 0);
  }

  function resetAllSending(now: string): number {
    const result = db
      .prepare(
        "UPDATE reports SET alert_state = 'pending', alert_error = NULL, alert_updated_at = ? WHERE alert_state = 'sending'",
      )
      .run(now);
    return Number(result.changes);
  }

  function resetStaleSending(before: string): number {
    const result = db
      .prepare(
        "UPDATE reports SET alert_state = 'pending', alert_error = NULL WHERE alert_state = 'sending' AND (alert_updated_at IS NULL OR alert_updated_at < ?)",
      )
      .run(before);
    return Number(result.changes);
  }

  function failStalePending(before: string, now = new Date().toISOString()): number {
    const result = db
      .prepare(
        "UPDATE reports SET alert_state = 'failed', alert_error = 'ALERT_STALE', alert_updated_at = ? WHERE alert_state = 'pending' AND created_at < ?",
      )
      .run(now, before);
    return Number(result.changes);
  }

  function resetAlertForRetry(id: string, at: string): boolean {
    // The placeholders come from a frozen constant list; state values are bound.
    const placeholders = RETRYABLE_ALERT_STATES.map(() => '?').join(', ');
    const result = db
      .prepare(
        `UPDATE reports SET alert_state = 'pending', alert_error = NULL, alert_updated_at = ? WHERE id = ? AND alert_state IN (${placeholders})`,
      )
      .run(at, id, ...RETRYABLE_ALERT_STATES);
    return Number(result.changes) > 0;
  }

  return {
    insert,
    get,
    list,
    patchStatus,
    patchResolution,
    claimPendingAlerts,
    patchAlert,
    findDuplicate,
    countOwnerReports,
    resetAllSending,
    resetStaleSending,
    failStalePending,
    resetAlertForRetry,
  };
}
