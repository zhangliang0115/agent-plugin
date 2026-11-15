/** Host-neutral types shared by the Code Mode runtime and its adapters. @module */

/** A tool as the program sees it: a name, a description, its JSON Schema input, and optionally its JSON Schema output. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  /** JSON Schema of the value the tool resolves to. Absent when the host does not declare one. */
  readonly outputSchema?: unknown;
}

/** What an invoker may ask of the run that started its tool call. */
export interface CallControl {
  /**
   * Pause the run deadline until the returned function is called. Use it while the call waits for a
   * person (an approval or a question): that time does not count toward the deadline. Holds nest; the
   * deadline pauses while at least one is active and resumes with the held time added back. The
   * release function is safe to call more than once. Only waiting is paused: guest code that runs
   * during a hold still counts toward the deadline. An abort ends a run that is waiting on a hold at once.
   */
  holdDeadline(): () => void;
}

/**
 * An error from a tool call that carries the host's error identity. The program sees `e.code` and
 * `e.errorName` next to the unchanged `e.message`; `e.name` stays `"Error"`.
 */
export class ToolCallError extends Error {
  readonly code?: string;
  /** The host's error class name, exposed to the program as `errorName`. */
  readonly errorName?: string;
  constructor(message: string, info: { readonly code?: string; readonly name?: string } = {}) {
    super(message);
    if (info.code !== undefined) this.code = info.code;
    if (info.name !== undefined) this.errorName = info.name;
  }
}
/** Runs one tool call made from program code. Rejections become catchable errors in the program. */
export type ToolInvoker = (name: string, args: unknown, signal: AbortSignal, control: CallControl) => Promise<unknown>;

/** Resource limits. Every value is positive. Defaults are in {@link DEFAULT_LIMITS}. */
export interface CodeLimits {
  /** Run deadline when the caller does not pass one. */
  readonly timeoutMs: number;
  /** Largest deadline a caller may request. */
  readonly maxTimeoutMs: number;
  /** Heap limit for one owner's QuickJS runtime. */
  readonly memoryBytes: number;
  /** Tool calls one run may start. Calls past the limit reject inside the program. */
  readonly maxSubCallsPerRun: number;
  /** Tool calls one run may have in flight at once. */
  readonly maxParallelSubCalls: number;
  /** Characters kept in `<result>`. */
  readonly resultChars: number;
  /** Characters kept in `<log>`. */
  readonly logChars: number;
  /** Characters kept in `<error>`. */
  readonly errorChars: number;
  /** Console entries kept per owner for `console.tail`. */
  readonly consoleRingSize: number;
  /** Time a run waits after an abort or deadline for in-flight tool calls to settle. */
  readonly drainGraceMs: number;
}

export const DEFAULT_LIMITS: CodeLimits = {
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  memoryBytes: 64 * 1024 * 1024,
  maxSubCallsPerRun: 256,
  maxParallelSubCalls: 10,
  resultChars: 10_000,
  logChars: 10_000,
  errorChars: 2_000,
  consoleRingSize: 200,
  drainGraceMs: 2_000,
};
