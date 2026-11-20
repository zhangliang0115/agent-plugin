/** Structured log lines: local time, level, pid/thread and request context. */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  level?: LogLevel;
  /** Subsystem emitting the line: server | mcp | pool | exec | admin | ai | audit | alerts | reports | serve. */
  scope?: string;
  mcp?: string;
  client?: string;
  binding?: string | null;
  exec?: string;
  evalId?: number;
  runId?: string;
  taskId?: string;
  server?: string;
  tool?: string;
  method?: string;
  status?: number | string;
  durMs?: number;
  [key: string]: unknown;
}

export type LogFn = (message: string, fields?: LogFields) => void;

const FIELD_ORDER = [
  'scope',
  'mcp',
  'client',
  'binding',
  'exec',
  'evalId',
  'runId',
  'taskId',
  'server',
  'tool',
  'method',
  'status',
  'durMs',
] as const;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function formatValue(value: unknown): string {
  const text = value === null ? 'null' : String(value);
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

/** One line: `2026-11-20 13:05:06.007 WARN  pid=1 thread=0 scope=mcp … message`. */
export function formatLogLine(
  message: string,
  fields: LogFields = {},
  now: Date = new Date(),
  pid: number = process.pid,
  threadId: number = 0,
): string {
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  const level = (fields.level ?? 'info').toUpperCase().padEnd(5);
  const parts = [`pid=${pid}`, `thread=${threadId}`];
  for (const key of FIELD_ORDER) {
    const value = fields[key];
    if (value !== undefined) parts.push(`${key}=${formatValue(value)}`);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'level' || value === undefined) continue;
    if ((FIELD_ORDER as readonly string[]).includes(key)) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return `${time} ${level} ${parts.join(' ')} ${message}`;
}

/** Wraps a line sink (stderr) into a LogFn that stamps every line. */
export function createLog(
  write: (line: string) => void,
  context: { pid?: number; threadId?: number; now?: () => Date } = {},
): LogFn {
  const pid = context.pid ?? process.pid;
  const threadId = context.threadId ?? 0;
  const now = context.now ?? ((): Date => new Date());
  return (message, fields = {}) => write(formatLogLine(message, fields, now(), pid, threadId));
}
