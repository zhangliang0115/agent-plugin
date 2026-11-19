import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { AuditEvent, Clock } from '../src/ports.ts';
import {
  boundFramePayload,
  createProtocolFrameRecorder,
  FRAME_HEAD_BYTES,
  FRAME_MAX_BYTES,
  frameKey,
  pairProtocolFrames,
  redactText,
  stripFrameDetail,
} from '../src/audit/frames.ts';

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

class RecordingSink {
  readonly events: AuditEvent[] = [];

  write(event: AuditEvent): void {
    this.events.push(event);
  }
}

const START = Date.UTC(2026, 10, 18, 6, 0, 0, 0);

function makeRecorder(mode: 'off' | 'summary' | 'full', options: { maxQueue?: number } = {}) {
  const clock = new TestClock(START);
  const sink = new RecordingSink();
  const recorder = createProtocolFrameRecorder({
    mode,
    sink,
    clock,
    ...(options.maxQueue === undefined ? {} : { maxQueue: options.maxQueue }),
  });
  return { clock, sink, recorder };
}

function hashBase64(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex');
}

test('summary mode records both directions and pairs a response to its request', () => {
  const { clock, sink, recorder } = makeRecorder('summary');
  recorder.recordIn({
    mcp: 'mcp_1',
    identity: 'bound',
    binding: 'cb_1',
    client: 'claude-code/2.1.327',
    clientName: 'claude-code',
    clientVersion: '2.1.327',
    id: 1,
    method: 'tools/call',
    params: { name: 'run_script', arguments: { code: 'return 1' } },
  });
  clock.advance(25);
  recorder.recordOut({
    mcp: 'mcp_1',
    id: 1,
    result: { content: [{ type: 'text', text: 'ok' }] },
    exec: 'es_1',
    evalId: 7,
  });
  recorder.flush();

  assert.equal(sink.events.length, 2);
  const [request, response] = sink.events;
  assert.ok(request !== undefined && response !== undefined);
  assert.equal(request.event, 'proto_in');
  assert.equal(request.id, 1);
  assert.equal(request.method, 'tools/call');
  assert.ok(typeof request.bytes === 'number' && request.bytes > 0);
  assert.equal('params' in request, false, 'summary mode must not store params');

  assert.equal(response.event, 'proto_out');
  assert.equal(response.id, 1);
  assert.equal(response.method, 'tools/call', 'response inherits the request method');
  assert.equal(response.durMs, 25);
  assert.equal(response.ok, true);
  assert.equal(response.binding, 'cb_1', 'response inherits the request identity');
  assert.equal(response.client, 'claude-code/2.1.327');
  assert.equal(response.clientName, 'claude-code', 'response inherits the request client name');
  assert.equal(response.clientVersion, '2.1.327');
  assert.equal(response.exec, 'es_1');
  assert.equal(response.evalId, 7);
  assert.equal('result' in response, false, 'summary mode must not store the result');
  assert.deepEqual(recorder.stats(), {
    mode: 'summary',
    queued: 0,
    written: 2,
    dropped: 0,
    pending: 0,
    healthy: true,
  });
});

test('notifications use id null and are never paired', () => {
  const { sink, recorder } = makeRecorder('summary');
  recorder.recordIn({ mcp: 'mcp_1', id: null, method: 'notifications/initialized' });
  recorder.flush();

  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0]?.id, null);
  assert.equal(sink.events[0]?.method, 'notifications/initialized');
  assert.equal(recorder.stats().pending, 0);
});

test('an unmatched response keeps method null and reports failure from error', () => {
  const { sink, recorder } = makeRecorder('summary');
  recorder.recordOut({ mcp: 'mcp_1', id: 9, error: { code: -32601, message: 'no method' } });
  recorder.flush();

  const [response] = sink.events;
  assert.ok(response !== undefined);
  assert.equal(response.method, null);
  assert.equal(response.ok, false);
  assert.equal('durMs' in response, false);
});

test('full mode redacts Authorization/Cookie, strips URL queries and replaces base64', () => {
  const { sink, recorder } = makeRecorder('full');
  const secretBase64 = ['aGVs', 'bG8='].join('');
  recorder.recordIn({
    mcp: 'mcp_1',
    binding: 'cb_1',
    client: 'claude-code/2.1.327',
    id: 3,
    method: 'tools/call',
    params: {
      headers: {
        Authorization: 'Bearer test-bearer-value-123456',
        Cookie: ['session', 'cookie', 'value'].join('-'),
        'X-Api-Key': 'k-123',
      },
      url: 'http://127.0.0.1:8787/mcp?token=super-secret#frag',
      arguments: { base64: secretBase64, mediaType: 'image/png' },
      note: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"',
      nested: { cookie: 'value' },
    },
  });
  recorder.recordOut({
    mcp: 'mcp_1',
    id: 3,
    result: {
      content: [{ type: 'image', data: secretBase64, mimeType: 'image/png' }],
      inline: `data:image/png;base64,${secretBase64}`,
    },
    ok: true,
  });
  recorder.flush();

  const request = sink.events[0];
  const response = sink.events[1];
  assert.ok(request !== undefined && response !== undefined);
  const params = request.params as Record<string, unknown>;
  const headers = params.headers as Record<string, unknown>;
  assert.equal(headers.Authorization, '<redacted>');
  assert.equal(headers.Cookie, '<redacted>');
  assert.equal(headers['X-Api-Key'], '<redacted>');
  assert.equal(params.url, 'http://127.0.0.1:8787/mcp');
  assert.equal((params.nested as Record<string, unknown>).cookie, '<redacted>');
  assert.match(String(params.note), /<redacted>/);
  assert.doesNotMatch(String(params.note), /abcdefghijklmnopqrstuvwxyz/);
  assert.deepEqual(params.arguments, {
    base64: { mimeType: 'image/png', bytes: 5, sha256: hashBase64(secretBase64) },
    mediaType: 'image/png',
  });

  const result = response.result as Record<string, unknown>;
  const content = result.content as Array<Record<string, unknown>>;
  const image = content[0];
  assert.ok(image !== undefined);
  assert.deepEqual(image.data, {
    mimeType: 'image/png',
    bytes: 5,
    sha256: hashBase64(secretBase64),
  });
  assert.deepEqual(result.inline, {
    mimeType: 'image/png',
    bytes: 5,
    sha256: hashBase64(secretBase64),
  });
});

test('full mode truncates a payload over 256KB to a 32KB head plus metadata', () => {
  const { sink, recorder } = makeRecorder('full');
  recorder.recordIn({
    mcp: 'mcp_1',
    id: 4,
    method: 'tools/call',
    params: { blobText: 'y'.repeat(FRAME_MAX_BYTES + 1024) },
  });
  recorder.flush();

  const request = sink.events[0];
  assert.ok(request !== undefined);
  const params = request.params as Record<string, unknown>;
  assert.equal(params.truncated, true);
  assert.ok(typeof params.bytes === 'number' && params.bytes > FRAME_MAX_BYTES);
  assert.match(String(params.sha256), /^[0-9a-f]{64}$/);
  assert.ok(Buffer.byteLength(String(params.head), 'utf8') <= FRAME_HEAD_BYTES);
  assert.match(String(params.head), /^\{"blobText":"y+/);
});

test('payloads under the limit are kept intact', () => {
  const { sink, recorder } = makeRecorder('full');
  recorder.recordIn({ mcp: 'mcp_1', id: 5, method: 'ping', params: { small: 'value' } });
  recorder.flush();

  const request = sink.events[0];
  assert.ok(request !== undefined);
  assert.deepEqual(request.params, { small: 'value' });
});

test('the frame queue drops the oldest frames and reports per-second protocol_dropped', () => {
  const { sink, recorder } = makeRecorder('summary', { maxQueue: 5 });
  for (let id = 1; id <= 8; id += 1) {
    recorder.recordIn({ mcp: 'mcp_1', id, method: 'ping' });
  }
  assert.equal(recorder.droppedFrames, 3);
  recorder.flush();

  const inEvents = sink.events.filter((event) => event.event === 'proto_in');
  assert.deepEqual(
    inEvents.map((event) => event.id),
    [4, 5, 6, 7, 8],
  );
  const dropped = sink.events.find((event) => event.event === 'protocol_dropped');
  assert.ok(dropped !== undefined);
  assert.equal(dropped.count, 3);
  assert.equal(dropped.windowMs, 1000);
  assert.equal(dropped.ts, new Date(START).toISOString());
});

test('sink failures mark the recorder unhealthy without throwing', async () => {
  const clock = new TestClock(START);
  const syncFailure = createProtocolFrameRecorder({
    sink: {
      write() {
        throw new Error('disk full');
      },
    },
    clock,
  });
  syncFailure.recordIn({ mcp: 'mcp_1', id: 1, method: 'ping' });
  syncFailure.flush();
  assert.equal(syncFailure.stats().healthy, false);

  const asyncFailure = createProtocolFrameRecorder({
    sink: {
      write() {
        return Promise.reject(new Error('slow disk full'));
      },
    },
    clock,
  });
  asyncFailure.recordIn({ mcp: 'mcp_2', id: 1, method: 'ping' });
  asyncFailure.flush();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(asyncFailure.stats().healthy, false);
});

test('off mode records nothing', () => {
  const { sink, recorder } = makeRecorder('off');
  recorder.recordIn({ mcp: 'mcp_1', id: 1, method: 'ping' });
  recorder.recordOut({ mcp: 'mcp_1', id: 1, result: {} });
  recorder.flush();
  assert.equal(sink.events.length, 0);
  assert.equal(recorder.stats().written, 0);
});

test('pairProtocolFrames pairs by mcp + typed id and keeps orphan/notification rows', () => {
  const request: AuditEvent = {
    v: 1,
    ts: '2026-11-18T06:00:00.000Z',
    event: 'proto_in',
    mcp: 'mcp_1',
    id: 5,
    method: 'tools/call',
    bytes: 10,
  };
  const response: AuditEvent = {
    v: 1,
    ts: '2026-11-18T06:00:00.012Z',
    event: 'proto_out',
    mcp: 'mcp_1',
    id: 5,
    durMs: 12,
    ok: true,
    bytes: 20,
  };
  const notification: AuditEvent = {
    v: 1,
    ts: '2026-11-18T06:00:00.020Z',
    event: 'proto_in',
    mcp: 'mcp_1',
    id: null,
    method: 'notifications/initialized',
  };
  const orphan: AuditEvent = {
    v: 1,
    ts: '2026-11-18T06:00:00.030Z',
    event: 'proto_out',
    mcp: 'mcp_1',
    id: 9,
    ok: true,
  };
  const pairs = pairProtocolFrames([request, notification, response, orphan]);
  assert.equal(pairs.length, 3);

  const paired = pairs.find((pair) => pair.id === 5);
  assert.ok(paired !== undefined);
  assert.equal(paired.method, 'tools/call');
  assert.equal(paired.request, request);
  assert.equal(paired.response, response);
  assert.equal(paired.durMs, 12);
  assert.equal(paired.ok, true);

  const notificationPair = pairs.find((pair) => pair.id === null);
  assert.ok(notificationPair !== undefined);
  assert.equal(notificationPair.request, notification);
  assert.equal(notificationPair.response, null);

  const orphanPair = pairs.find((pair) => pair.id === 9);
  assert.ok(orphanPair !== undefined);
  assert.equal(orphanPair.request, null);
  assert.equal(orphanPair.response, orphan);
});

test('frameKey distinguishes numeric and string ids', () => {
  assert.notEqual(frameKey('mcp_1', 1), frameKey('mcp_1', '1'));
});

test('stripFrameDetail removes payload fields only', () => {
  const event: AuditEvent = {
    v: 1,
    ts: '2026-11-18T06:00:00.000Z',
    event: 'proto_in',
    mcp: 'mcp_1',
    id: 1,
    method: 'tools/call',
    params: { a: 1 },
    result: { b: 2 },
    error: { c: 3 },
    bytes: 10,
  };
  assert.deepEqual(stripFrameDetail(event), {
    v: 1,
    ts: '2026-11-18T06:00:00.000Z',
    event: 'proto_in',
    mcp: 'mcp_1',
    id: 1,
    method: 'tools/call',
    bytes: 10,
  });
});

test('redactText keeps the key and hides the value', () => {
  const redacted = redactText('Authorization: Bearer abcdefghijklmnop');
  assert.match(redacted, /^Authorization: <redacted>(?: <redacted>)?$/);
  assert.equal(redactText('plain text'), 'plain text');
});

test('boundFramePayload hashes the untruncated serialized payload', () => {
  const value = { text: 'z'.repeat(FRAME_MAX_BYTES + 1) };
  const bounded = boundFramePayload(value) as Record<string, unknown>;
  const expectedHash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.sha256, expectedHash);
  assert.equal(bounded.bytes, Buffer.byteLength(JSON.stringify(value), 'utf8'));
});
