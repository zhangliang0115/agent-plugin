import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatBytes,
  parseRaw,
  payloadSummary,
  payloadUrl,
  payloadView,
} from '../src/lib/payload-view.ts';

test('an inline tool argument reads back as the value, without a ref', () => {
  const view = payloadView({ args: { command: 'ls' }, argsBytes: 16 }, 'args');
  assert.deepEqual(view.inline, { command: 'ls' });
  assert.equal(view.ref, null);
  assert.equal(view.bytes, 16);
});

test('a blob-backed result exposes ref, preview and sha256', () => {
  const view = payloadView(
    {
      resultRef: 'payload/2026-11-23/es_1/1-1-Read-result.json',
      resultPreview: '{"content":[...]}',
      outBytes: 102_400,
      resultSha256: 'a'.repeat(64),
    },
    'result',
  );
  assert.equal(view.inline, undefined);
  assert.equal(view.ref, 'payload/2026-11-23/es_1/1-1-Read-result.json');
  assert.equal(view.bytes, 102_400);
  assert.equal(view.sha256, 'a'.repeat(64));
  assert.equal(view.truncated, false);
});

test('a split body is marked truncated and carries the tail ref', () => {
  const view = payloadView(
    { resultRef: 'x-head.json', resultTailRef: 'x-tail.json', outBytes: 60 * 1024 * 1024, truncated: 'size' },
    'result',
  );
  assert.equal(view.truncated, true);
  assert.equal(view.tailRef, 'x-tail.json');
});

test('a dropped payload is still describable', () => {
  const view = payloadView({ payloadDropped: 'io', argsBytes: 99_000 }, 'args');
  assert.equal(view.dropped, 'io');
  assert.equal(view.ref, null);
  assert.equal(payloadSummary(view), '正文未保存（写盘失败）');
});

test('frame rows use params/result keys, not args', () => {
  const frame = { paramsRef: 'p.json', paramsBytes: 8192, paramsPreview: '{"id":1}' };
  assert.equal(payloadView(frame, 'params', 'frame').ref, 'p.json');
  assert.equal(payloadView(frame, 'args', 'frame').ref, null);
  const response = { resultRef: 'r.json', resultBytes: 4096 };
  assert.equal(payloadView(response, 'result', 'frame').ref, 'r.json');
});

test('an empty row reports nothing rather than a fake empty body', () => {
  const view = payloadView({}, 'result');
  assert.equal(view.ref, null);
  assert.equal(view.preview, null);
  assert.equal(payloadSummary(view), '无正文');
});

test('formatBytes switches unit at 1024 and keeps one decimal', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(102_400), '100 KB');
  assert.equal(formatBytes(1024 * 1024 * 3), '3.0 MB');
  assert.equal(formatBytes(null), '—');
});

test('payloadUrl encodes the ref and only the given options', () => {
  assert.equal(
    payloadUrl('payload/2026-11-23/es_1/a.json'),
    '/admin/api/logs/payload?ref=payload%2F2026-11-23%2Fes_1%2Fa.json',
  );
  assert.equal(
    payloadUrl('a.json', { mode: 'range', offset: 0, limit: 8192 }),
    '/admin/api/logs/payload?ref=a.json&mode=range&offset=0&limit=8192',
  );
});

test('parseRaw keeps the structured value and reports a cut body', () => {
  const parsed = parseRaw('{"a":1}');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value : null, { a: 1 });
  const cut = parseRaw('{"a":');
  assert.equal(cut.ok, false);
  assert.equal(parseRaw('   ').ok, false);
});

test('summary tells the reader what to expect before they click', () => {
  assert.equal(payloadSummary(payloadView({ args: 1, argsBytes: 1 }, 'args')), '内联 1 B');
  assert.equal(
    payloadSummary(payloadView({ resultRef: 'r', outBytes: 2048 }, 'result')),
    '全文 2.0 KB',
  );
  assert.equal(
    payloadSummary(payloadView({ resultRef: 'r', resultTailRef: 't', outBytes: 60 * 1024 * 1024 }, 'result')),
    '全文 60.0 MB（仅存首尾各 1 MiB）',
  );
});

test('extractMedia pulls images and PDFs out and leaves no base64 in the rest', async () => {
  const { extractMedia } = await import('../src/lib/payload-view.ts');
  const body = {
    text: 'ok',
    images: [{ base64: 'AAAA', mediaType: 'image/jpeg' }],
    documents: [{ base64: 'BBBBBBBB' }],
  };
  const media = extractMedia(body);
  assert.equal(media.images[0]?.src, 'data:image/jpeg;base64,AAAA');
  assert.equal(media.images[0]?.bytes, 3);
  assert.equal(media.documents[0]?.href, 'data:application/pdf;base64,BBBBBBBB');
  assert.equal(JSON.stringify(media.rest).includes('AAAA'), false);
  assert.deepEqual((media.rest as { text: string }).text, 'ok');
});

test('extractMedia returns the same object when the body has no media', async () => {
  const { extractMedia } = await import('../src/lib/payload-view.ts');
  const body = { text: 'x', images: [] };
  assert.equal(extractMedia(body).rest, body);
  assert.equal(extractMedia('plain').rest, 'plain');
});
