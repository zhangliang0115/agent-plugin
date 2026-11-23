/**
 * Payload storage: turns one tool argument or result into either an inline
 * field on the event row or a blob under `log/payload/`.
 *
 * The event row is the index (constant size); the blob is the content. Writing
 * is `tmp -> fsync -> rename` so a blob that exists is always complete, and the
 * caller writes the row only after the blob settles — a row never points at a
 * missing file. The opposite window (blob without row) leaves an orphan that the
 * retention sweep reclaims by mtime.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, posix } from 'node:path';

import { resolveLogRef } from './refs.ts';

/** Content up to this size stays on the event row. */
export const INLINE_MAX_BYTES = 4 * 1024;
/** Bytes of the head kept next to a ref so the UI can render without a fetch. */
export const PREVIEW_BYTES = 2 * 1024;
/** A single blob above this is stored as head + tail only. */
export const PAYLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const PAYLOAD_HEAD_BYTES = 1024 * 1024;
export const PAYLOAD_TAIL_BYTES = 1024 * 1024;
/** A blob that takes longer than this is abandoned; the row records why. */
export const PAYLOAD_WRITE_TIMEOUT_MS = 2_000;
export const PAYLOAD_WRITE_CONCURRENCY = 4;

export type PayloadDropReason = 'serialize' | 'io' | 'timeout' | 'backlog';

export interface SerializedPayload {
  text: string;
  bytes: number;
  sha256: string;
}

export type PayloadPlan =
  | { kind: 'inline'; text: string; bytes: number }
  | { kind: 'blob'; text: string; bytes: number; sha256: string; preview: string }
  | { kind: 'split'; head: string; tail: string; bytes: number; sha256: string; preview: string }
  | { kind: 'dropped'; reason: PayloadDropReason };

/** Indexed byte access that satisfies `noUncheckedIndexedAccess`. */
function byteAt(buffer: Buffer, index: number): number {
  return buffer[index] ?? 0;
}

/** Trims a buffer that would end inside a multi-byte UTF-8 sequence. */
function trimUtf8Tail(buffer: Buffer): Buffer {
  const cut = buffer.length;
  let lead = cut - 1;
  while (lead >= 0 && (byteAt(buffer, lead) & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return buffer.subarray(0, 0);
  const first = byteAt(buffer, lead);
  const need = first < 0x80 ? 1 : first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  return buffer.subarray(0, lead + need <= cut ? cut : lead);
}

/** Leading `maxBytes` of `text`, never splitting a UTF-8 sequence. */
export function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return trimUtf8Tail(buffer.subarray(0, maxBytes)).toString('utf8');
}

/** Trailing `maxBytes` of `text`, starting on a UTF-8 boundary. */
export function utf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  const slice = buffer.subarray(buffer.length - maxBytes);
  let start = 0;
  while (start < slice.length && (byteAt(slice, start) & 0xc0) === 0x80) start += 1;
  return slice.subarray(start).toString('utf8');
}

/** `JSON.stringify` exactly once; a function/undefined value becomes `null`. */
export function serializePayload(value: unknown): SerializedPayload | null {
  let text: string;
  try {
    const encoded = JSON.stringify(value);
    text = encoded === undefined ? 'null' : encoded;
  } catch {
    return null;
  }
  const buffer = Buffer.from(text, 'utf8');
  return {
    text,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

/** A short, newline-aligned head used for inline previews. */
export function previewOf(text: string, maxBytes = PREVIEW_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const head = utf8Head(text, maxBytes);
  const lineBreak = head.lastIndexOf('\n');
  // Keep a readable cut when a line break sits in the last third of the window.
  if (lineBreak > Math.floor(maxBytes / 3)) return head.slice(0, lineBreak);
  return head;
}

/**
 * Decides how one value is stored. `inline` needs no file; `blob` and `split`
 * carry everything the event row needs to describe the file it points at.
 */
export function planPayload(value: unknown): PayloadPlan {
  const serialized = serializePayload(value);
  if (serialized === null) return { kind: 'dropped', reason: 'serialize' };

  if (serialized.bytes <= INLINE_MAX_BYTES) {
    return { kind: 'inline', text: serialized.text, bytes: serialized.bytes };
  }
  const preview = previewOf(serialized.text);
  if (serialized.bytes > PAYLOAD_MAX_BYTES) {
    return {
      kind: 'split',
      head: utf8Head(serialized.text, PAYLOAD_HEAD_BYTES),
      tail: utf8Tail(serialized.text, PAYLOAD_TAIL_BYTES),
      bytes: serialized.bytes,
      sha256: serialized.sha256,
      preview,
    };
  }
  return {
    kind: 'blob',
    text: serialized.text,
    bytes: serialized.bytes,
    sha256: serialized.sha256,
    preview,
  };
}

async function fsyncDir(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort: not every filesystem allows opening one.
  }
}

/** Writes payload blobs below the log root, atomically and with 0600. */
export class PayloadStore {
  readonly logRoot: string;

  constructor(logRoot: string) {
    this.logRoot = logRoot;
  }

  async write(ref: string, text: string): Promise<void> {
    const target = resolveLogRef(this.logRoot, ref);
    if (target === null) throw new RangeError(`invalid payload ref: ${JSON.stringify(ref)}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmp, target);
      await fsyncDir(dirname(target));
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Already closed.
        }
      }
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async read(ref: string): Promise<string | null> {
    const target = resolveLogRef(this.logRoot, ref);
    if (target === null) return null;
    try {
      return await readFile(target, 'utf8');
    } catch {
      return null;
    }
  }

  async size(ref: string): Promise<number | null> {
    const target = resolveLogRef(this.logRoot, ref);
    if (target === null) return null;
    try {
      return (await stat(target)).size;
    } catch {
      return null;
    }
  }

  open(ref: string): ReadStream | null {
    const target = resolveLogRef(this.logRoot, ref);
    if (target === null) return null;
    return createReadStream(target);
  }
}

export type PayloadReadMode = 'full' | 'head' | 'tail' | 'range';

export interface PayloadReadOptions {
  mode?: PayloadReadMode;
  offset?: number;
  limit?: number;
}

export interface PayloadReadResult {
  body: Buffer;
  total: number;
  start: number;
  end: number;
  truncated: boolean;
}

export const PAYLOAD_RANGE_LIMIT = 8 * 1024 * 1024;

/**
 * Reads a payload for the admin API. Returns `null` when the ref escapes the
 * log tree or the file is gone, so the endpoint can answer 400/404.
 */
export async function readPayload(
  logRoot: string,
  ref: string,
  options: PayloadReadOptions = {},
): Promise<PayloadReadResult | null> {
  const target = resolveLogRef(logRoot, ref);
  if (target === null) return null;
  let buffer: Buffer;
  try {
    buffer = await readFile(target);
  } catch {
    return null;
  }
  const total = buffer.length;
  const mode = options.mode ?? 'full';

  if (mode === 'full') {
    return { body: buffer, total, start: 0, end: total, truncated: false };
  }
  if (mode === 'head') {
    const end = Math.min(total, options.limit ?? PAYLOAD_HEAD_BYTES);
    return { body: buffer.subarray(0, end), total, start: 0, end, truncated: end < total };
  }
  if (mode === 'tail') {
    const length = Math.min(total, options.limit ?? PAYLOAD_TAIL_BYTES);
    const start = total - length;
    return { body: buffer.subarray(start), total, start, end: total, truncated: start > 0 };
  }
  const limit = Math.min(options.limit ?? PAYLOAD_RANGE_LIMIT, PAYLOAD_RANGE_LIMIT);
  const start = Math.max(0, Math.min(options.offset ?? 0, total));
  const end = Math.min(total, start + limit);
  return { body: buffer.subarray(start, end), total, start, end, truncated: end < total };
}

/** Default relative path for one direction of one tool call. */
export function toolPayloadRef(
  date: string,
  execId: string,
  evalId: number,
  seq: number,
  tool: string,
  phase: 'call' | 'result',
  part?: 'head' | 'tail',
): string {
  const safeTool = tool.replace(/[^A-Za-z0-9._-]/g, '_');
  const suffix = part === undefined ? '' : `-${part}`;
  return posix.join('payload', date, execId, `${evalId}-${seq}-${safeTool}-${phase}${suffix}.json`);
}

/** Default relative path for one body of one protocol frame. */
export function framePayloadRef(
  date: string,
  stamp: string,
  rpcId: string,
  phase: 'in' | 'out',
  field: 'params' | 'result' | 'error' = 'params',
  part?: 'head' | 'tail',
): string {
  const safeId = rpcId.replace(/[^A-Za-z0-9._-]/g, '_');
  const suffix = part === undefined ? '' : `-${part}`;
  return posix.join('payload', date, 'frames', `${stamp}-${safeId}-${phase}-${field}${suffix}.json`);
}
