/** Admin API for alert configuration, test sends and previews (06 §5.3). @module */

import { systemClock, type Clock } from '../ports.ts';
import { validateWebhookUrl, isKnownAlertEvent, normalizeAlertConfig } from '../reports/config.ts';
import { buildWecomMarkdown } from '../reports/wecom.ts';
import { SEVERITY_VALUES, type AlertConfig, type Severity } from '../reports/types.ts';
import type { AlertConfigStore } from '../alerts/config-store.ts';
import {
  AlertTestThrottledError,
  WebhookNotConfiguredError,
  WebhookUrlInvalidError,
} from '../alerts/errors.ts';
import type { AlertTestResult } from '../alerts/dispatcher.ts';
import {
  AdminApiError,
  adminHandler,
  adminJson,
  assertRevision,
  expectBoolean,
  invalidField,
  parseIfMatch,
  readJsonBody,
  rejectUnknownFields,
  requestSegments,
  requireObjectBody,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from './servers.ts';

export interface AlertTestSender {
  sendTest(): Promise<AlertTestResult>;
}

export interface AdminAlertsDeps {
  alerts: AlertConfigStore;
  /**
   * Sends `POST /alerts/test` through the shared dispatcher. Assembly always
   * wires it; when omitted, the test endpoint answers 500 rather than faking a
   * result. Preview and config routes do not need it.
   */
  dispatcher?: AlertTestSender;
  clock?: Clock;
}

const CONFIG_FIELDS: ReadonlySet<string> = new Set([
  'enabled',
  'minSeverity',
  'events',
  'webhook',
]);
const PREVIEW_FIELDS: ReadonlySet<string> = new Set(['severity', 'title']);
const PREVIEW_DEFAULT_TITLE = '示例：Bash 执行 npm test 时挂起';
const PREVIEW_REPORT_ID = 'rep_0123456789abcdef0123456789abcdef';

type WebhookAction = { kind: 'keep' } | { kind: 'delete' } | { kind: 'set'; value: string };

function configResponse(
  config: AlertConfig,
  revision: number,
  configured: boolean,
  secretName: string,
): Record<string, unknown> {
  return {
    enabled: config.enabled,
    minSeverity: config.minSeverity,
    events: [...config.events],
    webhook: { configured, secretName },
    revision,
  };
}

function revisionConflict(error: AdminApiError, webhookUpdated: boolean): AdminApiError {
  const details =
    error.details !== null && typeof error.details === 'object' && !Array.isArray(error.details)
      ? { ...(error.details as Record<string, unknown>), webhookUpdated }
      : { webhookUpdated };
  return new AdminApiError(409, 'REVISION_CONFLICT', error.message, details);
}

/** `GET/PUT /alerts/config`, `POST /alerts/test`, `POST /alerts/preview`. */
export function createAdminAlertsHandler(deps: AdminAlertsDeps): AdminHandler {
  const clock = deps.clock ?? systemClock;

  async function getConfig(): Promise<AdminResponse> {
    const state = await deps.alerts.read();
    const configured = await deps.alerts.webhookConfigured();
    return adminJson(
      200,
      configResponse(state.config, state.revision, configured, deps.alerts.secretName),
    );
  }

  async function putConfig(request: AdminRequest): Promise<AdminResponse> {
    const expected = parseIfMatch(request);
    const body = requireObjectBody(request);
    rejectUnknownFields(body, CONFIG_FIELDS);

    const hasEnabled = 'enabled' in body;
    const hasSeverity = 'minSeverity' in body;
    const hasEvents = 'events' in body;
    const hasWebhook = 'webhook' in body;
    if (!hasEnabled && !hasSeverity && !hasEvents && !hasWebhook) {
      throw new AdminApiError(422, 'EMPTY_PATCH', 'patch does not change any alert setting');
    }

    // Validate every field before writing anything (06 §5.3 execution order).
    const enabled = hasEnabled ? expectBoolean(body['enabled'], 'enabled') : undefined;

    let minSeverity: Severity | undefined;
    if (hasSeverity) {
      const raw = body['minSeverity'];
      if (typeof raw !== 'string' || !SEVERITY_VALUES.includes(raw as Severity)) {
        throw new AdminApiError(
          422,
          'INVALID_SEVERITY',
          'minSeverity must be low, medium, high or critical',
        );
      }
      minSeverity = raw as Severity;
    }

    let events: string[] | undefined;
    if (hasEvents) {
      const raw = body['events'];
      if (!Array.isArray(raw)) throw invalidField('events', 'must be an array of event names');
      const collected: string[] = [];
      for (let index = 0; index < raw.length; index += 1) {
        const entry = raw[index];
        if (typeof entry !== 'string') {
          throw invalidField(`events[${index}]`, 'must be a string');
        }
        if (!isKnownAlertEvent(entry)) {
          throw new AdminApiError(422, 'UNKNOWN_EVENT', `unknown alert event ${entry}`, {
            event: entry,
          });
        }
        if (!collected.includes(entry)) collected.push(entry);
      }
      events = collected;
    }

    let webhookAction: WebhookAction = { kind: 'keep' };
    if (hasWebhook) {
      const raw = body['webhook'];
      if (raw === null) {
        webhookAction = { kind: 'delete' };
      } else if (typeof raw === 'string') {
        const validation = validateWebhookUrl(raw);
        if (!validation.ok) {
          throw new AdminApiError(
            422,
            'WEBHOOK_URL_INVALID',
            `webhook URL violates the ${validation.rule} rule`,
            { rule: validation.rule },
          );
        }
        webhookAction = { kind: 'set', value: raw };
      } else {
        throw invalidField('webhook', 'must be a string or null');
      }
    }

    let current: { raw: unknown; revision: number; corrupt: boolean };
    try {
      current = await deps.alerts.readSettings();
    } catch (error) {
      throw new AdminApiError(
        500,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : String(error),
        { webhookUpdated: false },
      );
    }

    try {
      assertRevision(current.revision, expected);
    } catch (error) {
      if (error instanceof AdminApiError) throw revisionConflict(error, false);
      throw error;
    }

    let webhookUpdated = false;
    try {
      if (webhookAction.kind === 'delete') {
        await deps.alerts.deleteWebhook();
        webhookUpdated = true;
      } else if (webhookAction.kind === 'set') {
        await deps.alerts.setWebhook(webhookAction.value);
        webhookUpdated = true;
      }
    } catch (error) {
      throw new AdminApiError(
        500,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : String(error),
        { webhookUpdated: false },
      );
    }

    if (hasEnabled || hasSeverity || hasEvents) {
      const base = normalizeAlertConfig(current.raw);
      const next: AlertConfig = {
        enabled: enabled ?? base.enabled,
        minSeverity: minSeverity ?? base.minSeverity,
        events: events ?? base.events,
      };
      try {
        await deps.alerts.writeSettings(next, current.revision);
      } catch (error) {
        if (error instanceof AdminApiError && error.code === 'REVISION_CONFLICT') {
          throw revisionConflict(error, webhookUpdated);
        }
        throw new AdminApiError(
          500,
          'INTERNAL_ERROR',
          error instanceof Error ? error.message : String(error),
          { webhookUpdated },
        );
      }
    }

    const state = await deps.alerts.read();
    const configured = await deps.alerts.webhookConfigured();
    return adminJson(
      200,
      configResponse(state.config, state.revision, configured, deps.alerts.secretName),
    );
  }

  async function sendTest(): Promise<AdminResponse> {
    if (deps.dispatcher === undefined) {
      throw new AdminApiError(500, 'INTERNAL_ERROR', 'alert dispatcher is not wired');
    }
    let result: AlertTestResult;
    try {
      result = await deps.dispatcher.sendTest();
    } catch (error) {
      if (error instanceof AlertTestThrottledError) {
        throw new AdminApiError(429, 'ALERT_TEST_THROTTLED', error.message, {
          retryAfterMs: error.retryAfterMs,
        });
      }
      if (error instanceof WebhookNotConfiguredError) {
        throw new AdminApiError(422, 'WEBHOOK_NOT_CONFIGURED', error.message);
      }
      if (error instanceof WebhookUrlInvalidError) {
        throw new AdminApiError(422, 'WEBHOOK_URL_INVALID', error.message, {
          rule: error.rule,
        });
      }
      throw error;
    }

    const outcome = result.outcome;
    if (outcome.ok) {
      return adminJson(200, {
        ok: true,
        attempts: result.attempts,
        elapsedMs: result.elapsedMs,
      });
    }

    const response: {
      ok: false;
      attempts: number;
      elapsedMs: number;
      error: { code: string; message: string };
      details?: { httpStatus?: number };
    } = {
      ok: false,
      attempts: result.attempts,
      elapsedMs: result.elapsedMs,
      error: { code: outcome.code, message: outcome.message },
    };
    if (outcome.httpStatus !== undefined) response.details = { httpStatus: outcome.httpStatus };
    return adminJson(200, response);
  }

  async function preview(request: AdminRequest): Promise<AdminResponse> {
    let severity: Severity | undefined;
    let title = PREVIEW_DEFAULT_TITLE;

    const rawBody = readJsonBody(request);
    if (rawBody !== undefined && rawBody !== null) {
      const body = requireObjectBody(request);
      rejectUnknownFields(body, PREVIEW_FIELDS);
      if ('severity' in body) {
        const raw = body['severity'];
        if (typeof raw !== 'string' || !SEVERITY_VALUES.includes(raw as Severity)) {
          throw new AdminApiError(
            422,
            'INVALID_SEVERITY',
            'severity must be low, medium, high or critical',
          );
        }
        severity = raw as Severity;
      }
      if ('title' in body) {
        const raw = body['title'];
        if (typeof raw !== 'string' || raw.length > 2_000) {
          throw invalidField('title', 'must be a string of at most 2000 characters');
        }
        title = raw;
      }
    }

    const state = await deps.alerts.read();
    const effectiveSeverity = severity ?? state.config.minSeverity;
    const content = buildWecomMarkdown({
      id: PREVIEW_REPORT_ID,
      severity: effectiveSeverity,
      source: 'mcp',
      createdAt: new Date(clock.now()).toISOString(),
      title,
    });
    return adminJson(200, { content, bytes: Buffer.byteLength(content, 'utf8') });
  }

  return adminHandler(async (request): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    if (segments[0] !== 'alerts') return null;
    const method = request.method.toUpperCase();

    if (segments.length === 2 && segments[1] === 'config') {
      if (method === 'GET') return getConfig();
      if (method === 'PUT') return putConfig(request);
      return null;
    }
    if (segments.length === 2 && segments[1] === 'test' && method === 'POST') {
      return sendTest();
    }
    if (segments.length === 2 && segments[1] === 'preview' && method === 'POST') {
      return preview(request);
    }
    return null;
  });
}
