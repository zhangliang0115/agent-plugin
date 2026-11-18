/**
 * Bash argument clamping and result parsing for the `claude mcp serve` bridge.
 *
 * Serve returns Bash success as a JSON string inside `content[0].text` and a nonzero exit as
 * `isError: true` with an `Exit code N` body. Neither carries an `exitCode` field, so the bridge
 * derives it here. A nonzero exit resolves: it is a result the script inspects, not an exception.
 *
 * Design: learn-ai `claude-code/自建设计/02-执行体与进程治理.md` §1.2 (clamping) and
 * `01-Code Mode 工具桥与自建实现.md` §6.4 (normalized result).
 *
 * @module
 */
import { NoTimeLeftError } from '../errors.ts';

/**
 * L1 Bash limits from 02 §1.1: 120s default, 250ms floor, 600s cap, plus the 500ms slice held
 * back from the eval deadline. `constants.ts` has no Bash-specific entries yet and must not be
 * extended by this task, so the values live here as the single source until they move there.
 */
export const BASH_LIMITS = {
  defaultMs: 120_000,
  minMs: 250,
  maxMs: 600_000,
  reserveMs: 500,
} as const;

/** The part of an MCP content block this parser reads. */
export interface BashRawContentBlock {
  type?: string;
  text?: string;
}

/** Minimal shape of the MCP `CallToolResult` that `claude mcp serve` returns for Bash. */
export interface BashRawResult {
  content?: readonly BashRawContentBlock[];
  isError?: boolean;
}

/** Normalized Bash result handed to the script. `exitCode: null` means read the interpretation. */
export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  interrupted?: boolean;
  isImage?: boolean;
  noOutputExpected?: boolean;
  returnCodeInterpretation?: string;
}

/** Bash args with the deadline-bounded timeout filled in. */
export type ClampedBashArgs = Record<string, unknown> & { timeout: number };

/**
 * Narrows the Bash `timeout` argument to the eval deadline instead of adding a second timeout.
 *
 * The requested value defaults to 120s and is clamped to
 * `[250, min(deadline - now - 500, 600000)]`. Under the 250ms floor the call cannot finish
 * before the deadline, so it fails fast with `NoTimeLeftError`.
 */
export function clampBashArgs(
  args: Readonly<Record<string, unknown>>,
  deadline: number,
  now: number,
): ClampedBashArgs {
  const usableMs = deadline - now - BASH_LIMITS.reserveMs;
  if (usableMs < BASH_LIMITS.minMs) throw new NoTimeLeftError();

  const requested = Number(args.timeout ?? BASH_LIMITS.defaultMs);
  const requestedMs = Number.isFinite(requested) ? requested : BASH_LIMITS.defaultMs;
  return {
    ...args,
    timeout: Math.max(BASH_LIMITS.minMs, Math.min(requestedMs, usableMs, BASH_LIMITS.maxMs)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Serve puts the payload in the first text block of `content`. */
function textOf(res: BashRawResult): string {
  for (const block of res.content ?? []) {
    if (typeof block.text === 'string') return block.text;
  }
  return '';
}

/**
 * Turns a serve Bash result into `{ stdout, stderr, exitCode, ... }`. Never throws:
 *
 * - success JSON → `exitCode: 0`; with `returnCodeInterpretation` → `exitCode: null` and the
 *   field is preserved (`grep` with no match is a result, not a failure);
 * - `isError` body → `exitCode` parsed from `/Exit code (\d+)/`, still resolved;
 * - anything unparsable → the raw text as `stdout`, empty `stderr`, `exitCode: null`.
 */
export function parseBashResult(res: BashRawResult): BashResult {
  const text = textOf(res);

  if (res.isError === true) {
    const code = /Exit code (\d+)/.exec(text)?.[1];
    return code === undefined
      ? { stdout: text, stderr: '', exitCode: null }
      : { stdout: text, stderr: '', exitCode: Number.parseInt(code, 10) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { stdout: text, stderr: '', exitCode: null };
  }
  if (!isRecord(parsed)) return { stdout: text, stderr: '', exitCode: null };

  const result: BashResult = {
    stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
    stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
    exitCode: 0,
    interrupted: parsed.interrupted === true,
    isImage: parsed.isImage === true,
    noOutputExpected: parsed.noOutputExpected === true,
  };
  if (typeof parsed.returnCodeInterpretation === 'string') {
    result.exitCode = null;
    result.returnCodeInterpretation = parsed.returnCodeInterpretation;
  }
  return result;
}
