/** SSE wrapper behavior: last-event-id, gap frames, reconnect and polling fallback. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  createApiClient,
  createEventStream,
  type EventSourceLike,
  type EventStream,
} from '../src/lib/api.ts';

type Listener = (event: Event) => void;

/** Minimal EventSource test double: listeners are driven explicitly. */
class FakeEventSource implements EventSourceLike {
  readonly url: string;
  readonly init: { withCredentials?: boolean } | undefined;
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.init = init;
  }

  addEventListener(type: string, listener: Listener): void {
    const queue = this.listeners.get(type) ?? [];
    queue.push(listener);
    this.listeners.set(type, queue);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, event: Partial<MessageEvent> = {}): void {
    if (type === 'open') this.readyState = 1;
    const payload = { type, lastEventId: '', data: undefined, ...event } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }
}

function factoryFor(
  instances: FakeEventSource[],
): (url: string, init?: { withCredentials?: boolean }) => EventSourceLike {
  return (url, init) => {
    const source = new FakeEventSource(url, init);
    instances.push(source);
    return source;
  };
}

function enabledTimers(t: TestContext, apis: Array<'setTimeout' | 'setInterval'>): void {
  t.mock.timers.enable({ apis });
}

test('opens the stream and parses named frames while tracking the last event id', () => {
  const instances: FakeEventSource[] = [];
  const states: string[] = [];
  const frames: Array<{ type: string; data: unknown }> = [];
  const stream: EventStream = createEventStream('/admin/api/audit/stream', {
    eventTypes: ['audit'],
    createEventSource: factoryFor(instances),
    onStateChange: (state) => states.push(state),
    onEvent: (frame) => frames.push({ type: frame.type, data: frame.data }),
  });

  assert.equal(stream.state, 'connecting');
  assert.equal(instances.length, 1);
  assert.equal(instances[0]?.init?.withCredentials, true);

  instances[0]?.emit('open');
  assert.equal(stream.state, 'open');
  assert.deepEqual(states, ['connecting', 'open']);

  instances[0]?.emit('audit', {
    lastEventId: '7',
    data: JSON.stringify({ event: 'ai_run', ts: '2026-01-01T00:00:00.000Z' }),
  });
  assert.deepEqual(frames, [
    { type: 'audit', data: { event: 'ai_run', ts: '2026-01-01T00:00:00.000Z' } },
  ]);
  assert.equal(stream.lastEventId, '7');

  stream.close();
  assert.equal(stream.state, 'closed');
  assert.equal(instances[0]?.closed, true);
});

test('reports gap frames with oldestEventId', () => {
  const instances: FakeEventSource[] = [];
  const gaps: Array<string | null> = [];
  const stream = createEventStream('/admin/api/audit/stream', {
    eventTypes: ['audit'],
    createEventSource: factoryFor(instances),
    onGap: (gap) => gaps.push(gap.oldestEventId),
  });

  instances[0]?.emit('gap', { data: JSON.stringify({ oldestEventId: 101 }) });
  instances[0]?.emit('gap', { data: '{"oldestEventId":"102"}' });
  assert.deepEqual(gaps, ['101', '102']);
  stream.close();
});

test('passes the initial lastEventId as a query parameter for server-side replay', () => {
  const instances: FakeEventSource[] = [];
  const stream = createEventStream('/admin/api/audit/stream', {
    eventTypes: ['audit'],
    lastEventId: '17',
    createEventSource: factoryFor(instances),
  });

  // `EventSource` cannot set `Last-Event-ID` by hand, so the first open carries the
  // position in the query string for the server to replay from (`docs/03 §4.7`).
  assert.equal(instances[0]?.url, '/admin/api/audit/stream?lastEventId=17');
  stream.close();
});

test('a gap frame keeps the resume position until replayed frames arrive', (t) => {
  enabledTimers(t, ['setTimeout']);
  const instances: FakeEventSource[] = [];
  const gaps: Array<string | null> = [];
  const stream = createEventStream('/admin/api/audit/stream', {
    eventTypes: ['audit'],
    lastEventId: '17',
    createEventSource: factoryFor(instances),
    onGap: (gap) => gaps.push(gap.oldestEventId),
  });

  instances[0]?.emit('gap', { data: '{"oldestEventId":30}' });
  assert.deepEqual(gaps, ['30']);
  assert.equal(stream.lastEventId, '17');

  // Replayed frames after the gap advance the position again.
  instances[0]?.emit('audit', { lastEventId: '30', data: '{}' });
  assert.equal(stream.lastEventId, '30');

  const first = instances[0];
  assert.ok(first !== undefined);
  first.readyState = 2;
  first.emit('error');
  t.mock.timers.tick(1_000);
  assert.match(instances[1]?.url ?? '', /lastEventId=30/);
  stream.close();
});

test('reconnects after a fatal error and resumes from the last event id', (t) => {
  enabledTimers(t, ['setTimeout']);
  const instances: FakeEventSource[] = [];
  let catchUpPolls = 0;
  const stream = createEventStream('/admin/api/audit/stream', {
    eventTypes: ['audit'],
    createEventSource: factoryFor(instances),
    onFallbackPoll: () => {
      catchUpPolls += 1;
    },
  });

  instances[0]?.emit('audit', { lastEventId: '42', data: '{}' });
  const first = instances[0];
  assert.ok(first !== undefined);
  first.readyState = 2;
  first.emit('error');
  assert.equal(stream.state, 'reconnecting');

  t.mock.timers.tick(1_000);
  assert.equal(instances.length, 2);
  assert.match(instances[1]?.url ?? '', /lastEventId=42/);

  instances[1]?.emit('open');
  assert.equal(stream.state, 'open');
  assert.equal(catchUpPolls, 1);
  stream.close();
});

test('falls back to polling after repeated failures', (t) => {
  enabledTimers(t, ['setTimeout', 'setInterval']);
  const instances: FakeEventSource[] = [];
  let polls = 0;
  const stream = createEventStream('/admin/api/events', {
    eventTypes: ['operation'],
    createEventSource: factoryFor(instances),
    fallbackAfter: 1,
    fallbackPollMs: 10,
    onFallbackPoll: () => {
      polls += 1;
    },
  });

  const first = instances[0];
  assert.ok(first !== undefined);
  first.readyState = 2;
  first.emit('error');
  assert.equal(stream.state, 'fallback');

  t.mock.timers.tick(10);
  assert.equal(polls, 1);
  t.mock.timers.tick(10);
  assert.equal(polls, 2);
  stream.close();
});

test('disables SSE and polls when no EventSource factory is available', (t) => {
  enabledTimers(t, ['setTimeout', 'setInterval']);
  let polls = 0;
  const stream = createEventStream('/admin/api/events', {
    createEventSource: null,
    fallbackPollMs: 5,
    onFallbackPoll: () => {
      polls += 1;
    },
  });
  assert.equal(stream.state, 'fallback');
  t.mock.timers.tick(5);
  assert.equal(polls, 1);
  stream.close();
});

test('ApiClient.stream joins the base url, resumes via query and passes the factory through', () => {
  const instances: FakeEventSource[] = [];
  const client = createApiClient({
    baseUrl: '/admin/api',
    storage: null,
    eventSource: factoryFor(instances),
  });
  const stream = client.stream('/audit/stream', { eventTypes: ['audit'], lastEventId: '9' });
  assert.equal(instances[0]?.url, '/admin/api/audit/stream?lastEventId=9');
  assert.equal(instances[0]?.init?.withCredentials, true);
  stream.close();
});
