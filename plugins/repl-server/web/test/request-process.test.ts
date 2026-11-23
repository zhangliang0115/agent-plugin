import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRequestProcess,
  describeToolArgs,
  gapsWithin,
  mergeIntervals,
} from '../src/lib/request-process.ts';

const BASE = Date.parse('2026-11-20T00:00:00.000Z');
const T = (offsetMs: number): string => new Date(BASE + offsetMs).toISOString();

function syncEvalEvents(): Array<Record<string, unknown>> {
  return [
    { ts: T(50), event: 'eval_start', evalId: 3, mode: 'sync', codeBytes: 120 },
    {
      ts: T(100),
      event: 'tool_call',
      evalId: 3,
      seq: 1,
      tool: 'Read',
      server: 'fs',
      args: { file_path: '/a.ts' },
    },
    { ts: T(200), event: 'tool_result', evalId: 3, seq: 1, tool: 'Read', ok: true, ms: 100 },
    { ts: T(300), event: 'tool_call', evalId: 3, seq: 2, tool: 'Bash', args: { command: 'pnpm test' } },
    { ts: T(800), event: 'tool_result', evalId: 3, seq: 2, tool: 'Bash', ok: true, ms: 500 },
    { ts: T(950), event: 'eval_end', evalId: 3, ok: true, outcome: 'ok', ms: 900, resultBytes: 64 },
  ];
}

test('one row per tool call, with script time filling the gaps between calls', () => {
  const process = buildRequestProcess(
    { ts: T(0), method: 'tools/call', bytes: 200 },
    { ts: T(1_000), ok: true, bytes: 900 },
    syncEvalEvents(),
  );
  assert.ok(process !== null);
  const { summary, rows, composition } = process;

  assert.equal(summary.coverage, 'exec');
  assert.equal(summary.totalMs, 1_000);
  assert.equal(summary.ingressMs, 50);
  assert.equal(summary.egressMs, 50);
  assert.equal(summary.execMs, 900);
  assert.equal(summary.toolMs, 600);
  assert.equal(summary.toolSumMs, 600);
  assert.equal(summary.scriptMs, 300);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.toolFailures, 0);
  assert.equal(summary.slowest?.ms, 500);

  // Two calls, not four rows: `tool_call` and `tool_result` merge into one span.
  const toolRows = rows.filter((row) => row.kind === 'tool');
  assert.equal(toolRows.length, 2);
  assert.deepEqual(
    toolRows.map((row) => [row.label, row.durMs, row.indent]),
    [
      ['#1 Read', 100, 1],
      ['#2 Bash', 500, 1],
    ],
  );
  assert.equal(toolRows[1]?.hint, 'pnpm test');

  const script = rows.filter((row) => row.kind === 'script');
  assert.deepEqual(
    script.map((row) => [row.label, row.durMs]),
    [
      ['脚本 · 准备', 50],
      ['脚本 · 决策/组装', 100],
      ['脚本 · 收尾', 150],
    ],
  );

  // The composition adds up to the whole span: 50 + 300 + 600 + 50.
  assert.deepEqual(
    composition.map((part) => [part.key, part.ms]),
    [
      ['ingress', 50],
      ['script', 300],
      ['tool', 600],
      ['egress', 50],
    ],
  );

  // Every row keeps its share of the span, so the table column needs no hover.
  assert.equal(rows.find((row) => row.key === 'eval')?.share, 0.9);
  assert.equal(rows[0]?.label, '请求进入');
  assert.equal(rows.at(-1)?.label, '响应返回');
});

test('a failed tool is red, carries its error code and produces a conclusion', () => {
  const process = buildRequestProcess({ ts: T(0), method: 'tools/call' }, { ts: T(500) }, [
    { ts: T(20), event: 'eval_start', evalId: 1, mode: 'sync' },
    { ts: T(30), event: 'tool_call', evalId: 1, seq: 7, tool: 'Bash', args: { command: 'pnpm tsc' } },
    {
      ts: T(330),
      event: 'tool_result',
      evalId: 1,
      seq: 7,
      tool: 'Bash',
      ok: false,
      ms: 300,
      errorCode: 'TOOL_TIMEOUT',
      error: { message: 'Bash timed out after 300000ms' },
    },
    { ts: T(480), event: 'eval_end', evalId: 1, ok: false, outcome: 'error' },
  ]);
  assert.ok(process !== null);
  const tool = process.rows.find((row) => row.kind === 'tool');
  assert.ok(tool !== undefined);
  assert.equal(tool.tone, 'error');
  assert.equal(tool.hint, 'TOOL_TIMEOUT · pnpm tsc');
  assert.match(tool.title, /TOOL_TIMEOUT/u);
  assert.equal(process.summary.toolFailures, 1);
  assert.ok(process.summary.notes.some((note) => note.includes('1 次工具失败')));
  assert.ok(process.summary.notes.some((note) => note.includes('脚本报错')));
});

test('overlapping calls are not double-counted in the composition', () => {
  const process = buildRequestProcess({ ts: T(0) }, { ts: T(600) }, [
    { ts: T(10), event: 'eval_start', evalId: 1 },
    { ts: T(20), event: 'tool_call', evalId: 1, seq: 1, tool: 'Read' },
    { ts: T(100), event: 'tool_call', evalId: 1, seq: 2, tool: 'Read' },
    { ts: T(320), event: 'tool_result', evalId: 1, seq: 1, tool: 'Read', ok: true, ms: 300 },
    { ts: T(420), event: 'tool_result', evalId: 1, seq: 2, tool: 'Read', ok: true, ms: 320 },
    { ts: T(590), event: 'eval_end', evalId: 1, ok: true, outcome: 'ok' },
  ]);
  assert.ok(process !== null);
  assert.equal(process.summary.toolMs, 400);
  assert.equal(process.summary.toolSumMs, 620);
  assert.ok(process.summary.notes.some((note) => note.includes('工具并行执行')));
});

test('an async eval that ends after the response extends the axis', () => {
  const process = buildRequestProcess({ ts: T(0), method: 'tools/call' }, { ts: T(120) }, [
    { ts: T(20), event: 'eval_start', evalId: 2, mode: 'async' },
    { ts: T(30), event: 'tool_call', evalId: 2, seq: 1, tool: 'Bash' },
    { ts: T(500), event: 'tool_result', evalId: 2, seq: 1, tool: 'Bash', ok: true, ms: 470 },
    { ts: T(600), event: 'eval_end', evalId: 2, ok: true, outcome: 'ok' },
  ]);
  assert.ok(process !== null);
  assert.equal(process.to, BASE + 600);
  assert.equal(process.summary.totalMs, 120);
  assert.equal(process.summary.spanMs, 600);
  assert.equal(process.summary.mode, 'async');
  assert.ok(process.summary.notes.some((note) => note.includes('后台执行在响应之后又跑了 480ms')));
  // No egress: the response left before the eval finished.
  assert.equal(process.rows.some((row) => row.key === 'egress'), false);
});

test('a request without eval events reports frame coverage instead of faking phases', () => {
  const process = buildRequestProcess({ ts: T(0), method: 'tools/list' }, { ts: T(30), ok: true }, []);
  assert.ok(process !== null);
  assert.equal(process.summary.coverage, 'frame');
  assert.deepEqual(process.rows.map((row) => row.kind), ['request', 'response']);
  assert.deepEqual(process.summary.notes, []);
  assert.deepEqual(process.composition, []);
});

test('nothing to anchor on yields null', () => {
  assert.equal(buildRequestProcess(null, null, []), null);
  assert.equal(buildRequestProcess({}, {}, [{ event: 'tool_call' }]), null);
});

test('tool argument summaries stay on one readable line', () => {
  assert.equal(describeToolArgs({ command: 'pnpm   test\n--watch' }), 'pnpm test --watch');
  assert.equal(describeToolArgs({ file_path: '/tmp/a.ts', offset: 10 }), '/tmp/a.ts');
  assert.equal(describeToolArgs({ truncated: true, bytes: 2_048 }), '参数过大（2.0 KB）');
  assert.equal(describeToolArgs(null), null);
  assert.equal(describeToolArgs([1, 2]), null);
});

test('interval helpers merge overlaps and return the uncovered spans', () => {
  assert.deepEqual(mergeIntervals([{ start: 10, end: 20 }, { start: 15, end: 30 }]), [
    { start: 10, end: 30 },
  ]);
  assert.deepEqual(
    gapsWithin({ start: 0, end: 100 }, [
      { start: 10, end: 30 },
      { start: 25, end: 40 },
      { start: 60, end: 70 },
    ]),
    [
      { start: 0, end: 10 },
      { start: 40, end: 60 },
      { start: 70, end: 100 },
    ],
  );
});

// ---------------------------------------------------------------------------
// Step card and wait/queue rendering (`02 §2.4`, `09 §五`)
// ---------------------------------------------------------------------------

function queuedEvents(): Array<Record<string, unknown>> {
  return [
    { ts: T(0), event: 'eval_start', evalId: 5, mode: 'sync', codeBytes: 80 },
    {
      ts: T(10),
      event: 'tool_call',
      evalId: 5,
      seq: 1,
      tool: 'Edit',
      mode: 'serial',
      queuedAt: BASE + 10,
      args: { file_path: '/a.ts' },
      argsBytes: 300,
    },
    {
      ts: T(600),
      event: 'tool_result',
      evalId: 5,
      seq: 1,
      tool: 'Edit',
      ok: true,
      queueMs: 560,
      ms: 590,
      durMs: 30,
      startedAt: BASE + 570,
      endedAt: BASE + 600,
      waitReason: 'keyed-gate',
      outBytes: 2_100,
    },
    { ts: T(700), event: 'eval_end', evalId: 5, ok: true, outcome: 'ok', ms: 690 },
  ];
}

test('a queued call exposes the wait, the reason and the byte counts', () => {
  const process = buildRequestProcess(
    { ts: T(0), method: 'tools/call', bytes: 120 },
    { ts: T(720), ok: true, bytes: 200 },
    queuedEvents(),
  );
  assert.ok(process !== null);
  const row = process.rows.find((entry) => entry.kind === 'tool');
  assert.ok(row !== undefined);
  const detail = row.detail;
  assert.ok(detail !== undefined);

  assert.equal(detail.waitReason, 'keyed-gate');
  assert.equal(detail.queueMs, 560);
  assert.equal(detail.execMs, 30);
  assert.equal(detail.startedAt, BASE + 570);
  assert.equal(detail.open, false);
  // The waterfall starts at the call, so the queue band is drawable.
  assert.equal(row.start, BASE + 10);
  assert.equal(row.end, BASE + 600);

  // Bytes go into the hint; the "output" is the byte count, not the body.
  assert.match(row.hint ?? '', /入 300 B \/ 出 2\.1 KB/u);

  assert.equal(process.summary.queueWaits, 1);
  assert.equal(process.summary.queueTotalMs, 560);
  assert.ok(process.summary.notes.some((note) => note.includes('排队')));
});

test('a call without a result stays visible and is marked open', () => {
  const process = buildRequestProcess(
    { ts: T(0), method: 'tools/call', bytes: 100 },
    null,
    [
      { ts: T(0), event: 'eval_start', evalId: 6, mode: 'async' },
      { ts: T(20), event: 'tool_call', evalId: 6, seq: 1, tool: 'Bash', queuedAt: BASE + 20, args: { command: 'sleep 60' }, argsBytes: 40 },
      { ts: T(500), event: 'proto_in', id: 9 },
    ],
  );
  assert.ok(process !== null);
  const row = process.rows.find((entry) => entry.kind === 'tool');
  assert.ok(row !== undefined, 'an unfinished call must still get a row');
  assert.equal(row.detail?.open, true);
  assert.equal(row.tone, 'neutral');
  // Drawn up to the last observed event, not to "now".
  assert.equal(row.end, BASE + 500);
  assert.equal(process.summary.openCalls, 1);
  assert.match(row.hint ?? '', /尚未返回/u);
  assert.ok(process.summary.notes.some((note) => note.includes('还没有返回')));
});

test('a finished call with eval_end is not marked open', () => {
  const process = buildRequestProcess(
    { ts: T(0), method: 'tools/call', bytes: 100 },
    { ts: T(400), ok: true, bytes: 120 },
    [
      { ts: T(0), event: 'eval_start', evalId: 7, mode: 'sync' },
      { ts: T(10), event: 'tool_call', evalId: 7, seq: 1, tool: 'Read', queuedAt: BASE + 10, args: { file_path: '/a' } },
      { ts: T(60), event: 'tool_result', evalId: 7, seq: 1, tool: 'Read', ok: true, ms: 50, queueMs: 0, durMs: 50 },
      { ts: T(300), event: 'eval_end', evalId: 7, ok: true, outcome: 'ok' },
    ],
  );
  assert.ok(process !== null);
  assert.equal(process.rows.find((entry) => entry.kind === 'tool')?.detail?.open, false);
  assert.equal(process.summary.openCalls, 0);
  assert.equal(process.summary.queueWaits, 0, 'a 1 ms scheduling gap is not a queue wait');
});
