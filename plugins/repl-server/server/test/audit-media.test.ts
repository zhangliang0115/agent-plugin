import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { isMediaDate, isMediaSha, mediaExt } from '@zhangliang0115/repl-server-core';

import { createAuditRuntime, type AuditRuntime } from '../src/audit/runtime.ts';
import { createRetention } from '../src/audit/retention.ts';
import type { AdminHandler, AdminResponse } from '../src/admin/servers.ts';
import type { AuditEvent, Clock } from '../src/ports.ts';

const START = Date.UTC(2026, 10, 18, 6, 0, 0);
const ISO = new Date(START).toISOString();
const DAY = '2026-11-18';

class FixedClock implements Clock {
  now(): number {
    return START;
  }
}

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const PDF = Buffer.from('%PDF-1.4 fake body');
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function fixture(
  t: TestContext,
  options: { frameMode?: 'summary' | 'full'; prepare?: (dir: string) => Promise<void> } = {},
): Promise<{ dir: string; runtime: AuditRuntime }> {
  const dir = await mkdtemp(join(tmpdir(), 'repl-audit-media-'));
  if (options.prepare !== undefined) await options.prepare(dir);
  const runtime = createAuditRuntime({
    dir,
    clock: new FixedClock(),
    frameMode: options.frameMode ?? 'summary',
    log: () => undefined,
  });
  t.after(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, runtime };
}

async function rows(dir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(dir, `events-${DAY}.jsonl`), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function toolResult(seq: number, result: unknown): AuditEvent {
  return { ts: ISO, event: 'tool_result', exec: 'es_1', evalId: 1, seq, tool: 'Shot', ok: true, result };
}

async function get(runtime: AuditRuntime, query: Record<string, string>): Promise<AdminResponse> {
  const handlers: AdminHandler[] = runtime.handlers();
  for (const handler of handlers) {
    const response = await handler({ method: 'GET', path: '/admin/api/logs/media', query });
    if (response !== null) return response;
  }
  throw new Error('no handler matched /logs/media');
}

test('tool_result images and documents are stored by sha256 and listed on the row', async (t) => {
  const { dir, runtime } = await fixture(t);
  runtime.recordToolCall(
    toolResult(1, {
      text: 'ok',
      images: [{ base64: PNG.toString('base64'), mediaType: 'image/png' }],
      documents: [{ base64: PDF.toString('base64') }],
    }),
  );
  await runtime.flush();

  const [row] = await rows(dir);
  assert.deepEqual(row?.['media'], [
    { sha256: sha(PNG), mediaType: 'image/png', bytes: PNG.length },
    { sha256: sha(PDF), mediaType: 'application/pdf', bytes: PDF.length },
  ]);
  assert.deepEqual(await readFile(join(dir, 'payload', DAY, 'media', `${sha(PNG)}.png`)), PNG);
  assert.deepEqual(await readFile(join(dir, 'payload', DAY, 'media', `${sha(PDF)}.pdf`)), PDF);
});

test('a result without media gets no media field', async (t) => {
  const { dir, runtime } = await fixture(t);
  runtime.recordToolCall(toolResult(1, { text: 'plain' }));
  await runtime.flush();
  const [row] = await rows(dir);
  assert.equal('media' in (row ?? {}), false);
});

test('identical bytes are written once and not rewritten', async (t) => {
  const { dir, runtime } = await fixture(t);
  const image = { base64: PNG.toString('base64'), mediaType: 'image/png' };
  runtime.recordToolCall(toolResult(1, { images: [image, image] }));
  await runtime.flush();
  const file = join(dir, 'payload', DAY, 'media', `${sha(PNG)}.png`);
  const first = await stat(file);

  runtime.recordToolCall(toolResult(2, { images: [image] }));
  await runtime.flush();
  const second = await stat(file);

  assert.equal(second.ino, first.ino, 'the second write must not replace the file');
  assert.equal(second.mtimeMs, first.mtimeMs);
  const written = rows(dir);
  assert.equal(((await written)[0]?.['media'] as unknown[]).length, 1, 'duplicates inside one row collapse');
  assert.deepEqual(await readdir(join(dir, 'payload', DAY, 'media')), [`${sha(PNG)}.png`]);
});

test('protocol frames store the blob and keep the redacted {mimeType, bytes, sha256} shape', async (t) => {
  const { dir, runtime } = await fixture(t, { frameMode: 'full' });
  runtime.recordFrameOut({
    mcp: 'mcp_1',
    id: 5,
    method: 'tools/call',
    result: { content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }] },
  });
  await runtime.flush();

  const [row] = await rows(dir);
  assert.deepEqual(row?.['media'], [{ sha256: sha(PNG), mediaType: 'image/png', bytes: PNG.length }]);
  const result = row?.['result'] as { content: Array<{ data: unknown }> } | undefined;
  assert.deepEqual(result?.content[0]?.data, { mimeType: 'image/png', bytes: PNG.length, sha256: sha(PNG) });
  assert.deepEqual(await readFile(join(dir, 'payload', DAY, 'media', `${sha(PNG)}.png`)), PNG);
});

test('a media write failure drops only the media entry, never the row', async (t) => {
  const { dir, runtime } = await fixture(t, {
    // A regular file where `media/` must be a directory makes every put fail.
    prepare: async (root) => {
      await mkdir(join(root, 'payload', DAY), { recursive: true });
      await writeFile(join(root, 'payload', DAY, 'media'), 'not a directory');
    },
  });
  runtime.recordToolCall(toolResult(1, { text: 'kept', images: [{ base64: PNG.toString('base64'), mediaType: 'image/png' }] }));
  await runtime.flush();
  const [row] = await rows(dir);
  assert.equal(row?.['event'], 'tool_result');
  assert.equal('media' in (row ?? {}), false);
});

test('extension mapping falls back to bin', () => {
  assert.equal(mediaExt('image/jpeg'), 'jpg');
  assert.equal(mediaExt('IMAGE/PNG'), 'png');
  assert.equal(mediaExt('image/gif'), 'gif');
  assert.equal(mediaExt('image/webp'), 'webp');
  assert.equal(mediaExt('application/pdf'), 'pdf');
  assert.equal(mediaExt('audio/wav'), 'bin');
  assert.equal(mediaExt(null), 'bin');
});

test('key validators reject anything but 64 lowercase hex and real dates', () => {
  assert.equal(isMediaSha(sha(PNG)), true);
  assert.equal(isMediaSha(sha(PNG).toUpperCase()), false);
  assert.equal(isMediaSha(`${sha(PNG).slice(0, 62)}..`), false);
  assert.equal(isMediaDate('2026-11-18'), true);
  assert.equal(isMediaDate('2026-02-30'), false);
  assert.equal(isMediaDate('../../etc'), false);
});

test('GET /logs/media serves the bytes with type and immutable cache headers', async (t) => {
  const { runtime } = await fixture(t);
  runtime.recordToolCall(
    toolResult(1, { images: [{ base64: PNG.toString('base64'), mediaType: 'image/png' }], documents: [{ base64: PDF.toString('base64') }] }),
  );
  await runtime.flush();

  const png = await get(runtime, { sha: sha(PNG), date: DAY });
  assert.equal(png.status, 200);
  assert.equal(png.headers?.['content-type'], 'image/png');
  assert.equal(png.headers?.['cache-control'], 'private, max-age=86400, immutable');
  assert.deepEqual(png.body, PNG);

  const pdf = await get(runtime, { sha: sha(PDF), date: DAY });
  assert.equal(pdf.headers?.['content-type'], 'application/pdf');
});

test('GET /logs/media answers 404 for a missing file and 400 for bad keys', async (t) => {
  const { runtime } = await fixture(t);
  assert.equal((await get(runtime, { sha: sha(PNG), date: DAY })).status, 404);
  assert.equal((await get(runtime, { sha: sha(PNG), date: '2026-11-19' })).status, 404);

  const bad: Array<Record<string, string>> = [
    {},
    { sha: sha(PNG) },
    { date: DAY },
    { sha: 'abc', date: DAY },
    { sha: sha(PNG).toUpperCase(), date: DAY },
    { sha: `../${sha(PNG).slice(3)}`, date: DAY },
    { sha: sha(PNG), date: '../../log' },
    { sha: sha(PNG), date: '2026-13-01' },
    { sha: sha(PNG), date: `${DAY}/../..` },
  ];
  for (const query of bad) {
    assert.equal((await get(runtime, query)).status, 400, JSON.stringify(query));
  }
});

test('retention removes media together with its payload day', async (t) => {
  const { dir, runtime } = await fixture(t);
  runtime.recordToolCall(toolResult(1, { images: [{ base64: PNG.toString('base64'), mediaType: 'image/png' }] }));
  await runtime.flush();
  const file = join(dir, 'payload', DAY, 'media', `${sha(PNG)}.png`);
  await stat(file);

  // 100 days later the day is outside the 90-day window.
  const retention = createRetention({ logDir: dir, now: () => START + 100 * 24 * 3600 * 1000 });
  const stats = await retention.runOnce();
  assert.equal(stats.error, null);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  await assert.rejects(stat(join(dir, 'payload', DAY)), { code: 'ENOENT' });
});
