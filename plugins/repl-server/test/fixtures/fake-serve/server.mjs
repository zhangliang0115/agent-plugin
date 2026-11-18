#!/usr/bin/env node
// RST-T07 fake `claude mcp serve` (stdio, newline-delimited JSON-RPC).
//
// The fixture is deterministic: it never executes shell commands, never touches
// the network, and only reads/writes files when a test explicitly calls
// Read/Edit/Write. stdout carries JSON-RPC frames only; every log goes to
// stderr. See README.md for the simulated command grammar and option list.

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import http from 'node:http';

// 22 tool names measured from Claude Code 2.1.326 `tools/list`
// (learn-ai claude-code/自建设计/01 §2.1). Grep/Glob are deliberately absent;
// see that document's §2.2.
const TOOL_DEFS = [
  {
    name: 'Bash',
    description: 'Run a shell command.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number' },
        description: { type: 'string' },
      },
      required: ['command'],
      additionalProperties: true,
    },
  },
  {
    name: 'Read',
    description: 'Read a file from the local filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['file_path'],
      additionalProperties: true,
    },
  },
  {
    name: 'Edit',
    description: 'Replace an exact string in a file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: true,
    },
  },
  {
    name: 'Write',
    description: 'Write a file to the local filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
      additionalProperties: true,
    },
  },
  {
    name: 'NotebookEdit',
    description: 'Edit a Jupyter notebook cell.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string' },
        cell_id: { type: 'string' },
        new_source: { type: 'string' },
        cell_type: { type: 'string' },
        edit_mode: { type: 'string' },
      },
      required: ['notebook_path'],
      additionalProperties: true,
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetch a URL and extract its content.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['url', 'prompt'],
      additionalProperties: true,
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: true,
    },
  },
  {
    name: 'Agent',
    description: 'Launch a subagent to handle a task.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
        subagent_type: { type: 'string' },
      },
      required: ['description', 'prompt'],
      additionalProperties: true,
    },
  },
  {
    name: 'Workflow',
    description: 'Run a workflow.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'SendMessage',
    description: 'Send a message to another agent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['to', 'message'],
      additionalProperties: true,
    },
  },
  {
    name: 'ListAgents',
    description: 'List available agents.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'TaskStop',
    description: 'Stop a running task.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: true,
    },
  },
  {
    name: 'Skill',
    description: 'Invoke a skill.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        args: { type: 'string' },
      },
      required: ['skill'],
      additionalProperties: true,
    },
  },
  {
    name: 'EnterWorktree',
    description: 'Enter a worktree.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: true,
    },
  },
  {
    name: 'ExitWorktree',
    description: 'Exit a worktree.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'Monitor',
    description: 'Monitor a background process.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number' },
        description: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'CronCreate',
    description: 'Create a scheduled task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'CronDelete',
    description: 'Delete a scheduled task.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: true,
    },
  },
  {
    name: 'CronList',
    description: 'List scheduled tasks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'ScheduleWakeup',
    description: 'Schedule a wakeup.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'ToolSearch',
    description: 'Search for available tools.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: true,
    },
  },
  {
    name: 'ReportFindings',
    description: 'Report findings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
];

const TOOL_NAMES = TOOL_DEFS.map((tool) => tool.name);

const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
const MAX_HTTP_BODY = 1024 * 1024;
const DIFF_MEMORY_LIMIT = 4_000_000;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

class CancelledError extends Error {
  constructor() {
    super('request cancelled');
    this.name = 'CancelledError';
  }
}

function parseNumber(value, label, { integer = true, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min || parsed > max) {
    throw new Error(`${label} expects ${integer ? 'an integer' : 'a number'} in [${min}, ${max}], got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const opts = {
    delayMs: 0,
    crashAfter: 0,
    ignoreSigterm: false,
    httpPort: null,
    quiet: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inlineValue;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} expects a value`);
      return argv[i];
    };

    switch (arg) {
      case '--delay-ms':
        opts.delayMs = parseNumber(takeValue(), '--delay-ms');
        break;
      case '--crash-after':
        opts.crashAfter = parseNumber(takeValue(), '--crash-after');
        break;
      case '--http-port':
        opts.httpPort = parseNumber(takeValue(), '--http-port', { min: 0, max: 65535 });
        break;
      case '--ignore-sigterm':
        opts.ignoreSigterm = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--verbose':
      case '--debug':
        opts.verbose = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        // `claude mcp serve` passes these positionals; ignore them so the
        // fixture can be injected through REPL_CLAUDE_BIN without a wrapper
        // that strips them.
        if (arg !== 'mcp' && arg !== 'serve') {
          process.stderr.write(`[fake-serve] ignoring positional argument: ${arg}\n`);
        }
    }
  }

  return opts;
}

function usage() {
  return `Usage: node server.mjs [options]

stdio is the default transport; stdout carries only newline-delimited JSON-RPC.

Options:
  --delay-ms <n>     delay every tools/call by n ms (default 0)
  --crash-after <n>  SIGKILL the process while handling the n-th tools/call
  --ignore-sigterm   keep running after SIGTERM
  --http-port <n>    serve the same JSON-RPC over HTTP on 127.0.0.1:<n>
                     (manual curl checks only; 0 picks an ephemeral port)
  --quiet            suppress stderr logs
  --verbose          log inbound frames (truncated)
  --help             show this help
`;
}

const opts = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[fake-serve] ${error.message}\n${usage()}`);
    process.exit(2);
  }
})();

if (opts.help) {
  process.stderr.write(usage());
  process.exit(0);
}

function log(message) {
  if (!opts.quiet) process.stderr.write(`[fake-serve] ${message}\n`);
}

// -- state -----------------------------------------------------------------

const readFiles = new Set();
const pendingCalls = new Map();
let toolCallCount = 0;

function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

function cancellableDelay(id, ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const key = idKey(id);
    const timer = setTimeout(() => {
      pendingCalls.delete(key);
      resolve();
    }, ms);
    pendingCalls.set(key, {
      cancel() {
        clearTimeout(timer);
        pendingCalls.delete(key);
        reject(new CancelledError());
      },
    });
  });
}

function crash(reason) {
  process.stderr.write(`[fake-serve] CRASH pid=${process.pid}: ${reason}\n`);
  try {
    process.kill(process.pid, 'SIGKILL');
  } catch {
    process.exit(137);
  }
  // If the signal has not been delivered yet, never resolve so no JSON-RPC
  // response can escape after the crash marker.
  return new Promise(() => {});
}

// -- JSON-RPC helpers ------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolText(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }] };
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new RpcError(-32602, `Invalid params: "${field}" must be a ${allowEmpty ? '' : 'non-empty '}string`);
  }
  return value;
}

// -- simulated tools -------------------------------------------------------

function unquote(text) {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1);
  }
  return text;
}

async function runBash(args, id) {
  const command = requireString(args.command, 'command');
  let stdout = '';
  let stderr = '';

  if (/^\s*crash\s*$/.test(command)) {
    return crash('Bash command "crash"');
  }

  const exitMatch = /^\s*exit(?:\s+(-?\d+))?\s*$/.exec(command);
  const sleepMatch = /^\s*sleep\s+(\d+(?:\.\d+)?)\s*$/.exec(command);

  if (sleepMatch) {
    await cancellableDelay(id, Math.round(Number(sleepMatch[1]) * 1000));
  } else if (exitMatch) {
    const code = exitMatch[1] === undefined ? 0 : Number(exitMatch[1]);
    if (code !== 0) {
      return toolError(`Exit code ${code}`);
    }
  } else if (/^\s*pwd\s*$/.test(command)) {
    stdout = `${process.cwd()}\n`;
  } else if (/^\s*echoerr(?:\s+|$)/.test(command)) {
    stderr = `${unquote(command.replace(/^\s*echoerr\s*/, ''))}\n`;
  } else if (/^\s*echo(?:\s+|$)/.test(command)) {
    stdout = `${unquote(command.replace(/^\s*echo\s*/, ''))}\n`;
  }

  return toolText({
    stdout,
    stderr,
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  });
}

function readWholeFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function runRead(args) {
  const filePath = requireString(args.file_path, 'file_path');
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return toolError(`File does not exist: ${abs}`);
  if (fs.statSync(abs).isDirectory()) return toolError(`File is a directory: ${abs}`);

  const raw = readWholeFile(abs);
  const allLines = raw.split('\n');
  const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 1;
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : null;
  const slice = allLines.slice(offset - 1, limit === null ? undefined : offset - 1 + limit);

  readFiles.add(abs);
  return toolText({
    type: 'text',
    file: {
      filePath: abs,
      content: slice.join('\n'),
      numLines: slice.length,
      startLine: offset,
      totalLines: allLines.length,
    },
  });
}

function splitContentLines(text) {
  if (text === '') return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

function fallbackDiffOps(oldLines, newLines) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const ops = [];
  for (let i = 0; i < prefix; i += 1) ops.push([' ', oldLines[i]]);
  for (let i = prefix; i < oldLines.length - suffix; i += 1) ops.push(['-', oldLines[i]]);
  for (let i = prefix; i < newLines.length - suffix; i += 1) ops.push(['+', newLines[i]]);
  for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) ops.push([' ', oldLines[i]]);
  return ops;
}

function diffOps(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  if ((n + 1) * (m + 1) > DIFF_MEMORY_LIMIT) return fallbackDiffOps(oldLines, newLines);

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        oldLines[i] === newLines[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push([' ', oldLines[i]]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push(['-', oldLines[i]]);
      i += 1;
    } else {
      ops.push(['+', newLines[j]]);
      j += 1;
    }
  }
  while (i < n) {
    ops.push(['-', oldLines[i]]);
    i += 1;
  }
  while (j < m) {
    ops.push(['+', newLines[j]]);
    j += 1;
  }
  return ops;
}

function opsToHunks(ops, context = 3) {
  const hunks = [];
  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index][0] === ' ') index += 1;
    if (index >= ops.length) break;

    const start = index;
    let lastChange = index;
    let probe = index;
    while (probe < ops.length) {
      if (ops[probe][0] !== ' ') lastChange = probe;
      else if (probe - lastChange > context * 2) break;
      probe += 1;
    }

    const begin = Math.max(0, start - context);
    const finish = Math.min(ops.length - 1, lastChange + context);
    const slice = ops.slice(begin, finish + 1);

    let oldBefore = 0;
    let newBefore = 0;
    for (let i = 0; i < begin; i += 1) {
      if (ops[i][0] !== '+') oldBefore += 1;
      if (ops[i][0] !== '-') newBefore += 1;
    }

    let oldCount = 0;
    let newCount = 0;
    for (const [kind] of slice) {
      if (kind !== '+') oldCount += 1;
      if (kind !== '-') newCount += 1;
    }

    hunks.push({
      oldStart: oldBefore + 1,
      oldLines: oldCount,
      newStart: newBefore + 1,
      newLines: newCount,
      lines: slice.map(([kind, text]) => `${kind}${text}`),
    });
    index = finish + 1;
  }
  return hunks;
}

function buildStructuredPatch(before, after) {
  return opsToHunks(diffOps(splitContentLines(before), splitContentLines(after)));
}

function runEdit(args) {
  const filePath = requireString(args.file_path, 'file_path');
  const oldString = requireString(args.old_string, 'old_string', { allowEmpty: true });
  const newString = requireString(args.new_string, 'new_string', { allowEmpty: true });
  const replaceAll = args.replace_all === true;
  const abs = path.resolve(filePath);

  if (!fs.existsSync(abs)) return toolError(`File does not exist: ${abs}`);
  if (!readFiles.has(abs)) {
    return toolError('Tool Edit input is invalid: File has not been read yet. Read it first before writing to it.');
  }
  if (oldString.length === 0) {
    return toolError('Tool Edit input is invalid: old_string must not be empty.');
  }

  const before = readWholeFile(abs);
  if (!before.includes(oldString)) {
    return toolError(`Tool Edit input is invalid: String to replace not found in file.\nString: ${oldString}`);
  }

  let after;
  if (replaceAll) {
    after = before.split(oldString).join(newString);
  } else {
    const at = before.indexOf(oldString);
    after = before.slice(0, at) + newString + before.slice(at + oldString.length);
  }
  fs.writeFileSync(abs, after);
  readFiles.add(abs);

  return toolText({
    filePath: abs,
    oldString,
    newString,
    originalFile: before,
    structuredPatch: buildStructuredPatch(before, after),
    userModified: false,
    replaceAll,
  });
}

function runWrite(args) {
  const filePath = requireString(args.file_path, 'file_path');
  const content = requireString(args.content, 'content', { allowEmpty: true });
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  readFiles.add(abs);

  const lines = content.split('\n');
  return toolText({
    type: 'text',
    file: {
      filePath: abs,
      content,
      numLines: lines.length,
      startLine: 1,
      totalLines: lines.length,
    },
  });
}

function runGeneric(name, args) {
  return toolText({ tool: name, arguments: args, fake: true });
}

async function runTool(name, args, id) {
  switch (name) {
    case 'Bash':
      return runBash(args, id);
    case 'Read':
      return runRead(args);
    case 'Edit':
      return runEdit(args);
    case 'Write':
      return runWrite(args);
    default:
      if (!TOOL_NAMES.includes(name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
      return runGeneric(name, args);
  }
}

// -- dispatch --------------------------------------------------------------

function summarizeArgs(args) {
  let text;
  try {
    text = JSON.stringify(args);
  } catch {
    text = String(args);
  }
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function handleNotification(message) {
  if (message.method === 'notifications/cancelled') {
    const requestId = message.params?.requestId;
    const pending = pendingCalls.get(idKey(requestId));
    if (pending) {
      log(`cancelling request id=${JSON.stringify(requestId)}`);
      pending.cancel();
    }
    return;
  }
  if (message.method === 'notifications/initialized') {
    log('client initialized');
    return;
  }
  log(`ignoring notification: ${message.method}`);
}

async function dispatch(message) {
  if (Array.isArray(message)) {
    return rpcError(null, -32600, 'Batch requests are not supported');
  }
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    const id = message && typeof message === 'object' && 'id' in message ? message.id : null;
    return rpcError(id, -32600, 'Invalid Request');
  }

  if (!('id' in message)) {
    handleNotification(message);
    return null;
  }

  const { id } = message;
  try {
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        const protocolVersion = typeof requested === 'string' && requested.length > 0 ? requested : DEFAULT_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fake-serve', version: '2.1.327' },
          instructions: 'Deterministic fixture standing in for `claude mcp serve`.',
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOL_DEFS });
      case 'tools/call': {
        const params = message.params;
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
          throw new RpcError(-32602, 'Invalid params: expected an object');
        }
        const name = requireString(params.name, 'name');
        const args = params.arguments ?? {};
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          throw new RpcError(-32602, 'Invalid params: "arguments" must be an object');
        }

        toolCallCount += 1;
        log(`tools/call #${toolCallCount} ${name} args=${summarizeArgs(args)}`);
        if (opts.crashAfter > 0 && toolCallCount === opts.crashAfter) {
          return crash(`--crash-after ${opts.crashAfter}`);
        }
        if (opts.delayMs > 0) {
          await cancellableDelay(id, opts.delayMs);
        }
        return rpcResult(id, await runTool(name, args, id));
      }
      default:
        return rpcError(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    if (error instanceof CancelledError) return rpcError(id, -32800, 'Request cancelled');
    if (error instanceof RpcError) return rpcError(id, error.code, error.message, error.data);
    log(`internal error: ${error && error.stack ? error.stack : String(error)}`);
    return rpcError(id, -32603, `Internal error: ${error && error.message ? error.message : String(error)}`);
  }
}

// -- transports ------------------------------------------------------------

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function startStdio() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  log(`stdio ready pid=${process.pid} tools=${TOOL_NAMES.length}`);

  rl.on('line', (line) => {
    if (line.trim() === '') return;
    if (opts.verbose) log(`<- ${line.length > 500 ? `${line.slice(0, 500)}...` : line}`);

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeFrame(rpcError(null, -32700, 'Parse error'));
      return;
    }

    dispatch(message)
      .then((frame) => {
        if (frame !== null) {
          if (opts.verbose) log(`-> id=${JSON.stringify(frame.id)}`);
          writeFrame(frame);
        }
      })
      .catch((error) => {
        log(`dispatch failure: ${error && error.stack ? error.stack : String(error)}`);
        writeFrame(rpcError(message && message.id !== undefined ? message.id : null, -32603, 'Internal error'));
      });
  });

  rl.on('close', () => {
    log('stdin closed');
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function startHttp(port) {
  const server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    if (request.method === 'GET' && url === '/health') {
      sendJson(response, 200, { ok: true, pid: process.pid, mode: 'http', tools: TOOL_NAMES.length });
      return;
    }
    if (url !== '/mcp') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'POST /mcp only' });
      return;
    }

    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_HTTP_BODY) {
        tooLarge = true;
        sendJson(response, 413, { error: 'payload too large' });
        request.destroy();
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        sendJson(response, 200, rpcError(null, -32700, 'Parse error'));
        return;
      }
      dispatch(message)
        .then((frame) => {
          if (frame === null) {
            response.writeHead(202);
            response.end();
            return;
          }
          sendJson(response, 200, frame);
        })
        .catch((error) => {
          log(`dispatch failure: ${error && error.stack ? error.stack : String(error)}`);
          sendJson(response, 200, rpcError(null, -32603, 'Internal error'));
        });
    });
  });

  server.on('error', (error) => {
    process.stderr.write(`[fake-serve] http server error: ${error.message}\n`);
    process.exit(2);
  });

  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    log(`http mode listening on http://127.0.0.1:${actual}/mcp (curl checks only)`);
  });
}

if (opts.ignoreSigterm) {
  process.on('SIGTERM', () => {
    log('SIGTERM received; ignoring because --ignore-sigterm is set');
  });
}

if (opts.httpPort !== null) {
  startHttp(opts.httpPort);
} else {
  startStdio();
}
