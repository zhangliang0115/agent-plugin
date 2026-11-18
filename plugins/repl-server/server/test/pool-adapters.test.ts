import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isRecord } from '@zhangliang0115/repl-server-core/src/bridge/normalize-result.ts';
import { McpToolError } from '@zhangliang0115/repl-server-core/src/errors.ts';
import { psRow } from '@zhangliang0115/repl-server-core/src/process/tree.ts';

import { McpClient, mcpClientFactory, mcpTransportFactory } from '../src/pool/adapters/client.ts';
import { createHttpTransport } from '../src/pool/adapters/http.ts';
import type { HttpTransport } from '../src/pool/adapters/http.ts';
import { createStdioTransport } from '../src/pool/adapters/stdio.ts';
import { ConnectionPool } from '../src/pool/pool.ts';
import type { PoolServerSpec } from '../src/pool/pool.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(TEST_DIR, '../../test/fixtures');
const FAKE_SERVE = path.join(FIXTURE_DIR, 'fake-serve/server.mjs');
const COMPLIANT = path.join(FIXTURE_DIR, 'compliant-mcp/server.mjs');

const CHILD_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
};
if (process.env.LANG !== undefined) CHILD_ENV.LANG = process.env.LANG;

const REQUEST_TIMEOUT_MS = 5_000;

function requestSignal(ms = REQUEST_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('condition was not met before the deadline');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return value?.[0];
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').then(() => undefined);
  child.kill('SIGTERM');
  await Promise.race([exited, tick(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// -- compliant-mcp fixture over a recording proxy --------------------------

interface RunningFixture {
  child: ChildProcess;
  port: number;
}

async function startCompliantFixture(): Promise<RunningFixture> {
  const child = spawn(process.execPath, [COMPLIANT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  child.stdout?.resume();

  const port = await new Promise<number>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => {
      reject(new Error(`compliant-mcp did not report a port: ${text}`));
    }, REQUEST_TIMEOUT_MS);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      text += chunk;
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(text);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`compliant-mcp exited early (${String(code ?? signal)})`));
    });
  });
  return { child, port };
}

interface RecordedRequest {
  method: string;
  session: string | undefined;
  accept: string | undefined;
  apiKey: string | undefined;
}

interface RunningProxy {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startRecordingProxy(targetPort: number): Promise<RunningProxy> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        session: headerValue(req.headers['mcp-session-id']),
        accept: headerValue(req.headers.accept),
        apiKey: headerValue(req.headers['x-api-key']),
      });
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: targetPort,
          path: req.url ?? '/mcp',
          method: req.method,
          headers: req.headers,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.end(Buffer.concat(chunks));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('http adapter connects to compliant-mcp, keeps the session header and deletes it on close', async (t) => {
  const fixture = await startCompliantFixture();
  const proxy = await startRecordingProxy(fixture.port);
  t.after(async () => {
    await proxy.close();
    await stopChild(fixture.child);
  });

  const transport = createHttpTransport({
    url: proxy.url,
    headers: { 'x-api-key': 'secret-key' },
  });
  const spec: PoolServerSpec = { id: 'compliant', cfgVersion: 1, transport: 'http', url: proxy.url };
  const client = new McpClient(spec, transport);

  await client.connect(transport, { signal: requestSignal() });
  // The fixture echoes the legacy version the client asked for.
  assert.equal(client.protocolVersion, '2025-11-25');
  const session = transport.sessionId;
  assert.ok(typeof session === 'string' && session !== '', 'the response session id must be recorded');

  const tools = await client.listTools({ signal: requestSignal() });
  assert.deepEqual(tools.map((tool) => tool.name), ['slow']);

  const result = await client.callTool('slow', { ms: 5 }, { signal: requestSignal() });
  assert.match(JSON.stringify(result), /slept 5 ms/);

  const posts = proxy.requests.filter((request) => request.method === 'POST');
  assert.ok(posts.length >= 3, `expected initialize, initialized and two calls, saw ${posts.length}`);
  assert.equal(posts[0]?.session, undefined, 'initialize is sent before a session exists');
  for (const request of posts.slice(1)) {
    assert.equal(request.session, session, 'every later POST must carry the recorded session id');
  }
  for (const request of proxy.requests) {
    assert.match(request.accept ?? '', /application\/json/);
    assert.match(request.accept ?? '', /text\/event-stream/);
    assert.equal(request.apiKey, 'secret-key', 'configured headers must reach the server');
  }

  await client.close();
  await transport.close();
  assert.equal(transport.sessionId, null);
  assert.ok(
    proxy.requests.some((request) => request.method === 'DELETE' && request.session === session),
    'close must DELETE the recorded session',
  );
});

// -- stdio fixture ---------------------------------------------------------

test('stdio adapter spawns fake-serve detached and round-trips initialize, listTools and Bash', async (t) => {
  const options = {
    command: process.execPath,
    args: [FAKE_SERVE],
    env: CHILD_ENV,
    detached: true as const,
    stderr: 'pipe' as const,
  };
  const transport = createStdioTransport(options);
  const spec: PoolServerSpec = {
    id: 'fake',
    cfgVersion: 1,
    transport: 'stdio',
    command: options.command,
    args: options.args,
    env: CHILD_ENV,
  };
  const client = new McpClient(spec, transport);
  const stderr: string[] = [];
  transport.onStderr((chunk) => stderr.push(chunk));
  t.after(async () => {
    await client.close();
    await transport.close();
  });

  await client.connect(transport, { signal: requestSignal() });

  assert.equal(transport.kind, 'stdio');
  assert.equal(typeof transport.pid, 'number');
  assert.equal(transport.pgid, transport.pid, 'detached makes the child its own group leader');
  assert.equal(typeof transport.lstart, 'string');
  const row = psRow(transport.pid!);
  assert.equal(row?.lstart, transport.lstart, 'lstart must come from ps, not a timestamp');

  const tools = await client.listTools({ signal: requestSignal() });
  assert.equal(tools.length, 22);
  assert.ok(tools.some((tool) => tool.name === 'Bash'));

  const result = await client.callTool('Bash', { command: 'echo adapter-ok' }, { signal: requestSignal() });
  assert.match(JSON.stringify(result), /adapter-ok/);

  await waitFor(() => stderr.join('').includes('stdio ready'));
  const pid = transport.pid!;
  await client.close();
  await transport.close();
  await waitFor(() => !processAlive(pid));
  assert.equal(processAlive(pid), false, 'close must remove the child process');
});

test('stdio close escalates from SIGTERM to SIGKILL after the grace window', async (t) => {
  const transport = createStdioTransport(
    {
      command: process.execPath,
      args: [FAKE_SERVE, '--ignore-sigterm'],
      env: CHILD_ENV,
      detached: true,
      stderr: 'pipe',
    },
    100,
  );
  const stderr: string[] = [];
  transport.onStderr((chunk) => stderr.push(chunk));
  t.after(() => transport.close());

  const pid = transport.pid;
  assert.equal(typeof pid, 'number');
  await waitFor(() => stderr.join('').includes('stdio ready'));

  const started = Date.now();
  await Promise.all([transport.close(), transport.close()]);
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 90, `close returned after ${elapsed}ms, before the SIGTERM grace window`);
  assert.equal(processAlive(pid!), false, 'SIGKILL must remove a child that ignored SIGTERM');
  assert.match(stderr.join(''), /ignoring because --ignore-sigterm/);
});

// -- error mapping and timeout ---------------------------------------------

interface RunningStub {
  url: string;
  readonly deletes: number;
  close(): Promise<void>;
}

function sendSse(res: ServerResponse, frames: readonly unknown[]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'mcp-session-id': 'stub-session',
  });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.end();
}

async function startStubServer(): Promise<RunningStub> {
  const state = { deletes: 0 };
  const server: Server = createServer((req, res) => {
    if (req.method === 'DELETE') {
      state.deletes += 1;
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (!isRecord(message) || typeof message.method !== 'string') {
        res.writeHead(400);
        res.end();
        return;
      }
      if (!Object.hasOwn(message, 'id')) {
        res.writeHead(202, { 'mcp-session-id': 'stub-session' });
        res.end();
        return;
      }

      const id = message.id;
      const method = message.method;
      if (method === 'initialize') {
        sendSse(res, [
          {
            jsonrpc: '2.0',
            id,
            result: {
              // Deliberately newer than the version the client asks for.
              protocolVersion: '2026-07-28',
              capabilities: { tools: {} },
              serverInfo: { name: 'stub', version: '1' },
            },
          },
        ]);
        return;
      }
      if (method === 'tools/list') {
        sendSse(res, [
          {
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                { name: 'plain' },
                { name: 'fail' },
                { name: 'garbage' },
                { name: 'slow' },
                { name: 'error-result' },
              ],
            },
          },
        ]);
        return;
      }
      if (method === 'tools/call') {
        const params = isRecord(message.params) ? message.params : {};
        const name = params.name;
        if (name === 'fail') {
          sendSse(res, [
            {
              jsonrpc: '2.0',
              id,
              error: { code: -32001, message: 'upstream boom', data: { code: 'UPSTREAM_BOOM' } },
            },
          ]);
          return;
        }
        if (name === 'plain') {
          sendSse(res, [{ jsonrpc: '2.0', id, error: { code: -32002, message: 'plain failure' } }]);
          return;
        }
        if (name === 'error-result') {
          sendSse(res, [
            {
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: 'Exit code 3' }], isError: true },
            },
          ]);
          return;
        }
        if (name === 'garbage') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'stub-session',
          });
          res.end('data: not-json\n\n');
          return;
        }
        if (name === 'slow') return; // held until the caller's signal aborts the fetch
        sendSse(res, [{ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } }]);
        return;
      }
      if (method === 'ping') {
        sendSse(res, [{ jsonrpc: '2.0', id, result: {} }]);
        return;
      }
      sendSse(res, [{ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }]);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get deletes(): number {
      return state.deletes;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeStubClient(url: string): { transport: HttpTransport; client: McpClient } {
  const spec: PoolServerSpec = { id: 'stub', cfgVersion: 1, transport: 'http', url };
  const transport = createHttpTransport({ url, headers: {} });
  return { transport, client: new McpClient(spec, transport) };
}

test('client accepts a newer negotiated version and maps server error codes', async (t) => {
  const stub = await startStubServer();
  const { transport, client } = makeStubClient(stub.url);
  t.after(async () => {
    client.close();
    await transport.close();
    await stub.close();
  });

  await client.connect(transport, { signal: requestSignal() });
  assert.equal(client.protocolVersion, '2026-07-28');
  await client.ping({ signal: requestSignal() });

  await assert.rejects(
    client.callTool('fail', {}, { signal: requestSignal() }),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError);
      assert.equal(error.code, 'UPSTREAM_BOOM');
      assert.equal(error.message, 'upstream boom');
      assert.deepEqual(error.detail, { code: 'UPSTREAM_BOOM' });
      return true;
    },
  );

  await assert.rejects(
    client.callTool('plain', {}, { signal: requestSignal() }),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError);
      assert.equal(error.code, 'MCP_TOOL_ERROR');
      assert.equal(error.message, 'plain failure');
      return true;
    },
  );

  await assert.rejects(
    client.callTool('error-result', {}, { signal: requestSignal() }),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError);
      assert.equal(error.code, 'MCP_TOOL_ERROR');
      assert.equal(error.message, 'Exit code 3');
      return true;
    },
  );

  await transport.close();
  assert.ok(stub.deletes >= 1, 'close must attempt a DELETE even when the server answers 404');
});

test('a non-JSON protocol frame rejects the call with MCP_PROTOCOL_ERROR', async (t) => {
  const stub = await startStubServer();
  const { transport, client } = makeStubClient(stub.url);
  t.after(async () => {
    client.close();
    await transport.close();
    await stub.close();
  });

  await client.connect(transport, { signal: requestSignal() });
  await assert.rejects(
    client.callTool('garbage', {}, { signal: requestSignal() }),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError);
      assert.equal(error.code, 'MCP_PROTOCOL_ERROR');
      return true;
    },
  );
});

test('an aborting signal rejects the pending call with MCP_CALL_TIMEOUT', async (t) => {
  const stub = await startStubServer();
  const { transport, client } = makeStubClient(stub.url);
  t.after(async () => {
    client.close();
    await transport.close();
    await stub.close();
  });

  await client.connect(transport, { signal: requestSignal() });
  const started = Date.now();
  await assert.rejects(
    client.callTool('slow', {}, { signal: requestSignal(100) }),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError);
      assert.equal(error.code, 'MCP_CALL_TIMEOUT');
      return true;
    },
  );
  assert.ok(Date.now() - started < 2_000, 'the abort must settle the call promptly');
});

// -- pool integration ------------------------------------------------------

test('adapter factories plug into ConnectionPool without changing its interfaces', async (t) => {
  const records: Array<Record<string, unknown>> = [];
  const spec: PoolServerSpec = {
    id: 'fake',
    cfgVersion: 1,
    transport: 'stdio',
    command: process.execPath,
    args: [FAKE_SERVE],
    env: CHILD_ENV,
  };
  const pool = new ConnectionPool({
    transportFactory: mcpTransportFactory,
    clientFactory: mcpClientFactory,
    servers: [spec],
    autoReconnect: false,
    ledger: {
      async recordPool(entry) {
        records.push({ ...entry });
      },
      async removePool() {
        // The pool removes the record on disconnect; nothing to assert here.
      },
    },
  });
  t.after(() => pool.close());

  await pool.ensureConnected('fake');
  const entry = pool.entry('fake');
  assert.equal(entry?.state, 'ready');
  assert.equal(entry?.tools.length, 22);

  const running = records.find((record) => record.state === 'running');
  assert.ok(running !== undefined, 'the ledger must receive a running record');
  assert.equal(typeof running.pid, 'number');
  assert.equal(running.pid, entry?.pid);
  assert.equal(running.pgid, entry?.pgid);
  assert.equal(running.lstart, entry?.lstart);
  assert.equal(typeof running.lstart, 'string');

  const result = await pool.callTool('fake', 'Bash', { command: 'echo through-pool' });
  assert.match(JSON.stringify(result), /through-pool/);

  const pid = entry?.pid;
  await pool.disconnect('fake');
  assert.equal(pool.entry('fake')?.state, 'idle');
  if (typeof pid === 'number') await waitFor(() => !processAlive(pid));
});
