/** Admin API for problem reports (06 §5.1–§5.2). @module */

import {
  AdminApiError,
  adminHandler,
  adminJson,
  invalidField,
  queryValue,
  rejectUnknownFields,
  requestSegments,
  requireObjectBody,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from './servers.ts';
import {
  AlertRetryConflictError,
  ReportNotFoundError,
  ReportStatusConflictError,
  ReportValidationError,
  type ReportService,
} from '../reports/service.ts';
import { decodeReportCursor } from '../reports/store.ts';
import {
  REPORT_STATUS_VALUES,
  SEVERITY_VALUES,
  type ReportFilter,
  type ReportSource,
  type ReportStatus,
  type Severity,
  type StoredReport,
} from '../reports/types.ts';

export interface AdminReportsDeps {
  reports: ReportService;
}

const CREATE_FIELDS: ReadonlySet<string> = new Set(['title', 'detail', 'severity', 'context']);
const PATCH_FIELDS: ReadonlySet<string> = new Set(['status']);
const SOURCE_VALUES: readonly ReportSource[] = ['mcp', 'admin'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** List projection: 06 §5.2 keeps `detail`/`context` out of list responses. */
export function reportListView(report: StoredReport): Record<string, unknown> {
  return {
    id: report.id,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    source: report.source,
    binding: report.binding,
    client: report.client,
    clientName: report.clientName,
    clientVersion: report.clientVersion,
    mcp: report.mcp,
    exec: report.exec,
    evalId: report.evalId,
    severity: report.severity,
    title: report.title,
    status: report.status,
    alertState: report.alertState,
    alertError: report.alertError,
    alertAttempts: report.alertAttempts,
    alertUpdatedAt: report.alertUpdatedAt,
    alertedAt: report.alertedAt,
  };
}

/** Detail projection: adds `detail` and the parsed `context`. */
export function reportDetailView(report: StoredReport): Record<string, unknown> {
  return {
    ...reportListView(report),
    detail: report.detail,
    context: report.context,
  };
}

function translate(error: unknown): never {
  if (error instanceof ReportValidationError) {
    throw new AdminApiError(400, 'INVALID_BODY', error.message);
  }
  if (error instanceof ReportNotFoundError) {
    throw new AdminApiError(404, 'REPORT_NOT_FOUND', error.message, {
      reportId: error.reportId,
    });
  }
  if (error instanceof ReportStatusConflictError) {
    throw new AdminApiError(409, 'REPORT_STATUS_CONFLICT', error.message, {
      from: error.from,
      to: error.to,
    });
  }
  if (error instanceof AlertRetryConflictError) {
    throw new AdminApiError(409, 'ALERT_RETRY_CONFLICT', error.message, {
      alertState: error.alertState,
    });
  }
  throw error;
}

function invalidQuery(parameter: string, message?: string): AdminApiError {
  return new AdminApiError(
    400,
    'INVALID_QUERY',
    message ?? `${parameter} is not a valid query value`,
    { parameter },
  );
}

function readLimit(request: AdminRequest): number {
  const raw = queryValue(request, 'limit');
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw invalidQuery('limit', 'limit must be an integer between 1 and 200');
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw invalidQuery('limit', 'limit must be an integer between 1 and 200');
  }
  return value;
}

function readEnumQuery<T extends string>(
  request: AdminRequest,
  name: string,
  values: readonly T[],
): T | undefined {
  const raw = queryValue(request, name);
  if (raw === null || raw === '') return undefined;
  if (!values.includes(raw as T)) {
    throw invalidQuery(name, `${name} must be one of ${values.join(', ')}`);
  }
  return raw as T;
}

function readTimeQuery(request: AdminRequest, name: string): string | undefined {
  const raw = queryValue(request, name);
  if (raw === null || raw === '') return undefined;
  if (/^\d+$/.test(raw)) {
    const ms = Number.parseInt(raw, 10);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw invalidQuery(name, `${name} must be an ISO 8601 timestamp or epoch milliseconds`);
  }
  return new Date(parsed).toISOString();
}

function readListFilter(request: AdminRequest): ReportFilter {
  const filter: ReportFilter = { limit: readLimit(request) };

  const status = readEnumQuery(request, 'status', REPORT_STATUS_VALUES);
  if (status !== undefined) filter.status = status;
  const severity = readEnumQuery(request, 'severity', SEVERITY_VALUES);
  if (severity !== undefined) filter.severity = severity;
  const source = readEnumQuery(request, 'source', SOURCE_VALUES);
  if (source !== undefined) filter.source = source;

  const from = readTimeQuery(request, 'from');
  if (from !== undefined) filter.from = from;
  const to = readTimeQuery(request, 'to');
  if (to !== undefined) filter.to = to;

  const rawCursor = queryValue(request, 'cursor');
  if (rawCursor !== null && rawCursor !== '') {
    const cursor = decodeReportCursor(rawCursor);
    if (cursor === null) {
      throw new AdminApiError(400, 'INVALID_CURSOR', 'cursor is not a valid report cursor');
    }
    filter.cursor = cursor;
  }
  return filter;
}

/** `POST/GET /reports`, `GET/PATCH /reports/:id`, `POST /reports/:id/retry-alert`. */
export function createAdminReportsHandler(deps: AdminReportsDeps): AdminHandler {
  async function createReport(request: AdminRequest): Promise<AdminResponse> {
    const body = requireObjectBody(request);
    rejectUnknownFields(body, CREATE_FIELDS);

    const severity = body['severity'];
    if (typeof severity !== 'string' || !SEVERITY_VALUES.includes(severity as Severity)) {
      throw invalidField('severity', 'must be "low", "medium", "high" or "critical"');
    }
    const title = body['title'];
    if (typeof title !== 'string') throw invalidField('title', 'must be a string');
    const detail = body['detail'];
    if (typeof detail !== 'string') throw invalidField('detail', 'must be a string');

    const input = {
      source: 'admin' as const,
      title,
      detail,
      severity: severity as Severity,
      binding: null,
      client: 'admin',
      clientName: 'admin',
      clientVersion: '',
      mcp: 'admin',
      exec: null,
      evalId: null,
      ownerKey: 'admin',
      ...('context' in body ? { context: body['context'] } : {}),
    };

    try {
      const result = await deps.reports.create(input);
      return adminJson(201, { report: reportDetailView(result.report) });
    } catch (error) {
      translate(error);
    }
  }

  async function listReports(request: AdminRequest): Promise<AdminResponse> {
    const filter = readListFilter(request);
    const page = await deps.reports.list(filter);
    return adminJson(200, {
      items: page.items.map(reportListView),
      nextCursor: page.nextCursor,
    });
  }

  async function getReport(id: string): Promise<AdminResponse> {
    const report = await deps.reports.get(id);
    if (report === null) {
      throw new AdminApiError(404, 'REPORT_NOT_FOUND', `report ${id} does not exist`, {
        reportId: id,
      });
    }
    return adminJson(200, { report: reportDetailView(report) });
  }

  async function patchReport(id: string, request: AdminRequest): Promise<AdminResponse> {
    const body = requireObjectBody(request);
    rejectUnknownFields(body, PATCH_FIELDS);
    if (!('status' in body)) {
      throw new AdminApiError(400, 'INVALID_BODY', 'status is required');
    }
    const raw = body['status'];
    if (typeof raw !== 'string' || !REPORT_STATUS_VALUES.includes(raw as ReportStatus)) {
      throw invalidField('status', 'must be "open", "ack" or "closed"');
    }

    try {
      const report = await deps.reports.patchStatus(id, raw as ReportStatus);
      return adminJson(200, { report: reportDetailView(report) });
    } catch (error) {
      translate(error);
    }
  }

  async function retryAlert(id: string): Promise<AdminResponse> {
    try {
      const report = await deps.reports.retryAlert(id);
      return adminJson(200, { report: reportDetailView(report) });
    } catch (error) {
      translate(error);
    }
  }

  return adminHandler(async (request): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    if (segments[0] !== 'reports') return null;
    const method = request.method.toUpperCase();

    if (segments.length === 1) {
      if (method === 'GET') return listReports(request);
      if (method === 'POST') return createReport(request);
      return null;
    }

    const id = segments[1];
    if (id === undefined) return null;

    if (segments.length === 2) {
      if (method === 'GET') return getReport(id);
      if (method === 'PATCH') return patchReport(id, request);
      return null;
    }

    if (segments.length === 3 && segments[2] === 'retry-alert' && method === 'POST') {
      return retryAlert(id);
    }
    return null;
  });
}
