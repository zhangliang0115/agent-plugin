/**
 * `console` facade injected into the vm context.
 *
 * Every call is formatted into one line and handed to `write`, which the
 * worker entry turns into a `log` message plus the per-eval stdout/stderr
 * buffers. Formatting failures fall back to `String(...)` so a hostile
 * object cannot break logging.
 *
 * @module
 */
import { format, inspect } from 'node:util';

export type ConsoleStream = 'stdout' | 'stderr';

/** Receives one already-terminated line, including its trailing newline. */
export type ConsoleWrite = (stream: ConsoleStream, text: string) => void;

export interface SandboxConsole {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  dir(value: unknown): void;
  table(value: unknown): void;
  assert(condition: unknown, ...args: unknown[]): void;
  group(...args: unknown[]): void;
  groupEnd(): void;
  time(label?: unknown): void;
  timeEnd(label?: unknown): void;
}

function safeFormat(args: unknown[]): string {
  try {
    return format(...args);
  } catch {
    return args.map((arg) => String(arg)).join(' ');
  }
}

function safeInspect(value: unknown): string {
  try {
    return inspect(value);
  } catch {
    return String(value);
  }
}

export function createSandboxConsole(write: ConsoleWrite): SandboxConsole {
  const timers = new Map<string, number>();
  const line = (stream: ConsoleStream, text: string): void => {
    write(stream, `${text}\n`);
  };

  return {
    log: (...args) => line('stdout', safeFormat(args)),
    info: (...args) => line('stdout', safeFormat(args)),
    debug: (...args) => line('stdout', safeFormat(args)),
    warn: (...args) => line('stderr', safeFormat(args)),
    error: (...args) => line('stderr', safeFormat(args)),
    trace: (...args) => line('stderr', `Trace: ${safeFormat(args)}`),
    dir: (value) => line('stdout', safeInspect(value)),
    table: (value) => line('stdout', safeInspect(value)),
    assert: (condition, ...args) => {
      if (condition) return;
      line('stderr', args.length === 0 ? 'Assertion failed' : `Assertion failed: ${safeFormat(args)}`);
    },
    group: () => {},
    groupEnd: () => {},
    time: (label) => {
      timers.set(String(label ?? 'default'), Date.now());
    },
    timeEnd: (label) => {
      const key = String(label ?? 'default');
      const startedAt = timers.get(key);
      timers.delete(key);
      line('stdout', `${key}: ${startedAt === undefined ? 0 : Date.now() - startedAt}ms`);
    },
  };
}
