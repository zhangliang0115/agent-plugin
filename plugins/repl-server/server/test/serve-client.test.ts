import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ServeClient, type ServeClientProcess } from '../src/serve/client.ts';

interface WrittenMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

/** Minimal stdio child: answers `initialize` and records every request. */
class FakeChild {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: WrittenMessage[] = [];
  private readonly exitListeners: Array<() => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private exited = false;

  constructor() {
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line.trim() === '') continue;
        const message = JSON.parse(line) as WrittenMessage;
        this.written.push(message);
        if (message.method === 'initialize' && typeof message.id === 'number') {
          this.reply(message.id, {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'fake-serve', version: '0.0.0' },
          });
        }
      }
    });
  }

  reply(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  on(event: 'exit', listener: () => void): this {
    if (event === 'exit') this.exitListeners.push(listener);
    return this;
  }

  once(event: 'exit' | 'error', listener: () => void): this {
    if (event === 'error') this.errorListeners.push(listener as (error: Error) => void);
    else this.exitListeners.push(listener);
    return this;
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners.splice(0)) listener(error);
  }

  kill(): boolean {
    if (this.exited) return true;
    this.exited = true;
    // Real child processes emit `exit` asynchronously; mirror that so
    // `ServeClient.close()` registers its listener before the event lands.
    setImmediate(() => {
      this.stdin.end();
      this.stdout.end();
      this.stderr.end();
      for (const listener of this.exitListeners.splice(0)) listener();
    });
    return true;
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

async function connect(): Promise<{ client: ServeClient; child: FakeChild }> {
  const child = new FakeChild();
  const client = await ServeClient.connect(child as unknown as ServeClientProcess, {
    requestTimeoutMs: 500,
  });
  return { client, child };
}

test('aborting a tool call rejects with the reason and sends notifications/cancelled', async () => {
  const { client, child } = await connect();
  const controller = new AbortController();
  const reason = new Error('user cancelled');
  const pending = client.callTool('Slow', { value: 1 }, controller.signal);
  await tick();
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  await tick();

  const call = child.written.find((message) => message.method === 'tools/call');
  assert.ok(call !== undefined && typeof call.id === 'number');
  const cancelled = child.written.find((message) => message.method === 'notifications/cancelled');
  assert.ok(cancelled !== undefined);
  assert.equal(cancelled.params?.['requestId'], call.id);
  assert.deepEqual(cancelled.params?.['reason'], { name: 'Error', message: 'user cancelled' });

  await client.close();
});

test('an already-aborted signal never reaches the transport', async () => {
  const { client, child } = await connect();
  const controller = new AbortController();
  controller.abort(new Error('already gone'));

  await assert.rejects(
    client.callTool('Slow', {}, controller.signal),
    (error: unknown) => (error as Error).message === 'already gone',
  );
  assert.equal(child.written.filter((message) => message.method === 'tools/call').length, 0);
  await client.close();
});

test('a per-request timeout narrows the client-wide budget', async () => {
  const { client } = await connect();
  const started = Date.now();
  await assert.rejects(
    client.request('tools/call', { name: 'Slow', arguments: {} }, undefined, 20),
    /serve request timed out: tools\/call/,
  );
  assert.ok(Date.now() - started < 500);
  await client.close();
});

test('a stdin error rejects pending requests instead of crashing', async () => {
  const { client, child } = await connect();
  const pending = client.callTool('Slow', {});
  await tick();

  const error = new Error('EPIPE');
  child.stdin.emit('error', error);

  await assert.rejects(pending, (reason: unknown) => reason === error);
  await client.close();
});

test('a process error rejects pending requests and leaves the client closed', async () => {
  const { client, child } = await connect();
  const pending = client.callTool('Slow', {});
  await tick();

  const error = new Error('spawn ENOENT');
  child.emitError(error);

  await assert.rejects(pending, (reason: unknown) => reason === error);
  assert.equal(client.isClosed, true);
  await client.close();
});
