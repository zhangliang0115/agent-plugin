#!/usr/bin/env node
/**
 * Five-step smoke test for the compliant-mcp fixture.
 *
 * Starts `server.mjs` on an ephemeral port (read from stderr), then exercises:
 *   1. server/discover
 *   2. tools/call without a tasks declaration -> synchronous CallToolResult
 *   3. tools/call with a tasks declaration   -> CreateTaskResult
 *   4. tasks/get                             -> full working Task
 *   5. tasks/cancel                          -> empty confirmation, then cancelled
 *
 * Node built-ins only. Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const SERVER_PATH = fileURLToPath(new URL('./server.mjs', import.meta.url));
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;

function startServer() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });

  const lines = createInterface({ input: child.stderr });
  const portPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not report its port within ${START_TIMEOUT_MS}ms\nstderr:\n${stderr}`));
    }, START_TIMEOUT_MS);
    lines.on('line', (line) => {
      stderr += `${line}\n`;
      const match = line.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited before reporting its port (code=${code}, signal=${signal})\nstderr:\n${stderr}`));
    });
  });

  return {
    child,
    portPromise,
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
    closeLines() {
      lines.close();
    },
  };
}

function stopServer(handle) {
  return new Promise((resolve) => {
    const { child } = handle;
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.kill('SIGTERM');
  });
}

function createClient(baseURL) {
  let sessionId = null;
  let nextId = 1;

  async function post(body) {
    const headers = { 'content-type': 'application/json' };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const response = await fetch(`${baseURL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const responseSession = response.headers.get('mcp-session-id');
    if (responseSession !== null) sessionId = responseSession;
    return response;
  }

  async function rpc(method, params) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    const response = await post(message);
    const text = await response.text();
    assert.equal(response.status, 200, `${method} returned HTTP ${response.status}: ${text}`);
    const payload = JSON.parse(text);
    assert.equal(payload.jsonrpc, '2.0', `${method} jsonrpc field`);
    assert.equal(payload.id, id, `${method} echoed id`);
    assert.equal(payload.error, undefined, `${method} returned a JSON-RPC error: ${JSON.stringify(payload.error)}`);
    return payload.result;
  }

  return {
    rpc,
    get sessionId() {
      return sessionId;
    },
  };
}

function assertIsoDate(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(!Number.isNaN(Date.parse(value)), `${label} must parse as a date: ${value}`);
}

async function main() {
  const handle = startServer();
  let exit = null;

  try {
    const port = await handle.portPromise;
    const baseURL = `http://127.0.0.1:${port}`;
    console.log(`compliant-mcp smoke: server on port ${port}`);

    const client = createClient(baseURL);

    // Step 1: server/discover
    const discover = await client.rpc('server/discover', {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'compliant-mcp-smoke', version: '1.0.0' },
      },
    });
    assert.equal(discover.resultType, 'complete');
    assert.deepEqual(discover.supportedVersions, ['2026-07-28']);
    assert.equal(typeof discover.capabilities.tools, 'object');
    assert.ok(
      Object.hasOwn(discover.capabilities.extensions, TASKS_EXTENSION),
      'discover must declare capabilities.extensions["io.modelcontextprotocol/tasks"]',
    );
    assert.equal(typeof discover.instructions, 'string');
    assert.ok(discover.instructions.length > 0, 'instructions must not be empty');
    assert.equal(typeof discover.ttlMs, 'number');
    assert.ok(discover.ttlMs > 0, 'ttlMs must be positive');
    assert.equal(discover._meta['io.modelcontextprotocol/serverInfo'].name, 'compliant-mcp');
    assert.match(client.sessionId ?? '', /^s_/, 'server must return an Mcp-Session-Id header');
    console.log('PASS 1/5 server/discover');

    // Step 2: tools/call without the tasks capability -> synchronous result.
    const syncStarted = Date.now();
    const sync = await client.rpc('tools/call', {
      name: 'slow',
      arguments: { ms: 150 },
    });
    const syncElapsed = Date.now() - syncStarted;
    assert.equal(sync.resultType, 'complete');
    assert.equal(sync.isError, false);
    assert.equal(sync.taskId, undefined, 'a client that did not declare tasks must not get a task');
    assert.ok(Array.isArray(sync.content) && sync.content.length === 1);
    assert.equal(sync.content[0].type, 'text');
    assert.match(sync.content[0].text, /slept 150 ms/);
    assert.ok(syncElapsed >= 100, `sync call returned after ${syncElapsed}ms; expected it to wait for ~150ms`);
    console.log('PASS 2/5 tools/call without tasks declaration -> synchronous');

    // Step 3: tools/call with the tasks capability -> CreateTaskResult.
    const taskStarted = Date.now();
    const created = await client.rpc('tools/call', {
      name: 'slow',
      arguments: { ms: 10_000 },
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { [TASKS_EXTENSION]: {} },
        },
      },
    });
    const taskElapsed = Date.now() - taskStarted;
    assert.equal(created.resultType, 'task');
    assert.match(created.taskId, /^t_/, 'CreateTaskResult must carry a taskId');
    assert.equal(created.status, 'working');
    assertIsoDate(created.createdAt, 'CreateTaskResult.createdAt');
    assertIsoDate(created.lastUpdatedAt, 'CreateTaskResult.lastUpdatedAt');
    assert.ok(created.ttlMs > 0, 'CreateTaskResult.ttlMs must be positive');
    assert.ok(created.pollIntervalMs > 0, 'CreateTaskResult.pollIntervalMs must be positive');
    assert.ok(taskElapsed < 2_000, `task dispatch took ${taskElapsed}ms; expected an immediate CreateTaskResult`);
    console.log('PASS 3/5 tools/call with tasks declaration -> CreateTaskResult');

    // Step 4: tasks/get returns the full working Task.
    const task = await client.rpc('tasks/get', { taskId: created.taskId });
    assert.equal(task.resultType, 'complete');
    assert.equal(task.taskId, created.taskId);
    assert.equal(task.status, 'working');
    assertIsoDate(task.createdAt, 'Task.createdAt');
    assertIsoDate(task.lastUpdatedAt, 'Task.lastUpdatedAt');
    assert.equal(typeof task.ttlMs, 'number');
    assert.equal(task.ttlMs, created.ttlMs);
    assert.equal(typeof task.pollIntervalMs, 'number');
    assert.equal(task.pollIntervalMs, created.pollIntervalMs);
    assert.equal(task.result, undefined, 'a working task must not expose a result');
    console.log('PASS 4/5 tasks/get returns the full working Task');

    // Step 5: tasks/cancel returns an empty confirmation, then tasks/get observes
    // the cancelled state.
    const cancel = await client.rpc('tasks/cancel', { taskId: created.taskId });
    assert.deepEqual(cancel, { resultType: 'complete' });
    const cancelled = await client.rpc('tasks/get', { taskId: created.taskId });
    assert.equal(cancelled.status, 'cancelled');
    console.log('PASS 5/5 tasks/cancel -> cancelled');

    exit = await stopServer(handle);
    assert.equal(exit.code, 0, `server exited with code=${exit.code} signal=${exit.signal}\nstderr:\n${handle.stderr}`);
    assert.equal(handle.stdout, '', `server must not write to stdout, got: ${JSON.stringify(handle.stdout)}`);
    console.log('smoke: all 5 steps passed');
  } finally {
    handle.closeLines();
    if (exit === null) {
      await stopServer(handle);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
