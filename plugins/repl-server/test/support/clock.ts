/**
 * Test clocks behind the `REPL_TEST_CLOCK` hook.
 *
 * `docs/protocol.md` §8 reserves `REPL_TEST_CLOCK` for task TTL and idle
 * reclamation tests. Two forms are provided:
 *
 * - `FakeClock` — in-process virtual time for unit tests that accept a clock.
 * - `FileClock` — cross-process time for contract tests that spawn a daemon.
 *   The env value is the absolute path of a JSON file `{ "nowMs": <epoch ms> }`.
 *   The server-side hook (implemented by the executor/server tasks) reads
 *   `nowMs` from that file on each clock read while `NODE_ENV !== "production"`;
 *   a missing or invalid file falls back to system time.
 *
 * `sleep` is the real-time counterpart used for polling loops in tests.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';

/** Environment variable that selects the controllable clock. */
export const TEST_CLOCK_ENV = 'REPL_TEST_CLOCK';

export type TimeInput = number | string | Date;

/** Converts a numeric epoch, ISO string, or Date to epoch milliseconds. */
export function toEpochMs(value: TimeInput): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isFinite(ms)) {
    throw new RangeError(`invalid time value: ${String(value)}`);
  }
  return Math.trunc(ms);
}

/** Real-time sleep. Prefer this over `setTimeout` in async test helpers. */
export async function sleep(ms: number, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`sleep duration must be a non-negative number, got ${ms}`);
  }
  if (ms === 0) {
    return;
  }
  await delay(ms, undefined, { signal: options.signal });
}

interface Sleeper {
  at: number;
  resolve(): void;
}

/**
 * Virtual clock. `sleep` resolves only when `advance`/`set` moves time past the
 * deadline, so tests never wait on wall-clock TTLs.
 */
export class FakeClock {
  #nowMs: number;
  #sleepers: Sleeper[] = [];

  constructor(start: TimeInput = 0) {
    this.#nowMs = toEpochMs(start);
  }

  now(): number {
    return this.#nowMs;
  }

  nowIso(): string {
    return new Date(this.#nowMs).toISOString();
  }

  set(value: TimeInput): void {
    this.#nowMs = toEpochMs(value);
    this.#wake();
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`advance must be a non-negative number, got ${ms}`);
    }
    this.#nowMs += Math.trunc(ms);
    this.#wake();
  }

  pendingSleeps(): number {
    return this.#sleepers.length;
  }

  sleep(ms: number, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      return Promise.reject(new RangeError(`sleep duration must be a non-negative number, got ${ms}`));
    }
    const delayMs = Math.trunc(ms);
    if (delayMs === 0) {
      return Promise.resolve();
    }
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    }
    return new Promise<void>((resolve, reject) => {
      const sleeper: Sleeper = {
        at: this.#nowMs + delayMs,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = (): void => {
        this.#sleepers = this.#sleepers.filter((entry) => entry !== sleeper);
        reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#sleepers.push(sleeper);
    });
  }

  #wake(): void {
    if (this.#sleepers.length === 0) {
      return;
    }
    const due = this.#sleepers.filter((entry) => entry.at <= this.#nowMs);
    if (due.length === 0) {
      return;
    }
    this.#sleepers = this.#sleepers.filter((entry) => entry.at > this.#nowMs);
    for (const entry of due) {
      entry.resolve();
    }
  }
}

export interface FileClockOptions {
  /** Directory for `clock.json`; a private temp directory is created when omitted. */
  dir?: string;
  /** Initial time; defaults to `Date.now()` so the daemon starts in the present. */
  start?: TimeInput;
  /** When provided, `dispose` is registered as a test `after` hook. */
  t?: TestContext;
}

export interface FileClock {
  /** Absolute path handed to the child process via `REPL_TEST_CLOCK`. */
  readonly path: string;
  /** Environment fragment to merge into a spawned process. */
  readonly env: Readonly<Record<string, string>>;
  read(): Promise<number>;
  set(epochMs: number): Promise<void>;
  advance(ms: number): Promise<void>;
  dispose(): Promise<void>;
}

/** Creates a file-backed clock readable by a spawned daemon. */
export async function createFileClock(options: FileClockOptions = {}): Promise<FileClock> {
  const ownedDir = options.dir === undefined;
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'repl-server-clock-')));
  if (!ownedDir) {
    await mkdir(dir, { recursive: true });
  }
  const path = join(dir, 'clock.json');
  let disposal: Promise<void> | null = null;

  const write = async (nowMs: number): Promise<void> => {
    const staging = join(dir, `.clock-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(staging, `${JSON.stringify({ nowMs })}\n`, { mode: 0o600 });
    await rename(staging, path);
  };

  const read = async (): Promise<number> => {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('nowMs' in parsed)) {
      throw new Error(`clock file ${path} has no nowMs field`);
    }
    const value = (parsed as { nowMs: unknown }).nowMs;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`clock file ${path} has a non-numeric nowMs`);
    }
    return Math.trunc(value);
  };

  await write(toEpochMs(options.start ?? Date.now()));

  const clock: FileClock = {
    path,
    env: Object.freeze({ [TEST_CLOCK_ENV]: path }),
    read,
    async set(epochMs: number): Promise<void> {
      await write(toEpochMs(epochMs));
    },
    async advance(ms: number): Promise<void> {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`advance must be a non-negative number, got ${ms}`);
      }
      await write((await read()) + Math.trunc(ms));
    },
    dispose(): Promise<void> {
      disposal ??= (async () => {
        if (ownedDir) {
          await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        } else {
          await rm(path, { force: true });
        }
      })();
      return disposal;
    },
  };
  options.t?.after(() => clock.dispose());
  return clock;
}
