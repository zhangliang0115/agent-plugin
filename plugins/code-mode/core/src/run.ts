/** Public entry point: runs a program for an owner and returns the model-facing envelope. @module */
import { CodeSandbox } from './sandbox.ts';
import { escapeText, renderEnvelope } from './output.ts';
import { DEFAULT_LIMITS, type CodeLimits, type ToolDescriptor, type ToolInvoker } from './types.ts';

export interface RunRequest {
  readonly code: string;
  readonly tools: readonly ToolDescriptor[];
  readonly invoke: ToolInvoker;
  readonly signal: AbortSignal;
  /** Deadline for this run. Capped at `maxTimeoutMs`. */
  readonly timeoutMs?: number;
  /**
   * Called with the full result text when the escaped text the model would receive exceeds
   * `resultChars`, so every truncated result has a path to its full text. A returned string is added
   * to the truncation marker (for example where the full text was saved). Undefined or a failure
   * keeps the plain marker.
   */
  readonly onResultOverflow?: (text: string) => Promise<string | undefined>;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
}

/** Runs Code Mode programs. One instance serves many owners; each owner keeps its own persistent context. */
export class CodeMode {
  readonly limits: CodeLimits;
  private readonly sandbox: CodeSandbox;

  constructor(overrides: Partial<CodeLimits> = {}) {
    const limits: CodeLimits = { ...DEFAULT_LIMITS, ...overrides };
    for (const [name, value] of Object.entries(limits)) assertPositive(name, value);
    if (limits.timeoutMs > limits.maxTimeoutMs) throw new RangeError('timeoutMs must not exceed maxTimeoutMs');
    this.limits = limits;
    this.sandbox = new CodeSandbox(limits);
  }

  /** Run `request.code` for `owner`. Resolves with the `<repl-output>` envelope; never rejects for program failures. */
  async run(owner: object, request: RunRequest): Promise<string> {
    const timeoutMs = Math.min(request.timeoutMs ?? this.limits.timeoutMs, this.limits.maxTimeoutMs);
    const outcome = await this.sandbox.evaluate(owner, request.code, {
      tools: request.tools,
      invoke: request.invoke,
      signal: request.signal,
      timeoutMs,
    });
    let overflow: string | undefined;
    // The limit applies to the escaped text, so the trigger must too: a result of 6000 `&` is
    // truncated to a third of its length even though its raw length is under the limit.
    if (outcome.value !== undefined
      && escapeText(outcome.value).length > this.limits.resultChars
      && request.onResultOverflow !== undefined) {
      try {
        overflow = await request.onResultOverflow(outcome.value);
      } catch {
        overflow = undefined;
      }
    }
    return renderEnvelope({
      evalIndex: outcome.evalIndex,
      log: outcome.log,
      result: outcome.value,
      error: outcome.error,
    }, this.limits, overflow === undefined ? {} : { result: overflow });
  }

  /** Drop an owner's context. The next run for that owner starts empty. */
  release(owner: object): void {
    this.sandbox.release(owner);
  }

  /** Release every owner context. */
  dispose(): void {
    this.sandbox.dispose();
  }
}
