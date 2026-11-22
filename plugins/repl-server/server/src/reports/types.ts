/** Shared types for problem reports and their alert outbox (design 06 §2). @module */

import type { Clock } from '../ports.ts';

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type ReportSource = 'mcp' | 'admin';
export type ReportStatus = 'open' | 'ack' | 'closed';
export type AlertState = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped' | 'no_webhook';

/** Severity order used by the `minSeverity` rule (06 §4.1). */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});

export const SEVERITY_VALUES: readonly Severity[] = Object.freeze([
  'low',
  'medium',
  'high',
  'critical',
]);

export const REPORT_STATUS_VALUES: readonly ReportStatus[] = Object.freeze(['open', 'ack', 'closed']);

export const ALERT_STATE_VALUES: readonly AlertState[] = Object.freeze([
  'pending',
  'sending',
  'sent',
  'failed',
  'skipped',
  'no_webhook',
]);

/** `settings.alerts` shape; `events` is reserved for future event sources (06 §4.1). */
export interface AlertConfig {
  enabled: boolean;
  minSeverity: Severity;
  events: string[];
}

/** A report row exactly as stored; `context` is the parsed JSON object or `null`. */
export interface StoredReport {
  id: string;
  createdAt: string;
  updatedAt: string;
  source: ReportSource;
  binding: string | null;
  client: string;
  /** Parsed `clientInfo.name`; empty when the client reported none. */
  clientName: string;
  /** Parsed `clientInfo.version`; empty when the client reported none. */
  clientVersion: string;
  mcp: string;
  exec: string | null;
  evalId: number | null;
  ownerKey: string;
  severity: Severity;
  title: string;
  detail: string;
  context: unknown;
  fingerprint: string;
  status: ReportStatus;
  alertState: AlertState;
  alertError: string | null;
  alertAttempts: number;
  alertUpdatedAt: string | null;
  alertedAt: string | null;
  /** Admin-maintained handling note; never sent to alerts or audit (06 §2.2). */
  resolution: string | null;
  /** Set when the report last entered `closed`; cleared on reopen. */
  resolvedAt: string | null;
}

/** Insert payload; ids, timestamps and the fingerprint are computed by the service. */
export interface NewReportRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  source: ReportSource;
  binding: string | null;
  client: string;
  clientName?: string;
  clientVersion?: string;
  mcp: string;
  exec: string | null;
  evalId: number | null;
  ownerKey: string;
  severity: Severity;
  title: string;
  detail: string;
  contextJson: string | null;
  fingerprint: string;
}

export interface ReportInput {
  source: ReportSource;
  title: string;
  detail: string;
  severity: Severity;
  context?: unknown;
  binding: string | null;
  client: string;
  clientName?: string;
  clientVersion?: string;
  mcp: string;
  exec?: string | null;
  evalId?: number | null;
  ownerKey: string;
}

export interface ReportCursor {
  createdAt: string;
  id: string;
}

export interface ReportFilter {
  limit: number;
  cursor?: ReportCursor;
  status?: ReportStatus;
  severity?: Severity;
  source?: ReportSource;
  /** Inclusive lower bound on `created_at`, ISO 8601. */
  from?: string;
  /** Inclusive upper bound on `created_at`, ISO 8601. */
  to?: string;
}

export interface AlertPatch {
  state: AlertState;
  error: string | null;
  attempts?: number;
  alertedAt?: string | null;
  updatedAt?: string;
}

export interface ReportListPage {
  items: StoredReport[];
  nextCursor: string | null;
}

/** Persistence contract for `reports`; all methods are synchronous (node:sqlite). */
export interface ReportStore {
  insert(row: NewReportRow): StoredReport;
  get(id: string): StoredReport | null;
  list(filter: ReportFilter): ReportListPage;
  patchStatus(id: string, status: ReportStatus, at: string): StoredReport | null;
  /** Writes the handling note only; `null` clears it. */
  patchResolution(id: string, resolution: string | null, at: string): StoredReport | null;
  claimPendingAlerts(now: string, limit: number): StoredReport[];
  patchAlert(id: string, expected: AlertState, patch: AlertPatch): boolean;
  findDuplicate(ownerKey: string, fingerprint: string, since: string): StoredReport | null;
  countOwnerReports(ownerKey: string, since: string): number;
  resetAllSending(now: string): number;
  resetStaleSending(before: string): number;
  failStalePending(before: string, now?: string): number;
  /** Moves one of the retryable terminal states back to `pending` (06 §5.2). */
  resetAlertForRetry(id: string, at: string): boolean;
}

/** Narrow `settings.alerts` access; corrupt JSON is reported, not thrown (06 §4.1). */
export interface AlertSettingsStore {
  read(): Promise<{ raw: unknown; revision: number; corrupt: boolean }>;
  write(patch: { alerts: AlertConfig }, expectedRevision: number): Promise<number>;
}

/** Minimal audit sink accepted by the service and dispatcher. */
export interface ReportAuditSink {
  write(event: { event: string; ts?: string; [key: string]: unknown }): void;
}

export interface ReportLimits {
  dedupeWindowMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

export type SendOutcome =
  | { ok: true; attempts: number; httpStatus: number; errcode: 0 }
  | {
      ok: false;
      attempts: number;
      code: string;
      message: string;
      httpStatus?: number;
      errcode?: number;
      retryable: boolean;
      retryAfterMs?: number;
    };

export type AlertKicker = { kick(): void };

export type { Clock };
