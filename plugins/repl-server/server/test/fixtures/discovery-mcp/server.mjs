#!/usr/bin/env node
/**
 * Lazy-discovery MCP fixture (design 07 §9.1).
 *
 * Node built-ins only. HTTP mode (Streamable HTTP, JSON responses):
 *
 *   node server.mjs --port 0 [options]
 *
 * It advertises one `search_tools` tool (plus `echo` unless `--no-echo`) and
 * lets the test choose the response shape, pagination, brokenness and failure
 * mode. `GET /log` returns the request journal used to assert ordering,
 * warm-up caching and concurrency; `GET /health` is a liveness probe.
 *
 * Flags:
 *   --shape call_result_tools|call_result_array|tools_object|tool_array|envelope_tools
 *   --envelope result|data        envelope_tools inner key (default result)
 *   --elements N                  number of tools per page (default 3)
 *   --tools-count N               alias for --elements
 *   --page-size N                 enable pagination, N tools per page
 *   --cursor                      force a non-empty nextCursor without paging
 *   --schema-missing              omit inputSchema
 *   --big-schema                  one tool carries a >64 KiB schema
 *   --invalid                     append an invalid name, a duplicate and a non-object
 *   --prefix                      prefix names with mcp__<serverId>__ / <serverId>.
 *   --server-id ID                id used by --prefix (default lazy)
 *   --bad-shape                   return non-JSON text from search
 *   --fail-search iserror|rpc|timeout
 *   --search-delay MS             delay the search reply
 *   --strict                      non-search calls fail until search ran on the session
 *   --drop-connection-after-search destroy the socket right after answering search
 *   --log-file PATH               also append the journal as JSON lines
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined) {
    console.error(`fixture: ${name} requires a value`);
    process.exit(2);
  }
  return value;
}

function flag(name) {
  return argv.includes(name);
}

const PORT = Number(option('--port', '0'));
const SHAPE = option('--shape', 'call_result_tools');
const ENVELOPE = option('--envelope', 'result');
const ELEMENTS = Number(option('--tools-count', option('--elements', '3')));
const PAGE_SIZE = Number(option('--page-size', '0'));
const FORCE_CURSOR = flag('--cursor');
const SCHEMA_MISSING = flag('--schema-missing');
const BIG_SCHEMA = flag('--big-schema');
const INVALID = flag('--invalid');
const PREFIX = flag('--prefix');
const SERVER_ID = option('--server-id', 'lazy');
const BAD_SHAPE = flag('--bad-shape');
const FAIL_SEARCH = option('--fail-search', undefined);
const SEARCH_DELAY = Number(option('--search-delay', '0'));
const STRICT = flag('--strict');
const DROP_AFTER_SEARCH = flag('--drop-connection-after-search');
const DROP_ONCE = flag('--drop-once');
let droppedOnce = false;
const LOG_FILE = option('--log-file', undefined);
const NO_ECHO = flag('--no-echo');

const journal = [];
const sessions = new Map();
let sessionSeq = 0;
let seq = 0;
let active = 0;
let maxActive = 0;

function record(entry) {
  const item = { seq: ++seq, at: Date.now(), active, maxActive, ...entry };
  journal.push(item);
  if (journal.length > 5000) journal.shift();
  if (LOG_FILE !== undefined) {
    try {
      appendFileSync(LOG_FILE, `${JSON.stringify(item)}\n`);
    } catch {
      // Logging is best effort.
    }
  }
  return item;
}

function toolName(raw) {
  if (!PREFIX) return raw;
  return `${raw.startsWith(`mcp__${SERVER_ID}__`) ? '' : `mcp__${SERVER_ID}__`}${raw}`;
}

function schemaFor(index) {
  if (SCHEMA_MISSING) return undefined;
  if (BIG_SCHEMA && index === 0) {
    return {
      type: 'object',
      description: 'x'.repeat(70 * 1024),
      properties: { text: { type: 'string' } },
    };
  }
  return {
    type: 'object',
    properties: { text: { type: 'string' } },
    additionalProperties: true,
  };
}

function buildTools() {
  const count = Number.isFinite(ELEMENTS) && ELEMENTS >= 0 ? ELEMENTS : 3;
  const tools = [];
  for (let index = 0; index < count; index += 1) {
    const tool = {
      name: toolName(index === 0 ? 'list_tables' : `tool_${index}`),
      description: `Fixture tool ${index}`,
    };
    const schema = schemaFor(index);
    if (schema !== undefined) tool.inputSchema = schema;
    tools.push(tool);
  }
  if (INVALID) {
    tools.push({ name: 'bad name!', description: 'invalid' });
    tools.push({ name: toolName('list_tables'), description: 'duplicate' });
    tools.push('not-an-object');
  }
  return tools;
}

function pageOf(args) {
  const all = buildTools();
  if (!Number.isFinite(PAGE_SIZE) || PAGE_SIZE <= 0) {
    return { tools: all, nextCursor: FORCE_CURSOR ? 'page-2' : null };
  }
  const offset = Number.parseInt(String(args?.cursor ?? '0'), 10);
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const slice = all.slice(start, start + PAGE_SIZE);
  const next = start + PAGE_SIZE < all.length ? String(start + PAGE_SIZE) : null;
  return { tools: slice, nextCursor: next };
}

function jsonText(value) {
  return JSON.stringify(value);
}

function searchPayload(args) {
  const page = pageOf(args);
  let payload;
  switch (SHAPE) {
    case 'tools_object':
      payload = { tools: page.tools };
      if (page.nextCursor !== null) payload.nextCursor = page.nextCursor;
      return payload;
    case 'tool_array':
      return page.tools;
    case 'envelope_tools':
      if (ENVELOPE === 'data') {
        return { data: page.tools };
      }
      return { result: page.nextCursor === null ? { tools: page.tools } : { tools: page.tools, nextCursor: page.nextCursor } };
    case 'call_result_array':
      return {
        content: [{ type: 'text', text: jsonText(page.tools) }],
        isError: false,
      };
    case 'call_result_tools':
    default: {
      const body = { tools: page.tools };
      if (page.nextCursor !== null) body.nextCursor = page.nextCursor;
      return {
        content: [{ type: 'text', text: jsonText(body) }],
        isError: false,
      };
    }
  }
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionState(sessionId) {
  let state = sessions.get(sessionId);
  if (state === undefined) {
    state = { searched: false };
    sessions.set(sessionId, state);
  }
  return state;
}

async function handleRpc(message, context) {
  const method = message.method;
  const params = message.params ?? {};
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'discovery-fixture', version: '0.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
  if (method === 'tools/list') {
    const tools = [
      {
        name: 'search_tools',
        description: 'Search upstream tools',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];
    if (!NO_ECHO) {
      tools.push({ name: 'echo', description: 'Echo text', inputSchema: { type: 'object' } });
    }
    return { jsonrpc: '2.0', id: message.id, result: { tools } };
  }
  if (method !== 'tools/call') {
    return rpcError(message.id, -32601, `Method not found: ${method}`);
  }

  const tool = String(params.name ?? '');
  const args = params.arguments ?? {};
  const state = sessionState(context.sessionId);
  record({ tool, args });

  if (tool === 'search_tools') {
    state.searched = true;
    if (SEARCH_DELAY > 0) await sleep(SEARCH_DELAY);
    if (FAIL_SEARCH === 'iserror') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'search failed' }], isError: true },
      };
    }
    if (FAIL_SEARCH === 'rpc') {
      return rpcError(message.id, -32000, 'search exploded');
    }
    if (FAIL_SEARCH === 'timeout') {
      // Never answer within the caller's budget.
      await sleep(120_000);
    }
    if (BAD_SHAPE) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'this is not JSON at all' }] },
      };
    }
    return { jsonrpc: '2.0', id: message.id, result: searchPayload(args) };
  }

  if (STRICT && !state.searched) {
    return rpcError(message.id, -32601, `Unknown tool: ${tool}`);
  }
  return {
    jsonrpc: '2.0',
    id: message.id,
    result: { content: [{ type: 'text', text: `ok:${tool}` }], isError: false },
  };
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
      if (body.length > 1_000_000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = createServer((req, res) => {
  void handleHttp(req, res).catch((error) => {
    sendJson(res, 500, { ok: false, error: { code: 'FIXTURE_ERROR', message: String(error) } });
  });
});

async function handleHttp(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, fixture: 'discovery' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/log') {
    sendJson(res, 200, { requests: journal, maxActive, active });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/reset-log') {
    journal.length = 0;
    maxActive = active;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND' } });
    return;
  }
  if (req.method === 'DELETE') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } });
    return;
  }

  let message;
  try {
    message = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(message) || typeof message !== 'object' || message === null) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }

  let sessionId = req.headers['mcp-session-id'];
  const startsSession = sessionId === undefined && message.method === 'initialize';
  if (startsSession) sessionId = `s_${++sessionSeq}`;
  const context = { sessionId: sessionId ?? 'stateless' };

  active += 1;
  maxActive = Math.max(maxActive, active);
  let response;
  try {
    response = await handleRpc(message, context);
  } finally {
    active -= 1;
  }

  const headers = startsSession ? { 'Mcp-Session-Id': sessionId } : {};
  const isSearch =
    message.method === 'tools/call' && String(message.params?.name ?? '') === 'search_tools';
  if (response === null) {
    res.writeHead(202, headers);
    res.end();
    return;
  }
  sendJson(res, 200, response, headers);
  if (isSearch && DROP_AFTER_SEARCH && (!DROP_ONCE || !droppedOnce)) {
    droppedOnce = true;
    // Kill the keep-alive socket after the response has been flushed; the pool
    // sees a transport close, which is the R-13 late-writeback interleaving.
    setImmediate(() => req.socket.destroy());
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.error(`fixture listening on http://127.0.0.1:${server.address().port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
