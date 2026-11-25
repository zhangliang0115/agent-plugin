import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  INLINE_MAX_BYTES,
  PAYLOAD_MAX_BYTES,
  PREVIEW_BYTES,
  PayloadStore,
  framePayloadRef,
  planPayload,
  previewOf,
  readPayload,
  serializePayload,
  toolPayloadRef,
  utf8Head,
  utf8Tail,
} from '../src/audit/payload.ts';
import { resolveLogRef } from '../src/audit/refs.ts';

function logRoot(): string {
  return mkdtempSync(join(tmpdir(), 'repl-payload-'));
}

test('values at or below the inline limit stay inline', () => {
  const small = { command: 'ls' };
  const plan = planPayload(small);
  assert.equal(plan.kind, 'inline');
  assert.ok(plan.kind === 'inline');
  assert.deepEqual(JSON.parse(plan.text), small);
  assert.equal(plan.bytes, Buffer.byteLength(plan.text, 'utf8'));
});

test('the inline boundary is measured in bytes, not characters', () => {
  // Two bytes per character: 2048 characters is exactly the limit.
  // JSON adds two quote bytes; 2047 two-byte characters land exactly on 4096.
  const exact = planPayload('é'.repeat(INLINE_MAX_BYTES / 2 - 1));
  assert.equal(exact.kind, 'inline');

  const over = planPayload('é'.repeat(INLINE_MAX_BYTES / 2));
  assert.equal(over.kind, 'blob');
});

test('a blob carries a preview no larger than the preview budget', () => {
  const text = `${'x'.repeat(PREVIEW_BYTES)}y`.repeat(4);
  const plan = planPayload(text);
  assert.ok(plan.kind === 'blob');
  assert.equal(plan.bytes, Buffer.byteLength(plan.text, 'utf8'));
  assert.ok(Buffer.byteLength(plan.preview, 'utf8') <= PREVIEW_BYTES);
  assert.match(plan.sha256, /^[0-9a-f]{64}$/u);
  // The preview must be a genuine prefix: no re-encoding, no ellipsis.
  assert.ok(plan.text.startsWith(plan.preview));
  assert.ok(!plan.preview.includes('\ufffd'));
});

test('preview cuts on a line break when one sits in the window', () => {
  // The line break sits in the last third of the window, so cutting there
  // loses only the partial line instead of most of the preview.
  const preview = previewOf(`${'a'.repeat(1900)}\n${'b'.repeat(50_000)}`);
  assert.equal(preview, 'a'.repeat(1900));
  // A break early in the window is not worth cutting at.
  const early = previewOf(`${'a'.repeat(100)}\n${'b'.repeat(50_000)}`);
  assert.ok(early.includes('\nb'));
});

test('utf8 head and tail never split a multi-byte sequence', () => {
  const text = '中'.repeat(10); // 3 bytes each
  assert.equal(utf8Head(text, 7), '中中');
  assert.equal(utf8Tail(text, 7), '中中');
  assert.equal(utf8Head(text, 3), '中');
  assert.equal(utf8Tail(text, 3), '中');
  assert.equal(utf8Head(text, 0), '');
});

test('a value above the hard cap is split into head and tail', () => {
  const big = 'z'.repeat(PAYLOAD_MAX_BYTES + 8);
  const plan = planPayload(big);
  assert.ok(plan.kind === 'split');
  assert.ok(plan.head.includes('zzz'));
  assert.ok(plan.tail.includes('zzz'));
  assert.equal(plan.bytes, Buffer.byteLength(JSON.stringify(big), 'utf8'));
  assert.ok(plan.head.length + plan.tail.length < big.length);
  assert.match(plan.sha256, /^[0-9a-f]{64}$/u);
});

test('a value that cannot be serialized is dropped with a reason', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.deepEqual(planPayload(cyclic), { kind: 'dropped', reason: 'serialize' });
  assert.equal(serializePayload(undefined)?.text, 'null');
});

test('the store writes atomically, reads back, and rejects escaping refs', async () => {
  const root = logRoot();
  const store = new PayloadStore(root);
  const ref = toolPayloadRef('2026-11-23', 'es_1', 6, 1, 'Bash', 'call');

  assert.equal(ref, 'payload/2026-11-23/es_1/6-1-Bash-call.json');
  assert.ok(!ref.includes('\\'));
  assert.equal(await store.read(ref), null);

  await store.write(ref, '{"command":"ls"}');
  assert.equal(await store.read(ref), '{"command":"ls"}');
  assert.equal(await store.size(ref), 16);

  await assert.rejects(() => store.write('../state.db', 'x'), /invalid payload ref/u);
  assert.equal(resolveLogRef(root, '../state.db'), null);
});

test('refs allow only safe segment characters', () => {
  const root = logRoot();
  assert.equal(resolveLogRef(root, 'payload/ok_name-1.2.json'), join(root, 'payload/ok_name-1.2.json'));

  for (const bad of ['payload/a:b.json', 'payload/a b.json', 'payload/中文.json', 'payload//x.json', 'payload/./x.json', 'payload/..']) {
    assert.equal(resolveLogRef(root, bad), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('concurrent writes to one ref do not share a temp path', async () => {
  const root = logRoot();
  const store = new PayloadStore(root);
  const ref = toolPayloadRef('2026-11-23', 'es_1', 8, 1, 'Bash', 'result');

  await Promise.all([store.write(ref, 'first'), store.write(ref, 'second')]);
  const text = await store.read(ref);
  assert.ok(text === 'first' || text === 'second');

  const leftovers = (await readdir(root, { recursive: true })).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('rejects invalid limit and offset instead of clamping', async () => {
  const root = logRoot();
  const store = new PayloadStore(root);
  const ref = toolPayloadRef('2026-11-23', 'es_1', 9, 1, 'Bash', 'call');
  await store.write(ref, '0123456789');

  for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    await assert.rejects(() => readPayload(root, ref, { mode: 'range', limit }), RangeError);
  }
  await assert.rejects(() => readPayload(root, ref, { mode: 'range', offset: -1 }), RangeError);
  await assert.rejects(() => readPayload(root, ref, { mode: 'head', offset: Number.NaN }), RangeError);
});

test('readPayload serves full, head, tail and range slices', async () => {
  const root = logRoot();
  const store = new PayloadStore(root);
  const ref = framePayloadRef('2026-11-23', '093012.451', '71', 'in');
  assert.equal(ref, 'payload/2026-11-23/frames/093012.451-71-in-params.json');
  await store.write(ref, '0123456789');

  const full = await readPayload(root, ref, { mode: 'full' });
  assert.equal(full?.body.toString(), '0123456789');
  assert.deepEqual(
    { total: full?.total, start: full?.start, end: full?.end, truncated: full?.truncated },
    { total: 10, start: 0, end: 10, truncated: false },
  );
  assert.equal((await readPayload(root, ref, { mode: 'head', limit: 4 }))?.body.toString(), '0123');
  assert.equal((await readPayload(root, ref, { mode: 'tail', limit: 3 }))?.body.toString(), '789');
  const range = await readPayload(root, ref, { mode: 'range', offset: 2, limit: 3 });
  assert.equal(range?.body.toString(), '234');
  assert.equal(range?.truncated, true);

  const past = await readPayload(root, ref, { mode: 'range', offset: 99, limit: 3 });
  assert.equal(past?.body.toString(), '');
  assert.equal(past?.start, 10);

  assert.equal(await readPayload(root, 'payload/missing.json', { mode: 'full' }), null);
  assert.equal(await readPayload(root, '../state.db', { mode: 'full' }), null);
});
