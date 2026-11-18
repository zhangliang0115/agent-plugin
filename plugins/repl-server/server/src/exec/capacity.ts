/** Capacity quotas for execution sessions.
 *
 * Defaults are frozen from the design contract (03 §2.6). `evictIdleMs` is also
 * stated in `docs/protocol.md` §8. `REPL_CAPACITY_*` environment overrides
 * exist for tests only and are ignored when `NODE_ENV === "production"`.
 * @module
 */

import { LIMITS } from '@zhangliang0115/repl-server-core/src/constants.ts';

export interface CapacityLimits {
  /** Execution sessions across the whole process. */
  maxExecSessions: number;
  /** Execution sessions owned by one binding (unbound clients: one MCP session). */
  maxExecSessionsPerBinding: number;
  /** Workspace bindings inside one MCP session. */
  maxWorkspacesPerMcpSession: number;
  /** In-flight evals inside one execution session. */
  maxInFlightEvalsPerExecSession: number;
  /** In-flight evals across every execution session of one binding. */
  maxInFlightEvalsPerBinding: number;
  /** Minimum idle time (measured from `lastEvalAt`) before capacity eviction. */
  evictIdleMs: number;
}

export const CAPACITY_DEFAULTS: Readonly<CapacityLimits> = Object.freeze({
  maxExecSessions: 8,
  maxExecSessionsPerBinding: LIMITS.execSessionsPerBinding,
  maxWorkspacesPerMcpSession: 4,
  maxInFlightEvalsPerExecSession: LIMITS.inFlightPerExecSession,
  maxInFlightEvalsPerBinding: LIMITS.inFlightPerBinding,
  evictIdleMs: LIMITS.evictIdleMs,
});

export const CAPACITY_ENV: Readonly<Record<keyof CapacityLimits, string>> = {
  maxExecSessions: 'REPL_CAPACITY_MAX_EXEC_SESSIONS',
  maxExecSessionsPerBinding: 'REPL_CAPACITY_MAX_EXEC_SESSIONS_PER_BINDING',
  maxWorkspacesPerMcpSession: 'REPL_CAPACITY_MAX_WORKSPACES_PER_MCP_SESSION',
  maxInFlightEvalsPerExecSession: 'REPL_CAPACITY_MAX_IN_FLIGHT_EVALS_PER_EXEC_SESSION',
  maxInFlightEvalsPerBinding: 'REPL_CAPACITY_MAX_IN_FLIGHT_EVALS_PER_BINDING',
  evictIdleMs: 'REPL_CAPACITY_EVICT_IDLE_MS',
};

const LIMIT_NAMES = Object.keys(CAPACITY_DEFAULTS) as (keyof CapacityLimits)[];

function assertLimit(name: keyof CapacityLimits, value: number): void {
  const min = name === 'evictIdleMs' ? 0 : 1;
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${String(value)}`);
  }
}

/**
 * Merges explicit overrides over the frozen defaults.
 * Rejects non-integer or out-of-range values instead of silently clamping.
 */
export function resolveCapacityLimits(overrides: Partial<CapacityLimits> = {}): CapacityLimits {
  const limits: CapacityLimits = { ...CAPACITY_DEFAULTS, ...overrides };
  for (const name of LIMIT_NAMES) assertLimit(name, limits[name]);
  return limits;
}

/**
 * Reads `REPL_CAPACITY_*` overrides from `env`. Returns the defaults unchanged
 * in production, where the test hooks must not affect behaviour.
 */
export function capacityLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): CapacityLimits {
  if (env.NODE_ENV === 'production') return { ...CAPACITY_DEFAULTS };

  const overrides: Partial<CapacityLimits> = {};
  for (const name of LIMIT_NAMES) {
    const key = CAPACITY_ENV[name];
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') continue;
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      throw new RangeError(`${key} must be an integer, got ${JSON.stringify(raw)}`);
    }
    overrides[name] = value;
  }
  return resolveCapacityLimits(overrides);
}

/** `CAPACITY_EXCEEDED` for capacity quotas, `WS_LIMIT` for the workspace quota. */
export type CapacityCode = 'CAPACITY_EXCEEDED' | 'WS_LIMIT';

export type CapacityResource =
  | 'exec_sessions'
  | 'exec_sessions_per_binding'
  | 'workspaces_per_mcp_session'
  | 'in_flight_evals_per_exec_session'
  | 'in_flight_evals_per_binding';

export interface CapacityExceededOptions {
  resource: CapacityResource;
  current: number;
  limit: number;
  /** Human-readable scope: `global`, `binding:cb_...`, `mcp:mcp_...`, `es_...`. */
  scope: string;
  code?: CapacityCode;
  message?: string;
}

/**
 * Raised when a quota would be exceeded. Callers never queue on this error;
 * besides `code` the payload carries the `{resource, current, limit, scope}`
 * shape required by the protocol.
 */
export class CapacityExceededError extends Error {
  readonly code: CapacityCode;
  readonly resource: CapacityResource;
  readonly current: number;
  readonly limit: number;
  readonly scope: string;

  constructor(options: CapacityExceededOptions) {
    super(
      options.message ??
        `${options.resource} quota exceeded for ${options.scope} (${options.current}/${options.limit})`,
    );
    this.name = 'CapacityExceededError';
    this.code = options.code ?? 'CAPACITY_EXCEEDED';
    this.resource = options.resource;
    this.current = options.current;
    this.limit = options.limit;
    this.scope = options.scope;
  }
}
