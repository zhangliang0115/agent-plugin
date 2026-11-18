/**
 * L5 output normalization: field caps, estimated-token budget and media limits.
 *
 * Order, fixed so the same result is normalized the same way every time:
 *
 * 1. `result` keeps its first `resultChars` characters.
 * 2. Each log stream (`stdout`, `stderr`) keeps its last `logLines` lines, then its last
 *    `resultChars` characters. The wire format folds both streams into one `<log>`; per-stream
 *    caps keep the per-field flags in `TruncationFlags` meaningful.
 * 3. When the estimated token total exceeds `estimatedTokens`, `result` is cut first, then the log
 *    streams keep only their tails (`stdout` as it precedes `stderr` in `<log>`, so stderr survives
 *    longer: it usually carries the errors).
 * 4. Media: at most `images` / `documents` blocks; a block larger than `mediaBytes` (decoded size of
 *    its base64 payload) is dropped. Every dropped block is counted.
 *
 * The result is a plain structure; rendering XML is `renderEnvelope`'s job.
 *
 * @module
 */
import { LIMITS } from '../constants.ts';
import type { TruncationFlags } from '../types.ts';
import { estimateTokens } from './tokens.ts';

export interface OutputImage {
  readonly base64: string;
  readonly mediaType: string;
}

export interface OutputDocument {
  readonly base64: string;
}

export interface OutputInput {
  /** Raw script result. Strings pass through; other values are rendered as text. */
  readonly result?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly images?: readonly OutputImage[];
  readonly documents?: readonly OutputDocument[];
}

/** Limits for one normalization pass. Mirrors the relevant frozen entries in `LIMITS`. */
export interface OutputLimits {
  /** Character cap for `result` and for each log stream. */
  readonly resultChars: number;
  /** Line cap for each log stream. */
  readonly logLines: number;
  /** Estimated-token cap for `result` + `stdout` + `stderr`. */
  readonly estimatedTokens: number;
  /** Block cap for images. */
  readonly images: number;
  /** Block cap for documents (PDFs). */
  readonly documents: number;
  /** Byte cap for one image or document block. */
  readonly mediaBytes: number;
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  resultChars: LIMITS.resultChars,
  logLines: LIMITS.logLines,
  estimatedTokens: LIMITS.estimatedTokens,
  images: LIMITS.images,
  documents: LIMITS.documents,
  mediaBytes: LIMITS.mediaBytes,
};

export interface NormalizedOutput {
  /** Text of the script result; `undefined` when the script returned nothing. */
  result?: string;
  stdout: string;
  stderr: string;
  images: OutputImage[];
  documents: OutputDocument[];
  imagesOmitted: number;
  documentsOmitted: number;
  /** Only the fields that were cut are present, and always `true`. */
  truncated: TruncationFlags;
}

/** Renders a script result as the text `<result>` will carry. */
function resultText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  try {
    const json = JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    );
    return json ?? String(value);
  } catch {
    // Functions, symbols and circular objects do not serialize; keep a readable stand-in.
    return String(value);
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Keeps the first `max` characters without splitting a surrogate pair. */
function cutHead(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  let end = max;
  if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  return text.slice(0, end);
}

/** Keeps the last `max` characters without splitting a surrogate pair. */
function cutTail(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  let start = text.length - max;
  if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start += 1;
  }
  return text.slice(start);
}

/**
 * Keeps the last `maxLines` lines. A trailing newline terminates the last line instead of starting
 * an empty one, so `"a\nb\nc\n"` has three lines, not four.
 */
function keepLastLines(text: string, maxLines: number): string {
  if (maxLines <= 0 || text === '') return '';
  let newlines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) newlines += 1;
  }
  const lineCount = newlines + (text.charCodeAt(text.length - 1) === 10 ? 0 : 1);
  const drop = lineCount - maxLines;
  if (drop <= 0) return text;

  let seen = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      seen += 1;
      if (seen === drop) return text.slice(i + 1);
    }
  }
  return '';
}

/** Longest prefix whose estimate fits `maxTokens`. */
function fitPrefixToTokens(text: string, maxTokens: number): string {
  if (text === '' || estimateTokens(text) <= maxTokens) return text;
  if (maxTokens <= 0) return '';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return cutHead(text, low);
}

/** Shortest suffix whose estimate fits `maxTokens`. */
function fitSuffixToTokens(text: string, maxTokens: number): string {
  if (text === '' || estimateTokens(text) <= maxTokens) return text;
  if (maxTokens <= 0) return '';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateTokens(text.slice(mid)) <= maxTokens) high = mid;
    else low = mid + 1;
  }
  return cutTail(text, text.length - low);
}

interface LogCut {
  readonly text: string;
  readonly truncated: boolean;
}

/** Applies the line cap and then the character cap to one log stream. */
function normalizeLog(text: string, limits: OutputLimits): LogCut {
  const byLines = keepLastLines(text, limits.logLines);
  const byChars = cutTail(byLines, limits.resultChars);
  return { text: byChars, truncated: byChars !== text };
}

interface MediaCut<T> {
  readonly kept: T[];
  readonly omitted: number;
}

/**
 * Keeps the first `max` blocks that fit `maxBytes`; every other block (over the count, or oversized)
 * is counted as omitted. An oversized block does not consume the count quota.
 */
function takeMedia<T>(
  items: readonly T[],
  max: number,
  bytes: (item: T) => number,
  maxBytes: number,
): MediaCut<T> {
  const kept: T[] = [];
  let omitted = 0;
  for (const item of items) {
    if (kept.length >= max || bytes(item) > maxBytes) {
      omitted += 1;
      continue;
    }
    kept.push(item);
  }
  return { kept, omitted };
}

/** Decoded byte size of a base64 payload, without allocating the decoded buffer. */
function base64Bytes(base64: string): number {
  let length = 0;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    // Whitespace and padding do not carry data.
    if (code === 61 || code === 32 || code === 9 || code === 10 || code === 13) continue;
    length += 1;
  }
  return Math.floor((length * 3) / 4);
}

/** Normalizes one eval's output under the L5 limits. */
export function normalizeOutput(
  input: OutputInput,
  overrides: Partial<OutputLimits> = {},
): NormalizedOutput {
  const limits: OutputLimits = { ...DEFAULT_OUTPUT_LIMITS, ...overrides };
  const truncated: TruncationFlags = {};

  let result = resultText(input.result);
  if (result !== undefined) {
    const cut = cutHead(result, limits.resultChars);
    if (cut !== result) {
      truncated.result = true;
      result = cut;
    }
  }

  const stdoutCut = normalizeLog(input.stdout ?? '', limits);
  if (stdoutCut.truncated) truncated.stdout = true;
  const stderrCut = normalizeLog(input.stderr ?? '', limits);
  if (stderrCut.truncated) truncated.stderr = true;

  let stdout = stdoutCut.text;
  let stderr = stderrCut.text;

  const total = estimateTokens(result ?? '') + estimateTokens(stdout) + estimateTokens(stderr);
  if (total > limits.estimatedTokens) {
    // Keep the logs and give the result whatever budget remains.
    const logTokens = estimateTokens(stdout) + estimateTokens(stderr);
    if (result !== undefined) {
      const fitted = fitPrefixToTokens(result, limits.estimatedTokens - logTokens);
      if (fitted !== result) {
        truncated.result = true;
        result = fitted;
      }
    }

    // The logs still do not fit: keep their tails, stderr first (`<log>` puts stderr last).
    let remaining = limits.estimatedTokens - estimateTokens(result ?? '');
    const fittedStderr = fitSuffixToTokens(stderr, remaining);
    if (fittedStderr !== stderr) {
      truncated.stderr = true;
      stderr = fittedStderr;
    }
    remaining -= estimateTokens(stderr);
    const fittedStdout = fitSuffixToTokens(stdout, remaining);
    if (fittedStdout !== stdout) {
      truncated.stdout = true;
      stdout = fittedStdout;
    }
  }

  const imageCut = takeMedia(
    input.images ?? [],
    limits.images,
    (image) => base64Bytes(image.base64),
    limits.mediaBytes,
  );
  const documentCut = takeMedia(
    input.documents ?? [],
    limits.documents,
    (document) => base64Bytes(document.base64),
    limits.mediaBytes,
  );

  return {
    result,
    stdout,
    stderr,
    images: imageCut.kept,
    documents: documentCut.kept,
    imagesOmitted: imageCut.omitted,
    documentsOmitted: documentCut.omitted,
    truncated,
  };
}
