import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { createAdminAlertsHandler } from '../src/admin/alerts.ts';
import type { AdminHandler, AdminRequest, AdminResponse } from '../src/admin/servers.ts';
import { createAlertConfigStore, type AlertConfigStore } from '../src/alerts/config-store.ts';
import {
  AlertTestThrottledError,
  WebhookNotConfiguredError,
  WebhookUrlInvalidError,
} from '../src/alerts/errors.ts';
import type { AlertTestResult } from '../src/alerts/dispatcher.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { getRevision, patchSettings } from '../src/db/meta.ts';
import {
  createAlertSettingsStore,
  normalizeAlertConfig,
  validateWebhookUrl,
} from '../src/reports/config.ts';
import type { SecretStore } from '../src/secrets/store.ts';

class MemorySecrets implements SecretStore {
  readonly data = new Map<string, string>();

  async get(name: string): Promise<string | undefined> {
    return this.data.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    this.data.set(name, value);
  }

  async delete(name: string): Promise<void> {
    this.data.delete(name);
  }

  async listNames(): Promise<string[]> {
    return [...this.data.keys()].sort();
  }
}

class FakeDispatcher {
  error: unknown = null;
  result: AlertTestResult = {
    ok: true,
    attempts: 1,
    elapsedMs: 12,
    outcome: { ok: true, attempts: 1, httpStatus: 200, errcode: 0 },
  };
  calls = 0;

  async sendTest(): Promise<AlertTestResult> {
    this.calls += 1;
    if (this.error !== null) throw this.error;
    return this.result;
  }
}

interface Harness {
  db: DatabaseSync;
  secrets: MemorySecrets;
  alerts: AlertConfigStore;
  dispatcher: FakeDispatcher;
  handler: AdminHandler;
  clock: { now(): number };
}

function harness(t: TestContext): Harness {
  const db = openStateDb(':memory:');
  t.after(() => db.close());
  const secrets = new MemorySecrets();
  const alerts = createAlertConfigStore({ db, secrets });
  const dispatcher = new FakeDispatcher();
  const handler = createAdminAlertsHandler({
    alerts,
    dispatcher,
    clock: { now: () => Date.UTC(2026, 10, 18, 6, 0, 0) },
  });
  return {
    db,
    secrets,
    alerts,
    dispatcher,
    handler,
    clock: { now: () => Date.UTC(2026, 10, 18, 6, 0, 0) },
  };
}

async function call(
  handler: AdminHandler,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<AdminResponse> {
  const request: AdminRequest = {
    method,
    path,
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

function errorOf(response: AdminResponse): { code: string; message: string; details?: unknown } {
  return bodyOf(response)['error'] as { code: string; message: string; details?: unknown };
}

const VALID_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123456789abcdef';

test('validateWebhookUrl accepts only WeCom robot URLs', () => {
  assert.deepEqual(validateWebhookUrl(VALID_URL, {}), { ok: true });

  const rules: Array<[string, string]> = [
    ['http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123456789abcdef', 'scheme'],
    ['https://evil.example.com/cgi-bin/webhook/send?key=0123456789abcdef', 'host'],
    ['https://user:pass@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123456789abcdef', 'credentials'],
    ['https://qyapi.weixin.qq.com/cgi-bin/webhook/other?key=0123456789abcdef', 'path'],
    ['https://qyapi.weixin.qq.com:8443/cgi-bin/webhook/send?key=0123456789abcdef', 'port'],
    ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123456789abcdef&other=1', 'query'],
    ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=short', 'key'],
    ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123456789abcdef#frag', 'fragment'],
    ['not a url', 'parse'],
  ];
  for (const [url, rule] of rules) {
    const result = validateWebhookUrl(url, {});
    assert.equal(result.ok, false, `expected ${url} to fail`);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.rule, rule);
    assert.doesNotMatch(result.rule, /qyapi|key=/, 'validation never echoes the URL');
  }
});

test('loopback webhooks need both test variables', () => {
  const loopback = 'http://127.0.0.1:43123/cgi-bin/webhook/send?key=test-key-1234';
  assert.equal(validateWebhookUrl(loopback, {}).ok, false);
  assert.equal(
    validateWebhookUrl(loopback, { NODE_ENV: 'test' }).ok,
    false,
    'the explicit loopback flag is required',
  );
  assert.equal(
    validateWebhookUrl(loopback, { REPL_ALERT_WEBHOOK_ALLOW_LOOPBACK: '1' }).ok,
    false,
    'NODE_ENV=test is required',
  );
  const env = { NODE_ENV: 'test', REPL_ALERT_WEBHOOK_ALLOW_LOOPBACK: '1' };
  assert.deepEqual(validateWebhookUrl(loopback, env), { ok: true });
  assert.deepEqual(
    validateWebhookUrl('http://localhost:5555/cgi-bin/webhook/send?key=test-key-1234', env),
    { ok: true },
  );
  assert.deepEqual(
    validateWebhookUrl('http://[::1]:5555/cgi-bin/webhook/send?key=test-key-1234', env),
    { ok: true },
  );
  const userinfo = validateWebhookUrl(
    'http://user:pass@127.0.0.1:5555/cgi-bin/webhook/send?key=test-key-1234',
    env,
  );
  assert.equal(userinfo.ok, false);
});

test('normalizeAlertConfig fills defaults and fails closed', () => {
  assert.deepEqual(normalizeAlertConfig(undefined), {
    enabled: false,
    minSeverity: 'high',
    events: ['report'],
  });
  assert.deepEqual(normalizeAlertConfig({ enabled: 'true', minSeverity: 'weird', events: 'x' }), {
    enabled: false,
    minSeverity: 'high',
    events: ['report'],
  });
  assert.deepEqual(
    normalizeAlertConfig({ enabled: true, minSeverity: 'low', events: ['report'] }),
    { enabled: true, minSeverity: 'low', events: ['report'] },
  );
});

test('the narrow settings store reports corrupt JSON instead of throwing', async (t) => {
  const h = harness(t);
  h.db.prepare("INSERT INTO settings(key, value) VALUES('alerts', '{not json')").run();
  const store = createAlertSettingsStore(h.db);
  const state = await store.read();
  assert.equal(state.corrupt, true);
  assert.equal(state.raw, undefined);

  const snapshot = await h.alerts.read();
  assert.equal(snapshot.corrupt, true);
  assert.equal(snapshot.config.enabled, false);

  const response = await call(h.handler, 'GET', '/admin/api/alerts/config');
  assert.equal(response.status, 200);
  assert.equal(bodyOf(response)['enabled'], false);
});

test('GET /alerts/config never exposes the webhook value', async (t) => {
  const h = harness(t);
  await h.secrets.set('wecom.webhook', VALID_URL);
  const response = await call(h.handler, 'GET', '/admin/api/alerts/config');
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body['enabled'], false);
  assert.equal(body['minSeverity'], 'high');
  assert.deepEqual(body['events'], ['report']);
  assert.deepEqual(body['webhook'], {
    configured: true,
    secretName: 'wecom.webhook',
  });
  assert.equal(body['revision'], 0);
  assert.doesNotMatch(JSON.stringify(body), /qyapi|0123456789abcdef/);
});

test('PUT /alerts/config validates the If-Match precondition and body', async (t) => {
  const h = harness(t);
  const missing = await call(h.handler, 'PUT', '/admin/api/alerts/config', {
    body: { enabled: true },
  });
  assert.equal(missing.status, 400);
  assert.equal(errorOf(missing).code, 'IF_MATCH_REQUIRED');

  const empty = await call(h.handler, 'PUT', '/admin/api/alerts/config', {
    body: {},
    headers: { 'if-match': '0' },
  });
  assert.equal(empty.status, 422);
  assert.equal(errorOf(empty).code, 'EMPTY_PATCH');

  const unknown = await call(h.handler, 'PUT', '/admin/api/alerts/config', {
    body: { enabled: true, other: 1 },
    headers: { 'if-match': '0' },
  });
  assert.equal(unknown.status, 400);
  assert.equal(errorOf(unknown).code, 'UNKNOWN_FIELD');

  const badSeverity = await call(h.handler, 'PUT', '/admin/api/alerts/config', {
    body: { minSeverity: 'urgent' },
    headers: { 'if-match': '0' },
  });
  assert.equal(badSeverity.status, 422);
  assert.equal(errorOf(badSeverity).code, 'INVALID_SEVERITY');

  const badEvent = await call(h.handler, 'PUT', '/admin/api/alerts/config', {
    body: { events: ['error'] },
    headers: { 'if-match': '0' },
  });
  assert.equal(badEvent.status, 422);
  assert.equal(errorOf(badEvent).code, 'UNKNOWN_EVENT');

  const badUrl = await call(h.handler, 'PUT', '/admin/api/alerts/config', {
    body: { webhook: 'http://evil.example.com/hook?key=0123456789abcdef' },
    headers: { 'if-match': '0' },
  });
  assert.equal(badUrl.status, 422);
  const failure = errorOf(badUrl);
  assert.equal(failure.code, 'WEBHOOK_URL_INVALID');
  assert.deepEqual(failure.details, { rule: 'scheme' });
  assert.doesNotMatch(JSON.stringify(failure), /evil\.example/, 'the URL is never echoed');

  const stale = await call(h.handler, 'PUT', '/admin/api/alerts/config', {
    body: { enabled: true },
    headers: { 'if-match': '99' },
  });
  assert.equal(stale.status, 409);
  assert.equal(errorOf(stale).code, 'REVISION_CONFLICT');
});

test('PUT /alerts/config writes settings and the webhook in the frozen order', async (t) => {
  const h = harness(t);
  const revision = getRevision(h.db);

  const saved = await call(h.handler, 'PUT', '/admin/api/alerts/config', {
    body: { enabled: true, minSeverity: 'critical', webhook: VALID_URL },
    headers: { 'if-match': String(revision) },
  });
  assert.equal(saved.status, 200);
  const body = bodyOf(saved);
  assert.equal(body['enabled'], true);
  assert.equal(body['minSeverity'], 'critical');
  assert.deepEqual(body['webhook'], {
    configured: true,
    secretName: 'wecom.webhook',
  });
  assert.equal(body['revision'], revision + 1);
  assert.doesNotMatch(JSON.stringify(body), /qyapi|0123456789abcdef/);
  assert.equal(await h.secrets.get('wecom.webhook'), VALID_URL);

  // A webhook-only change must not bump the revision.
  const webhookOnly = await call(h.handler, 'PUT', '/admin/api/alerts/config', {
    body: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fedcba9876543210' },
    headers: { 'if-match': String(body['revision']) },
  });
  assert.equal(webhookOnly.status, 200);
  assert.equal(bodyOf(webhookOnly)['revision'], body['revision']);

  // null deletes the secret and leaves the switches alone.
  const cleared = await call(h.handler, 'PUT', '/admin/api/alerts/config', {
    body: { webhook: null },
    headers: { 'if-match': String(body['revision']) },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(bodyOf(cleared)['webhook'], {
    configured: false,
    secretName: 'wecom.webhook',
  });
  assert.equal(await h.secrets.get('wecom.webhook'), undefined);
  assert.equal(bodyOf(cleared)['enabled'], true, 'clearing the webhook does not disable alerts');
});

test('PUT reports webhookUpdated when settings lose the revision race after the secret write', async (t) => {
  const h = harness(t);
  const wrapped: AlertConfigStore = {
    ...h.alerts,
    async writeSettings(config, expectedRevision) {
      patchSettings(h.db, { alerts: config });
      return h.alerts.writeSettings(config, expectedRevision);
    },
  };
  const handler = createAdminAlertsHandler({
    alerts: wrapped,
    dispatcher: h.dispatcher,
    clock: h.clock,
  });

  const response = await call(handler, 'PUT', '/admin/api/alerts/config', {
    body: { enabled: true, webhook: VALID_URL },
    headers: { 'if-match': '0' },
  });
  assert.equal(response.status, 409);
  const error = errorOf(response);
  assert.equal(error.code, 'REVISION_CONFLICT');
  assert.deepEqual(error.details, { expected: 0, current: 1, webhookUpdated: true });
  assert.equal(await h.secrets.get('wecom.webhook'), VALID_URL);
});

test('POST /alerts/test maps dispatcher errors and never returns the webhook', async (t) => {
  const h = harness(t);
  h.dispatcher.error = new WebhookNotConfiguredError();
  const notConfigured = await call(h.handler, 'POST', '/admin/api/alerts/test');
  assert.equal(notConfigured.status, 422);
  assert.equal(errorOf(notConfigured).code, 'WEBHOOK_NOT_CONFIGURED');

  h.dispatcher.error = new AlertTestThrottledError(4_000);
  const throttled = await call(h.handler, 'POST', '/admin/api/alerts/test');
  assert.equal(throttled.status, 429);
  assert.equal(errorOf(throttled).code, 'ALERT_TEST_THROTTLED');
  assert.deepEqual(errorOf(throttled).details, { retryAfterMs: 4_000 });

  h.dispatcher.error = new WebhookUrlInvalidError('host');
  const invalid = await call(h.handler, 'POST', '/admin/api/alerts/test');
  assert.equal(invalid.status, 422);
  assert.equal(errorOf(invalid).code, 'WEBHOOK_URL_INVALID');

  h.dispatcher.error = null;
  h.dispatcher.result = {
    ok: false,
    attempts: 2,
    elapsedMs: 10_480,
    outcome: {
      ok: false,
      attempts: 2,
      code: 'ALERT_HTTP_500',
      message: 'upstream returned HTTP 500',
      httpStatus: 500,
      retryable: true,
    },
  };
  const failed = await call(h.handler, 'POST', '/admin/api/alerts/test');
  assert.equal(failed.status, 200);
  assert.deepEqual(bodyOf(failed), {
    ok: false,
    attempts: 2,
    elapsedMs: 10_480,
    error: { code: 'ALERT_HTTP_500', message: 'upstream returned HTTP 500' },
    details: { httpStatus: 500 },
  });

  h.dispatcher.result = {
    ok: true,
    attempts: 1,
    elapsedMs: 142,
    outcome: { ok: true, attempts: 1, httpStatus: 200, errcode: 0 },
  };
  const ok = await call(h.handler, 'POST', '/admin/api/alerts/test');
  assert.deepEqual(bodyOf(ok), { ok: true, attempts: 1, elapsedMs: 142 });
  assert.equal(h.dispatcher.calls, 5);
});

test('POST /alerts/preview renders through the same sanitizer without sending', async (t) => {
  const h = harness(t);
  const defaults = await call(h.handler, 'POST', '/admin/api/alerts/preview');
  assert.equal(defaults.status, 200);
  const content = bodyOf(defaults)['content'] as string;
  assert.ok(content.startsWith('## REPL 问题报告'));
  assert.ok((bodyOf(defaults)['bytes'] as number) < 4096);
  assert.equal(h.dispatcher.calls, 0);

  const custom = await call(h.handler, 'POST', '/admin/api/alerts/preview', {
    body: { severity: 'critical', title: 'Bearer abcdefghijklmnop\n**bold** `x`' },
  });
  assert.equal(custom.status, 200);
  const customContent = bodyOf(custom)['content'] as string;
  assert.match(customContent, /严重（critical）/);
  assert.doesNotMatch(customContent, /abcdefghijklmnop/);
  assert.doesNotMatch(customContent, /\*\*bold\*\*/);

  const badSeverity = await call(h.handler, 'POST', '/admin/api/alerts/preview', {
    body: { severity: 'urgent' },
  });
  assert.equal(badSeverity.status, 422);
  assert.equal(errorOf(badSeverity).code, 'INVALID_SEVERITY');

  const unknown = await call(h.handler, 'POST', '/admin/api/alerts/preview', {
    body: { other: 1 },
  });
  assert.equal(unknown.status, 400);
  assert.equal(errorOf(unknown).code, 'UNKNOWN_FIELD');
});
