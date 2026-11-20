import type { LogFn } from '../log.ts';
/**
 * `claude -p` runner: fixed argv, whitelisted env, an empty temp cwd, a per-run
 * empty MCP config, a hard timeout that kills the process group, and bounded
 * stdout/stderr (08 §2.2–§2.3).
 *
 * The prompt enters through stdin only. The parsed envelope is the only value
 * handed back; stdout/stderr text never reaches logs or responses unredacted.
 * @module
 */

import { randomUUID } from 'node:crypto';
import {
  type ChildProcess,
  type SpawnOptions,
  spawn as nodeSpawn,
  spawnSync,
} from 'node:child_process';
import { constants as fsConstants, accessSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import {
  newId,
  normalizeLstart,
  ProcessLedger,
  killTree,
} from '@zhangliang0115/repl-server-core';

import { systemClock, type Clock } from '../ports.ts';
import { redactAiText } from './redact.ts';
import {
  AI_DEFAULT_TIMEOUT_MS,
  AI_ENV_KEYS,
  AI_FIXED_ARGS,
  AI_MCP_CONFIG_JSON,
  AI_OUTPUT_MAX_BYTES,
  AI_PROBE_TIMEOUT_MS,
  AI_REQUIRED_FLAGS,
  AI_STDERR_MAX_BYTES,
  AI_TERMINATE_GRACE_MS,
} from './constants.ts';
import { AiRunnerError } from './errors.ts';

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Outcome of probing the resolved CLI before the first spawn. */
export type AiCliProbeResult =
  | { ok: true }
  | { ok: false; reason: string; missing?: string[] };

/** Test seam for the CLI gate; production uses {@link probeClaudeCli}. */
export type AiCliProbe = (
  bin: string,
  context: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => AiCliProbeResult | Promise<AiCliProbeResult>;

/** Per-run settings resolved from `ai` right before the spawn. */
export interface AiRunnerConfig {
  claudeBin: string;
  model: string | null;
  timeoutMs: number;
}

export interface AiRunResult {
  /** Parsed JSON value returned inside the CLI envelope's `result` string. */
  payload: unknown;
  /** The unfenced `result` string; used only for byte counts, never persisted. */
  resultText: string;
  model: string | null;
  durationMs: number;
  costUsd: number | null;
}

export interface AiRunnerDeps {
  /** Parent of each `ai-run-*` directory; defaults to `<AGENTS_HOME>/repl-server`. */
  dataDir?: string;
  spawn?: SpawnFn;
  /** Test seam only; production callers never pass this (08 §2.2). */
  extraEnv?: Readonly<Record<string, string>>;
  clock?: Clock;
  log?: LogFn;
  maxOutputBytes?: number;
  stderrLimitBytes?: number;
  /** Test seam; production uses the real `--version`/`--help` probe. */
  probe?: AiCliProbe;
  /** Boot id recorded in `ai-runs.json`; defaults to one id per server process. */
  bootId?: string;
}

export interface AiRunner {
  run(prompt: string, config: AiRunnerConfig): Promise<AiRunResult>;
  /**
   * Terminates every in-flight `claude -p` process group, removes its run
   * directory and rejects later runs. Idempotent.
   */
  close(): Promise<void>;
}

/** Default data directory, matching `local-tokens.ts`. */
function defaultDataDir(): string {
  return join(process.env['AGENTS_HOME'] ?? join(homedir(), '.agents'), 'repl-server');
}

function buildEnv(extraEnv: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AI_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extraEnv !== undefined) {
    for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
  }
  return env;
}

/** Redacts credential-shaped text and caps it before it enters an error detail. */
export function redactTruncated(text: string, max = 2000): string {
  const redacted = redactAiText(text);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

/**
 * Removes one Markdown fence only when it wraps the whole value. Anything else
 * (prose around the JSON, dangling fences) is left untouched so `JSON.parse`
 * fails loudly instead of accepting a half-repaired object.
 */
export function stripFences(text: string): string {
  let out = text.trim();
  for (const fence of ['```', '~~~']) {
    if (!out.startsWith(fence)) continue;
    const firstNewline = out.indexOf('\n');
    if (firstNewline === -1) return '';
    out = out.slice(firstNewline + 1);
    const close = out.lastIndexOf(fence);
    if (close !== -1) out = out.slice(0, close);
    out = out.trim();
    break;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function badEnvelope(text: string): AiRunnerError {
  return new AiRunnerError('AI_BAD_ENVELOPE', 502, 'claude stdout is not a JSON envelope', {
    snippet: redactTruncated(text),
  });
}

/**
 * Parses the CLI envelope in the fixed order (08 §2.3): envelope JSON, then
 * `is_error`, then the `result` type, then the fenced payload. `is_error` is
 * checked before `result` because CLI error envelopes may omit `result` or put
 * an object there.
 */
export function parseClaudeEnvelope(
  text: string,
  configuredModel: string | null,
  durationMs: number,
): AiRunResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw badEnvelope(text);
  }
  if (!isRecord(envelope)) throw badEnvelope(text);

  if (envelope['is_error'] === true) {
    const raw =
      typeof envelope['result'] === 'string'
        ? envelope['result']
        : JSON.stringify(envelope['result'] ?? envelope['subtype'] ?? '');
    throw new AiRunnerError('AI_RUN_FAILED', 502, 'claude reported an error', {
      resultSnippet: redactTruncated(raw),
    });
  }

  const result = envelope['result'];
  if (typeof result !== 'string') throw badEnvelope(text);

  const stripped = stripFences(result);
  let payload: unknown;
  try {
    payload = JSON.parse(stripped);
  } catch {
    throw new AiRunnerError('AI_INVALID_JSON', 502, 'claude result is not JSON', {
      snippet: redactTruncated(stripped),
    });
  }

  const costUsd =
    typeof envelope['total_cost_usd'] === 'number' ? envelope['total_cost_usd'] : null;
  const model =
    typeof envelope['model'] === 'string' && envelope['model'] !== ''
      ? envelope['model']
      : configuredModel;

  return { payload, resultText: result, model, durationMs, costUsd };
}

function unavailable(command: string, error: unknown): AiRunnerError {
  const code = (error as { code?: unknown }).code;
  const reason =
    typeof code === 'string'
      ? code
      : error instanceof Error
        ? error.message
        : String(error);
  return new AiRunnerError('AI_RUNNER_UNAVAILABLE', 503, `cannot start ${command}`, {
    command,
    reason,
  });
}

async function createRunDir(base: string): Promise<string> {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(base, 'ai-run-'));
  await chmod(dir, 0o700);
  return dir;
}

/** One boot id per server process; every runner instance records the same value. */
const PROCESS_BOOT_ID = newId('boot');

/** Resolves a bare command through `PATH`; falls back to the configured text. */
function resolveCliPath(bin: string): string {
  const candidates: string[] = [];
  if (bin.includes('/') || bin.includes('\\')) {
    candidates.push(resolve(bin));
  } else {
    const searchPath = process.env['PATH'] ?? '';
    for (const dir of searchPath.split(delimiter)) {
      if (dir !== '') candidates.push(join(dir, bin));
    }
  }

  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Try the next PATH entry; a missing file is reported by the probe.
    }
  }
  return candidates[0] ?? bin;
}

function probeFailure(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
}

/** Runs `--version` then `--help` and verifies the flags the runner depends on. */
export function probeClaudeCli(
  bin: string,
  context: { env: NodeJS.ProcessEnv; timeoutMs: number },
): AiCliProbeResult {
  const version = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    env: context.env,
    timeout: context.timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (version.error !== undefined) return { ok: false, reason: probeFailure(version.error) };
  if (version.status !== 0) {
    return { ok: false, reason: `version_exit_${version.status ?? 'signal'}` };
  }

  const help = spawnSync(bin, ['--help'], {
    encoding: 'utf8',
    env: context.env,
    timeout: context.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (help.error !== undefined) return { ok: false, reason: probeFailure(help.error) };
  if (help.status !== 0) {
    return { ok: false, reason: `help_exit_${help.status ?? 'signal'}` };
  }

  const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
  const missing = AI_REQUIRED_FLAGS.filter((flag) => !text.includes(flag));
  if (missing.length > 0) return { ok: false, reason: 'missing_flags', missing };
  return { ok: true };
}

function cliUnavailable(bin: string, probe: AiCliProbeResult): AiRunnerError {
  if (probe.ok) throw new TypeError('cliUnavailable called with a successful probe');
  const details: Record<string, unknown> = { command: bin, reason: probe.reason };
  if (probe.missing !== undefined) details['missing'] = [...probe.missing];
  const suffix =
    probe.missing !== undefined && probe.missing.length > 0
      ? `; missing ${probe.missing.join(', ')}`
      : '';
  return new AiRunnerError(
    'AI_RUNNER_UNAVAILABLE',
    503,
    `claude CLI ${bin} cannot serve AI runs (${probe.reason}${suffix})`,
    details,
  );
}

/** `ps -o lstart=` for one PID; empty when `ps` cannot answer. */
function readLstart(pid: number): string {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 2_000,
  });
  if (result.error !== undefined || result.status !== 0) return '';
  return normalizeLstart(result.stdout ?? '');
}

/** Immediate SIGKILL for the group; used after a hard failure, not for the timeout path. */
function killGroupNow(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone or was never created.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited.
  }
}

/** Graceful group termination for the timeout path; SIGTERM, then SIGKILL. */
async function terminate(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    await killTree(pid, { graceMs: AI_TERMINATE_GRACE_MS, reason: 'ai_timeout' });
  } catch {
    // ps unavailable; the group kill below is the fallback.
  }
  killGroupNow(child);
}

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
}

/** One spawned run, tracked so `close` can terminate it and remove its directory. */
interface ActiveRun {
  child: ChildProcess | null;
  runDir: string;
}

function runnerClosed(): AiRunnerError {
  return new AiRunnerError('AI_RUNNER_UNAVAILABLE', 503, 'AI runner is shutting down');
}

/**
 * Creates the runner. One instance serves all requests; each `run` call creates
 * its own temp cwd and child process.
 */
export function createAiRunner(deps: AiRunnerDeps = {}): AiRunner {
  const clock = deps.clock ?? systemClock;
  const spawnFn: SpawnFn = deps.spawn ?? nodeSpawn;
  const dataDir = deps.dataDir ?? defaultDataDir();
  const maxOutputBytes = deps.maxOutputBytes ?? AI_OUTPUT_MAX_BYTES;
  const stderrLimitBytes = deps.stderrLimitBytes ?? AI_STDERR_MAX_BYTES;
  const bootId = deps.bootId ?? PROCESS_BOOT_ID;
  const probeEnv = buildEnv(deps.extraEnv);
  const ledger = new ProcessLedger({ root: dataDir });
  const probeCache = new Map<string, Promise<AiCliProbeResult>>();
  const activeRuns = new Map<string, ActiveRun>();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  function ledgerWrite(label: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      // The run itself can still succeed; a broken ledger only affects recovery.
      deps.log?.(
        `ai ledger ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn', scope: 'ai', ledger: label },
      );
    }
  }

  /** Cached per resolved path, so a healthy CLI costs two probes per process. */
  async function ensureCli(bin: string): Promise<void> {
    let result: AiCliProbeResult;
    if (deps.probe !== undefined) {
      result = await deps.probe(bin, { env: probeEnv, timeoutMs: AI_PROBE_TIMEOUT_MS });
    } else {
      const resolved = resolveCliPath(bin);
      let cached = probeCache.get(resolved);
      if (cached === undefined) {
        cached = Promise.resolve().then(() =>
          probeClaudeCli(resolved, { env: probeEnv, timeoutMs: AI_PROBE_TIMEOUT_MS }),
        );
        probeCache.set(resolved, cached);
      }
      result = await cached;
    }
    if (!result.ok) throw cliUnavailable(bin, result);
  }

  return {
    async run(prompt: string, config: AiRunnerConfig): Promise<AiRunResult> {
      if (closed) throw runnerClosed();
      await ensureCli(config.claudeBin);
      if (closed) throw runnerClosed();

      const runId = `air_${randomUUID().replaceAll('-', '')}`;
      const runDir = await createRunDir(dataDir);
      const active: ActiveRun = { child: null, runDir };
      activeRuns.set(runId, active);
      const mcpConfigPath = join(runDir, 'mcp.json');
      const timeoutMs =
        Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
          ? Math.trunc(config.timeoutMs)
          : AI_DEFAULT_TIMEOUT_MS;
      const terminationRef: { current: Promise<void> | null } = { current: null };

      ledgerWrite('spawning', () =>
        ledger.upsertAiRun({
          runId,
          pid: null,
          pgid: null,
          lstart: null,
          state: 'spawning',
          bootId,
          runDir: resolve(runDir),
          startedAt: new Date(clock.now()).toISOString(),
        }),
      );

      try {
        if (closed) throw runnerClosed();
        await writeFile(mcpConfigPath, AI_MCP_CONFIG_JSON, { mode: 0o600 });

        const model = config.model !== null && config.model !== '' ? config.model : null;
        const args: string[] = [...AI_FIXED_ARGS, '--mcp-config', mcpConfigPath];
        if (model !== null) args.push('--model', model);

        const started = clock.now();
        let child: ChildProcess;
        if (closed) throw runnerClosed();
        try {
          child = spawnFn(config.claudeBin, args, {
            cwd: runDir,
            env: buildEnv(deps.extraEnv),
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
            shell: false,
          });
        } catch (error) {
          throw unavailable(config.claudeBin, error);
        }
        active.child = child;

        if (child.pid !== undefined) {
          const pid = child.pid;
          const lstart = readLstart(pid);
          ledgerWrite('running', () =>
            ledger.patchAiRun(runId, { pid, pgid: pid, lstart, state: 'running' }),
          );
        }

        return await new Promise<AiRunResult>((resolve, reject) => {
          let settled = false;
          let stdoutBytes = 0;
          let stderrBytes = 0;
          const stdoutChunks: Buffer[] = [];
          let stderrText = '';
          let timer: ReturnType<typeof setTimeout> | undefined;

          const settle = (finish: () => void): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            finish();
          };

          child.stdout?.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const buffer = toBuffer(chunk);
            stdoutBytes += buffer.length;
            if (stdoutBytes > maxOutputBytes) {
              settle(() =>
                reject(
                  new AiRunnerError(
                    'AI_OUTPUT_TOO_LARGE',
                    502,
                    `claude wrote more than ${maxOutputBytes} bytes to stdout`,
                    { maxBytes: maxOutputBytes },
                  ),
                ),
              );
              killGroupNow(child);
              return;
            }
            stdoutChunks.push(buffer);
          });

          child.stderr?.on('data', (chunk: Buffer | string) => {
            // Keep draining after the cap so the child never blocks on a full pipe.
            const buffer = toBuffer(chunk);
            const remaining = stderrLimitBytes - stderrBytes;
            if (remaining > 0) stderrText += buffer.subarray(0, remaining).toString('utf8');
            stderrBytes += buffer.length;
          });

          child.on('error', (error) => {
            settle(() => reject(unavailable(config.claudeBin, error)));
          });

          child.on('close', (code, signal) => {
            if (settled) return;
            const durationMs = Math.max(0, clock.now() - started);
            if (code !== 0) {
              const details: Record<string, unknown> = {};
              if (code !== null) details['exitCode'] = code;
              if (signal !== null) details['signal'] = signal;
              if (stderrText !== '') details['stderr'] = redactTruncated(stderrText);
              settle(() =>
                reject(
                  new AiRunnerError(
                    'AI_RUN_FAILED',
                    502,
                    `claude exited with ${code ?? signal ?? 'unknown status'}`,
                    details,
                  ),
                ),
              );
              return;
            }

            try {
              const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
              const result = parseClaudeEnvelope(stdoutText, model, durationMs);
              settle(() => resolve(result));
            } catch (error) {
              settle(() => reject(error));
            }
          });

          timer = setTimeout(() => {
            settle(() =>
              reject(
                new AiRunnerError('AI_TIMEOUT', 504, `claude did not finish within ${timeoutMs}ms`, {
                  timeoutMs,
                }),
              ),
            );
            // The ledger entry stays until the group is actually gone; a crash
            // mid-termination is then still recoverable by the startup sweep.
            terminationRef.current = terminate(child);
          }, timeoutMs);
          timer.unref?.();

          // EPIPE means the child closed stdin early. Do not turn it into an
          // unhandled 'error' event; the exit/parse path reports the real reason.
          child.stdin?.on('error', () => undefined);
          child.stdin?.end(prompt);
        });
      } finally {
        activeRuns.delete(runId);
        const pendingTermination = terminationRef.current;
        if (pendingTermination !== null) await pendingTermination.catch(() => undefined);
        ledgerWrite('remove', () => ledger.removeAiRun(runId));
        await rm(runDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }).catch(
          () => undefined,
        );
      }
    },
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closed = true;
      // Snapshot synchronously so every run that already registered is covered;
      // a run that starts later sees `closed` and never spawns.
      const runs = [...activeRuns.values()];
      closePromise = (async () => {
        await Promise.allSettled(
          runs.map(async (run) => {
            if (run.child !== null) await terminate(run.child);
          }),
        );
        await Promise.allSettled(
          runs.map((run) =>
            rm(run.runDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }),
          ),
        );
      })();
      return closePromise;
    },
  };
}
