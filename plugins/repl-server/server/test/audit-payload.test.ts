import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  INLINE_MAX_BYTES,
  PAYLOAD_MAX_BYTES,
} from '@zhangliang0115/repl-server-core';

import { createAuditRuntime, type AuditRuntime } from '../src/audit/runtime.ts';
import type { AuditEvent, Clock } from '../src/ports.ts';

const START = Date.UTC(2026, 10, 18, 6, 0, 0);
const ISO = new Date(START).toISOString();
const DAY = '2026-11-18';
const EXEC = 'es_1';

class FixedClock implements Clock {
  now(): number {
    return START;
  }
}

interface EventBase {
  ts: string;
  identity: string;
  binding: string;
  client: string;
  mcp: string;
  exec: string;
}

function identity(): EventBase {
  return {
    ts: ISO,
    identity: 'bound',
    binding: 'cb_1',
    client: 'claude-code/2.1.327',
    mcp: 'mcp_1',
    exec: EXEC,
  };
}

/** A 100 KB text body: large enough to leave the row, small enough to be one blob. */
const BIG_TEXT = `${'x'.repeat(100 * 1024)}\nend of file`;

function readResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }] };
}

interface Fixture {
  dir: string;
  runtime: AuditRuntime;
}

async function createFixture(
  t: TestContext,
  options: { payload?: 'full' | 'off'; prepare?: (dir: string) => Promise<void> } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'repl-audit-payload-'));
  if (options.prepare !== undefined) await options.prepare(dir);
  const runtime = createAuditRuntime({
    dir,
    clock: new FixedClock(),
    frameMode: 'summary',
    log: () => undefined,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
  t.after(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, runtime };
}

async function readRows(dir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(dir, `events-${DAY}.jsonl`), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function toolCall(seq: number, tool: string, args: unknown): AuditEvent {
  return { ...identity(), event: 'tool_call', evalId: 1, seq, tool, args };
}

function toolResult(seq: number, tool: string, result: unknown): AuditEvent {
  return { ...identity(), event: 'tool_result', evalId: 1, seq, tool, ok: true, result };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('a small argument object stays inline and records only its size', async (t) => {
  const { dir, runtime } = await createFixture(t);

  const args = { command: 'ls -la', cwd: '/tmp' };
  runtime.recordToolCall(toolCall(1, 'Bash', args));
  await runtime.flush();

  const [row] = await readRows(dir);
  assert.ok(row !== undefined);
  assert.equal(row['v'], 2);
  assert.deepEqual(row['args'], args);
  assert.equal(row['argsBytes'], Buffer.byteLength(JSON.stringify(args), 'utf8'));
  assert.equal('argsRef' in row, false);
  assert.equal('argsPreview' in row, false);
  assert.equal(runtime.stats().payloadWritten, 0);
});

test('a large result moves to payload/ and the row keeps ref, preview and sha256', async (t) => {
  const { dir, runtime } = await createFixture(t);

  const result = readResult(BIG_TEXT);
  const serialized = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serialized, 'utf8') > INLINE_MAX_BYTES);

  runtime.recordToolCall(toolResult(1, 'Read', result));
  await runtime.flush();

  const [row] = await readRows(dir);
  assert.ok(row !== undefined);
  assert.equal('result' in row, false, 'the row must not also carry the value');
  assert.equal(row['resultRef'], `payload/${DAY}/${EXEC}/1-1-Read-result.json`);
  assert.equal(row['outBytes'], Buffer.byteLength(serialized, 'utf8'));
  assert.equal(row['resultSha256'], sha256(serialized));
  const preview = row['resultPreview'];
  assert.equal(typeof preview, 'string');
  assert.ok((preview as string).length > 0);
  assert.ok(Buffer.byteLength(preview as string, 'utf8') <= 2048);

  const blob = await readFile(join(dir, row['resultRef'] as string), 'utf8');
  assert.equal(blob, serialized, 'the blob must be byte-identical to the original value');
  assert.equal(runtime.stats().payloadWritten, 1);
  assert.equal(runtime.stats().payloadDropped, 0);
});

test('a failing payload store keeps the row and marks payloadDropped', async (t) => {
  const { dir, runtime } = await createFixture(t, {
    // Occupy the payload root with a file so every mkdir below it fails.
    prepare: async (root) => {
      await writeFile(join(root, 'payload'), 'not a directory', 'utf8');
    },
  });

  runtime.recordToolCall(toolResult(1, 'Read', readResult(BIG_TEXT)));
  await runtime.flush();

  const rows = await readRows(dir);
  assert.equal(rows.length, 1, 'a lost blob must never lose the row');
  const row = rows[0] as Record<string, unknown>;
  assert.equal(row['event'], 'tool_result');
  assert.equal(row['payloadDropped'], 'io');
  assert.equal('resultRef' in row, false);
  assert.equal('resultPreview' in row, false);
  assert.equal('resultSha256' in row, false);
  assert.equal(runtime.stats().payloadDropped, 1);
  assert.equal(runtime.stats().payloadWritten, 0);
});

test('rows keep call order when several calls are recorded back to back', async (t) => {
  const { dir, runtime } = await createFixture(t);

  const args = { command: 'cat big.txt' };
  runtime.recordToolCall(toolCall(1, 'Bash', args));
  runtime.recordToolCall(toolResult(1, 'Bash', readResult(BIG_TEXT)));
  runtime.recordToolCall(toolCall(2, 'Bash', args));
  runtime.recordToolCall(toolResult(2, 'Bash', readResult(BIG_TEXT)));
  await runtime.flush();

  const rows = await readRows(dir);
  assert.deepEqual(
    rows.map((row) => `${String(row['event'])}:${String(row['seq'])}`),
    ['tool_call:1', 'tool_result:1', 'tool_call:2', 'tool_result:2'],
  );
  assert.deepEqual(
    rows.filter((row) => row['event'] === 'tool_result').map((row) => row['resultRef']),
    [
      `payload/${DAY}/${EXEC}/1-1-Bash-result.json`,
      `payload/${DAY}/${EXEC}/1-2-Bash-result.json`,
    ],
  );
});

test('values over the hard cap are stored as head/tail pairs', async (t) => {
  const { dir, runtime } = await createFixture(t);

  // Just over the cap: two 1 MiB sides instead of one 50 MiB blob.
  const body = 'y'.repeat(PAYLOAD_MAX_BYTES + 1024);
  runtime.recordToolCall(toolResult(1, 'Read', readResult(body)));
  await runtime.flush();

  const [row] = await readRows(dir);
  assert.ok(row !== undefined);
  assert.equal(row['truncated'], 'size');
  assert.equal(row['resultRef'], `payload/${DAY}/${EXEC}/1-1-Read-result-head.json`);
  assert.equal(row['resultTailRef'], `payload/${DAY}/${EXEC}/1-1-Read-result-tail.json`);
  const head = await readFile(join(dir, row['resultRef'] as string), 'utf8');
  const tail = await readFile(join(dir, row['resultTailRef'] as string), 'utf8');
  assert.ok(head.length > 0);
  assert.ok(tail.length > 0);
  assert.equal(head.length + tail.length < body.length, true);
});

test('payload mode off keeps values inline for rollback', async (t) => {
  const { dir, runtime } = await createFixture(t, { payload: 'off' });

  runtime.recordToolCall(toolResult(1, 'Read', readResult(BIG_TEXT)));
  await runtime.flush();

  const [row] = await readRows(dir);
  assert.ok(row !== undefined);
  assert.equal('resultRef' in row, false);
  const result = row['result'] as { content: Array<{ text: string }> };
  assert.equal(result.content[0]?.text, BIG_TEXT);
  assert.equal(runtime.stats().payloadWritten, 0);
});
