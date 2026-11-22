import type { LogFn } from '../log.ts';
/** The single write pipeline shared by the MCP tool and the admin API (06 §3.3). @module */

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { systemClock, type Clock } from '../ports.ts';
import {
  DEDUPE_WINDOW_MS,
  MAX_CONTEXT_BYTES,
  MAX_DETAIL_CODE_POINTS,
  MAX_RESOLUTION_CODE_POINTS,
  MAX_TITLE_CODE_POINTS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  REPORT_ID_PREFIX,
} from './constants.ts';
import { createDbReportStore } from './store.ts';
import {
  SEVERITY_VALUES,
  type AlertKicker,
  type NewReportRow,
  type ReportAuditSink,
  type ReportFilter,
  type ReportInput,
  type ReportLimits,
  type ReportListPage,
  type ReportStatus,
  type ReportStore,
  type Severity,
  type StoredReport,
} from './types.ts';

/** Invalid title/detail/severity/context, before anything is written. */
export class ReportValidationError extends Error {
  readonly code = 'INVALID_ARGUMENT';
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ReportValidationError';
    this.field = field;
  }
}

/** Per-owner MCP budget exhausted (06 §3.4). */
export class ReportRateLimitError extends Error {
  readonly code = 'REPORT_RATE_LIMITED';
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('report rate limit exceeded; retry later');
    this.name = 'ReportRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class ReportNotFoundError extends Error {
  readonly code = 'REPORT_NOT_FOUND';
  readonly reportId: string;

  constructor(id: string) {
    super(`report ${id} does not exist`);
    this.name = 'ReportNotFoundError';
    this.reportId = id;
  }
}

export class ReportStatusConflictError extends Error {
  readonly code = 'REPORT_STATUS_CONFLICT';
  readonly from: ReportStatus;
  readonly to: ReportStatus;

  constructor(from: ReportStatus, to: ReportStatus) {
    super(`report status cannot change from ${from} to ${to}`);
    this.name = 'ReportStatusConflictError';
    this.from = from;
    this.to = to;
  }
}

export class AlertRetryConflictError extends Error {
  readonly code = 'ALERT_RETRY_CONFLICT';
  readonly alertState: string;

  constructor(alertState: string) {
    super(`alert state ${alertState} cannot be retried`);
    this.name = 'AlertRetryConflictError';
    this.alertState = alertState;
  }
}

export interface ReportService {
  create(input: ReportInput): Promise<{ report: StoredReport; duplicate: boolean }>;
  get(id: string): Promise<StoredReport | null>;
  list(filter: ReportFilter): Promise<ReportListPage>;
  /** Applies the 06 §2.3 state machine; a same-state PATCH is a no-op. */
  patchStatus(id: string, status: ReportStatus): Promise<StoredReport>;
  /** Replaces the handling note independently of status; empty clears it (06 §2.3). */
  patchResolution(id: string, resolution: string | null): Promise<StoredReport>;
  /** `failed` / `skipped` / `no_webhook` back to `pending` and kicks the dispatcher. */
  retryAlert(id: string): Promise<StoredReport>;
}

export interface ReportServiceDeps {
  db?: DatabaseSync;
  store?: ReportStore;
  alerts?: AlertKicker;
  audit?: ReportAuditSink;
  clock?: Clock;
  limits?: Partial<ReportLimits>;
  log?: LogFn;
}

export interface ValidatedReport {
  title: string;
  detail: string;
  severity: Severity;
  context: unknown;
  contextJson: string | null;
}

const RETRYABLE_ALERT_STATES: readonly string[] = ['failed', 'skipped', 'no_webhook'];

function codePointLength(value: string): number {
  return [...value].length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Final validation for both entry points; trims title/detail before storage. */
export function validateReportInput(input: ReportInput): ValidatedReport {
  const rawTitle = input.title;
  if (typeof rawTitle !== 'string') {
    throw new ReportValidationError('title must be a string', 'title');
  }
  const title = rawTitle.trim();
  if (title === '') {
    throw new ReportValidationError('title must not be empty', 'title');
  }
  if (codePointLength(title) > MAX_TITLE_CODE_POINTS) {
    throw new ReportValidationError(
      `title must be at most ${MAX_TITLE_CODE_POINTS} characters`,
      'title',
    );
  }

  const rawDetail = input.detail;
  if (typeof rawDetail !== 'string') {
    throw new ReportValidationError('detail must be a string', 'detail');
  }
  const detail = rawDetail.trim();
  if (detail === '') {
    throw new ReportValidationError('detail must not be empty', 'detail');
  }
  if (codePointLength(detail) > MAX_DETAIL_CODE_POINTS) {
    throw new ReportValidationError(
      `detail must be at most ${MAX_DETAIL_CODE_POINTS} characters`,
      'detail',
    );
  }

  if (!SEVERITY_VALUES.includes(input.severity)) {
    throw new ReportValidationError('severity must be low, medium, high or critical', 'severity');
  }

  let context: unknown = null;
  let contextJson: string | null = null;
  if (input.context !== undefined) {
    if (!isPlainObject(input.context)) {
      throw new ReportValidationError('context must be a JSON object', 'context');
    }
    context = input.context;
    try {
      contextJson = JSON.stringify(context);
    } catch {
      throw new ReportValidationError('context must be JSON-serializable', 'context');
    }
    if (contextJson === undefined) {
      throw new ReportValidationError('context must be JSON-serializable', 'context');
    }
    if (Buffer.byteLength(contextJson, 'utf8') > MAX_CONTEXT_BYTES) {
      throw new ReportValidationError(
        `context must be at most ${MAX_CONTEXT_BYTES} bytes as JSON`,
        'context',
      );
    }
  }

  return { title, detail, severity: input.severity, context, contextJson };
}

/** Trims the handling note and treats an empty result as "no note". */
export function normalizeResolution(resolution: string | null): string | null {
  if (resolution === null) return null;
  const text = resolution.trim();
  if (text === '') return null;
  if (codePointLength(text) > MAX_RESOLUTION_CODE_POINTS) {
    throw new ReportValidationError(
      `resolution must be at most ${MAX_RESOLUTION_CODE_POINTS} characters`,
      'resolution',
    );
  }
  return text;
}

/** `sha256(severity + '\n' + title + '\n' + detail)` over trimmed storage values. */
export function fingerprintOf(severity: Severity, title: string, detail: string): string {
  return createHash('sha256').update(`${severity}\n${title}\n${detail}`, 'utf8').digest('hex');
}

/** `rep_<32 hex>`; the core id registry has no report kind and is outside this module. */
export function newReportId(): string {
  return `${REPORT_ID_PREFIX}_${randomUUID().replaceAll('-', '')}`;
}

/**
 * Builds the shared report service. `db` is a convenience for assembly: when
 * `store` is omitted the SQLite repository from `reports/store.ts` is used.
 */
export function createReportService(deps: ReportServiceDeps): ReportService {
  let store = deps.store;
  if (store === undefined) {
    if (deps.db === undefined) {
      throw new Error('createReportService requires either `db` or `store`');
    }
    store = createDbReportStore(deps.db);
  }
  const activeStore: ReportStore = store;
  const clock = deps.clock ?? systemClock;
  const limits: ReportLimits = {
    dedupeWindowMs: deps.limits?.dedupeWindowMs ?? DEDUPE_WINDOW_MS,
    rateLimitWindowMs: deps.limits?.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS,
    rateLimitMax: deps.limits?.rateLimitMax ?? RATE_LIMIT_MAX,
  };
  const log = deps.log ?? ((): void => undefined);

  function nowIso(): string {
    return new Date(clock.now()).toISOString();
  }

  function record(fields: { event: string; [key: string]: unknown }): void {
    if (deps.audit === undefined) return;
    try {
      deps.audit.write({ ts: nowIso(), ...fields });
    } catch (error) {
      log(`report audit write failed: ${error instanceof Error ? error.message : String(error)}`, { level: 'error', scope: 'reports' });
    }
  }

  function kick(): void {
    if (deps.alerts === undefined) return;
    try {
      deps.alerts.kick();
    } catch (error) {
      log(`alert kick failed: ${error instanceof Error ? error.message : String(error)}`, { level: 'error', scope: 'reports' });
    }
  }

  return {
    async create(input) {
      const validated = validateReportInput(input);
      const nowMs = clock.now();
      const now = new Date(nowMs).toISOString();

      if (input.source === 'mcp') {
        const fingerprint = fingerprintOf(validated.severity, validated.title, validated.detail);
        const duplicateSince = new Date(nowMs - limits.dedupeWindowMs).toISOString();
        const duplicate = activeStore.findDuplicate(input.ownerKey, fingerprint, duplicateSince);
        if (duplicate !== null) {
          return { report: duplicate, duplicate: true };
        }

        const rateSince = new Date(nowMs - limits.rateLimitWindowMs).toISOString();
        if (activeStore.countOwnerReports(input.ownerKey, rateSince) >= limits.rateLimitMax) {
          throw new ReportRateLimitError(limits.rateLimitWindowMs);
        }
      }

      const fingerprint = fingerprintOf(validated.severity, validated.title, validated.detail);
      const row: NewReportRow = {
        id: newReportId(),
        createdAt: now,
        updatedAt: now,
        source: input.source,
        binding: input.binding,
        client: input.client,
        clientName: input.clientName ?? '',
        clientVersion: input.clientVersion ?? '',
        mcp: input.mcp,
        exec: input.exec ?? null,
        evalId: input.evalId ?? null,
        ownerKey: input.ownerKey,
        severity: validated.severity,
        title: validated.title,
        detail: validated.detail,
        contextJson: validated.contextJson,
        fingerprint,
      };

      const report = activeStore.insert(row);
      // Metadata only: never title, detail, context or webhook values (06 §4.6).
      record({
        event: 'report_created',
        reportId: report.id,
        source: report.source,
        severity: report.severity,
      });
      kick();
      return { report, duplicate: false };
    },

    async get(id) {
      return activeStore.get(id);
    },

    async list(filter) {
      return activeStore.list(filter);
    },

    async patchStatus(id, status) {
      const current = activeStore.get(id);
      if (current === null) throw new ReportNotFoundError(id);
      if (current.status === status) return current;
      if (current.status === 'closed' && status === 'ack') {
        throw new ReportStatusConflictError('closed', 'ack');
      }
      const updated = activeStore.patchStatus(id, status, nowIso());
      if (updated === null) throw new ReportNotFoundError(id);
      record({
        event: 'report_status',
        reportId: updated.id,
        from: current.status,
        to: updated.status,
      });
      return updated;
    },

    async patchResolution(id, resolution) {
      const stored = normalizeResolution(resolution);
      const updated = activeStore.patchResolution(id, stored, nowIso());
      if (updated === null) throw new ReportNotFoundError(id);
      record({
        event: 'report_resolution',
        reportId: updated.id,
        bytes: Buffer.byteLength(stored ?? '', 'utf8'),
        hasResolution: stored !== null,
      });
      return updated;
    },

    async retryAlert(id) {
      const current = activeStore.get(id);
      if (current === null) throw new ReportNotFoundError(id);
      if (!RETRYABLE_ALERT_STATES.includes(current.alertState)) {
        throw new AlertRetryConflictError(current.alertState);
      }
      const reset = activeStore.resetAlertForRetry(id, nowIso());
      if (!reset) {
        const latest = activeStore.get(id);
        if (latest === null) throw new ReportNotFoundError(id);
        throw new AlertRetryConflictError(latest.alertState);
      }
      kick();
      const updated = activeStore.get(id);
      if (updated === null) throw new ReportNotFoundError(id);
      return updated;
    },
  };
}
