import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AuditEvent, Clock, RequestIdentity } from '../src/ports.ts';
import { createAuditEndpoints } from '../src/audit/endpoints.ts';
import {
  AuditStatsSaturatedError,
  AuditStatsService,
  computeAuditStats,
  countAudit,
  exportAuditJsonl,
  InvalidAuditFilterError,
  listAuditFiles,
  listExecSessions,
  matchesFilter,
  normalizeFilter,
  eventStatus,
  parseAuditQueryParams,
  queryAudit,
  readEvalTrace,
  type StatsWorkerData,
  type StatsWorkerLike,
} from '../src/audit/query.ts';

const IDENTITY: RequestIdentity = {
  identity: 'bound',
  binding: 'cb_1',
  client: 'claude-code/2.1.327',
  clientName: 'claude-code',
  clientVersion: '2.1.327',
  mcp: 'mcp_1',
};

const DAY_18 = Date.UTC(2026, 10, 18, 6, 0, 0);
const DAY_17_TS = '2026-11-17T23:59:00.000Z';

interface Fixture {
  dir: string;
  auditEvents: AuditEvent[];
}

function nextTs(counter: { value: number }): string {
  const ts = new Date(DAY_18 + counter.value * 10).toISOString();
  counter.value += 1;
  return ts;
}

function buildAuditEvents(): AuditEvent[] {
  const counter = { value: 0 };
  const common = { v: 1, ...IDENTITY };
  return [
    { ...common, ts: DAY_17_TS, event: 'session_start', transport: 'http' },
    { ...common, ts: nextTs(counter), event: 'exec_start', exec: 'es_1', workspace: '/repo/a', servePid: 101 },
    { ...common, ts: nextTs(counter), event: 'eval_start', exec: 'es_1', evalId: 1, timeoutMs: 30000 },
    {
      ...common,
      ts: nextTs(counter),
      event: 'tool_call',
      exec: 'es_1',
      evalId: 1,
      seq: 1,
      tool: 'Bash',
      server: 'serve',
      mode: 'serial',
      queuedAt: 1,
    },
    {
      ...common,
      ts: nextTs(counter),
      event: 'tool_result',
      exec: 'es_1',
      evalId: 1,
      seq: 1,
      tool: 'Bash',
      server: 'serve',
      ok: true,
      queueMs: 5,
      ms: 20,
    },
    {
      ...common,
      ts: nextTs(counter),
      event: 'tool_call',
      exec: 'es_1',
      evalId: 1,
      seq: 2,
      tool: 'Read',
      server: 'serve',
      mode: 'parallel',
      queuedAt: 2,
    },
    {
      ...common,
      ts: nextTs(counter),
      event: 'tool_result',
      exec: 'es_1',
      evalId: 1,
      seq: 2,
      tool: 'Read',
      server: 'serve',
      ok: false,
      queueMs: 50,
      ms: 200,
      errorCode: 'TOOL_ERROR',
    },
    { ...common, ts: nextTs(counter), event: 'eval_end', exec: 'es_1', evalId: 1, outcome: 'timeout', ms: 30050 },
    { ...common, ts: nextTs(counter), event: 'exec_start', exec: 'es_2', workspace: '/repo/b', servePid: 102 },
    { ...common, ts: nextTs(counter), event: 'eval_start', exec: 'es_2', evalId: 1, timeoutMs: 30000 },
    {
      ...common,
      ts: nextTs(counter),
      event: 'tool_call',
      exec: 'es_2',
      evalId: 1,
      seq: 1,
      tool: 'Bash',
      server: 'mcp:pg',
      mode: 'parallel',
      queuedAt: 3,
    },
    {
      ...common,
      ts: nextTs(counter),
      event: 'tool_result',
      exec: 'es_2',
      evalId: 1,
      seq: 1,
      tool: 'Bash',
      server: 'mcp:pg',
      ok: true,
      queueMs: 0,
      ms: 5,
    },
    { ...common, ts: nextTs(counter), event: 'eval_end', exec: 'es_2', evalId: 1, outcome: 'ok', ms: 10 },
    { ...common, ts: nextTs(counter), event: 'exec_end', exec: 'es_2', reason: 'idle_recycle', ms: 1000 },
    { ...common, ts: nextTs(counter), event: 'exec_end', exec: 'es_1', reason: 'shutdown', ms: 2000 },
  ] as AuditEvent[];
}

function buildProtocolEvents(): AuditEvent[] {
  const at = (offset: number): string => new Date(DAY_18 + offset).toISOString();
  const common = { v: 1, ...IDENTITY };
  return [
    { ...common, ts: at(0), event: 'proto_in', id: 1, method: 'tools/call', bytes: 40, params: { name: 'run_script' } },
    {
      ...common,
      ts: at(12),
      event: 'proto_out',
      id: 1,
      method: 'tools/call',
      durMs: 12,
      ok: true,
      bytes: 60,
      result: { content: [{ type: 'text', text: 'ok' }] },
    },
    { ...common, ts: at(20), event: 'proto_in', id: null, method: 'notifications/initialized', bytes: 2 },
    { v: 1, ts: at(30), event: 'protocol_dropped', count: 4, windowMs: 1000 },
  ] as AuditEvent[];
}

async function createFixture(t: { after(fn: () => unknown): void }): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'repl-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  const auditEvents = buildAuditEvents();
  const protocolEvents = buildProtocolEvents();
  const day17 = auditEvents.filter((event) => event.ts === DAY_17_TS);
  const day18 = auditEvents.filter((event) => event.ts !== DAY_17_TS);
  await writeFile(
    join(dir, 'audit-2026-11-17.jsonl'),
    `${day17.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(
    join(dir, 'audit-2026-11-18.jsonl'),
    `${day18.map((event) => JSON.stringify(event)).join('\n')}\n{"torn":\n`,
    'utf8',
  );
  await writeFile(
    join(dir, 'protocol-2026-11-18.jsonl'),
    `${protocolEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  return { dir, auditEvents };
}

function bodyOf(result: { body?: unknown; stream?: AsyncIterable<string> }): Record<string, unknown> {
  assert.ok(result.body !== undefined, 'expected a JSON body');
  return result.body as Record<string, unknown>;
}

async function collectStream(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test('parseAuditQueryParams validates evalId, status and limit', () => {
  assert.throws(
    () => normalizeFilter({ evalId: 1 }),
    (error: unknown) => error instanceof InvalidAuditFilterError && /requires exec/.test(error.message),
  );
  assert.throws(
    () => normalizeFilter({ status: 'slow' }),
    (error: unknown) => error instanceof InvalidAuditFilterError,
  );
  const parsed = normalizeFilter({
    from: '2026-11-18T06:00:00.000Z',
    to: DAY_18 + 1000,
    event: ['tool_result', 'eval_end'],
    evalId: '3',
    exec: 'es_1',
    status: 'error',
  });
  assert.equal(parsed.from, DAY_18);
  assert.equal(parsed.to, DAY_18 + 1000);
  assert.deepEqual(parsed.events, ['tool_result', 'eval_end']);
  assert.equal(parsed.evalId, 3);
  assert.equal(parsed.status, 'error');
});

test('ai_run maps outcome to status and serverId to the server filter', () => {
  const base = {
    v: 1,
    ts: new Date(DAY_18).toISOString(),
    event: 'ai_run',
    identity: 'unbound',
    binding: null,
    client: 'admin',
    mcp: 'admin',
    kind: 'annotate',
    trigger: 'manual',
    serverId: 'srv_ai',
    template: 'annotate',
    promptVersion: 1,
    promptBytes: 10,
    model: null,
    durationMs: 5,
    code: null,
    resultBytes: 0,
    costUsd: null,
    proposalId: null,
  } as unknown as AuditEvent;

  const failed = { ...base, outcome: 'error' } as AuditEvent;
  const passed = { ...base, outcome: 'ok' } as AuditEvent;
  assert.equal(eventStatus(failed), 'error');
  assert.equal(eventStatus(passed), 'ok');
  assert.equal(matchesFilter(failed, normalizeFilter({ status: 'error' })), true);
  assert.equal(matchesFilter(passed, normalizeFilter({ status: 'error' })), false);
  assert.equal(matchesFilter(failed, normalizeFilter({ server: 'srv_ai' })), true);
  assert.equal(matchesFilter(failed, normalizeFilter({ server: 'srv_other' })), false);
});

test('eval_end maps outcome to status', () => {
  const base = {
    v: 1,
    ts: new Date(DAY_18).toISOString(),
    event: 'eval_end',
    exec: 'es_1',
    evalId: 1,
  } as unknown as AuditEvent;

  assert.equal(eventStatus({ ...base, outcome: 'ok' } as AuditEvent), 'ok');
  assert.equal(eventStatus({ ...base, outcome: 'error' } as AuditEvent), 'error');
  assert.equal(eventStatus({ ...base, outcome: 'worker_dead' } as AuditEvent), 'error');
  assert.equal(eventStatus({ ...base, outcome: 'timeout' } as AuditEvent), 'timeout');
  assert.equal(eventStatus({ ...base, outcome: 'cancelled' } as AuditEvent), 'ok');
});

test('matchesFilter and parseAuditQueryParams support the eval runId', () => {
  const event = {
    event: 'tool_call',
    ts: new Date(DAY_18).toISOString(),
    exec: 'es_1',
    runId: 'run_1',
  };
  assert.equal(matchesFilter(event, normalizeFilter({ runId: 'run_1' })), true);
  assert.equal(matchesFilter(event, normalizeFilter({ runId: 'run_2' })), false);
  assert.equal(parseAuditQueryParams(new URLSearchParams('runId=run_1')).runId, 'run_1');
});

test('queryAudit finds ai_run events by status and serverId', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'repl-audit-ai-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = {
    v: 1,
    ts: new Date(DAY_18).toISOString(),
    event: 'ai_run',
    identity: 'unbound',
    binding: null,
    client: 'admin',
    mcp: 'admin',
    kind: 'annotate',
    trigger: 'manual',
    serverId: 'srv_ai',
    template: 'annotate',
    promptVersion: 1,
    promptBytes: 10,
    model: null,
    durationMs: 5,
    code: null,
    resultBytes: 0,
    costUsd: null,
    proposalId: null,
    outcome: 'ok',
  };
  const failed = { ...base, ts: new Date(DAY_18 + 10).toISOString(), outcome: 'error', code: 'AI_TIMEOUT' };
  const passed = { ...base, ts: new Date(DAY_18 + 20).toISOString() };
  await writeFile(
    join(dir, 'audit-2026-11-18.jsonl'),
    `${[JSON.stringify(failed), JSON.stringify(passed)].join('\n')}\n`,
    'utf8',
  );

  const hits = await queryAudit(dir, normalizeFilter({ status: 'error', server: 'srv_ai' }), {
    limit: 100,
  });
  assert.equal(hits.events.length, 1);
  assert.equal(hits.events[0]?.event, 'ai_run');
  assert.equal(hits.events[0]?.outcome, 'error');
  assert.equal(hits.events[0]?.code, 'AI_TIMEOUT');

  const byServer = await queryAudit(dir, normalizeFilter({ server: 'srv_ai' }), { limit: 100 });
  assert.equal(byServer.events.length, 2);
  assert.ok(byServer.events.every((event) => event.event === 'ai_run'));
});

test('queryAudit pages across files with a byte-offset cursor and skips torn lines', async (t) => {
  const { dir, auditEvents } = await createFixture(t);
  const filter = normalizeFilter({});
  const first = await queryAudit(dir, filter, { limit: 4 });
  assert.equal(first.events.length, 4);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor !== null);

  const seen: string[] = [];
  let cursor: string | undefined = first.nextCursor ?? undefined;
  seen.push(...first.events.map((event) => `${event.event}:${event.ts}`));
  let pages = 1;
  while (cursor !== undefined) {
    const page: Awaited<ReturnType<typeof queryAudit>> = await queryAudit(dir, filter, {
      limit: 4,
      cursor,
    });
    seen.push(...page.events.map((event) => `${event.event}:${event.ts}`));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    assert.ok(pages < 20, 'pagination failed to terminate');
  }
  assert.equal(seen.length, auditEvents.length);
  assert.equal(new Set(seen).size, seen.length, 'pages must not overlap');
});

test('queryAudit applies event, exec/evalId, tool and status filters', async (t) => {
  const { dir, auditEvents } = await createFixture(t);

  const toolResults = await queryAudit(dir, normalizeFilter({ event: 'tool_result' }), { limit: 100 });
  assert.equal(toolResults.events.length, 3);

  const rawFilter = await queryAudit(dir, { event: 'tool_result' }, { limit: 100 });
  assert.equal(rawFilter.events.length, 3, 'raw filters are normalized by the query helpers');

  const evalEvents = await queryAudit(dir, normalizeFilter({ exec: 'es_1', evalId: 1 }), {
    limit: 100,
  });
  assert.equal(evalEvents.events.length, 6);
  assert.ok(evalEvents.events.every((event) => event.exec === 'es_1' && event.evalId === 1));

  const reads = await queryAudit(dir, normalizeFilter({ tool: 'Read' }), { limit: 100 });
  assert.equal(reads.events.length, 2);
  assert.equal(reads.events[0]?.event, 'tool_call');

  const failures = await queryAudit(dir, normalizeFilter({ event: 'tool_result', status: 'error' }), {
    limit: 100,
  });
  assert.equal(failures.events.length, 1);
  assert.equal(failures.events[0]?.seq, 2);

  const timeouts = await queryAudit(dir, normalizeFilter({ status: 'timeout' }), { limit: 100 });
  assert.equal(timeouts.events.length, 1);
  assert.equal(timeouts.events[0]?.event, 'eval_end');

  const from = DAY_18 + 50;
  const to = DAY_18 + 90;
  const windowed = await queryAudit(dir, normalizeFilter({ from, to }), { limit: 100 });
  const expected = auditEvents.filter((event) => {
    const ts = Date.parse(event.ts);
    return ts >= from && ts <= to;
  });
  assert.equal(windowed.events.length, expected.length);
  assert.ok(windowed.events.every((event) => {
    const ts = Date.parse(event.ts);
    return ts >= from && ts <= to;
  }));
});

test('multi-value filters accept repeated and comma-separated params', async (t) => {
  const { dir } = await createFixture(t);
  const parsed = parseAuditQueryParams(
    new URLSearchParams([
      ['clientName', 'claude-code,other'],
      ['clientName', 'third'],
      ['clientVersion', '2.1.327'],
      ['binding', 'cb_1'],
      ['binding', 'cb_2'],
      ['tool', 'Bash'],
      ['tool', 'Read'],
      ['server', 'serve,mcp:pg'],
      ['method', 'tools/call'],
      ['method', 'tools/list'],
      ['status', 'ok'],
      ['status', 'error'],
    ]),
  );
  assert.deepEqual(parsed.clientNames, ['claude-code', 'other', 'third']);
  assert.equal(parsed.clientVersion, '2.1.327');
  assert.deepEqual(parsed.bindings, ['cb_1', 'cb_2']);
  assert.deepEqual(parsed.tools, ['Bash', 'Read']);
  assert.deepEqual(parsed.servers, ['serve', 'mcp:pg']);
  assert.deepEqual(parsed.methods, ['tools/call', 'tools/list']);
  assert.deepEqual(parsed.statuses, ['ok', 'error']);

  const byTools = await queryAudit(dir, normalizeFilter({ tool: ['Bash', 'Read'] }), { limit: 100 });
  assert.ok(byTools.events.length > 0);
  assert.ok(byTools.events.every((event) => event.tool === 'Bash' || event.tool === 'Read'));

  const statuses = await queryAudit(dir, normalizeFilter({ status: ['ok', 'error'] }), { limit: 100 });
  const errorsOnly = await queryAudit(dir, normalizeFilter({ status: 'error' }), { limit: 100 });
  assert.ok(statuses.events.length > errorsOnly.events.length);

  assert.throws(
    () => normalizeFilter({ status: ['ok', 'nope'] }),
    InvalidAuditFilterError,
  );
});

test('listAuditFiles filters by UTC day and sorted order', async (t) => {
  const { dir } = await createFixture(t);
  const all = await listAuditFiles(dir, 'audit');
  assert.deepEqual(
    all.map((file) => file.split('/').pop()),
    ['audit-2026-11-17.jsonl', 'audit-2026-11-18.jsonl'],
  );
  const day18Only = await listAuditFiles(dir, 'audit', DAY_18);
  assert.deepEqual(
    day18Only.map((file) => file.split('/').pop()),
    ['audit-2026-11-18.jsonl'],
  );
  assert.deepEqual(await listAuditFiles(join(dir, 'missing'), 'audit'), []);
});

test('readEvalTrace returns the ordered trace for one exec + evalId', async (t) => {
  const { dir } = await createFixture(t);
  const trace = await readEvalTrace(dir, 'es_1', 1);
  assert.equal(trace.length, 6);
  assert.equal(trace[0]?.event, 'eval_start');
  assert.equal(trace[trace.length - 1]?.event, 'eval_end');
  const timestamps = trace.map((event) => Date.parse(event.ts));
  assert.deepEqual(timestamps, [...timestamps].sort((left, right) => left - right));
  assert.deepEqual(await readEvalTrace(dir, 'es_1', 99), []);
});

test('listExecSessions aggregates starts, ends and tool activity', async (t) => {
  const { dir } = await createFixture(t);
  const sessions = await listExecSessions(dir, normalizeFilter({}));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.exec, 'es_1', 'most recently active first');
  assert.equal(sessions[0]?.workspace, '/repo/a');
  assert.equal(sessions[0]?.servePid, 101);
  assert.equal(sessions[0]?.evals, 1);
  assert.equal(sessions[0]?.toolCalls, 2);
  assert.equal(sessions[0]?.toolErrors, 1);
  assert.equal(sessions[0]?.endReason, 'shutdown');
  assert.equal(sessions[0]?.client, 'claude-code/2.1.327');
  assert.equal(sessions[0]?.clientName, 'claude-code');
  assert.equal(sessions[0]?.clientVersion, '2.1.327');
  assert.equal(sessions[1]?.exec, 'es_2');
  assert.equal(sessions[1]?.workspace, '/repo/b');
  assert.equal(sessions[1]?.toolCalls, 1);
  assert.equal(sessions[1]?.toolErrors, 0);
  assert.equal(sessions[1]?.endReason, 'idle_recycle');
});

test('client name and version filter independently and the legacy client filter still works', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'repl-audit-client-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = (offset: number): string => new Date(DAY_18 + offset).toISOString();
  const events: AuditEvent[] = [
    {
      v: 1,
      ts: at(0),
      event: 'tool_result',
      client: 'claude-code/2.1.327',
      clientName: 'claude-code',
      clientVersion: '2.1.327',
      ok: true,
    },
    {
      v: 1,
      ts: at(10),
      event: 'tool_result',
      client: 'claude-code/2.1.328',
      clientName: 'claude-code',
      clientVersion: '2.1.328',
      ok: true,
    },
    {
      v: 1,
      ts: at(20),
      event: 'tool_result',
      client: 'probe/1.0',
      clientName: 'probe',
      clientVersion: '1.0',
      ok: true,
    },
    // Pre-v4 audit lines carry only the combined label.
    { v: 1, ts: at(30), event: 'tool_result', client: 'legacy-only', ok: true },
  ];
  await writeFile(
    join(dir, 'audit-2026-11-18.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );

  const byName = await queryAudit(dir, normalizeFilter({ clientName: 'claude-code' }), {
    limit: 100,
  });
  assert.equal(byName.events.length, 2);

  const byVersion = await queryAudit(dir, normalizeFilter({ clientVersion: '2.1.327' }), {
    limit: 100,
  });
  assert.equal(byVersion.events.length, 1);

  const combined = await queryAudit(
    dir,
    normalizeFilter({ clientName: 'claude-code', clientVersion: '2.1.328' }),
    { limit: 100 },
  );
  assert.equal(combined.events.length, 1);
  assert.equal(combined.events[0]?.client, 'claude-code/2.1.328');

  const legacy = await queryAudit(dir, normalizeFilter({ client: 'claude-code/2.1.327' }), {
    limit: 100,
  });
  assert.equal(legacy.events.length, 1);

  const parsed = parseAuditQueryParams(
    new URLSearchParams({ clientName: 'probe', clientVersion: '1.0', client: 'probe/1.0' }),
  );
  assert.equal(parsed.clientName, 'probe');
  assert.equal(parsed.clientVersion, '1.0');
  assert.equal(parsed.client, 'probe/1.0');

  assert.equal(
    matchesFilter(events[3] as AuditEvent, normalizeFilter({ clientName: 'legacy-only' })),
    false,
    'a pre-v4 line has no clientName to match',
  );
});

test('countAudit and exportAuditJsonl stream every matching event', async (t) => {
  const { dir, auditEvents } = await createFixture(t);
  const filter = normalizeFilter({});
  const counted = await countAudit(dir, filter, { stopAfter: 10_000 });
  assert.equal(counted.count, auditEvents.length);
  assert.equal(counted.truncated, false);

  const capped = await countAudit(dir, filter, { stopAfter: 3 });
  assert.deepEqual(capped, { count: 3, truncated: true });

  const lines = await collectStream(exportAuditJsonl(dir, filter, { maxRows: 10_000 }));
  assert.equal(lines.length, auditEvents.length);
  for (const line of lines) {
    assert.ok(line.endsWith('\n'));
    const parsed = JSON.parse(line) as AuditEvent;
    assert.ok(typeof parsed.event === 'string');
  }
});

test('stats aggregate tool results in a worker thread', async (t) => {
  const { dir } = await createFixture(t);
  const stats = await computeAuditStats(dir, normalizeFilter({}));
  assert.equal(stats.cached, false);
  assert.equal(stats.calls, 3);
  assert.equal(stats.errors, 1);
  assert.ok(Math.abs(stats.errorRate - 1 / 3) < 1e-9);
  assert.equal(stats.p50, 20);
  assert.equal(stats.p95, 200);
  assert.ok(stats.queueAvgMs !== null && Math.abs(stats.queueAvgMs - 55 / 3) < 1e-9);
  assert.match(stats.snapshotId, /^[0-9a-f]{32}$/);
  assert.ok(stats.scannedRows >= 15);
  assert.deepEqual(stats.groups, []);

  const errorsOnly = await computeAuditStats(dir, normalizeFilter({ status: 'error' }), {
    cacheTtlMs: 0,
  });
  assert.equal(errorsOnly.calls, 1);
  assert.equal(errorsOnly.errors, 1);
  assert.equal(errorsOnly.p50, 200);

  const bothStatuses = await computeAuditStats(
    dir,
    normalizeFilter({ status: ['ok', 'error'] }),
    { cacheTtlMs: 0 },
  );
  assert.equal(bothStatuses.calls, 3, 'multi-value status reaches the stats worker');

  const bothTools = await computeAuditStats(
    dir,
    normalizeFilter({ tool: ['Bash', 'Read'] }),
    { cacheTtlMs: 0 },
  );
  assert.equal(bothTools.calls, 3, 'multi-value tool reaches the stats worker');
});

test('stats groupBy tool/server/status produces ordered buckets', async (t) => {
  const { dir } = await createFixture(t);
  const byTool = await computeAuditStats(dir, normalizeFilter({}), { groupBy: 'tool' });
  assert.equal(byTool.groupBy, 'tool');
  const bash = byTool.groups.find((group) => group.key === 'Bash');
  const read = byTool.groups.find((group) => group.key === 'Read');
  assert.ok(bash !== undefined && read !== undefined);
  assert.equal(bash.calls, 2);
  assert.equal(bash.errors, 0);
  assert.equal(read.calls, 1);
  assert.equal(read.errors, 1);

  const byServer = await computeAuditStats(dir, normalizeFilter({}), { groupBy: 'server' });
  assert.deepEqual(
    byServer.groups.map((group) => [group.key, group.calls]),
    [['serve', 2], ['mcp:pg', 1]],
  );

  const byStatus = await computeAuditStats(dir, normalizeFilter({}), { groupBy: 'status' });
  assert.deepEqual(
    byStatus.groups.map((group) => [group.key, group.calls]),
    [['ok', 2], ['error', 1]],
  );
});

test('stats cache reuses a snapshot for 10s of injected clock time', async (t) => {
  const { dir } = await createFixture(t);
  const clock: Clock & { current: number } = {
    current: DAY_18,
    now() {
      return this.current;
    },
  };
  const counter = { count: 0 };
  const factory = makeFakeStatsFactory(counter);
  const service = new AuditStatsService({ clock, workerFactory: factory, cacheTtlMs: 10_000 });
  const filter = normalizeFilter({});
  const first = await service.compute(dir, filter);
  assert.equal(first.cached, false);
  assert.equal(counter.count, 1);
  const second = await service.compute(dir, filter);
  assert.equal(second.cached, true);
  assert.equal(counter.count, 1);
  clock.current += 10_001;
  const third = await service.compute(dir, filter);
  assert.equal(third.cached, false);
  assert.equal(counter.count, 2);
});

test('stats timeout saturation rejects with AuditStatsSaturatedError', async (t) => {
  const { dir } = await createFixture(t);
  await assert.rejects(
    computeAuditStats(dir, normalizeFilter({}), {
      timeoutMs: 0,
      timeoutGraceMs: 0,
      workerFactory: hangingStatsFactory,
    }),
    (error: unknown) =>
      error instanceof AuditStatsSaturatedError && error.details.reason === 'timeout',
  );
});

test('query endpoint paginates and reports invalid cursors', async (t) => {
  const { dir, auditEvents } = await createFixture(t);
  const endpoints = createAuditEndpoints({ dir });
  const identity = IDENTITY;
  const first = await endpoints.query({
    identity,
    params: new URLSearchParams({ limit: '4' }),
  });
  assert.equal(first.status, 200);
  const firstBody = bodyOf(first);
  assert.equal((firstBody.events as AuditEvent[]).length, 4);
  assert.equal(firstBody.hasMore, true);
  const cursor = firstBody.nextCursor;
  assert.equal(typeof cursor, 'string');

  const second = await endpoints.query({
    identity,
    params: new URLSearchParams({ limit: '4', cursor: String(cursor) }),
  });
  const secondBody = bodyOf(second);
  const firstKeys = (firstBody.events as AuditEvent[]).map((event) => `${event.event}:${event.ts}`);
  const secondKeys = (secondBody.events as AuditEvent[]).map((event) => `${event.event}:${event.ts}`);
  assert.ok(firstKeys.every((key) => !secondKeys.includes(key)));

  const invalid = await endpoints.query({
    identity,
    params: new URLSearchParams({ cursor: 'not-a-cursor' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((bodyOf(invalid).error as Record<string, unknown>).code, 'INVALID_CURSOR');

  const badLimit = await endpoints.query({
    identity,
    params: new URLSearchParams({ limit: '0' }),
  });
  assert.equal(badLimit.status, 400);

  assert.ok(auditEvents.length > 4);
});

test('eval trace endpoint returns the trace or 404', async (t) => {
  const { dir } = await createFixture(t);
  const endpoints = createAuditEndpoints({ dir });
  const found = await endpoints.evalTrace({
    identity: IDENTITY,
    params: new URLSearchParams({ exec: 'es_1', evalId: '1' }),
  });
  assert.equal(found.status, 200);
  const body = bodyOf(found);
  assert.equal(body.count, 6);
  assert.equal(body.exec, 'es_1');
  assert.equal(body.evalId, 1);

  const missing = await endpoints.evalTrace({
    identity: IDENTITY,
    params: new URLSearchParams({ exec: 'es_1', evalId: '99' }),
  });
  assert.equal(missing.status, 404);
  assert.equal((bodyOf(missing).error as Record<string, unknown>).code, 'EVAL_NOT_FOUND');

  const invalid = await endpoints.evalTrace({
    identity: IDENTITY,
    params: new URLSearchParams({ evalId: '1' }),
  });
  assert.equal(invalid.status, 400);
});

test('sessions endpoint lists exec sessions', async (t) => {
  const { dir } = await createFixture(t);
  const endpoints = createAuditEndpoints({ dir });
  const result = await endpoints.sessions({ identity: IDENTITY, params: new URLSearchParams() });
  assert.equal(result.status, 200);
  const sessions = bodyOf(result).sessions as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.exec, 'es_1');
});

test('frames endpoint pairs requests/responses and strips detail by default', async (t) => {
  const { dir } = await createFixture(t);
  const endpoints = createAuditEndpoints({ dir });

  const summary = await endpoints.frames({ identity: IDENTITY, params: new URLSearchParams() });
  assert.equal(summary.status, 200);
  const summaryBody = bodyOf(summary);
  assert.equal(summaryBody.droppedFrames, 4);
  const summaryFrames = summaryBody.frames as Array<Record<string, unknown>>;
  assert.equal(summaryFrames.length, 2);
  const paired = summaryFrames.find((frame) => frame.id === 1);
  assert.ok(paired !== undefined);
  assert.equal(paired.method, 'tools/call');
  assert.equal(paired.durMs, 12);
  const summaryRequest = paired.request as Record<string, unknown>;
  const summaryResponse = paired.response as Record<string, unknown>;
  assert.equal('params' in summaryRequest, false);
  assert.equal('result' in summaryResponse, false);

  const full = await endpoints.frames({
    identity: IDENTITY,
    params: new URLSearchParams({ detail: 'full' }),
  });
  const fullFrames = bodyOf(full).frames as Array<Record<string, unknown>>;
  const fullPaired = fullFrames.find((frame) => frame.id === 1);
  assert.ok(fullPaired !== undefined);
  assert.deepEqual((fullPaired.request as Record<string, unknown>).params, { name: 'run_script' });
  assert.ok((fullPaired.response as Record<string, unknown>).result !== undefined);

  const filtered = await endpoints.frames({
    identity: IDENTITY,
    params: new URLSearchParams({ mcp: 'mcp_1', id: '1' }),
  });
  assert.equal((bodyOf(filtered).frames as unknown[]).length, 1);

  const badDetail = await endpoints.frames({
    identity: IDENTITY,
    params: new URLSearchParams({ detail: 'raw' }),
  });
  assert.equal(badDetail.status, 400);
});

test('frames endpoint filters by tool, protocol status and execution result', async (t) => {
  const { dir } = await createFixture(t);
  const at = (offset: number): string => new Date(DAY_18 + 100 + offset).toISOString();
  const common = { v: 1, ...IDENTITY };
  const extra = [
    { ...common, ts: at(0), event: 'proto_in', id: 2, method: 'tools/call', params: { name: 'search_tools' } },
    {
      ...common,
      ts: at(10),
      event: 'proto_out',
      id: 2,
      method: 'tools/call',
      ok: true,
      result: { content: [], isError: true },
    },
    { ...common, ts: at(20), event: 'proto_in', id: 3, method: 'tools/list' },
    {
      ...common,
      ts: at(21),
      event: 'proto_out',
      id: 3,
      method: 'tools/list',
      ok: false,
      error: { code: -32600, message: 'bad request' },
    },
    { ...common, ts: at(30), event: 'proto_in', id: 4, method: 'tools/call', params: { name: 'run_script' } },
  ];
  await writeFile(
    join(dir, 'protocol-2026-11-18.jsonl'),
    `${extra.map((event) => JSON.stringify(event)).join('\n')}\n`,
    { encoding: 'utf8', flag: 'a' },
  );
  const endpoints = createAuditEndpoints({ dir });

  const byTool = await endpoints.frames({
    identity: IDENTITY,
    params: new URLSearchParams({ tool: 'search_tools' }),
  });
  const toolFrames = bodyOf(byTool).frames as Array<Record<string, unknown>>;
  assert.equal(toolFrames.length, 1);
  assert.equal(toolFrames[0]?.id, 2);

  const protocolError = await endpoints.frames({
    identity: IDENTITY,
    params: new URLSearchParams({ protocol: 'error' }),
  });
  const errorFrames = bodyOf(protocolError).frames as Array<Record<string, unknown>>;
  assert.deepEqual(errorFrames.map((frame) => frame.id), [3]);

  const resultError = await endpoints.frames({
    identity: IDENTITY,
    params: new URLSearchParams({ result: 'error' }),
  });
  const resultFrames = bodyOf(resultError).frames as Array<Record<string, unknown>>;
  assert.deepEqual(resultFrames.map((frame) => frame.id), [2]);

  const unresolved = await endpoints.frames({
    identity: IDENTITY,
    params: new URLSearchParams({ protocol: 'none', tool: 'run_script' }),
  });
  const pendingFrames = bodyOf(unresolved).frames as Array<Record<string, unknown>>;
  assert.deepEqual(pendingFrames.map((frame) => frame.id), [4]);

  const bad = await endpoints.frames({
    identity: IDENTITY,
    params: new URLSearchParams({ protocol: 'maybe' }),
  });
  assert.equal(bad.status, 400);
});

test('export endpoint enforces the row ceiling and streams JSONL otherwise', async (t) => {
  const { dir, auditEvents } = await createFixture(t);
  const small = createAuditEndpoints({ dir, exportMaxRows: 3 });
  const rejected = await small.export({ identity: IDENTITY, params: new URLSearchParams() });
  assert.equal(rejected.status, 400);
  assert.equal(
    (bodyOf(rejected).error as Record<string, unknown>).code,
    'EXPORT_LIMIT_EXCEEDED',
  );

  const endpoints = createAuditEndpoints({ dir, exportMaxRows: 10_000 });
  const accepted = await endpoints.export({ identity: IDENTITY, params: new URLSearchParams() });
  assert.equal(accepted.status, 200);
  assert.ok('stream' in accepted);
  const stream = (accepted as { stream: AsyncIterable<string> }).stream;
  const lines = await collectStream(stream);
  assert.equal(lines.length, auditEvents.length);
});

test('stats endpoint returns 503 when the worker scan saturates', async (t) => {
  const { dir } = await createFixture(t);
  const endpoints = createAuditEndpoints({
    dir,
    clock: { now: () => DAY_18 },
    stats: { maxRows: 3, cacheTtlMs: 0 },
  });
  const result = await endpoints.stats({ identity: IDENTITY, params: new URLSearchParams() });
  assert.equal(result.status, 503);
  const error = bodyOf(result).error as Record<string, unknown>;
  assert.equal(error.code, 'AUDIT_STATS_SATURATED');
  assert.equal((error.details as Record<string, unknown>).reason, 'rows');
});

test('stats endpoint rejects an unknown groupBy', async (t) => {
  const { dir } = await createFixture(t);
  const endpoints = createAuditEndpoints({ dir });
  const result = await endpoints.stats({
    identity: IDENTITY,
    params: new URLSearchParams({ groupBy: 'eval' }),
  });
  assert.equal(result.status, 400);
});

const FAKE_STATS_RESULT = {
  scannedRows: 10,
  calls: 2,
  errors: 0,
  p50: 5,
  p95: 9,
  queueAvgMs: 1,
  groups: [],
};

function makeFakeStatsFactory(counter: { count: number }): (data: StatsWorkerData) => StatsWorkerLike {
  return (data: StatsWorkerData): StatsWorkerLike => {
    counter.count += 1;
    const listeners = new Map<string, Array<(value: unknown) => void>>();
    const worker = {
      postMessage(): void {
        setTimeout(() => {
          for (const listener of listeners.get('message') ?? []) {
            listener({ ok: true, result: FAKE_STATS_RESULT });
          }
        }, 0);
      },
      terminate(): number {
        return 0;
      },
      on(event: string, listener: (value: unknown) => void): unknown {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return undefined;
      },
    };
    void data;
    return worker as unknown as StatsWorkerLike;
  };
}

function hangingStatsFactory(_data: StatsWorkerData): StatsWorkerLike {
  return {
    postMessage(): void {
      // never answers; the main thread timeout must win
    },
    terminate(): number {
      return 0;
    },
    on(): unknown {
      return undefined;
    },
  } as unknown as StatsWorkerLike;
}
