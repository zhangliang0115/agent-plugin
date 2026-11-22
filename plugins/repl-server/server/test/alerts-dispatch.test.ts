import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { createAlertConfigStore, type AlertConfigStore } from '../src/alerts/config-store.ts';
import { createAlertDispatcher, type AlertDispatcher } from '../src/alerts/dispatcher.ts';
import {
  AlertTestThrottledError,
  WebhookNotConfiguredError,
} from '../src/alerts/errors.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { getRevision } from '../src/db/meta.ts';
import { createReportService, type ReportService } from '../src/reports/service.ts';
import { createDbReportStore } from '../src/reports/store.ts';
import type {
  AlertConfig,
  ReportAuditSink,
  ReportStore,
  StoredReport,
} from '../src/reports/types.ts';
import { buildWecomMarkdown, sanitizeAlertTitle, sendWecomMarkdown } from '../src/reports/wecom.ts';
import type { SecretStore } from '../src/secrets/store.ts';
import { startFakeWebhook } from './fixtures/fake-webhook/server.ts';

const VALID_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123456789abcdef';
const LOOPBACK_ENV = { NODE_ENV: 'test', REPL_ALERT_WEBHOOK_ALLOW_LOOPBACK: '1' };

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

interface Clock {
  now(): number;
  advance(ms: number): void;
}

interface Harness {
  db: DatabaseSync;
  secrets: MemorySecrets;
  config: AlertConfigStore;
  store: ReportStore;
  service: ReportService;
  clock: Clock;
  sleeps: number[];
  auditEvents: Array<Record<string, unknown>>;
}

function harness(t: TestContext): Harness {
  const db = openStateDb(':memory:');
  t.after(() => db.close());
  let nowMs = Date.UTC(2026, 10, 18, 6, 0, 0);
  const clock: Clock = {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
    },
  };
  const secrets = new MemorySecrets();
  const config = createAlertConfigStore({ db, secrets });
  const store = createDbReportStore(db);
  const auditEvents: Array<Record<string, unknown>> = [];
  const audit: ReportAuditSink = {
    write(event) {
      auditEvents.push(event);
    },
  };
  const service = createReportService({
    store,
    alerts: { kick: () => undefined },
    audit,
    clock,
  });
  return { db, secrets, config, store, service, clock, sleeps: [], auditEvents };
}

async function configure(h: Harness, config: Partial<AlertConfig>): Promise<void> {
  const base = (await h.config.read()).config;
  await h.config.writeSettings({ ...base, ...config }, getRevision(h.db));
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface FetchScript {
  status?: number;
  body?: unknown;
  rawBody?: string;
  abort?: boolean;
  networkError?: boolean;
  waitForAbort?: boolean;
}

interface ScriptedFetch {
  fetch: typeof fetch;
  calls: FetchCall[];
}

function scriptedFetch(script: FetchScript[]): ScriptedFetch {
  const calls: FetchCall[] = [];
  let index = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const pick = script[Math.min(index, script.length - 1)] ?? { body: { errcode: 0 } };
    index += 1;
    if (pick.abort === true) throw new DOMException('aborted', 'AbortError');
    if (pick.networkError === true) throw new TypeError('fetch failed');
    if (pick.waitForAbort === true) {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    const text = pick.rawBody ?? JSON.stringify(pick.body ?? {});
    return new Response(text, { status: pick.status ?? 200 });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function dispatcher(h: Harness, fetched: ScriptedFetch, overrides: Partial<Parameters<typeof createAlertDispatcher>[0]> = {}): AlertDispatcher {
  return createAlertDispatcher({
    store: h.store,
    config: h.config,
    clock: h.clock,
    fetch: fetched.fetch,
    audit: {
      write(event) {
        h.auditEvents.push(event);
      },
    },
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
    env: {},
    ...overrides,
  });
}

async function createReport(
  h: Harness,
  title: string,
  severity: StoredReport['severity'] = 'high',
): Promise<StoredReport> {
  const result = await h.service.create({
    source: 'mcp',
    title,
    detail: `detail for ${title}: never include this text`,
    severity,
    context: { secret: 'never include this context' },
    binding: 'cb_1',
    client: 'claude-code/2.1.327',
    clientName: 'claude-code',
    clientVersion: '2.1.327',
    mcp: 'mcp_1',
    exec: null,
    evalId: null,
    ownerKey: 'cb_1',
  });
  return result.report;
}

// ---------------------------------------------------------------------------
// Markdown construction
// ---------------------------------------------------------------------------

test('buildWecomMarkdown renders every severity label and the metadata', () => {
  const labels: Array<[StoredReport['severity'], string]> = [
    ['low', '低'],
    ['medium', '中'],
    ['high', '高'],
    ['critical', '严重'],
  ];
  for (const [severity, label] of labels) {
    const content = buildWecomMarkdown({
      id: 'rep_0123456789abcdef0123456789abcdef',
      severity,
      source: 'mcp',
      createdAt: '2026-11-18T02:03:04.567Z',
      title: 'Bash hangs',
    });
    assert.ok(content.startsWith('## REPL 问题报告'));
    assert.ok(content.includes(`严重级：${label}（${severity}）`));
    assert.ok(content.includes('来源：mcp'));
    assert.ok(content.includes('时间：2026-11-18T02:03:04.567Z'));
    assert.ok(content.includes('报告 ID：rep_0123456789abcdef0123456789abcdef'));
    assert.ok(content.includes('**Bash hangs**'));
    assert.ok(Buffer.byteLength(content, 'utf8') < 4096);
  }
});

test('sanitizeAlertTitle redacts credentials, flattens and strips markdown', () => {
  const sanitized = sanitizeAlertTitle(
    'line1\nline2 Bearer abcdefghijklmnop **bold** `code` [link](x) # h > q | p \\',
  );
  assert.doesNotMatch(sanitized, /abcdefghijklmnop/);
  assert.doesNotMatch(sanitized, /[\r\n]/);
  assert.doesNotMatch(sanitized, /[`*_\[\]()#>|\\]/);
  assert.match(sanitized, /line1 line2/);
});

test('sanitizeAlertTitle truncates to 200 code points and keeps emoji intact', () => {
  assert.equal([...sanitizeAlertTitle('x'.repeat(300))].length, 200);
  assert.equal([...sanitizeAlertTitle('😀'.repeat(300))].length, 200);
});

test('the message never contains detail, context or webhook values', () => {
  const report: StoredReport = {
    id: 'rep_0123456789abcdef0123456789abcdef',
    createdAt: '2026-11-18T02:03:04.567Z',
    updatedAt: '2026-11-18T02:03:04.567Z',
    source: 'mcp',
    binding: 'cb_1',
    client: 'claude-code/2.1.327',
    clientName: 'claude-code',
    clientVersion: '2.1.327',
    mcp: 'mcp_1',
    exec: null,
    evalId: null,
    ownerKey: 'cb_1',
    severity: 'high',
    title: 'Bash hangs',
    detail: 'DETAIL-SECRET',
    context: { token: 'CONTEXT-SECRET' },
    fingerprint: 'a'.repeat(64),
    status: 'open',
    alertState: 'pending',
    alertError: null,
    alertAttempts: 0,
    alertUpdatedAt: null,
    resolution: null,
    resolvedAt: null,
    alertedAt: null,
  };
  const content = buildWecomMarkdown(report);
  assert.doesNotMatch(content, /DETAIL-SECRET|CONTEXT-SECRET/);
  assert.doesNotMatch(content, /qyapi|wecom\.webhook/);
});

// ---------------------------------------------------------------------------
// sendWecomMarkdown
// ---------------------------------------------------------------------------

test('sendWecomMarkdown posts markdown with redirect:error and accepts errcode 0', async () => {
  const fetched = scriptedFetch([{ body: { errcode: 0, errmsg: 'ok' } }]);
  const outcome = await sendWecomMarkdown(VALID_URL, 'hello', {
    fetch: fetched.fetch,
    env: {},
    sleep: async () => undefined,
  });
  assert.deepEqual(outcome, { ok: true, attempts: 1, httpStatus: 200, errcode: 0 });
  assert.equal(fetched.calls.length, 1);
  const call = fetched.calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    msgtype: 'markdown',
    markdown: { content: 'hello' },
  });
});

test('timeouts are retried once and end as ALERT_TIMEOUT', async () => {
  const fetched = scriptedFetch([{ abort: true }, { abort: true }]);
  const sleeps: number[] = [];
  const outcome = await sendWecomMarkdown(VALID_URL, 'hello', {
    fetch: fetched.fetch,
    env: {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.equal(outcome.code, 'ALERT_TIMEOUT');
  assert.equal(outcome.attempts, 2);
  assert.deepEqual(sleeps, [500]);
});

test('network errors are retryable and can succeed on the second attempt', async () => {
  const fetched = scriptedFetch([{ networkError: true }, { body: { errcode: 0 } }]);
  const outcome = await sendWecomMarkdown(VALID_URL, 'hello', {
    fetch: fetched.fetch,
    env: {},
    sleep: async () => undefined,
  });
  assert.deepEqual(outcome, { ok: true, attempts: 2, httpStatus: 200, errcode: 0 });
});

test('HTTP 500 and 429 retry; other 4xx do not', async () => {
  const retried = scriptedFetch([{ status: 500 }, { status: 500 }]);
  const failed = await sendWecomMarkdown(VALID_URL, 'hello', {
    fetch: retried.fetch,
    env: {},
    sleep: async () => undefined,
  });
  assert.equal(failed.ok, false);
  if (failed.ok) throw new Error('unreachable');
  assert.equal(failed.code, 'ALERT_HTTP_500');
  assert.equal(failed.attempts, 2);
  assert.equal(failed.httpStatus, 500);

  const clientError = scriptedFetch([{ status: 400, body: { errcode: 0 } }]);
  const noRetry = await sendWecomMarkdown(VALID_URL, 'hello', {
    fetch: clientError.fetch,
    env: {},
    sleep: async () => undefined,
  });
  assert.equal(noRetry.ok, false);
  if (noRetry.ok) throw new Error('unreachable');
  assert.equal(noRetry.attempts, 1);
  assert.equal(noRetry.code, 'ALERT_HTTP_400');
});

test('3xx responses are ALERT_REDIRECT and are never followed', async () => {
  const fetched = scriptedFetch([{ status: 302 }]);
  const outcome = await sendWecomMarkdown(VALID_URL, 'hello', {
    fetch: fetched.fetch,
    env: {},
    sleep: async () => undefined,
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.equal(outcome.code, 'ALERT_REDIRECT');
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.retryable, false);
  assert.equal(fetched.calls[0]?.init.redirect, 'error');
});

test('non-JSON bodies are ALERT_BAD_RESPONSE with no retry', async () => {
  const fetched = scriptedFetch([{ rawBody: '<html>proxy</html>' }]);
  const outcome = await sendWecomMarkdown(VALID_URL, 'hello', {
    fetch: fetched.fetch,
    env: {},
    sleep: async () => undefined,
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.equal(outcome.code, 'ALERT_BAD_RESPONSE');
  assert.equal(outcome.attempts, 1);
});

test('45009 is not retried in-send and carries the cooldown hint', async () => {
  const fetched = scriptedFetch([{ body: { errcode: 45009 } }]);
  const outcome = await sendWecomMarkdown(VALID_URL, 'hello', {
    fetch: fetched.fetch,
    env: {},
    sleep: async () => undefined,
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.equal(outcome.code, 'ALERT_WECOM_45009');
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.retryable, false);
  assert.equal(outcome.retryAfterMs, 60_000);
  assert.equal(fetched.calls.length, 1);
});

test('-1 is retried once', async () => {
  const fetched = scriptedFetch([{ body: { errcode: -1 } }, { body: { errcode: 0 } }]);
  const outcome = await sendWecomMarkdown(VALID_URL, 'hello', {
    fetch: fetched.fetch,
    env: {},
    sleep: async () => undefined,
  });
  assert.deepEqual(outcome, { ok: true, attempts: 2, httpStatus: 200, errcode: 0 });
});

test('an invalid webhook URL fails before any request', async () => {
  const fetched = scriptedFetch([{ body: { errcode: 0 } }]);
  const outcome = await sendWecomMarkdown(
    'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123456789abcdef',
    'hello',
    { fetch: fetched.fetch, env: {}, sleep: async () => undefined },
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.equal(outcome.code, 'WEBHOOK_URL_INVALID');
  assert.equal(outcome.attempts, 0);
  assert.equal(fetched.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Dispatcher rules and outbox state
// ---------------------------------------------------------------------------

test('the rule matrix writes the frozen alert_error codes in order', async (t) => {
  const disabled = harness(t);
  const disabledReport = await createReport(disabled, 'disabled');
  const disabledFetch = scriptedFetch([{ body: { errcode: 0 } }]);
  const d1 = dispatcher(disabled, disabledFetch);
  assert.equal(await d1.runOnce(), 1);
  assert.equal(disabled.store.get(disabledReport.id)?.alertState, 'skipped');
  assert.equal(disabled.store.get(disabledReport.id)?.alertError, 'ALERTS_DISABLED');
  await d1.close();

  const noEvents = harness(t);
  await configure(noEvents, { enabled: true, events: [] });
  const noEventReport = await createReport(noEvents, 'no events');
  const d2 = dispatcher(noEvents, scriptedFetch([{ body: { errcode: 0 } }]));
  await d2.runOnce();
  assert.equal(noEvents.store.get(noEventReport.id)?.alertError, 'EVENT_DISABLED');
  await d2.close();

  const below = harness(t);
  await configure(below, { enabled: true, minSeverity: 'critical' });
  const belowReport = await createReport(below, 'below', 'high');
  const d3 = dispatcher(below, scriptedFetch([{ body: { errcode: 0 } }]));
  await d3.runOnce();
  assert.equal(below.store.get(belowReport.id)?.alertError, 'BELOW_MIN_SEVERITY');
  await d3.close();

  const noHook = harness(t);
  await configure(noHook, { enabled: true });
  const noHookReport = await createReport(noHook, 'no hook');
  const d4 = dispatcher(noHook, scriptedFetch([{ body: { errcode: 0 } }]));
  await d4.runOnce();
  assert.equal(noHook.store.get(noHookReport.id)?.alertState, 'no_webhook');
  assert.equal(noHook.store.get(noHookReport.id)?.alertError, 'WEBHOOK_NOT_CONFIGURED');
  await d4.close();
});

test('a successful send writes sent, alerted_at and metadata-only audit', async (t) => {
  const h = harness(t);
  await configure(h, { enabled: true });
  await h.secrets.set('wecom.webhook', VALID_URL);
  const report = await createReport(h, 'Bash hangs');
  const fetched = scriptedFetch([{ body: { errcode: 0 } }]);
  const d = dispatcher(h, fetched);
  t.after(() => d.close());

  assert.equal(await d.runOnce(), 1);
  const stored = h.store.get(report.id);
  assert.equal(stored?.alertState, 'sent');
  assert.equal(stored?.alertAttempts, 1);
  assert.ok(stored?.alertedAt !== null);
  assert.equal(stored?.alertError, null);

  const body = JSON.parse(String(fetched.calls[0]?.init.body)) as {
    msgtype: string;
    markdown: { content: string };
  };
  assert.equal(body.msgtype, 'markdown');
  assert.ok(body.markdown.content.includes(report.id));
  assert.ok(body.markdown.content.includes('Bash hangs'));
  assert.doesNotMatch(body.markdown.content, /never include this text|never include this context/);

  const alertAudit = h.auditEvents.filter((event) => event['event'] === 'report_alert');
  assert.equal(alertAudit.length, 1);
  assert.equal(alertAudit[0]?.['state'], 'sent');
  assert.deepEqual(Object.keys(alertAudit[0] ?? {}).sort(), [
    'attempts',
    'event',
    'reportId',
    'state',
    'ts',
  ]);
});

test('failed sends write failed with the code prefix and attempts', async (t) => {
  const h = harness(t);
  await configure(h, { enabled: true });
  await h.secrets.set('wecom.webhook', VALID_URL);
  const report = await createReport(h, 'will fail');
  const d = dispatcher(h, scriptedFetch([{ status: 500 }, { status: 500 }]));
  t.after(() => d.close());

  await d.runOnce();
  const stored = h.store.get(report.id);
  assert.equal(stored?.alertState, 'failed');
  assert.equal(stored?.alertAttempts, 2);
  assert.match(stored?.alertError ?? '', /^ALERT_HTTP_500: /);

  const alertAudit = h.auditEvents.filter((event) => event['event'] === 'report_alert');
  assert.equal(alertAudit[0]?.['errorCode'], 'ALERT_HTTP_500');
});

test('45009 returns the row to pending, pauses the drain and retries after the cooldown', async (t) => {
  const h = harness(t);
  await configure(h, { enabled: true });
  await h.secrets.set('wecom.webhook', VALID_URL);
  const report = await createReport(h, 'rate limited');
  const fetched = scriptedFetch([{ body: { errcode: 45009 } }, { body: { errcode: 0 } }]);
  const d = dispatcher(h, fetched);
  t.after(() => d.close());

  assert.equal(await d.runOnce(), 1);
  let stored = h.store.get(report.id);
  assert.equal(stored?.alertState, 'pending');
  assert.equal(stored?.alertError, 'ALERT_WECOM_45009');
  assert.equal(stored?.alertAttempts, 0);

  assert.equal(await d.runOnce(), 0, 'cooldown blocks an immediate claim');
  assert.equal(fetched.calls.length, 1);

  h.clock.advance(60_000);
  assert.equal(await d.runOnce(), 1);
  stored = h.store.get(report.id);
  assert.equal(stored?.alertState, 'sent');
  assert.equal(fetched.calls.length, 2);
});

test('serial sends observe the minimum start-to-start interval', async (t) => {
  const h = harness(t);
  await configure(h, { enabled: true });
  await h.secrets.set('wecom.webhook', VALID_URL);
  await createReport(h, 'first');
  await createReport(h, 'second');
  const d = dispatcher(h, scriptedFetch([{ body: { errcode: 0 } }]));
  t.after(() => d.close());

  assert.equal(await d.runOnce(), 2);
  assert.ok(h.sleeps.includes(3_000), `expected a 3000 ms gap, saw ${h.sleeps.join(',')}`);
});

test('start() recovers sending rows and fails 24h-stale pending rows', async (t) => {
  const h = harness(t);
  const fresh = await createReport(h, 'fresh');
  const stale = await createReport(h, 'stale');
  h.db
    .prepare("UPDATE reports SET alert_state = 'sending', alert_updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
    .run(fresh.id);
  h.db
    .prepare('UPDATE reports SET created_at = ? WHERE id = ?')
    .run(new Date(h.clock.now() - 25 * 60 * 60 * 1000).toISOString(), stale.id);

  const d = dispatcher(h, scriptedFetch([{ body: { errcode: 0 } }]));
  d.start();
  // start() applies both recovery steps synchronously before the async drain runs.
  assert.equal(h.store.get(fresh.id)?.alertState, 'pending');
  assert.equal(h.store.get(stale.id)?.alertState, 'failed');
  assert.equal(h.store.get(stale.id)?.alertError, 'ALERT_STALE');
  await d.close();
});

test('close() aborts an in-flight send and returns the row to pending', async (t) => {
  const h = harness(t);
  await configure(h, { enabled: true });
  await h.secrets.set('wecom.webhook', VALID_URL);
  const report = await createReport(h, 'in flight');
  const fetched = scriptedFetch([{ waitForAbort: true }]);
  const d = dispatcher(h, fetched);
  t.after(() => d.close());

  const running = d.runOnce();
  while (fetched.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(h.store.get(report.id)?.alertState, 'sending');
  await d.close();
  await running;
  assert.equal(h.store.get(report.id)?.alertState, 'pending');
});

test('sendTest uses the same serial channel, throttles 5 s and writes no report row', async (t) => {
  const h = harness(t);
  await h.secrets.set('wecom.webhook', VALID_URL);
  const fetched = scriptedFetch([{ body: { errcode: 0 } }]);
  const d = dispatcher(h, fetched);
  t.after(() => d.close());

  const first = await d.sendTest();
  assert.deepEqual(
    { ok: first.ok, attempts: first.attempts },
    { ok: true, attempts: 1 },
  );
  await assert.rejects(
    d.sendTest(),
    (error: unknown) =>
      error instanceof AlertTestThrottledError && error.retryAfterMs === 5_000,
  );
  h.clock.advance(5_000);
  const third = await d.sendTest();
  assert.equal(third.ok, true);

  const count = h.db.prepare('SELECT count(*) AS n FROM reports').get();
  assert.equal(Number(count?.['n']), 0);
  assert.equal(
    h.auditEvents.filter((event) => event['event'] === 'alert_test').length,
    2,
  );
});

test('sendTest requires a configured webhook', async (t) => {
  const h = harness(t);
  const d = dispatcher(h, scriptedFetch([{ body: { errcode: 0 } }]));
  t.after(() => d.close());
  await assert.rejects(d.sendTest(), (error: unknown) => error instanceof WebhookNotConfiguredError);
});

test('sendTest and the drain share one serial send channel', async (t) => {
  const h = harness(t);
  await configure(h, { enabled: true });
  await h.secrets.set('wecom.webhook', VALID_URL);
  await createReport(h, 'serial');

  let active = 0;
  let maxActive = 0;
  const fetchImpl = async (): Promise<Response> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  };
  const d = createAlertDispatcher({
    store: h.store,
    config: h.config,
    clock: h.clock,
    fetch: fetchImpl as unknown as typeof fetch,
    sleep: async () => undefined,
    env: {},
  });
  t.after(() => d.close());

  const [processed, testResult] = await Promise.all([d.runOnce(), d.sendTest()]);
  assert.equal(processed, 1);
  assert.equal(testResult.ok, true);
  assert.equal(maxActive, 1, 'no two outbound sends may overlap');
});

test('the fake webhook end to end: loopback hook, markdown body, sent row', async (t) => {
  const hook = await startFakeWebhook();
  t.after(() => hook.close());
  const h = harness(t);
  await configure(h, { enabled: true });
  const url = `${hook.url}/cgi-bin/webhook/send?key=test-key-1234`;
  await h.secrets.set('wecom.webhook', url);
  const report = await createReport(h, 'E2E hangs');
  const d = dispatcher(h, scriptedFetch([]), { fetch: globalThis.fetch, env: LOOPBACK_ENV });
  t.after(() => d.close());

  await d.runOnce();
  await hook.waitForRequests(1);

  assert.equal(h.store.get(report.id)?.alertState, 'sent');
  const request = hook.requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.method, 'POST');
  assert.ok(request.path.startsWith('/cgi-bin/webhook/send?key='));
  const body = request.body as { msgtype: string; markdown: { content: string } };
  assert.equal(body.msgtype, 'markdown');
  assert.ok(body.markdown.content.includes(report.id));
  assert.ok(body.markdown.content.includes('E2E hangs'));
  assert.doesNotMatch(
    body.markdown.content,
    /never include this text|never include this context|test-key-1234/,
  );
});
