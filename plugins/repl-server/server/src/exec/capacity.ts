/** Capacity quotas for execution sessions.
 *
 * Defaults are frozen from the design contract (03 §2.6). `evictIdleMs` is also
 * stated in `docs/protocol.md` §8. The same values are configurable through
 * `PATCH /settings` (`settings.capacity`) and, for tests, through
 * `REPL_CAPACITY_*` environment variables that take precedence over stored
 * settings and are ignored when `NODE_ENV === "production"`.
 *
 * Every limit is expressed here so gateway, pool gates and the serve runtime
 * read one merged snapshot: defaults ← stored settings ← environment.
 * @module
 */

import { LIMITS } from '@zhangliang0115/repl-server-core/src/constants.ts';

export interface CapacityLimits {
  /** Execution sessions across the whole process. Capped by `maxWorkers`. */
  maxExecSessions: number;
  /** Execution sessions owned by one binding (unbound clients: one transport id). */
  maxExecSessionsPerBinding: number;
  /** Serve groups across the process; one group is a keeper plus `claude mcp serve`. */
  maxServeProcesses: number;
  /** Worker processes across the process; one per execution session. */
  maxWorkers: number;
  /** In-flight evals inside one execution session. */
  maxInFlightEvalsPerExecSession: number;
  /** In-flight evals across every execution session of one binding. */
  maxInFlightEvalsPerBinding: number;
  /** In-flight pooled MCP calls per binding x server. */
  maxInFlightCallsPerBindingPerServer: number;
  /** Queued pooled MCP calls per binding x server before `MCP_QUEUE_FULL`. */
  maxQueuedCallsPerBindingPerServer: number;
  /** Minimum idle time (measured from `lastEvalAt`) before capacity eviction. */
  evictIdleMs: number;
}

export const CAPACITY_DEFAULTS: Readonly<CapacityLimits> = Object.freeze({
  maxExecSessions: 64,
  maxExecSessionsPerBinding: LIMITS.execSessionsPerBinding,
  maxServeProcesses: 64,
  maxWorkers: 64,
  maxInFlightEvalsPerExecSession: LIMITS.inFlightPerExecSession,
  maxInFlightEvalsPerBinding: LIMITS.inFlightPerBinding,
  maxInFlightCallsPerBindingPerServer: LIMITS.callsPerBindingPerServer,
  maxQueuedCallsPerBindingPerServer: LIMITS.queuedPerBindingPerServer,
  evictIdleMs: LIMITS.evictIdleMs,
});

export const CAPACITY_ENV: Readonly<Record<keyof CapacityLimits, string>> = {
  maxExecSessions: 'REPL_CAPACITY_MAX_EXEC_SESSIONS',
  maxExecSessionsPerBinding: 'REPL_CAPACITY_MAX_EXEC_SESSIONS_PER_BINDING',
  maxServeProcesses: 'REPL_CAPACITY_MAX_SERVE_PROCESSES',
  maxWorkers: 'REPL_CAPACITY_MAX_WORKERS',
  maxInFlightEvalsPerExecSession: 'REPL_CAPACITY_MAX_IN_FLIGHT_EVALS_PER_EXEC_SESSION',
  maxInFlightEvalsPerBinding: 'REPL_CAPACITY_MAX_IN_FLIGHT_EVALS_PER_BINDING',
  maxInFlightCallsPerBindingPerServer:
    'REPL_CAPACITY_MAX_IN_FLIGHT_CALLS_PER_BINDING_PER_SERVER',
  maxQueuedCallsPerBindingPerServer: 'REPL_CAPACITY_MAX_QUEUED_CALLS_PER_BINDING_PER_SERVER',
  evictIdleMs: 'REPL_CAPACITY_EVICT_IDLE_MS',
};

const LIMIT_NAMES = Object.keys(CAPACITY_DEFAULTS) as (keyof CapacityLimits)[];

function minimumOf(name: keyof CapacityLimits): number {
  return name === 'evictIdleMs' ? 0 : 1;
}

function assertLimit(name: keyof CapacityLimits, value: number): void {
  const min = minimumOf(name);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Known capacity values from a stored settings snapshot. `settings.capacity` is
 * preferred and a bare capacity object is accepted too. Invalid entries are
 * skipped: `normalizeSettings` already drops them on read, and one corrupt row
 * must not make startup fail.
 */
export function capacityOverridesFromSettings(settings: unknown): Partial<CapacityLimits> {
  const capacity =
    isRecord(settings) && isRecord(settings['capacity']) ? settings['capacity'] : settings;
  if (!isRecord(capacity)) return {};

  const overrides: Partial<CapacityLimits> = {};
  for (const name of LIMIT_NAMES) {
    const value = capacity[name];
    if (typeof value !== 'number' || !Number.isInteger(value)) continue;
    if (value < minimumOf(name)) continue;
    overrides[name] = value;
  }
  return overrides;
}

/** Parses `REPL_CAPACITY_*` variables; malformed values are rejected, not clamped. */
function capacityOverridesFromEnv(
  env: Record<string, string | undefined>,
): Partial<CapacityLimits> {
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
  return overrides;
}

/**
 * One worker per execution session, so the effective execution-session cap is
 * the smaller of `maxExecSessions` and `maxWorkers`. Both values stay visible
 * in their raw form; only `maxExecSessions` is narrowed here.
 */
function allocateWorkers(limits: CapacityLimits): CapacityLimits {
  return { ...limits, maxExecSessions: Math.min(limits.maxExecSessions, limits.maxWorkers) };
}

/**
 * Effective limits used at startup and for every committed settings snapshot.
 *
 * Precedence: defaults ← stored settings ← environment. Environment overrides
 * exist for tests and are ignored when `NODE_ENV === "production"`.
 */
export function resolveCapacityLimitsFromSettings(
  settings: unknown,
  env: Record<string, string | undefined> = process.env,
): CapacityLimits {
  const stored = resolveCapacityLimits(capacityOverridesFromSettings(settings));
  if (env.NODE_ENV === 'production') return allocateWorkers(stored);
  const overrides = { ...stored, ...capacityOverridesFromEnv(env) };
  return allocateWorkers(resolveCapacityLimits(overrides));
}

/**
 * Reads `REPL_CAPACITY_*` overrides from `env`, ignoring stored settings.
 * Returns the defaults unchanged in production, where the test hooks must not
 * affect behaviour.
 */
export function capacityLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): CapacityLimits {
  return resolveCapacityLimitsFromSettings({}, env);
}

/** `CAPACITY_EXCEEDED` for capacity quotas; `WS_LIMIT` belongs to workspace resolution. */
export type CapacityCode = 'CAPACITY_EXCEEDED' | 'WS_LIMIT';

export type CapacityResource =
  | 'exec_sessions'
  | 'exec_sessions_per_binding'
  | 'in_flight_evals_per_exec_session'
  | 'in_flight_evals_per_binding'
  | 'serve_processes';

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
