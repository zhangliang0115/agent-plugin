import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRequestTimeline } from '../src/lib/request-timeline.ts';

const T = (offsetMs: number): string => new Date(Date.parse('2026-11-20T00:00:00.000Z') + offsetMs).toISOString();

test('request and response markers bracket event bars on one axis', () => {
  const timeline = buildRequestTimeline(
    { ts: T(0), method: 'tools/call' },
    { ts: T(1_000) },
    [
      { ts: T(200), event: 'eval_start' },
      { ts: T(900), event: 'tool_result', tool: 'Bash', ok: true, durMs: 400 },
      { ts: T(1_000), event: 'eval_end', ms: 700 },
    ],
  );
  assert.ok(timeline !== null);
  assert.equal(timeline.from, Date.parse(T(0)));
  assert.equal(timeline.to, Date.parse(T(1_000)));
  assert.equal(timeline.items[0]?.label, '请求');
  assert.equal(timeline.items.at(-1)?.label, '响应');

  const tool = timeline.items.find((item) => item.key.startsWith('event-1'));
  assert.ok(tool !== undefined);
  assert.equal(tool.kind, 'bar');
  assert.equal(tool.end - tool.start, 400);
  assert.equal(tool.color, '#13c2c2');

  const evalEnd = timeline.items.find((item) => item.key.startsWith('event-2'));
  assert.ok(evalEnd !== undefined);
  assert.equal(evalEnd.end - evalEnd.start, 700);
});

test('events without a parseable timestamp are skipped; nothing to draw yields null', () => {
  assert.equal(buildRequestTimeline(null, null, [{ event: 'tool_call' }]), null);
  const timeline = buildRequestTimeline(
    null,
    { ts: T(500) },
    [
      { event: 'tool_call', tool: 'Read' },
      { ts: 'not-a-date', event: 'tool_call' },
    ],
  );
  assert.ok(timeline !== null);
  assert.equal(timeline.items.length, 1);
  assert.equal(timeline.to - timeline.from, 1);
});

test('a failed tool result uses the error color', () => {
  const timeline = buildRequestTimeline(null, null, [
    { ts: T(100), event: 'tool_result', tool: 'Bash', ok: false },
  ]);
  assert.ok(timeline !== null);
  assert.equal(timeline.items[0]?.color, '#ff4d4f');
  assert.equal(timeline.items[0]?.kind, 'marker');
});
