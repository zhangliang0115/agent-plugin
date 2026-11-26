/** Typed errors shared by the executor, tool bridge and MCP layer. @module */

export class ReplError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** Whether the failure says the transport is unhealthy, not the call. */
  readonly transport?: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number; transport?: boolean } = {},
  ) {
    super(message);
    this.name = 'ReplError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.transport = options.transport;
  }
}

export class McpToolError extends ReplError {
  readonly server?: string;
  readonly tool?: string;
  readonly detail?: unknown;

  constructor(
    message: string,
    options: {
      code?: string;
      server?: string;
      tool?: string;
      detail?: unknown;
      retryable?: boolean;
      retryAfterMs?: number;
      transport?: boolean;
    } = {},
  ) {
    super(options.code ?? 'MCP_TOOL_ERROR', message, options);
    this.name = 'McpToolError';
    this.server = options.server;
    this.tool = options.tool;
    this.detail = options.detail;
  }
}

export class WorkerKilledError extends ReplError {
  constructor(message = 'worker was terminated') {
    super('WORKER_KILLED', message);
    this.name = 'WorkerKilledError';
  }
}

export class StaleEvalError extends ReplError {
  constructor() {
    super('STALE_EVAL', 'the eval has already finished');
    this.name = 'StaleEvalError';
  }
}

export class EvalTimeoutError extends ReplError {
  readonly layer: string;

  constructor(layer: string) {
    super('EVAL_TIMEOUT', `eval stopped at layer ${layer}`);
    this.name = 'EvalTimeoutError';
    this.layer = layer;
  }
}

/** The eval deadline leaves no room for a Bash call, even at the minimum timeout. */
export class NoTimeLeftError extends ReplError {
  constructor(message = 'not enough time left before the eval deadline') {
    super('NO_TIME_LEFT', message);
    this.name = 'NoTimeLeftError';
  }
}

/**
 * An abort caused by an `MCP_CALL_TIMEOUT` reason is the pool's own deadline;
 * every other reason is the caller cancelling the call, which says nothing
 * about the transport's health.
 */
export function isTransportTimeout(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { code?: unknown }).code === 'MCP_CALL_TIMEOUT'
  );
}
