/** Alert configuration model: `settings.alerts`, webhook URL validation and the narrow store. @module */

import type { DatabaseSync } from 'node:sqlite';

import { assertRevision } from '../admin/servers.ts';
import { getRevision, getSetting, patchSettings } from '../db/meta.ts';
import { DbValidationError } from '../db/schema.ts';
import { SEVERITY_VALUES, type AlertConfig, type AlertSettingsStore, type Severity } from './types.ts';

/** `settings` key that holds the non-secret alert switches. */
export const ALERT_SETTINGS_KEY = 'alerts';
/** SecretStore key that holds the WeCom robot URL (value never leaves the process). */
export const WECOM_WEBHOOK_SECRET = 'wecom.webhook';

export const DEFAULT_ALERT_CONFIG: AlertConfig = Object.freeze({
  enabled: false,
  minSeverity: 'high',
  events: ['report'],
});

const ALLOWED_EVENTS: readonly string[] = Object.freeze(['report']);
const WECOM_HOST = 'qyapi.weixin.qq.com';
const WECOM_PATH = '/cgi-bin/webhook/send';
const WEBHOOK_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isKnownAlertEvent(event: string): boolean {
  return ALLOWED_EVENTS.includes(event);
}

/** Test-only SSRF escape hatch (06 §4.5); both variables must be set. */
export function loopbackWebhookAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NODE_ENV'] === 'test' && env['REPL_ALERT_WEBHOOK_ALLOW_LOOPBACK'] === '1';
}

/**
 * Fills invalid or missing fields with defaults. `enabled` fails closed: only a
 * literal `true` turns alerting on (06 §4.1).
 */
export function normalizeAlertConfig(raw: unknown): AlertConfig {
  const defaults = DEFAULT_ALERT_CONFIG;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: defaults.enabled, minSeverity: defaults.minSeverity, events: [...defaults.events] };
  }

  const record = raw as Record<string, unknown>;
  const enabled = record['enabled'] === true;

  const storedSeverity = record['minSeverity'];
  const minSeverity =
    typeof storedSeverity === 'string' && SEVERITY_VALUES.includes(storedSeverity as Severity)
      ? (storedSeverity as Severity)
      : defaults.minSeverity;

  let events: string[] = [...defaults.events];
  const storedEvents = record['events'];
  if (
    Array.isArray(storedEvents) &&
    storedEvents.every((entry) => typeof entry === 'string' && entry.length > 0)
  ) {
    events = [...(storedEvents as string[])];
  }

  return { enabled, minSeverity, events };
}

export type WebhookUrlValidation = { ok: true } | { ok: false; rule: string };

/**
 * Validates a WeCom robot URL without ever echoing it back (06 §4.5). The
 * sender re-runs this because `PUT /admin/api/secrets/wecom.webhook` can bypass
 * the config endpoint.
 */
export function validateWebhookUrl(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): WebhookUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, rule: 'parse' };
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, rule: 'credentials' };
  }
  if (parsed.hash !== '') {
    return { ok: false, rule: 'fragment' };
  }

  const loopback = loopbackWebhookAllowed(env) && LOOPBACK_HOSTS.has(parsed.hostname);

  if (loopback) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, rule: 'scheme' };
    }
  } else {
    if (parsed.protocol !== 'https:') {
      return { ok: false, rule: 'scheme' };
    }
    if (parsed.hostname !== WECOM_HOST) {
      return { ok: false, rule: 'host' };
    }
    if (parsed.port !== '' && parsed.port !== '443') {
      return { ok: false, rule: 'port' };
    }
  }

  if (parsed.pathname !== WECOM_PATH) {
    return { ok: false, rule: 'path' };
  }

  const keys = [...parsed.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'key') {
    return { ok: false, rule: 'query' };
  }
  const key = parsed.searchParams.get('key');
  if (key === null || !WEBHOOK_KEY_PATTERN.test(key)) {
    return { ok: false, rule: 'key' };
  }

  return { ok: true };
}

/**
 * Narrow access to `settings.alerts` built directly on `db/meta.ts` (06 §4.1).
 * Corrupt JSON is reported as `corrupt: true` instead of failing the read;
 * revision corruption still throws because it is a database-level fault.
 */
export function createAlertSettingsStore(db: DatabaseSync): AlertSettingsStore {
  return {
    async read() {
      let raw: unknown;
      try {
        raw = getSetting(db, ALERT_SETTINGS_KEY);
      } catch (error) {
        if (error instanceof DbValidationError) {
          return { raw: undefined, revision: getRevision(db), corrupt: true };
        }
        throw error;
      }
      return { raw, revision: getRevision(db), corrupt: false };
    },
    async write(patch, expectedRevision) {
      assertRevision(getRevision(db), expectedRevision);
      const result = patchSettings(db, { [ALERT_SETTINGS_KEY]: patch.alerts });
      return result.revision;
    },
  };
}
