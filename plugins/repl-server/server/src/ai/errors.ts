/** Typed errors raised by the AI runner and the AI service. @module */

/** Codes produced by the runner/limiter; mapped to admin errors by the service. */
export type AiRunnerErrorCode =
  | 'AI_BUSY'
  | 'AI_TIMEOUT'
  | 'AI_RUN_FAILED'
  | 'AI_BAD_ENVELOPE'
  | 'AI_INVALID_JSON'
  | 'AI_OUTPUT_TOO_LARGE'
  | 'AI_RUNNER_UNAVAILABLE';

/**
 * A single AI run failed. The error carries its own HTTP status so the admin layer
 * can map it without knowing runner internals. `message` and `details` never contain
 * the prompt or the unredacted AI output.
 */
export class AiRunnerError extends Error {
  readonly code: AiRunnerErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: AiRunnerErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AiRunnerError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isAiRunnerError(value: unknown): value is AiRunnerError {
  return value instanceof AiRunnerError;
}
