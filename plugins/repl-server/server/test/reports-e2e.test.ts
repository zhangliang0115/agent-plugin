// hook-allow: localhost-only test fetch, no external egress
/**
 * Whole-chain E2E for problem reports and alerts (design 06 §8.3).
 *
 * Starts a real `assemble()` HTTP server plus the loopback fake webhook, drives
 * `report_problem` through `/mcp`, and asserts SQLite, the webhook payload and
 * the audit JSONL. No `src` seam is replaced: the only injected things are the
 * webhook stand-in and the two documented test hooks (`NODE_ENV=test`,
 * `REPL_ALERT_WEBHOOK_ALLOW_LOOPBACK=1`).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test, { after, before, type TestContext } from 'node:test';

import { assemble, type Assembly } from '../src/assembly.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { createDbReportStore } from '../src/reports/store.ts';
import { startFakeWebhook, type FakeWebhook } from './fixtures/fake-webhook/server.ts';

const ADMIN_TOKEN = 'e2e-admin-token';
const WEBHOOK_KEY = 'e2e-webhook-key-1234';
const LOOPBACK_ENV = {
  NODE_ENV: 'test',
  REPL_ALERT_WEBHOOK_ALLOW_LOOPBACK: '1',
} as const;

const SAVED_ENV: Record<string, string | undefined> = {};

before(() => {
  for (const name of [...Object.keys(LOOPBACK_ENV), 'REPL_ADMIN_TOKEN']) {
    SAVED_ENV[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(LOOPBACK_ENV)) process.env[name] = value;
  process.env['REPL_ADMIN_TOKEN'] = ADMIN_TOKEN;
});

after(() => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolved: boolean;
  resolve(): void;
}

function createDeferred(): Deferred {
  let release = (): void => undefined;
  let resolved = false;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      resolved = true;
      resolve();
    };
  });
  return {
    promise,
    get resolved() {
      return resolved;
    },
    resolve: release,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  label: string,
  probe: () => T | null | undefined | false,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not resolve within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface Harness {
  assembly: Assembly;
  base: string;
  root: string;
  dataDir: string;
  dbPath: string;
  /** Closes the assembly exactly once, leaving files on disk for inspection. */
  closeAssembly(): Promise<void>;
  /** Closes (if needed) and removes the temp root. */
  dispose(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'repl-reports-e2e-'));
  const dataDir = join(root, 'repl-server');
  const dbPath = join(dataDir, 'state.db');
  const assembly = await assemble({ root, log: () => undefined });
  await new Promise<void>((resolve) => assembly.server.listen(0, '127.0.0.1', resolve));
  const address = assembly.server.address();
  assert.ok(address !== null && typeof address === 'object');
  const base = `http://127.0.0.1:${(address as AddressInfo).port}`;

  let closed = false;
  let disposed = false;
  const closeAssembly = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await assembly.close();
  };

  return {
    assembly,
    base,
    root,
    dataDir,
    dbPath,
    closeAssembly,
    async dispose() {
      await closeAssembly();
      if (disposed) return;
      disposed = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}

function webhookUrl(hook: FakeWebhook): string {
  return `${hook.url}/cgi-bin/webhook/send?key=${WEBHOOK_KEY}`;
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

/** Enables report alerts and stores the loopback webhook through the admin API. */
async function configureAlerts(base: string, url: string): Promise<void> {
  const read = await fetch(`${base}/admin/api/alerts/config`, { headers: adminHeaders() });
  const readText = await read.text();
  assert.equal(read.status, 200, readText);
  const current = JSON.parse(readText) as { revision: number };

  const write = await fetch(`${base}/admin/api/alerts/config`, {
    method: 'PUT',
    headers: {
      ...adminHeaders(),
      'content-type': 'application/json',
      'if-match': String(current.revision),
    },
    body: JSON.stringify({
      enabled: true,
      minSeverity: 'low',
      events: ['report'],
      webhook: url,
    }),
  });
  const writeText = await write.text();
  assert.equal(write.status, 200, writeText);
}

async function mcpPost(
  base: string,
  body: unknown,
  session?: string,
): Promise<Response> {
  return await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session === undefined ? {} : { 'mcp-session-id': session }),
    },
    body: JSON.stringify(body),
  });
}

interface ReportProblemOutcome {
  isError: boolean;
  reportId: string;
  duplicate: boolean;
  body: Record<string, unknown>;
}

/** Real `/mcp` round trip: discover a session, then call `report_problem`. */
async function reportProblem(
  base: string,
  args: Record<string, unknown>,
): Promise<ReportProblemOutcome> {
  const discover = await mcpPost(base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  assert.equal(discover.status, 200);
  const session = discover.headers.get('mcp-session-id');
  assert.ok(session !== null && session !== '');

  const call = await mcpPost(
    base,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'report_problem', arguments: args },
    },
    session,
  );
  const callText = await call.text();
  assert.equal(call.status, 200, callText);
  const payload = JSON.parse(callText) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  const result = payload.result;
  assert.ok(result !== undefined, callText);
  const text = result.content?.[0]?.text;
  assert.ok(typeof text === 'string', callText);
  const body = JSON.parse(text) as Record<string, unknown>;
  return {
    isError: result.isError === true,
    reportId: typeof body['reportId'] === 'string' ? body['reportId'] : '',
    duplicate: body['duplicate'] === true,
    body,
  };
}

type ReportRow = Record<string, unknown>;

function reportRow(db: DatabaseSync, id: string): ReportRow | null {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  return row === undefined ? null : (row as ReportRow);
}

function countReports(db: DatabaseSync, where = '1 = 1'): number {
  const row = db.prepare(`SELECT count(*) AS n FROM reports WHERE ${where}`).get();
  return Number(row?.['n'] ?? -1);
}

/** Reads every daily audit JSONL file in `<dataDir>/audit`. */
async function readAuditEvents(dataDir: string): Promise<Array<Record<string, unknown>>> {
  const dir = join(dataDir, 'audit');
  const names = (await readdir(dir)).filter((name) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  const events: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      events.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return events;
}

function registerCleanup(t: TestContext, app: Harness, hook: FakeWebhook): void {
  t.after(async () => {
    await app.dispose();
    await hook.close();
  });
}

// ---------------------------------------------------------------------------
// 1–3. Success path: non-blocking tool response, exactly one send, body
//      metadata only, audit metadata only.
// ---------------------------------------------------------------------------

test('report_problem answers before the webhook is released and sends exactly once', async (t) => {
  const gate = createDeferred();
  const hook = await startFakeWebhook({ gate: gate.promise });
  const app = await startHarness();
  registerCleanup(t, app, hook);
  await configureAlerts(app.base, webhookUrl(hook));

  const title = 'Bash hangs while npm test runs';
  const detail = 'DETAIL-ONLY-MARKER: the eval never returns';
  const context = { note: 'CONTEXT-ONLY-MARKER' };

  // The webhook response is held by the gate; the tool must still answer.
  const outcome = await withTimeout(
    reportProblem(app.base, { title, detail, severity: 'high', context }),
    5_000,
    'report_problem response',
  );
  assert.equal(outcome.isError, false, JSON.stringify(outcome.body));
  assert.equal(outcome.duplicate, false);
  assert.match(outcome.reportId, /^rep_[0-9a-f]{32}$/);

  await hook.waitForRequests(1, 5_000);
  assert.equal(gate.resolved, false, 'the webhook response must still be gated');
  assert.equal(hook.requests.length, 1, 'exactly one POST must be in flight');

  gate.resolve();

  // The row was stored by the real pipeline before the alert went out.
  const stored = reportRow(app.assembly.db, outcome.reportId);
  assert.ok(stored !== null);
  assert.equal(stored['source'], 'mcp');
  assert.equal(stored['severity'], 'high');
  assert.equal(stored['title'], title);
  assert.equal(stored['detail'], detail);

  const sent = await until('alert_state sent', () => {
    const current = reportRow(app.assembly.db, outcome.reportId);
    return current !== null && current['alert_state'] === 'sent' ? current : null;
  });
  assert.equal(sent['alert_attempts'], 1);
  assert.ok(sent['alerted_at'] !== null);

  // A success is terminal: no retry, no second POST.
  await delay(150);
  assert.equal(hook.requests.length, 1, 'a successful send must not be repeated');

  const request = hook.requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.method, 'POST');
  assert.ok(request.path.startsWith('/cgi-bin/webhook/send?key='));
  const body = request.body as { msgtype?: string; markdown?: { content?: string } } | null;
  assert.ok(body !== null && typeof body === 'object');
  assert.equal(body.msgtype, 'markdown');
  const content = body.markdown?.content ?? '';
  const createdAt = String(sent['created_at']);
  const assertions: Array<[string, string]> = [
    ['report id', outcome.reportId],
    ['severity', '严重级：高（high）'],
    ['source', '来源：mcp'],
    ['time', `时间：${createdAt}`],
    ['title', title],
  ];
  for (const [label, needle] of assertions) {
    assert.ok(content.includes(needle), `webhook body must carry the ${label}`);
  }
  assert.doesNotMatch(
    request.rawBody,
    new RegExp(
      `DETAIL-ONLY-MARKER|CONTEXT-ONLY-MARKER|${WEBHOOK_KEY.replaceAll('-', '\\-')}`,
    ),
  );

  // Audit is metadata only; flush by closing, then read the JSONL.
  await app.closeAssembly();
  const events = await readAuditEvents(app.dataDir);

  const created = events.filter(
    (event) => event['event'] === 'report_created' && event['reportId'] === outcome.reportId,
  );
  assert.equal(created.length, 1);
  const createdEvent = created[0];
  assert.ok(createdEvent !== undefined);
  assert.equal(createdEvent['source'], 'mcp');
  assert.equal(createdEvent['severity'], 'high');
  assert.deepEqual(Object.keys(createdEvent).sort(), [
    'event',
    'reportId',
    'severity',
    'source',
    'ts',
    'v',
  ]);

  const alertEvents = events.filter(
    (event) => event['event'] === 'report_alert' && event['reportId'] === outcome.reportId,
  );
  assert.equal(alertEvents.length, 1);
  assert.equal(alertEvents[0]?.['state'], 'sent');
  assert.equal(alertEvents[0]?.['attempts'], 1);
  assert.deepEqual(Object.keys(alertEvents[0] ?? {}).sort(), [
    'attempts',
    'event',
    'reportId',
    'state',
    'ts',
    'v',
  ]);

  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /DETAIL-ONLY-MARKER|CONTEXT-ONLY-MARKER/);
  assert.doesNotMatch(serialized, /Bash hangs while npm test runs/);
  assert.doesNotMatch(serialized, new RegExp(WEBHOOK_KEY.replaceAll('-', '\\-')));
});

// ---------------------------------------------------------------------------
// 4. Failure path: two HTTP 500 responses -> failed/attempts=2, tool still ok.
// ---------------------------------------------------------------------------

test('two HTTP 500 responses mark the row failed with attempts=2 and the tool still succeeds', async (t) => {
  const hook = await startFakeWebhook({ responses: [{ status: 500 }, { status: 500 }] });
  const app = await startHarness();
  registerCleanup(t, app, hook);
  await configureAlerts(app.base, webhookUrl(hook));

  const outcome = await reportProblem(app.base, {
    title: 'webhook answers 500',
    detail: 'the upstream keeps failing',
    severity: 'medium',
  });
  assert.equal(outcome.isError, false, JSON.stringify(outcome.body));
  assert.match(outcome.reportId, /^rep_[0-9a-f]{32}$/);

  const failed = await until('alert_state failed', () => {
    const current = reportRow(app.assembly.db, outcome.reportId);
    return current !== null && current['alert_state'] === 'failed' ? current : null;
  }, 10_000);
  assert.equal(failed['alert_attempts'], 2);
  assert.match(String(failed['alert_error']), /^ALERT_HTTP_500: /);
  assert.equal(failed['alerted_at'], null);
  assert.equal(hook.requests.length, 2, 'one retry means exactly two POSTs');
});

// ---------------------------------------------------------------------------
// 5. Shutdown path: close() during a drain returns the row to pending.
// ---------------------------------------------------------------------------

test('closing assembly during a drain returns the in-flight row to pending', async (t) => {
  const gate = createDeferred();
  const hook = await startFakeWebhook({ gate: gate.promise });
  const app = await startHarness();
  registerCleanup(t, app, hook);
  await configureAlerts(app.base, webhookUrl(hook));

  const outcome = await reportProblem(app.base, {
    title: 'in flight at shutdown',
    detail: 'close() must not lose this report',
    severity: 'high',
  });
  assert.equal(outcome.isError, false, JSON.stringify(outcome.body));

  await hook.waitForRequests(1, 5_000);
  await until('row claimed as sending', () => {
    const current = reportRow(app.assembly.db, outcome.reportId);
    return current !== null && current['alert_state'] === 'sending' ? current : null;
  });

  await app.closeAssembly();

  // The DB is closed by assembly.close(); reopen the same file to inspect it.
  const reopened = openStateDb(app.dbPath);
  try {
    const row = reportRow(reopened, outcome.reportId);
    assert.ok(row !== null, 'the report row must survive shutdown');
    assert.equal(row['alert_state'], 'pending');
    assert.equal(row['alerted_at'], null);
  } finally {
    reopened.close();
  }
  assert.equal(hook.requests.length, 1);
});

// ---------------------------------------------------------------------------
// 6. Rate control: 25 pending rows + 45009 cooldown never mark a row failed.
// ---------------------------------------------------------------------------

test('a 45009 cooldown with 25 backlog rows never marks a report failed', async (t) => {
  const hook = await startFakeWebhook({
    responses: [{ body: { errcode: 45009, errmsg: 'api freq out of limit' } }],
  });
  const app = await startHarness();
  registerCleanup(t, app, hook);
  await configureAlerts(app.base, webhookUrl(hook));

  // Backlog setup only; the 25th row is created through the admin API so its
  // create() call kicks the dispatcher, exactly like production.
  const store = createDbReportStore(app.assembly.db);
  const baseMs = Date.now();
  for (let index = 0; index < 24; index += 1) {
    store.insert({
      id: `rep_${randomUUID().replaceAll('-', '')}`,
      createdAt: new Date(baseMs + index).toISOString(),
      updatedAt: new Date(baseMs + index).toISOString(),
      source: 'mcp',
      binding: null,
      client: 'e2e',
      mcp: 'e2e',
      exec: null,
      evalId: null,
      ownerKey: `e2e-backlog-${index}`,
      severity: 'high',
      title: `backlog ${index}`,
      detail: `backlog detail ${index}`,
      contextJson: null,
      fingerprint: `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
    });
  }
  assert.equal(countReports(app.assembly.db), 24);

  const created = await fetch(`${app.base}/admin/api/reports`, {
    method: 'POST',
    headers: { ...adminHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'backlog 24',
      detail: 'backlog detail 24',
      severity: 'high',
    }),
  });
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  assert.equal(countReports(app.assembly.db), 25);

  const limited = await until('first ALERT_WECOM_45009', () => {
    const row = app.assembly.db
      .prepare("SELECT * FROM reports WHERE alert_error = 'ALERT_WECOM_45009'")
      .get();
    return row === undefined ? null : (row as ReportRow);
  }, 10_000);
  assert.equal(limited['alert_state'], 'pending');
  assert.equal(limited['alert_attempts'], 0);
  assert.equal(hook.requests.length, 1);

  // Cooldown suppresses further sends while the backlog stays queued.
  await delay(600);
  assert.equal(hook.requests.length, 1, 'the 45009 cooldown must pause the drain');

  assert.equal(countReports(app.assembly.db, "alert_state = 'failed'"), 0);
  assert.equal(countReports(app.assembly.db, "alert_state = 'sent'"), 0);
  assert.equal(countReports(app.assembly.db), 25);
});
