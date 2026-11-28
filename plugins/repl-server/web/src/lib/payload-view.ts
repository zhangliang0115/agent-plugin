/**
 * Reading side of the payload layout (`09 §四`).
 *
 * A row never carries a body above 4 KiB: it carries `*Ref` (a path below the
 * log root), `*Preview` (2 KiB, newline-aligned), `*Bytes` and `*Sha256`.
 * These helpers turn that into the three things the UI needs — "is there an
 * inline value", "is there a blob to fetch", "what do I show before fetching"
 * — without the components knowing the field naming rules.
 */

/** Audit payload field triple for one direction of one call. */
export type PayloadField = 'args' | 'result' | 'params';

export interface PayloadKeys {
  value: PayloadField;
  bytes: string;
  preview: string;
  ref: string;
  tailRef: string;
  sha: string;
}

const TOOL_KEYS: Record<'args' | 'result', PayloadKeys> = {
  args: { value: 'args', bytes: 'argsBytes', preview: 'argsPreview', ref: 'argsRef', tailRef: 'argsTailRef', sha: 'argsSha256' },
  result: { value: 'result', bytes: 'outBytes', preview: 'resultPreview', ref: 'resultRef', tailRef: 'resultTailRef', sha: 'resultSha256' },
};

const FRAME_KEYS: Record<'params' | 'result', PayloadKeys> = {
  params: { value: 'params', bytes: 'paramsBytes', preview: 'paramsPreview', ref: 'paramsRef', tailRef: 'paramsTailRef', sha: 'paramsSha256' },
  result: { value: 'result', bytes: 'resultBytes', preview: 'resultPreview', ref: 'resultRef', tailRef: 'resultTailRef', sha: 'resultSha256' },
};

export interface PayloadView {
  /** Present when the body stayed inline (≤ 4 KiB). */
  inline: unknown;
  /** Ref to fetch, when the body was externalised. */
  ref: string | null;
  /** Ref to the tail half of a body over the 50 MiB cap. */
  tailRef: string | null;
  preview: string | null;
  bytes: number | null;
  sha256: string | null;
  /** `payloadDropped` reason: the row survived but the body did not. */
  dropped: string | null;
  /** True when only head/tail survived. */
  truncated: boolean;
}

const EMPTY: PayloadView = {
  inline: undefined,
  ref: null,
  tailRef: null,
  preview: null,
  bytes: null,
  sha256: null,
  dropped: null,
  truncated: false,
};

function textOf(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberOf(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Reads the payload triple for `field` off a row, frame or tool. */
export function payloadView(
  row: Record<string, unknown>,
  field: PayloadField,
  source: 'tool' | 'frame' = 'tool',
): PayloadView {
  const keys = source === 'frame' ? FRAME_KEYS[field as 'params' | 'result'] : TOOL_KEYS[field as 'args' | 'result'];
  if (keys === undefined) return EMPTY;
  const ref = textOf(row, keys.ref);
  const preview = textOf(row, keys.preview);
  const dropped = textOf(row, 'payloadDropped');
  if (ref === null && preview === null && row[keys.value] === undefined && dropped === null) return EMPTY;
  return {
    inline: ref === null ? row[keys.value] : undefined,
    ref,
    tailRef: textOf(row, keys.tailRef),
    preview,
    bytes: numberOf(row, keys.bytes),
    sha256: textOf(row, keys.sha),
    dropped,
    truncated: row['truncated'] === 'size' || textOf(row, keys.tailRef) !== null,
  };
}

export type PayloadMode = 'full' | 'head' | 'tail' | 'range';

export interface PayloadSlice {
  ref: string;
  mode: PayloadMode;
  total: number;
  start: number;
  end: number;
  truncated: boolean;
  body: string;
}

/** Query string for `GET /admin/api/logs/payload`; ref is the only required part. */
export function payloadUrl(
  ref: string,
  options: { mode?: PayloadMode; offset?: number; limit?: number } = {},
): string {
  const params = new URLSearchParams({ ref });
  if (options.mode !== undefined) params.set('mode', options.mode);
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  return `/admin/api/logs/payload?${params.toString()}`;
}

/** Bytes as the UI renders them: `512 B`, `4.2 KB`, `1.8 MB`. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? 'KB'}`;
}

export type ParsedRaw =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Parses a blob back into structured data. Every blob is written from a JSON
 * serialization, so a parse failure means the body was cut (head/tail mode) or
 * the file was tampered with — never that the original was not JSON.
 */
export function parseRaw(text: string): ParsedRaw {
  if (text.trim() === '') return { ok: false, error: '空内容' };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Fetches one slice of a blob from the admin API. */
export async function fetchPayloadSlice(
  ref: string,
  mode: 'full' | 'head' | 'tail',
): Promise<PayloadSlice> {
  const response = await fetch(payloadUrl(ref, { mode }), {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  return (await response.json()) as PayloadSlice;
}

/**
 * Saves a fetched slice as a local file. Bodies over the render cap are
 * download-only by design, so this is the "reader" for them.
 */
export function downloadSlice(slice: PayloadSlice): void {
  const name = slice.ref.split('/').pop() ?? 'payload.json';
  const url = URL.createObjectURL(new Blob([slice.body], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name.endsWith('.json') ? name : `${name}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * One-line status for a payload block: what the reader should expect before
 * clicking anything.
 */
export function payloadSummary(view: PayloadView): string {
  if (view.dropped !== null) {
    const reason =
      view.dropped === 'timeout'
        ? '写入超时'
        : view.dropped === 'io'
          ? '写盘失败'
          : view.dropped === 'serialize'
            ? '无法序列化'
            : '队列溢出';
    return `正文未保存（${reason}）`;
  }
  if (view.ref !== null) {
    return view.truncated ? `全文 ${formatBytes(view.bytes)}（仅存首尾各 1 MiB）` : `全文 ${formatBytes(view.bytes)}`;
  }
  if (view.preview !== null) return `预览 ${formatBytes(view.bytes)}`;
  if (view.inline !== undefined) return `内联 ${formatBytes(view.bytes)}`;
  return '无正文';
}

export interface MediaImage {
  src: string;
  mediaType: string;
  bytes: number;
}

export interface MediaDocument {
  href: string;
  bytes: number;
  /** Set for files that are not PDFs (rows carry any `mediaType`); a PDF leaves it out. */
  mediaType?: string;
}

/** Thumbnails and download links of one record, from either source. */
export interface MediaSet {
  images: MediaImage[];
  documents: MediaDocument[];
}

export interface ExtractedMedia {
  /** The body with base64 swapped for `{ mediaType, bytes }`; every other field is untouched. */
  rest: unknown;
  images: MediaImage[];
  documents: MediaDocument[];
}

const base64Bytes = (data: string): number => Math.floor((data.length * 3) / 4);

/**
 * Pulls the top-level `images` / `documents` out of a tool result (the shape
 * `mediaOf` in exec/gateway.ts reads) so the viewer can draw them instead of
 * dumping base64. Anything that does not match is left in place, so a body
 * without media comes back as the same object.
 */
export function extractMedia(value: unknown): ExtractedMedia {
  const none: ExtractedMedia = { rest: value, images: [], documents: [] };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return none;
  const record = value as Record<string, unknown>;
  const images: MediaImage[] = [];
  const documents: MediaDocument[] = [];
  const rest: Record<string, unknown> = { ...record };

  if (Array.isArray(record.images)) {
    rest.images = record.images.map((item) => {
      if (typeof item !== 'object' || item === null) return item;
      const { base64, mediaType, ...others } = item as Record<string, unknown>;
      if (typeof base64 !== 'string') return item;
      const type = typeof mediaType === 'string' && mediaType.startsWith('image/') ? mediaType : 'image/png';
      images.push({ src: `data:${type};base64,${base64}`, mediaType: type, bytes: base64Bytes(base64) });
      return { ...others, mediaType: type, bytes: base64Bytes(base64) };
    });
  }
  if (Array.isArray(record.documents)) {
    rest.documents = record.documents.map((item) => {
      if (typeof item !== 'object' || item === null) return item;
      const { base64, ...others } = item as Record<string, unknown>;
      if (typeof base64 !== 'string') return item;
      documents.push({ href: `data:application/pdf;base64,${base64}`, bytes: base64Bytes(base64) });
      return { ...others, mediaType: 'application/pdf', bytes: base64Bytes(base64) };
    });
  }
  if (images.length === 0 && documents.length === 0) return none;
  return { rest, images, documents };
}

/**
 * UTC day of an event `ts`. The server files media under `payloadDay`, which is
 * `ts.slice(0, 10)` of the same ISO string (audit/runtime.ts `utcDateOf`), so
 * the browser must not convert to local time.
 */
export function mediaDate(ts: unknown): string | null {
  return typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(ts) ? ts.slice(0, 10) : null;
}

/** URL of `GET /admin/api/logs/media` for one stored file. */
export function mediaUrl(sha256: string, date: string): string {
  return `/admin/api/logs/media?${new URLSearchParams({ sha: sha256, date }).toString()}`;
}

/**
 * Media listed on an event row (`media: [{ sha256, mediaType, bytes }]`),
 * pointed at the media endpoint. Empty for rows without the field, and for rows
 * whose `ts` gives no day; the caller then falls back to {@link extractMedia}.
 */
export function rowMedia(row: Record<string, unknown>): MediaSet {
  const out: MediaSet = { images: [], documents: [] };
  const date = mediaDate(row['ts']);
  if (date === null || !Array.isArray(row['media'])) return out;
  for (const item of row['media'] as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { sha256, mediaType, bytes } = item as Record<string, unknown>;
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) continue;
    const type = typeof mediaType === 'string' ? mediaType : 'application/octet-stream';
    const size = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
    const url = mediaUrl(sha256, date);
    if (type.startsWith('image/')) out.images.push({ src: url, mediaType: type, bytes: size });
    else out.documents.push({ href: url, bytes: size, ...(type === 'application/pdf' ? {} : { mediaType: type }) });
  }
  return out;
}

export const hasMedia = (media: MediaSet): boolean => media.images.length > 0 || media.documents.length > 0;
