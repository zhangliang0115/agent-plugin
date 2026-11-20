/**
 * L5 output normalization: media limits only.
 *
 * Script results and logs are returned as produced; there is no character,
 * line or token cap. Media is still bounded because images and PDFs travel as
 * base64 blocks appended after the XML envelope, and every block has to fit in
 * one transport response.
 *
 * The result is a plain structure; rendering XML is `renderEnvelope`'s job.
 *
 * @module
 */
import { LIMITS } from '../constants.ts';
import type { TruncationFlags } from '../types.ts';

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

/** Limits for one normalization pass. Mirrors the media entries in `LIMITS`. */
export interface OutputLimits {
  /** Block cap for images. */
  readonly images: number;
  /** Block cap for documents (PDFs). */
  readonly documents: number;
  /** Byte cap for one image or document block. */
  readonly mediaBytes: number;
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
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
  /** Reserved for callers that still read it; text output is never truncated. */
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

/** Normalizes one eval's output under the media limits. */
export function normalizeOutput(
  input: OutputInput,
  overrides: Partial<OutputLimits> = {},
): NormalizedOutput {
  const limits: OutputLimits = { ...DEFAULT_OUTPUT_LIMITS, ...overrides };

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
    result: resultText(input.result),
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    images: imageCut.kept,
    documents: documentCut.kept,
    imagesOmitted: imageCut.omitted,
    documentsOmitted: documentCut.omitted,
    truncated: {},
  };
}
