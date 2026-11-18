/** UTC-daily JSONL audit writer with a bounded queue and retention. @module */
import {
  createWriteStream,
  fchmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';

import { redactDeep } from './redact.ts';

export const AUDIT_SCHEMA_VERSION = 1;
export const AUDIT_FILE_PATTERN = /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/;
export const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RETENTION_DAYS = 14;
export const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/**
 * Read-only identity filled in by the server's transport/auth layer.
 * The writer never parses tokens or HTTP headers itself.
 */
export interface AuditIdentity {
  identity: 'bound' | 'unbound';
  binding: string | null;
  client: string;
  mcp: string;
  exec?: string;
}

export interface AuditWriterOptions {
  /** Directory that holds `audit-YYYY-MM-DD.jsonl`. Created when missing. */
  dir: string;
  /** Default identity; a per-event identity overrides it. */
  identity?: AuditIdentity;
  /** Injectable clock in epoch milliseconds. */
  now?: () => number;
  /** Detail events are dropped once the write backlog exceeds this. */
  maxQueueBytes?: number;
  /** Daily files older than this are pruned. */
  retentionDays?: number;
  /** Total size of retained daily files. */
  maxTotalBytes?: number;
  /** Applies `redactDeep` to event fields. Defaults to true. */
  redact?: boolean;
}

export interface AuditEvent extends Record<string, unknown> {
  event: string;
}

/** Fine-grained events whose loss is acceptable under write pressure. */
const DETAIL_EVENTS = new Set(['tool_call', 'tool_result', 'tool_denied']);

const DAY_MS = 86_400_000;

/** `audit-2026-11-18.jsonl` for the given UTC date. */
export function auditFileName(date: string): string {
  return `audit-${date}.jsonl`;
}

/**
 * Appends one event per line, switching files at UTC midnight. Writes are
 * buffered and never awaited; when the backlog passes `maxQueueBytes`,
 * detail events are dropped while control events are kept. A dropped
 * window is reported once with a single `audit_dropped` event.
 */
export class AuditWriter {
  private readonly dir: string;
  private readonly identity: AuditIdentity | undefined;
  private readonly now: () => number;
  private readonly maxQueueBytes: number;
  private readonly retentionDays: number;
  private readonly maxTotalBytes: number;
  private readonly redact: boolean;

  private stream: WriteStream | undefined;
  private streamDate: string | undefined;
  private closed = false;
  private healthyState = true;
  private lastError: Error | undefined;

  private droppedCount = 0;
  private droppedWindowStart = 0;
  private droppedWindowEnd = 0;

  private readonly retired: Promise<void>[] = [];

  constructor(options: AuditWriterOptions) {
    this.dir = options.dir;
    this.identity = options.identity;
    this.now = options.now ?? Date.now;
    this.maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.redact = options.redact ?? true;

    if (!Number.isFinite(this.maxQueueBytes) || this.maxQueueBytes <= 0) {
      throw new RangeError('maxQueueBytes must be a positive number');
    }
    if (!Number.isFinite(this.retentionDays) || this.retentionDays < 0) {
      throw new RangeError('retentionDays must be zero or a positive number');
    }
    if (!Number.isFinite(this.maxTotalBytes) || this.maxTotalBytes <= 0) {
      throw new RangeError('maxTotalBytes must be a positive number');
    }

    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Writes one event, merging the identity fields in front of `fields`. */
  write(event: string, fields: Record<string, unknown> = {}, identity?: AuditIdentity): void {
    if (this.closed) return;

    const at = this.now();
    const detail = DETAIL_EVENTS.has(event);
    if (detail && this.stream !== undefined && this.backlog() > this.maxQueueBytes) {
      this.recordDrop(at);
      return;
    }

    this.ensureStream(utcDate(at));
    this.emit(event, fields, identity ?? this.identity, at);
    this.maybeEmitDropped(false);
  }

  /** Convenience for callers that already carry an `event` key. */
  writeEvent(event: AuditEvent, identity?: AuditIdentity): void {
    const { event: name, ...fields } = event;
    this.write(name, fields, identity);
  }

  /** Waits until every chunk handed to a stream has been flushed. */
  async flush(): Promise<void> {
    const stream = this.stream;
    if (stream !== undefined) {
      this.maybeEmitDropped(true);
      if (!stream.destroyed) {
        await new Promise<void>((resolve) => {
          stream.write(Buffer.alloc(0), () => resolve());
        });
      }
    }
    await Promise.all(this.retired.slice());
  }

  /** Flushes, ends the current stream and waits for every retired stream. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.maybeEmitDropped(true);
    this.closed = true;

    const stream = this.stream;
    this.stream = undefined;
    this.streamDate = undefined;
    if (stream !== undefined) this.retire(stream);
    await Promise.all(this.retired.slice());
  }

  /** Applies the 14-day / 200MB (by default) retention policy. */
  async prune(at = this.now()): Promise<string[]> {
    const currentName = this.streamDate === undefined ? undefined : auditFileName(this.streamDate);
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }

    const cutoff = utcDate(at - this.retentionDays * DAY_MS);
    const removed: string[] = [];
    const kept: Array<{ name: string; date: string; size: number }> = [];

    for (const name of names) {
      if (!AUDIT_FILE_PATTERN.test(name)) continue;
      const date = name.slice('audit-'.length, 'audit-'.length + 10);
      const path = join(this.dir, name);
      if (date < cutoff && name !== currentName) {
        if (removeFile(path)) removed.push(name);
        continue;
      }
      try {
        kept.push({ name, date, size: statSync(path).size });
      } catch {
        // The file vanished between readdir and stat.
      }
    }

    kept.sort((a, b) => a.date.localeCompare(b.date));
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    for (const file of kept) {
      if (total <= this.maxTotalBytes) break;
      if (file.name === currentName) continue;
      if (removeFile(join(this.dir, file.name))) {
        removed.push(file.name);
        total -= file.size;
      }
    }
    return removed;
  }

  get currentFile(): string | undefined {
    return this.streamDate === undefined ? undefined : join(this.dir, auditFileName(this.streamDate));
  }

  get queueBytes(): number {
    return this.backlog();
  }

  get droppedEvents(): number {
    return this.droppedCount;
  }

  get healthy(): boolean {
    return this.healthyState;
  }

  get error(): Error | undefined {
    return this.lastError;
  }

  private backlog(): number {
    return this.stream?.writableLength ?? 0;
  }

  private ensureStream(date: string): void {
    if (this.stream !== undefined && this.streamDate === date) return;

    this.maybeEmitDropped(true);
    if (this.stream !== undefined) {
      this.retire(this.stream);
      this.stream = undefined;
      this.streamDate = undefined;
    }

    this.streamDate = date;
    const stream = createWriteStream(join(this.dir, auditFileName(date)), { flags: 'a', mode: 0o600 });
    stream.on('open', (fd) => {
      try {
        fchmodSync(fd, 0o600);
      } catch {
        // Best effort: mode already applies when the file is created.
      }
    });
    stream.on('error', (error: Error) => {
      this.healthyState = false;
      this.lastError = error;
    });
    stream.on('drain', () => this.maybeEmitDropped(false));
    this.stream = stream;

    void this.prune();
  }

  private emit(event: string, fields: Record<string, unknown>, identity: AuditIdentity | undefined, at: number): void {
    if (this.stream === undefined) return;
    const record = this.buildRecord(new Date(at).toISOString(), event, fields, identity);

    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      this.healthyState = false;
      this.lastError = error instanceof Error ? error : new Error(String(error));
      return;
    }
    this.stream.write(Buffer.from(line, 'utf8'));
  }

  private buildRecord(
    ts: string,
    event: string,
    fields: Record<string, unknown>,
    identity: AuditIdentity | undefined,
  ): Record<string, unknown> {
    const record: Record<string, unknown> = { v: AUDIT_SCHEMA_VERSION, ts, event };
    if (identity !== undefined) {
      record.identity = identity.identity;
      record.binding = identity.binding;
      record.client = identity.client;
      record.mcp = identity.mcp;
      if (identity.exec !== undefined) record.exec = identity.exec;
    }

    const safeFields = this.redact ? (redactDeep(fields) as Record<string, unknown>) : fields;
    for (const [key, value] of Object.entries(safeFields)) {
      if (key === 'v' || key === 'ts' || key === 'event') continue;
      record[key] = value;
    }
    return record;
  }

  private recordDrop(at: number): void {
    if (this.droppedCount === 0) this.droppedWindowStart = at;
    this.droppedCount += 1;
    this.droppedWindowEnd = at;
  }

  private maybeEmitDropped(force: boolean): void {
    if (this.droppedCount === 0 || this.stream === undefined) return;
    if (!force && this.backlog() > this.maxQueueBytes) return;

    const count = this.droppedCount;
    const windowMs = Math.max(0, this.droppedWindowEnd - this.droppedWindowStart);
    this.droppedCount = 0;
    this.emit('audit_dropped', { count, windowMs }, this.identity, this.now());
  }

  private retire(stream: WriteStream): void {
    const done = new Promise<void>((resolve) => {
      if (stream.destroyed) {
        resolve();
        return;
      }
      stream.once('close', () => resolve());
      stream.end();
    });
    this.retired.push(done);
    void done.then(() => {
      const index = this.retired.indexOf(done);
      if (index >= 0) this.retired.splice(index, 1);
    });
  }
}

function utcDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function removeFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
