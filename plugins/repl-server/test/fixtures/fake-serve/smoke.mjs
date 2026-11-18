#!/usr/bin/env node
// RST-T07 smoke test: spawn server.mjs over stdio, exercise initialize,
// tools/list, Bash and Read (plus the Edit read-state machine), then close
// stdin and require a clean exit 0.
//
// Run: node test/fixtures/fake-serve/smoke.mjs

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const REQUEST_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;

// Oracle copied from learn-ai claude-code/自建设计/01 §2.1 (22 measured names).
// Grep/Glob are intentionally absent (§2.2).
const EXPECTED_TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Workflow',
  'SendMessage',
  'ListAgents',
  'TaskStop',
  'Skill',
  'EnterWorktree',
  'ExitWorktree',
  'Monitor',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'ToolSearch',
  'ReportFindings',
];

let checkCount = 0;
function check(label) {
  checkCount += 1;
  process.stdout.write(`ok ${checkCount} - ${label}\n`);
}

function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrChunks = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const pending = new Map();
  let nextId = 1;
  let protocolViolation = null;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      protocolViolation = `non-JSON stdout line: ${JSON.stringify(line.slice(0, 120))}`;
      for (const entry of pending.values()) entry.reject(new Error(protocolViolation));
      pending.clear();
      return;
    }
    if (frame.jsonrpc !== '2.0') {
      protocolViolation = `frame without jsonrpc 2.0: ${JSON.stringify(frame).slice(0, 120)}`;
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) {
      protocolViolation = `unexpected response id ${JSON.stringify(frame.id)}`;
      return;
    }
    pending.delete(frame.id);
    entry.clearTimer();
    if (frame.error) {
      entry.reject(new Error(`${entry.method} failed: ${frame.error.code} ${frame.error.message}`));
      return;
    }
    entry.resolve(frame.result);
  });

  function request(method, params) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms waiting for ${method}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        method,
        resolve,
        reject,
        clearTimer: () => clearTimeout(timer),
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async function stop() {
    child.stdin.end();
    let timer;
    try {
      const exit = await Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`server did not exit within ${EXIT_TIMEOUT_MS}ms`)), EXIT_TIMEOUT_MS);
        }),
      ]);
      return { code: exit[0], signal: exit[1] };
    } finally {
      clearTimeout(timer);
    }
  }

  function kill() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  return {
    child,
    request,
    notify,
    stop,
    kill,
    stderr: () => stderrChunks.join(''),
    violation: () => protocolViolation,
  };
}

function parseToolText(result, label) {
  assert.ok(Array.isArray(result.content) && result.content.length > 0, `${label}: content must be a non-empty array`);
  assert.equal(result.content[0].type, 'text', `${label}: content[0].type`);
  assert.equal(typeof result.content[0].text, 'string', `${label}: content[0].text`);
  return JSON.parse(result.content[0].text);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-serve-smoke-'));
  const alphaPath = path.join(tempDir, 'alpha.txt');
  const betaPath = path.join(tempDir, 'beta.txt');
  const alphaOriginal = 'hello world\nsecond line\n';
  fs.writeFileSync(alphaPath, alphaOriginal);
  fs.writeFileSync(betaPath, 'beta\n');

  const server = startServer();

  try {
    // 1. initialize
    const init = await server.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'fake-serve-smoke', version: '0.0.0' },
    });
    assert.equal(init.protocolVersion, '2025-11-25');
    assert.equal(init.serverInfo.name, 'fake-serve');
    assert.ok(init.capabilities && typeof init.capabilities.tools === 'object');
    check('initialize returns protocolVersion, capabilities.tools and serverInfo');

    server.notify('notifications/initialized', {});

    // 2. tools/list
    const list = await server.request('tools/list', {});
    const names = list.tools.map((tool) => tool.name);
    assert.deepEqual(names, EXPECTED_TOOLS);
    assert.equal(new Set(names).size, 22);
    assert.ok(!names.includes('Grep') && !names.includes('Glob'), 'Grep/Glob must not be exposed');
    for (const tool of list.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.inputSchema.type, 'object');
    }
    check('tools/list returns exactly the 22 measured tool names without Grep/Glob');

    // 3. Bash success -> JSON in content[0].text
    const bash = await server.request('tools/call', {
      name: 'Bash',
      arguments: { command: 'echo hello-from-fake-serve' },
    });
    assert.notEqual(bash.isError, true);
    const bashPayload = parseToolText(bash, 'Bash');
    assert.equal(bashPayload.stdout, 'hello-from-fake-serve\n');
    assert.equal(bashPayload.stderr, '');
    assert.equal(bashPayload.interrupted, false);
    assert.equal(bashPayload.isImage, false);
    assert.equal(bashPayload.noOutputExpected, false);
    check('Bash success returns the protocol JSON with stdout');

    // 4. Bash non-zero exit -> isError with plain "Exit code N" text
    const bashFailure = await server.request('tools/call', {
      name: 'Bash',
      arguments: { command: 'exit 3' },
    });
    assert.equal(bashFailure.isError, true);
    assert.ok(
      bashFailure.content[0].text.startsWith('Exit code 3'),
      `expected "Exit code 3", got ${JSON.stringify(bashFailure.content[0].text)}`,
    );
    check('Bash non-zero exit returns isError with "Exit code N"');

    // 5. Read returns file.content
    const read = await server.request('tools/call', {
      name: 'Read',
      arguments: { file_path: alphaPath },
    });
    const readPayload = parseToolText(read, 'Read');
    assert.equal(readPayload.type, 'text');
    assert.equal(readPayload.file.filePath, alphaPath);
    assert.equal(readPayload.file.content, alphaOriginal);
    assert.equal(readPayload.file.numLines, 3);
    assert.equal(readPayload.file.startLine, 1);
    assert.equal(readPayload.file.totalLines, 3);
    check('Read returns { type, file: { filePath, content, numLines, startLine, totalLines } }');

    // 6. Edit before Read is rejected by the read-state machine
    const editDenied = await server.request('tools/call', {
      name: 'Edit',
      arguments: { file_path: betaPath, old_string: 'beta', new_string: 'gamma' },
    });
    assert.equal(editDenied.isError, true);
    assert.match(editDenied.content[0].text, /File has not been read yet/);
    check('Edit before Read returns the read-state-machine error');

    // 7. Edit after Read returns structuredPatch and changes the file
    const edit = await server.request('tools/call', {
      name: 'Edit',
      arguments: { file_path: alphaPath, old_string: 'world', new_string: 'there' },
    });
    assert.notEqual(edit.isError, true);
    const editPayload = parseToolText(edit, 'Edit');
    assert.equal(editPayload.filePath, alphaPath);
    assert.equal(editPayload.oldString, 'world');
    assert.equal(editPayload.newString, 'there');
    assert.equal(editPayload.originalFile, alphaOriginal);
    assert.equal(editPayload.userModified, false);
    assert.equal(editPayload.replaceAll, false);
    assert.equal(editPayload.structuredPatch.length, 1);
    assert.deepEqual(editPayload.structuredPatch[0], {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: ['-hello world', '+hello there', ' second line'],
    });
    assert.equal(fs.readFileSync(alphaPath, 'utf8'), 'hello there\nsecond line\n');
    check('Edit after Read returns structuredPatch and writes the replacement');

    // 8. stdout purity and stderr logging
    assert.equal(server.violation(), null, `stdout violation: ${server.violation()}`);
    assert.match(server.stderr(), /\[fake-serve\] stdio ready/);
    check('stdout carried only JSON-RPC frames; logs went to stderr');

    // 9. clean exit on stdin EOF
    const exit = await server.stop();
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
    check('stdin EOF exits with code 0');

    process.stdout.write(`\nsmoke: PASS (${checkCount} checks)\n`);
  } finally {
    server.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`\nsmoke: FAIL\n${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
