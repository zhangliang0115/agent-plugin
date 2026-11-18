import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { AdminHandler, AdminRequest, AdminResponse } from '../src/admin/servers.ts';
import { createAuditRuntime, type AuditRuntime } from '../src/audit/runtime.ts';
import type { AuditEvent, Clock } from '../src/ports.ts';

const START = Date.UTC(2026, 10, 18, 6, 0, 0);
const ISO = new Date(START).toISOString();
const DAY = '2026-11-18';

class TestClock implements Clock {
  private current: number;

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

interface Fixture {
  dir: string;
  clock: TestClock;
  runtime: AuditRuntime;
}

async function createFixture(
  t: TestContext,
  options: { onEvent?: (event: AuditEvent) => void; log?: (line: string) => void } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'repl-audit-runtime-'));
  const clock = new TestClock(START);
  const runtime = createAuditRuntime({
    dir,
    clock,
    frameMode: 'summary',
    log: options.log ?? (() => undefined),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  t.after(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, clock, runtime };
}

async function readRecords(dir: string, day = DAY): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(dir, `audit-${day}.jsonl`), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface EventIdentity {
  v: number;
  ts: string;
  identity: 'bound';
  binding: string;
  client: string;
  mcp: string;
  exec?: string;
}

function identity(exec?: string): EventIdentity {
  return {
    v: 1,
    ts: ISO,
    identity: 'bound',
    binding: 'cb_1',
    client: 'claude-code/2.1.327',
    mcp: 'mcp_1',
    ...(exec === undefined ? {} : { exec }),
  };
}

function sampleEvents(): {
  evalStart: AuditEvent;
  toolCall: AuditEvent;
  toolResult: AuditEvent;
  task: AuditEvent;
} {
  return {
    evalStart: {
      ...identity('es_1'),
      event: 'eval_start',
      evalId: 1,
      timeoutMs: 30_000,
    },
    toolCall: {
      ...identity('es_1'),
      event: 'tool_call',
      evalId: 1,
      seq: 1,
      tool: 'Bash',
      server: 'serve',
      mode: 'serial',
      queuedAt: START,
    },
    toolResult: {
      ...identity('es_1'),
      event: 'tool_result',
      evalId: 1,
      seq: 1,
      ok: true,
      queueMs: 0,
      ms: 12,
    },
    task: {
      ...identity('es_1'),
      event: 'async_dispatch',
      evalId: 1,
      evalTaskId: 't_1',
      ttlMs: 9_000_000,
    },
  };
}

function request(
  method: string,
  path: string,
  query: Record<string, string | string[]> = {},
): AdminRequest {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, value);
    }
  }
  return { method, path, query: params };
}

async function call(
  handlers: readonly AdminHandler[],
  incoming: AdminRequest,
): Promise<AdminResponse | null> {
  for (const handler of handlers) {
    const response = await handler(incoming);
    if (response !== null) return response;
  }
  return null;
}

function bodyOf(response: AdminResponse | null): Record<string, unknown> {
  assert.ok(response !== null, 'expected a handler response');
  assert.ok(response.body !== undefined, 'expected a response body');
  return response.body as Record<string, unknown>;
}

test('records eval, tool, task and frame events into daily JSONL and drains on close', async (t) => {
  const seen: AuditEvent[] = [];
  const { dir, runtime } = await createFixture(t, { onEvent: (event) => seen.push(event) });
  const { evalStart, toolCall, toolResult, task } = sampleEvents();

  runtime.recordEval(evalStart);
  runtime.recordToolCall(toolCall);
  runtime.recordToolCall(toolResult);
  runtime.recordTask(task);
  runtime.recordFrameIn({
    mcp: 'mcp_1',
    identity: 'bound',
    binding: 'cb_1',
    client: 'claude-code/2.1.327',
    id: 1,
    method: 'tools/call',
    params: { name: 'run_script', arguments: { code: 'return 1' } },
  });
  runtime.recordFrameOut({
    mcp: 'mcp_1',
    id: 1,
    result: { content: [{ type: 'text', text: 'ok' }] },
    exec: 'es_1',
    evalId: 1,
  });

  await runtime.close();

  const records = await readRecords(dir);
  assert.deepEqual(
    records.map((record) => record['event']),
    ['eval_start', 'tool_call', 'tool_result', 'async_dispatch', 'proto_in', 'proto_out'],
  );
  for (const record of records) {
    assert.equal(record['v'], 1);
    assert.equal(record['ts'], ISO, 'the injected clock stamps every line');
    assert.equal(record['binding'], 'cb_1');
    assert.equal(record['client'], 'claude-code/2.1.327');
  }

  const [protoIn, protoOut] = records.slice(-2);
  assert.ok(protoIn !== undefined && protoOut !== undefined);
  assert.equal(protoIn['id'], 1);
  assert.equal(protoIn['method'], 'tools/call');
  assert.equal(typeof protoIn['bytes'], 'number');
  assert.equal('params' in protoIn, false, 'summary mode stores no payload');

  assert.equal(protoOut['method'], 'tools/call', 'response inherits the request method');
  assert.equal(protoOut['durMs'], 0);
  assert.equal(protoOut['ok'], true);
  assert.equal(protoOut['exec'], 'es_1');
  assert.equal(protoOut['evalId'], 1);
  assert.equal('result' in protoOut, false, 'summary mode stores no payload');

  assert.deepEqual(
    seen.map((event) => event.event),
    ['eval_start', 'tool_call', 'tool_result', 'async_dispatch', 'proto_in', 'proto_out'],
    'onEvent sees every event that reached the writer',
  );
  const stats = runtime.stats();
  assert.equal(stats.healthy, true);
  assert.equal(stats.droppedEvents, 0);
  assert.equal(stats.frames.written, 2);
  assert.equal(stats.frames.pending, 0);
  assert.equal(stats.file, null, 'close clears the current file handle');
});

test('flush drains without closing and close is idempotent', async (t) => {
  const { dir, runtime } = await createFixture(t);
  const { evalStart } = sampleEvents();

  runtime.recordEval(evalStart);
  await runtime.flush();
  const afterFlush = await readRecords(dir);
  assert.equal(afterFlush.length, 1);
  assert.equal(afterFlush[0]?.['event'], 'eval_start');

  await runtime.close();
  const contents = await readFile(join(dir, `audit-${DAY}.jsonl`), 'utf8');

  runtime.recordEval({ ...evalStart, event: 'eval_end', outcome: 'ok' });
  runtime.recordFrameIn({ mcp: 'mcp_1', id: 2, method: 'ping' });
  runtime.recordTask({ ...evalStart, event: 'task_cancel', evalTaskId: 't_1' });
  await runtime.close();

  assert.equal(await readFile(join(dir, `audit-${DAY}.jsonl`), 'utf8'), contents);
});

test('invalid events are logged and never written', async (t) => {
  const lines: string[] = [];
  const { dir, runtime } = await createFixture(t, { log: (line) => lines.push(line) });

  runtime.recordEval({ ts: ISO, event: '' } as AuditEvent);
  await runtime.close();

  assert.deepEqual(await readdir(dir), [], 'no daily file is opened for a rejected event');
  assert.ok(lines.some((line) => /missing event name/.test(line)));
});

const FIXTURE_EVENTS: AuditEvent[] = [
  {
    ...identity('es_1'),
    event: 'eval_start',
    evalId: 1,
    timeoutMs: 30_000,
  },
  {
    ...identity('es_1'),
    event: 'tool_call',
    evalId: 1,
    seq: 1,
    tool: 'Bash',
    server: 'serve',
    mode: 'serial',
    queuedAt: START,
  },
  {
    ...identity('es_1'),
    event: 'tool_result',
    evalId: 1,
    seq: 1,
    ok: true,
    queueMs: 0,
    ms: 12,
  },
  {
    ...identity('es_1'),
    event: 'eval_end',
    evalId: 1,
    outcome: 'ok',
    ms: 20,
  },
];

const FIXTURE_FRAMES: AuditEvent[] = [
  {
    ...identity(),
    event: 'proto_in',
    id: 7,
    method: 'tools/call',
    bytes: 40,
    params: { name: 'run_script' },
  },
  {
    ...identity(),
    event: 'proto_out',
    id: 7,
    method: 'tools/call',
    durMs: 12,
    ok: true,
    bytes: 60,
    result: { content: [{ type: 'text', text: 'ok' }] },
  },
];

async function writeAuditFixture(dir: string): Promise<void> {
  await writeFile(
    join(dir, `audit-${DAY}.jsonl`),
    `${FIXTURE_EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(
    join(dir, `protocol-${DAY}.jsonl`),
    `${FIXTURE_FRAMES.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
}

test('handlers serve query pagination, eval traces, sessions, frames, stats and export', async (t) => {
  const { dir, runtime } = await createFixture(t);
  await writeAuditFixture(dir);
  const handlers = runtime.handlers();

  const firstPage = await call(handlers, request('GET', '/admin/api/audit/query', { limit: '2' }));
  assert.equal(firstPage?.status, 200);
  const firstBody = bodyOf(firstPage);
  assert.equal((firstBody.events as AuditEvent[]).length, 2);
  assert.equal(firstBody.hasMore, true);
  const cursor = firstBody.nextCursor;
  assert.equal(typeof cursor, 'string');

  const fromPath = await call(handlers, request('GET', '/admin/api/audit/query?limit=2'));
  assert.equal(fromPath?.status, 200);
  assert.equal((bodyOf(fromPath).events as AuditEvent[]).length, 2);

  // `/api` is accepted as the already-consumed prefix form.
  const secondPage = await call(
    handlers,
    request('GET', '/api/audit/query', { limit: '2', cursor: String(cursor) }),
  );
  assert.equal(secondPage?.status, 200);
  const secondEvents = bodyOf(secondPage).events as AuditEvent[];
  assert.equal(secondEvents.length, 2);
  const firstKeys = (firstBody.events as AuditEvent[]).map((event) => `${event.event}:${event.ts}`);
  assert.ok(
    secondEvents.every((event) => !firstKeys.includes(`${event.event}:${event.ts}`)),
    'cursor pages must not overlap',
  );

  const trace = await call(handlers, request('GET', '/admin/api/audit/evals/es_1/1'));
  assert.equal(trace?.status, 200);
  assert.equal(bodyOf(trace).count, 4);
  assert.equal((bodyOf(trace).events as AuditEvent[])[0]?.event, 'eval_start');

  const missingTrace = await call(handlers, request('GET', '/admin/api/audit/evals/es_1/99'));
  assert.equal(missingTrace?.status, 404);
  assert.equal((bodyOf(missingTrace).error as Record<string, unknown>).code, 'EVAL_NOT_FOUND');

  const badEvalId = await call(handlers, request('GET', '/admin/api/audit/evals/es_1/abc'));
  assert.equal(badEvalId?.status, 400);

  const sessions = await call(handlers, request('GET', '/admin/api/audit/sessions'));
  assert.equal(sessions?.status, 200);
  const sessionRows = bodyOf(sessions).sessions as Array<Record<string, unknown>>;
  assert.equal(sessionRows.length, 1);
  assert.equal(sessionRows[0]?.['exec'], 'es_1');

  const summaryFrames = await call(handlers, request('GET', '/admin/api/audit/frames'));
  assert.equal(summaryFrames?.status, 200);
  const summaryBody = bodyOf(summaryFrames);
  const summaryRows = summaryBody.frames as Array<Record<string, unknown>>;
  assert.equal(summaryRows.length, 1);
  const summaryPair = summaryRows[0];
  assert.ok(summaryPair !== undefined);
  assert.equal(summaryPair['id'], 7);
  assert.equal(summaryPair['durMs'], 12);
  assert.equal('params' in (summaryPair['request'] as Record<string, unknown>), false);
  assert.equal('result' in (summaryPair['response'] as Record<string, unknown>), false);

  const fullFrames = await call(
    handlers,
    request('GET', '/admin/api/audit/frames', { detail: 'full' }),
  );
  assert.equal(fullFrames?.status, 200);
  const fullPair = (bodyOf(fullFrames).frames as Array<Record<string, unknown>>)[0];
  assert.ok(fullPair !== undefined);
  assert.deepEqual((fullPair['request'] as Record<string, unknown>)['params'], {
    name: 'run_script',
  });
  assert.ok((fullPair['response'] as Record<string, unknown>)['result'] !== undefined);

  const badDetail = await call(
    handlers,
    request('GET', '/admin/api/audit/frames', { detail: 'raw' }),
  );
  assert.equal(badDetail?.status, 400);

  const stats = await call(handlers, request('GET', '/admin/api/audit/stats'));
  assert.equal(stats?.status, 200);
  const statsBody = bodyOf(stats);
  assert.equal(statsBody.calls, 1, 'only tool_result rows count as calls');
  assert.equal(statsBody.errors, 0);
  assert.match(String(statsBody.snapshotId), /^[0-9a-f]{32}$/);

  const exported = await call(handlers, request('GET', '/admin/api/audit/export'));
  assert.equal(exported?.status, 200);
  assert.match(
    String(exported?.headers?.['content-type']),
    /^application\/x-ndjson/,
    'export keeps the NDJSON content type',
  );
  assert.ok(Buffer.isBuffer(exported?.body), 'the admin layer buffers the export stream');
  const lines = (exported?.body as Buffer).toString('utf8').trim().split('\n');
  assert.equal(lines.length, FIXTURE_EVENTS.length);

  const notGet = await call(handlers, request('POST', '/admin/api/audit/query'));
  assert.equal(notGet, null, 'audit routes only accept GET');
  const unknown = await call(handlers, request('GET', '/admin/api/audit/unknown'));
  assert.equal(unknown, null, 'unknown audit routes fall through');
  const elsewhere = await call(handlers, request('GET', '/admin/api/servers'));
  assert.equal(elsewhere, null, 'non-audit routes fall through');
});

test('query rejects an invalid cursor with a 400', async (t) => {
  const { dir, runtime } = await createFixture(t);
  await writeAuditFixture(dir);
  const response = await call(
    runtime.handlers(),
    request('GET', '/admin/api/audit/query', { cursor: 'not-a-cursor' }),
  );
  assert.equal(response?.status, 400);
  assert.equal((bodyOf(response).error as Record<string, unknown>).code, 'INVALID_CURSOR');
});
