#!/usr/bin/env node
/**
 * Standalone MCP JSON-RPC fixture for the test support self-tests.
 *
 * Node built-ins only. Two modes:
 *
 *   node server.mjs --port 0 [--token T] [--child-pid-file P]
 *   node server.mjs --stdio [--server-request roots/list]
 *
 * HTTP mode serves GET /health, POST/GET/DELETE /mcp. It announces the actual
 * port on stderr so `test/support/daemon.ts` can parse it, and can spawn a
 * grandchild whose pid is written to `--child-pid-file` to prove that stopping
 * the daemon kills the whole process group.
 *
 * stdio mode speaks newline-delimited JSON-RPC on stdin/stdout; logs stay on
 * stderr. With `--server-request`, the first client request is preceded by a
 * server-initiated request, and the client's answer is echoed back as a
 * `notifications/fixture/response` notification.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = argv[index + 1];
  if (value === undefined) {
    console.error(`fixture: ${name} requires a value`);
    process.exit(2);
  }
  return value;
}

const STDIO = argv.includes('--stdio');
const PORT = Number(option('--port', '0'));
const TOKEN = option('--token', undefined);
const CHILD_PID_FILE = option('--child-pid-file', undefined);
const SERVER_REQUEST = option('--server-request', undefined);

let sessionSeq = 0;
let serverRequestSeq = 0;

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function resultFor(method, params, context) {
  switch (method) {
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'support-fixture', version: '0.0.0' } },
        instructions: 'fixture',
        ttlMs: 3600000,
        cacheScope: 'public',
      };
    case 'initialize':
      return {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'support-fixture', version: '0.0.0' },
        instructions: 'fixture',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: [
          { name: 'echo', description: 'Echo the text argument', inputSchema: { type: 'object' } },
        ],
      };
    case 'tools/call': {
      const text = String(params?.arguments?.text ?? '');
      return { content: [{ type: 'text', text: `echo:${text}` }], isError: false };
    }
    case 'fixture/echo':
      return {
        params: params ?? null,
        authorization: context.authorization ?? null,
        sessionId: context.sessionId ?? null,
      };
    default:
      return undefined;
  }
}

/** Returns a response object, or null for notifications. */
function handleRpc(message, context = {}) {
  if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message && typeof message === 'object' ? message.id : null, -32600, 'Invalid Request');
  }
  const hasId = Object.hasOwn(message, 'id');
  if (!hasId) {
    return null;
  }
  if (message.method === 'tasks/get') {
    return rpcError(message.id, -32602, 'Task not found', { code: 'TASK_NOT_FOUND' });
  }
  const result = resultFor(message.method, message.params, context);
  if (result === undefined) {
    return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
  return { jsonrpc: '2.0', id: message.id, result };
}

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function printListening(server) {
  const address = server.address();
  console.error(`fixture listening on http://127.0.0.1:${address.port}`);
}

function startChild() {
  if (CHILD_PID_FILE === undefined) {
    return;
  }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  child.unref();
  if (child.pid !== undefined) {
    writeFileSync(CHILD_PID_FILE, String(child.pid));
  }
}

function startHttp() {
  const server = createServer((req, res) => {
    void handleHttp(req, res, server).catch((error) => {
      sendJson(res, 500, { ok: false, error: { code: 'FIXTURE_ERROR', message: String(error) } });
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    printListening(server);
    startChild();
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}

async function handleHttp(req, res, server) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, fixture: true });
    return;
  }
  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND' } });
    return;
  }
  if (TOKEN !== undefined && req.headers.authorization !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED' } });
    return;
  }

  if (req.method === 'POST') {
    const raw = await readBody(req);
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
      return;
    }
    if (Array.isArray(message)) {
      sendJson(res, 400, rpcError(null, -32600, 'Batch requests are not supported'));
      return;
    }
    let sessionId = req.headers['mcp-session-id'];
    const method = typeof message === 'object' && message !== null ? message.method : undefined;
    const startsSession = sessionId === undefined && (method === 'server/discover' || method === 'initialize');
    if (startsSession) {
      sessionId = `s_${++sessionSeq}`;
    }
    const response = handleRpc(message, {
      authorization: req.headers.authorization ?? null,
      sessionId: sessionId ?? null,
    });
    const headers = startsSession ? { 'Mcp-Session-Id': sessionId } : {};
    if (response === null) {
      res.writeHead(202, headers);
      res.end();
      return;
    }
    sendJson(res, 200, response, headers);
    return;
  }

  if (req.method === 'GET') {
    if (!String(req.headers.accept ?? '').includes('text/event-stream')) {
      sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const payload = { jsonrpc: '2.0', method: 'notifications/fixture', params: { hello: true } };
    res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 10_000);
    req.on('close', () => {
      clearInterval(heartbeat);
    });
    return;
  }

  if (req.method === 'DELETE') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } });
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function startStdio() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let sentServerRequest = false;

  rl.on('line', (line) => {
    if (line.trim() === '') {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeMessage(rpcError(null, -32700, 'Parse error'));
      return;
    }
    if (typeof message === 'object' && message !== null && typeof message.method === 'string') {
      if (!Object.hasOwn(message, 'id')) {
        return;
      }
      if (SERVER_REQUEST !== undefined && !sentServerRequest) {
        sentServerRequest = true;
        serverRequestSeq += 1;
        writeMessage({ jsonrpc: '2.0', id: `srv_${serverRequestSeq}`, method: SERVER_REQUEST });
      }
      writeMessage(handleRpc(message));
      return;
    }
    if (typeof message === 'object' && message !== null && message.id === `srv_${serverRequestSeq}`) {
      writeMessage({ jsonrpc: '2.0', method: 'notifications/fixture/response', params: message });
    }
  });

  console.error('fixture stdio ready');

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => process.exit(0));
  }
}

if (STDIO) {
  startStdio();
} else {
  if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
    console.error(`fixture: invalid port ${JSON.stringify(option('--port', '0'))}`);
    process.exit(2);
  }
  startHttp();
}
