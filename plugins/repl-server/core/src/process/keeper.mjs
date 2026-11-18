#!/usr/bin/env node
/**
 * Detached keeper for `claude mcp serve`.
 *
 * The host launches this file through StdioClientTransport:
 *
 *   node keeper.mjs --session <sessionId> --boot <bootId> --state-dir <dir> -- <serve command...>
 *
 * The keeper spawns serve with `detached: true` (so the child is its own process
 * group leader), atomically writes `sessions/<sessionId>/serve.json` *before*
 * forwarding any MCP byte, and tears the whole group down when its stdin reaches
 * EOF or it receives SIGTERM: SIGTERM first, SIGKILL after 2s.
 *
 * This is a dependency-free ESM script executed directly by the host, not a
 * module imported by the TypeScript sources.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const GRACE_MS = 2_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const USAGE =
  'usage: keeper.mjs --session <id> --boot <id> --state-dir <dir> -- <serve command...>';

function fail(message) {
  process.stderr.write(`keeper: ${message}\n`);
  process.exit(2);
}

/**
 * Parses `--session <id> --boot <id> --state-dir <dir> -- <command...>`.
 * Everything after the first `--` belongs to serve, verbatim.
 */
function parseArgv(argv) {
  const options = { sessionId: '', bootId: '', stateDir: '', command: '', args: [] };
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg !== '--session' && arg !== '--boot' && arg !== '--state-dir') {
      fail(`unknown option "${arg}" (${USAGE})`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`${arg} requires a value (${USAGE})`);
    }
    if (arg === '--session') options.sessionId = value;
    else if (arg === '--boot') options.bootId = value;
    else options.stateDir = value;
    index += 2;
  }

  if (argv[index] === undefined) fail(`missing serve command after "--" (${USAGE})`);
  options.command = argv[index];
  options.args = argv.slice(index + 1);

  if (!ID_PATTERN.test(options.sessionId)) fail(`invalid --session id (${USAGE})`);
  if (!ID_PATTERN.test(options.bootId)) fail(`invalid --boot id (${USAGE})`);
  if (options.stateDir === '') fail(`--state-dir is required (${USAGE})`);
  return options;
}

/** Writes `contents` through a same-directory temp file, then renames it into place. */
function writeFileAtomic(filePath, contents) {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const tmpPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  let fd;
  try {
    fd = openSync(tmpPath, 'wx', 0o600);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // nothing to clean up
    }
    throw error;
  }
}

/** Raw `ps -o lstart=` value used to detect PID reuse; empty when unknown. */
function lstartOf(pid) {
  try {
    const output = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    return output.trim();
  } catch {
    return '';
  }
}

function ignoreStreamError() {
  // EPIPE after the peer disappeared is expected during shutdown.
}

function main() {
  const options = parseArgv(process.argv.slice(2));
  const recordPath = join(options.stateDir, 'sessions', options.sessionId, 'serve.json');

  const serve = spawn(options.command, options.args, {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, REPL_SERVER_BOOT: options.bootId },
  });

  let closing = false;
  let killTimer = null;

  function killGroup(signal) {
    if (serve.pid === undefined) return;
    try {
      process.kill(-serve.pid, signal);
    } catch {
      // ESRCH: the group is already gone.
    }
  }

  function shutdown() {
    if (closing) return;
    closing = true;
    killGroup('SIGTERM');
    // Referenced on purpose: the timer must survive a serve that already closed
    // its pipes while still ignoring SIGTERM.
    killTimer = setTimeout(() => {
      killGroup('SIGKILL');
      process.exit(0);
    }, GRACE_MS);
  }

  // Diagnostics only ever go to stderr; stdout is the MCP channel.
  serve.stderr.pipe(process.stderr);
  serve.stdin.on('error', ignoreStreamError);
  serve.stdout.on('error', ignoreStreamError);
  serve.stderr.on('error', ignoreStreamError);
  process.stdout.on('error', ignoreStreamError);
  process.stderr.on('error', ignoreStreamError);

  serve.on('error', (error) => {
    process.stderr.write(`keeper: failed to spawn serve: ${error.message}\n`);
    process.exit(127);
  });

  serve.on('exit', (code, signal) => {
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });

  // Registered before the record is written so a signal that races startup still
  // tears the serve group down.
  process.on('SIGTERM', shutdown);

  if (serve.pid === undefined) return;

  const record = {
    pid: serve.pid,
    pgid: serve.pid,
    keeperPid: process.pid,
    sessionId: options.sessionId,
    bootId: options.bootId,
    lstart: lstartOf(serve.pid),
    transport: 'stdio',
    startedAt: new Date().toISOString(),
  };

  try {
    writeFileAtomic(recordPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    process.stderr.write(`keeper: cannot write ${recordPath}: ${error.message}\n`);
    // The group may still be mid-setsid; give it a beat before escalating.
    killGroup('SIGTERM');
    setTimeout(() => {
      killGroup('SIGKILL');
      process.exit(1);
    }, 200);
    return;
  }

  // MCP traffic starts only after the record is on disk.
  process.stdin.pipe(serve.stdin);
  serve.stdout.pipe(process.stdout);

  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

main();
