// hook-allow: localhost-only test fetch, no external egress
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';

import { createEventHub, type EventHub } from '../src/admin/events.ts';

interface SseFrame {
  raw: string;
  id: number | null;
  event: string | null;
  data: unknown;
  /** Heartbeat comment text (`ping`), or null for data frames. */
  comment: string | null;
}

function parseFrame(raw: string): SseFrame {
  let id: number | null = null;
  let event: string | null = null;
  let data = '';
  let comment: string | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) {
      comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = Number(value);
    else if (field === 'event') event = value;
    else if (field === 'data') data = data === '' ? value : `${data}\n${value}`;
  }
  return {
    raw,
    id,
    event,
    data: data === '' ? undefined : JSON.parse(data),
    comment,
  };
}

/** Minimal SSE client over the fetch body stream. */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private ended = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async next(): Promise<SseFrame> {
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const raw = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        return parseFrame(raw);
      }
      if (this.ended) throw new Error('SSE stream ended before a complete frame');
      const { value, done } = await this.reader.read();
      if (done) {
        this.ended = true;
        if (this.buffer !== '') {
          const raw = this.buffer;
          this.buffer = '';
          return parseFrame(raw);
        }
        throw new Error('SSE stream ended');
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  /** Resolves when the server ends the response. */
  async readToEnd(): Promise<void> {
    for (;;) {
      const { done } = await this.reader.read();
      if (done) return;
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

async function startServer(t: TestContext, hub: EventHub): Promise<string> {
  const server: Server = createServer((req, res) => {
    hub.subscribe(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function connect(
  base: string,
  headers: Record<string, string> = {},
  path = '/events',
): Promise<{ controller: AbortController; reader: SseReader }> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.ok(response.body !== null);
  return { controller, reader: new SseReader(response.body) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a first connection receives live events with monotonic ids and no replay', async (t) => {
  const hub = createEventHub({ bufferSize: 10, heartbeatMs: 60_000 });
  const base = await startServer(t, hub);

  assert.equal(hub.publish('server_state', { id: 'pg', from: 'idle', to: 'ready' }), 1);
  const client = await connect(base);
  assert.equal(hub.stats().clients, 1);

  const liveId = hub.publish('catalog_changed', { revision: 2, servers: ['pg'] });
  assert.equal(liveId, 2);

  const frame = await client.reader.next();
  assert.equal(frame.comment, null);
  assert.equal(frame.id, 2, 'without Last-Event-ID the stream starts at the live edge');
  assert.equal(frame.event, 'catalog_changed');
  assert.deepEqual(frame.data, { revision: 2, servers: ['pg'] });

  await client.reader.cancel();
  client.controller.abort();
});

test('Last-Event-ID replays buffered events and then continues live', async (t) => {
  const hub = createEventHub({ bufferSize: 10, heartbeatMs: 60_000 });
  const base = await startServer(t, hub);

  assert.equal(hub.publish('eval', { phase: 'start' }), 1);
  assert.equal(hub.publish('eval', { phase: 'end' }), 2);
  assert.equal(hub.publish('operation', { id: 'op_1', state: 'ok' }), 3);

  const client = await connect(base, { 'last-event-id': '1' });

  const replay1 = await client.reader.next();
  assert.equal(replay1.id, 2, 'events at or before Last-Event-ID are not replayed');
  assert.equal(replay1.event, 'eval');
  assert.deepEqual(replay1.data, { phase: 'end' });

  const replay2 = await client.reader.next();
  assert.equal(replay2.id, 3);
  assert.equal(replay2.event, 'operation');
  assert.deepEqual(replay2.data, { id: 'op_1', state: 'ok' });

  assert.equal(hub.publish('server_state', { id: 'pg', from: 'ready', to: 'idle' }), 4);
  const live = await client.reader.next();
  assert.equal(live.id, 4);
  assert.equal(live.event, 'server_state');

  await client.reader.cancel();
  client.controller.abort();
});

test('a Last-Event-ID outside the window emits gap before the replay', async (t) => {
  const hub = createEventHub({ bufferSize: 2, heartbeatMs: 60_000 });
  const base = await startServer(t, hub);

  for (let index = 1; index <= 4; index += 1) {
    assert.equal(hub.publish('eval', { index }), index);
  }
  assert.deepEqual(hub.stats(), { clients: 0, buffered: 2, lastEventId: 4, closed: false });

  const client = await connect(base, { 'last-event-id': '1' });
  const gap = await client.reader.next();
  assert.equal(gap.id, null);
  assert.equal(gap.event, 'gap');
  assert.deepEqual(gap.data, { oldestEventId: 3 });

  const first = await client.reader.next();
  assert.equal(first.id, 3);
  assert.deepEqual(first.data, { index: 3 });
  const second = await client.reader.next();
  assert.equal(second.id, 4);
  assert.deepEqual(second.data, { index: 4 });

  await client.reader.cancel();
  client.controller.abort();
});

test('?lastEventId= replays like the header, and the header wins when both exist', async (t) => {
  const hub = createEventHub({ bufferSize: 10, heartbeatMs: 60_000 });
  const base = await startServer(t, hub);

  assert.equal(hub.publish('eval', { phase: 'start' }), 1);
  assert.equal(hub.publish('eval', { phase: 'end' }), 2);
  assert.equal(hub.publish('operation', { id: 'op_1', state: 'ok' }), 3);

  const byQuery = await connect(base, {}, '/events?lastEventId=1');
  const replay2 = await byQuery.reader.next();
  assert.equal(replay2.id, 2);
  assert.deepEqual(replay2.data, { phase: 'end' });
  const replay3 = await byQuery.reader.next();
  assert.equal(replay3.id, 3);
  await byQuery.reader.cancel();
  byQuery.controller.abort();

  const both = await connect(base, { 'last-event-id': '2' }, '/events?lastEventId=1');
  const only3 = await both.reader.next();
  assert.equal(only3.id, 3, 'the header takes precedence over the query parameter');
  await both.reader.cancel();
  both.controller.abort();
});

test('?lastEventId= outside the window still emits the gap frame', async (t) => {
  const hub = createEventHub({ bufferSize: 1, heartbeatMs: 60_000 });
  const base = await startServer(t, hub);

  assert.equal(hub.publish('eval', { index: 1 }), 1);
  assert.equal(hub.publish('eval', { index: 2 }), 2);

  const client = await connect(base, {}, '/events?lastEventId=0');
  const gap = await client.reader.next();
  assert.equal(gap.event, 'gap');
  assert.deepEqual(gap.data, { oldestEventId: 2 });
  const next = await client.reader.next();
  assert.equal(next.id, 2);
  await client.reader.cancel();
  client.controller.abort();
});

test('subscribers receive a comment heartbeat', async (t) => {
  const hub = createEventHub({ bufferSize: 5, heartbeatMs: 30 });
  const base = await startServer(t, hub);
  const client = await connect(base);

  const frame = await client.reader.next();
  assert.ok(frame.comment !== null, `expected a heartbeat frame, got ${frame.raw}`);
  assert.match(frame.comment, /^ping$/);
  assert.equal(frame.event, null);

  await client.reader.cancel();
  client.controller.abort();
});

test('a disconnected subscriber is removed and publishing keeps working', async (t) => {
  const hub = createEventHub({ bufferSize: 5, heartbeatMs: 60_000 });
  const base = await startServer(t, hub);
  const client = await connect(base);
  await waitFor(() => hub.stats().clients === 1);

  await client.reader.cancel();
  client.controller.abort();
  await waitFor(() => hub.stats().clients === 0);

  assert.doesNotThrow(() => {
    hub.publish('eval', { phase: 'start' });
  });
  assert.equal(hub.stats().lastEventId, 1);
});

test('close ends every subscriber, clears the buffer and refuses new subscriptions', async (t) => {
  const hub = createEventHub({ bufferSize: 5, heartbeatMs: 60_000 });
  const base = await startServer(t, hub);
  const first = await connect(base);
  const second = await connect(base);
  await waitFor(() => hub.stats().clients === 2);

  hub.publish('eval', { phase: 'start' });
  assert.equal(hub.stats().lastEventId, 1);

  hub.close();
  assert.deepEqual(hub.stats(), { clients: 0, buffered: 0, lastEventId: 1, closed: true });
  assert.equal(hub.publish('eval', { phase: 'end' }), null, 'a closed hub is a no-op for publishers');
  assert.doesNotThrow(() => {
    hub.close();
  });

  await Promise.all([first.reader.readToEnd(), second.reader.readToEnd()]);

  const late = await fetch(`${base}/events`);
  assert.equal(late.status, 503);
  assert.deepEqual(await late.json(), {
    error: { code: 'SSE_CLOSED', message: 'event stream is closed' },
  });

  first.controller.abort();
  second.controller.abort();
});
