/**
 * Minimal WeCom webhook stand-in for tests and local E2E.
 *
 * It binds to 127.0.0.1 only and records every request. Responses are consumed
 * from a queue (the last entry repeats) so a test can script success, 5xx and
 * `errcode` sequences deterministically.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export interface FakeWebhookRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  body: unknown;
}

export interface FakeWebhookResponseSpec {
  status?: number;
  body?: unknown;
  delayMs?: number;
}

export interface FakeWebhookOptions {
  /** Consumed in order; the final entry repeats. Defaults to `{ errcode: 0 }`. */
  responses?: FakeWebhookResponseSpec[];
  /** Resolves before each response is written, so a test can hold a send in flight. */
  gate?: Promise<void>;
}

export interface FakeWebhook {
  url: string;
  port: number;
  requests: FakeWebhookRequest[];
  waitForRequests(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_RESPONSE: FakeWebhookResponseSpec = { status: 200, body: { errcode: 0, errmsg: 'ok' } };

export async function startFakeWebhook(options: FakeWebhookOptions = {}): Promise<FakeWebhook> {
  const requests: FakeWebhookRequest[] = [];
  const queue = options.responses === undefined ? [] : [...options.responses];
  let index = 0;

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }
    requests.push({
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: req.headers,
      rawBody,
      body,
    });

    if (options.gate !== undefined) await options.gate;

    const pick = queue.length === 0 ? DEFAULT_RESPONSE : (queue[Math.min(index, queue.length - 1)] ?? DEFAULT_RESPONSE);
    index += 1;
    if (pick.delayMs !== undefined && pick.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, pick.delayMs));
    }
    const status = pick.status ?? 200;
    const text = typeof pick.body === 'string' ? pick.body : JSON.stringify(pick.body ?? {});
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('fake webhook did not bind to a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    async waitForRequests(count, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < count) {
        if (Date.now() >= deadline) {
          throw new Error(`fake webhook received ${requests.length} request(s), expected ${count}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
