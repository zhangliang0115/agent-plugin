#!/usr/bin/env node
/**
 * Compliant MCP 2026-07-28 probe fixture over Streamable HTTP.
 *
 * One tool, `slow({ ms })`, plus the tasks extension methods. The server decides
 * between a synchronous CallToolResult and a CreateTaskResult from the current
 * request's `params._meta["io.modelcontextprotocol/clientCapabilities"].extensions`
 * declaration only. No session-level caching, no clientInfo sniffing.
 *
 * `--ignore-client-caps` intentionally violates "Never return a task to a client
 * that did not declare support". It exists to reproduce learn-ai 04 pit #5
 * (`-p`/headless getting a task and reporting `Unsupported result type 'task'`).
 * Contract tests must run without that flag.
 *
 * Node built-ins only. Listens on 127.0.0.1:0 and prints the actual port to stderr.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const LEGACY_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18', LEGACY_PROTOCOL_VERSION]);
const SUPPORTED_VERSIONS = Object.freeze([PROTOCOL_VERSION]);
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const SERVER_NAME = 'compliant-mcp';
const SERVER_VERSION = '1.0.0';
const TASK_TTL_MS = 600_000;
const POLL_INTERVAL_MS = 100;
const DEFAULT_SLOW_MS = 500;
const MAX_SLOW_MS = 600_000;
const MAX_BODY_BYTES = 1024 * 1024;

const INSTRUCTIONS = [
  'compliant-mcp is an MCP 2026-07-28 protocol probe with one tool: `slow({ ms })`.',
  'Call tools/call with {"name":"slow","arguments":{"ms":<integer 0-600000>}}.',
  'If the request declares the io.modelcontextprotocol/tasks extension in',
  'params._meta["io.modelcontextprotocol/clientCapabilities"].extensions, the server',
  'returns a CreateTaskResult; poll tasks/get with the returned taskId until status',
  'is completed, then read result.content. Clients that do not declare tasks receive',
  'a synchronous CallToolResult. tasks/cancel {taskId} aborts a working task;',
  'tasks/update is a no-op and returns an empty confirmation.',
].join(' ');

const SLOW_TOOL = {
  name: 'slow',
  description:
    'Sleep for the requested number of milliseconds, then return one text content block. ' +
    'Returns a CreateTaskResult when the request declares the io.modelcontextprotocol/tasks ' +
    'extension; otherwise waits and returns a synchronous CallToolResult.',
  inputSchema: {
    type: 'object',
    properties: {
      ms: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_SLOW_MS,
        default: DEFAULT_SLOW_MS,
        description: 'Delay in milliseconds.',
      },
    },
    additionalProperties: false,
  },
};

const ignoreClientCaps = process.argv.includes('--ignore-client-caps');

/** @type {Map<string, Task>} */
const tasks = new Map();

/**
 * @typedef {{
 *   taskId: string,
 *   status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled',
 *   createdAt: string,
 *   lastUpdatedAt: string,
 *   ttlMs: number,
 *   pollIntervalMs: number,
 *   expiresAt: number,
 *   ms: number,
 *   result?: object,
 *   error?: { code: string, message: string, data?: unknown },
 *   timer: NodeJS.Timeout | null,
 * }} Task
 */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, status, body, sessionId) {
  const text = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  res.writeHead(status, headers);
  res.end(text);
}

function sendAccepted(res, sessionId) {
  const headers = sessionId ? { 'mcp-session-id': sessionId } : {};
  res.writeHead(202, headers);
  res.end();
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function readSessionId(req) {
  const value = req.headers['mcp-session-id'];
  if (typeof value === 'string' && value.length > 0) return value;
  return `s_${randomUUID()}`;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function expectObject(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError(-32602, `${label} must be an object`);
  }
  return value;
}

function handleDiscover(params) {
  const p = expectObject(params, 'params');
  const meta = expectObject(p._meta, 'params._meta');
  const requested = meta['io.modelcontextprotocol/protocolVersion'];
  if (requested !== undefined && !SUPPORTED_VERSIONS.includes(requested)) {
    throw new RpcError(-32600, `Unsupported protocol version: ${String(requested)}`, {
      supportedVersions: SUPPORTED_VERSIONS,
    });
  }
  return {
    resultType: 'complete',
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    instructions: INSTRUCTIONS,
    ttlMs: 3_600_000,
    cacheScope: 'public',
  };
}

function handleInitialize(params) {
  const p = expectObject(params, 'params');
  const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : LEGACY_PROTOCOL_VERSION;
  const version =
    requested === PROTOCOL_VERSION || LEGACY_VERSIONS.includes(requested)
      ? requested
      : LEGACY_PROTOCOL_VERSION;
  return {
    protocolVersion: version,
    capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  };
}

function handleToolsList() {
  return { tools: [SLOW_TOOL] };
}

function declaredTasksCapability(params) {
  const meta = expectObject(params._meta, 'params._meta');
  const capabilities = expectObject(
    meta['io.modelcontextprotocol/clientCapabilities'],
    'params._meta["io.modelcontextprotocol/clientCapabilities"]',
  );
  const extensions = expectObject(
    capabilities.extensions,
    'params._meta["io.modelcontextprotocol/clientCapabilities"].extensions',
  );
  return Object.hasOwn(extensions, TASKS_EXTENSION);
}

function createTask(ms) {
  const taskId = `t_${randomUUID()}`;
  const createdAt = new Date();
  const task = {
    taskId,
    status: 'working',
    createdAt: createdAt.toISOString(),
    lastUpdatedAt: createdAt.toISOString(),
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    expiresAt: createdAt.getTime() + TASK_TTL_MS,
    ms,
    result: undefined,
    error: undefined,
    timer: null,
  };
  task.timer = setTimeout(() => {
    task.status = 'completed';
    task.lastUpdatedAt = new Date().toISOString();
    task.result = {
      resultType: 'complete',
      content: [{ type: 'text', text: `slow: slept ${ms} ms (task ${taskId})` }],
      isError: false,
    };
    task.timer = null;
  }, ms);
  tasks.set(taskId, task);
  return {
    resultType: 'task',
    taskId,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
  };
}

async function handleToolsCall(params) {
  const p = expectObject(params, 'params');
  if (typeof p.name !== 'string' || p.name.length === 0) {
    throw new RpcError(-32602, 'params.name is required');
  }
  const args = expectObject(p.arguments, 'params.arguments');
  if (p.name !== SLOW_TOOL.name) {
    throw new RpcError(-32602, `Unknown tool: ${p.name}`);
  }
  const ms = args.ms === undefined ? DEFAULT_SLOW_MS : args.ms;
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > MAX_SLOW_MS) {
    throw new RpcError(-32602, `params.arguments.ms must be an integer between 0 and ${MAX_SLOW_MS}`);
  }

  const declared = declaredTasksCapability(p);
  const useTask = ignoreClientCaps || declared;
  console.error(
    `[compliant-mcp] tools/call slow ms=${ms} declaredTasks=${declared} ignoreClientCaps=${ignoreClientCaps} -> ${useTask ? 'task' : 'sync'}`,
  );

  if (!useTask) {
    await sleep(ms);
    return {
      resultType: 'complete',
      content: [{ type: 'text', text: `slow: slept ${ms} ms (synchronous)` }],
      isError: false,
    };
  }
  return createTask(ms);
}

function requireTask(params, method) {
  const p = expectObject(params, 'params');
  if (typeof p.taskId !== 'string' || p.taskId.length === 0) {
    throw new RpcError(-32602, `${method} requires params.taskId`);
  }
  const task = tasks.get(p.taskId);
  if (task === undefined) {
    throw new RpcError(-32602, `Unknown task: ${p.taskId}`, { code: 'TASK_NOT_FOUND', taskId: p.taskId });
  }
  if (Date.now() > task.expiresAt) {
    throw new RpcError(-32602, `Task expired: ${p.taskId}`, { code: 'TASK_EXPIRED', taskId: p.taskId });
  }
  return task;
}

function taskSnapshot(task) {
  const snapshot = {
    resultType: 'complete',
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
  };
  if (task.status === 'completed' && task.result !== undefined) snapshot.result = task.result;
  if (task.status === 'failed' && task.error !== undefined) snapshot.error = task.error;
  return snapshot;
}

function handleTasksGet(params) {
  return taskSnapshot(requireTask(params, 'tasks/get'));
}

function handleTasksCancel(params) {
  const task = requireTask(params, 'tasks/cancel');
  if (task.status === 'working' || task.status === 'input_required') {
    if (task.timer !== null) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    task.status = 'cancelled';
    task.lastUpdatedAt = new Date().toISOString();
  }
  return { resultType: 'complete' };
}

function handleTasksUpdate(params) {
  const p = expectObject(params, 'params');
  if (typeof p.taskId === 'string') {
    const task = tasks.get(p.taskId);
    // No input_required state in this fixture. Known tasks get a fresh timestamp;
    // unknown keys (including an unknown taskId) are ignored, and the confirmation
    // is always empty.
    if (task !== undefined) task.lastUpdatedAt = new Date().toISOString();
  }
  return { resultType: 'complete' };
}

async function callMethod(method, params) {
  switch (method) {
    case 'server/discover':
      return handleDiscover(params);
    case 'initialize':
      return handleInitialize(params);
    case 'ping':
      return {};
    case 'tools/list':
      return handleToolsList();
    case 'tools/call':
      return handleToolsCall(params);
    case 'tasks/get':
      return handleTasksGet(params);
    case 'tasks/cancel':
      return handleTasksCancel(params);
    case 'tasks/update':
      return handleTasksUpdate(params);
    case 'notifications/initialized':
      return {};
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

function isJsonRpcRequest(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.jsonrpc === '2.0' &&
    typeof value.method === 'string'
  );
}

async function dispatch(message, sessionId, res) {
  if (Array.isArray(message)) {
    sendJson(res, 200, rpcError(null, -32600, 'Batch requests are not supported'), sessionId);
    return;
  }
  if (!isJsonRpcRequest(message)) {
    const id = message !== null && typeof message === 'object' && 'id' in message ? message.id : null;
    sendJson(res, 200, rpcError(id, -32600, 'Invalid Request'), sessionId);
    return;
  }

  const { id, method, params } = message;
  if (!Object.hasOwn(message, 'id')) {
    // Notifications never get a JSON-RPC response; Streamable HTTP acknowledges
    // them with 202 and an empty body.
    sendAccepted(res, sessionId);
    return;
  }

  try {
    const result = await callMethod(method, params);
    sendJson(res, 200, rpcResult(id, result), sessionId);
  } catch (error) {
    if (error instanceof RpcError) {
      sendJson(res, 200, rpcError(id, error.code, error.message, error.data), sessionId);
      return;
    }
    throw error;
  }
}

function cancelAllTasks() {
  for (const task of tasks.values()) {
    if (task.timer !== null) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    if (task.status === 'working' || task.status === 'input_required') {
      task.status = 'cancelled';
      task.lastUpdatedAt = new Date().toISOString();
    }
  }
}

async function handleHttp(req, res) {
  const pathname = new URL(req.url ?? '/', `http://${HOST}`).pathname;
  const sessionId = readSessionId(req);

  if (pathname !== MCP_PATH) {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND' } }, sessionId);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const headers = { allow: 'POST, DELETE', 'mcp-session-id': sessionId };
    res.writeHead(405, headers);
    res.end();
    return;
  }

  if (req.method === 'DELETE') {
    cancelAllTasks();
    res.writeHead(204, { 'mcp-session-id': sessionId });
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST, DELETE', 'mcp-session-id': sessionId });
    res.end();
    return;
  }

  const raw = await readBody(req);
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
  await dispatch(message, sessionId, res);
}

const server = createServer((req, res) => {
  handleHttp(req, res).catch((error) => {
    console.error(`[compliant-mcp] request failed: ${error instanceof Error ? error.stack : String(error)}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(res, status, rpcError(null, -32603, error instanceof Error ? error.message : String(error)), readSessionId(req));
  });
});

server.listen(0, HOST, () => {
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  const suffix = ignoreClientCaps ? ' (ignore-client-caps)' : '';
  console.error(`compliant-mcp listening on http://${HOST}:${port}${MCP_PATH}${suffix}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.error(`[compliant-mcp] received ${signal}, shutting down`);
    cancelAllTasks();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
