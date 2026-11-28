/**
 * Content-addressed media store: images and PDFs that tool results and protocol
 * frames carried as base64, kept as decoded bytes at
 * `payload/<date>/media/<sha256>.<ext>`.
 *
 * The row only carries `{ sha256, mediaType, bytes }`; the bytes are served by
 * `GET /admin/api/logs/media`. Files live under the same `payload/<date>/` tree
 * as blobs, so the per-day retention sweep removes them with no extra logic.
 * Writing reuses {@link PayloadStore.write} (tmp -> fsync -> rename).
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

import { PayloadStore } from './payload.ts';
import { resolveLogRef } from './refs.ts';

/** One decoded media block waiting to be stored. */
export interface MediaInput {
  buffer: Buffer;
  mimeType: string | null;
}

/** What the event row keeps: enough to build the URL and label the thumbnail. */
export interface MediaRef {
  sha256: string;
  mediaType: string;
  bytes: number;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  bin: 'application/octet-stream',
};

/** Every extension a stored file can have; lookup by sha tries them in turn. */
export const MEDIA_EXTS = Object.keys(TYPE_BY_EXT);

export function mediaExt(mimeType: string | null): string {
  return (mimeType === null ? undefined : EXT_BY_TYPE[mimeType.toLowerCase()]) ?? 'bin';
}

export function mediaContentType(ext: string): string {
  return TYPE_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Ref relative to the log root; `date` and `sha256` must already be validated. */
export function mediaRef(date: string, sha256: string, ext: string): string {
  return posix.join('payload', date, 'media', `${sha256}.${ext}`);
}

export function isMediaSha(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** `YYYY-MM-DD` that names a real calendar day. */
export function isMediaDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Stores decoded media by content hash; an existing file is not rewritten. */
export class MediaStore {
  readonly store: PayloadStore;

  constructor(store: PayloadStore) {
    this.store = store;
  }

  async put(date: string, buffer: Buffer, mimeType: string | null): Promise<MediaRef> {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const ext = mediaExt(mimeType);
    const ref = mediaRef(date, sha256, ext);
    if ((await this.store.size(ref)) !== buffer.length) await this.store.write(ref, buffer);
    return {
      sha256,
      mediaType: mimeType !== null && mimeType !== '' ? mimeType : mediaContentType(ext),
      bytes: buffer.length,
    };
  }
}

/** Reads one stored file; `null` for a bad key or a missing file. */
export async function readMedia(
  logRoot: string,
  date: string,
  sha256: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  if (!isMediaDate(date) || !isMediaSha(sha256)) return null;
  for (const ext of MEDIA_EXTS) {
    const target = resolveLogRef(logRoot, mediaRef(date, sha256, ext));
    if (target === null) continue;
    try {
      return { body: await readFile(target), contentType: mediaContentType(ext) };
    } catch {
      // Not stored under this extension.
    }
  }
  return null;
}
