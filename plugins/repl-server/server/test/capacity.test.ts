import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPACITY_DEFAULTS,
  CapacityExceededError,
  capacityLimitsFromEnv,
  resolveCapacityLimits,
} from '../src/exec/capacity.ts';

test('frozen defaults match design 03 §2.6 and protocol §8', () => {
  assert.deepEqual(CAPACITY_DEFAULTS, {
    maxExecSessions: 8,
    maxExecSessionsPerBinding: 4,
    maxWorkspacesPerMcpSession: 4,
    maxInFlightEvalsPerExecSession: 8,
    maxInFlightEvalsPerBinding: 16,
    evictIdleMs: 300_000,
  });
  assert.ok(Object.isFrozen(CAPACITY_DEFAULTS));
});

test('resolveCapacityLimits merges overrides without mutating defaults', () => {
  const limits = resolveCapacityLimits({ maxExecSessions: 2, evictIdleMs: 0 });
  assert.equal(limits.maxExecSessions, 2);
  assert.equal(limits.evictIdleMs, 0);
  assert.equal(limits.maxExecSessionsPerBinding, 4);
  assert.equal(limits.maxInFlightEvalsPerBinding, 16);
  assert.equal(CAPACITY_DEFAULTS.maxExecSessions, 8);
  assert.equal(CAPACITY_DEFAULTS.evictIdleMs, 300_000);

  assert.deepEqual(resolveCapacityLimits(), { ...CAPACITY_DEFAULTS });
});

test('resolveCapacityLimits rejects non-integer and out-of-range values', () => {
  assert.throws(() => resolveCapacityLimits({ maxExecSessions: 0 }), RangeError);
  assert.throws(() => resolveCapacityLimits({ maxExecSessions: -1 }), RangeError);
  assert.throws(() => resolveCapacityLimits({ maxExecSessions: 1.5 }), RangeError);
  assert.throws(() => resolveCapacityLimits({ maxExecSessions: Number.NaN }), RangeError);
  assert.throws(() => resolveCapacityLimits({ evictIdleMs: -1 }), RangeError);
});

test('capacityLimitsFromEnv applies REPL_CAPACITY_* outside production', () => {
  const overridden = capacityLimitsFromEnv({
    REPL_CAPACITY_MAX_EXEC_SESSIONS: '2',
    REPL_CAPACITY_MAX_EXEC_SESSIONS_PER_BINDING: '1',
    REPL_CAPACITY_MAX_WORKSPACES_PER_MCP_SESSION: '1',
    REPL_CAPACITY_MAX_IN_FLIGHT_EVALS_PER_EXEC_SESSION: '3',
    REPL_CAPACITY_MAX_IN_FLIGHT_EVALS_PER_BINDING: '5',
    REPL_CAPACITY_EVICT_IDLE_MS: '0',
  });
  assert.deepEqual(overridden, {
    maxExecSessions: 2,
    maxExecSessionsPerBinding: 1,
    maxWorkspacesPerMcpSession: 1,
    maxInFlightEvalsPerExecSession: 3,
    maxInFlightEvalsPerBinding: 5,
    evictIdleMs: 0,
  });

  assert.deepEqual(capacityLimitsFromEnv({}), { ...CAPACITY_DEFAULTS });
  assert.deepEqual(
    capacityLimitsFromEnv({ REPL_CAPACITY_MAX_EXEC_SESSIONS: '2', REPL_CAPACITY_EVICT_IDLE_MS: ' ' }),
    { ...CAPACITY_DEFAULTS, maxExecSessions: 2 },
  );
});

test('capacityLimitsFromEnv ignores overrides in production', () => {
  const limits = capacityLimitsFromEnv({
    NODE_ENV: 'production',
    REPL_CAPACITY_MAX_EXEC_SESSIONS: '2',
  });
  assert.deepEqual(limits, { ...CAPACITY_DEFAULTS });
});

test('capacityLimitsFromEnv rejects malformed values', () => {
  assert.throws(
    () => capacityLimitsFromEnv({ REPL_CAPACITY_MAX_EXEC_SESSIONS: '0' }),
    RangeError,
  );
  assert.throws(
    () => capacityLimitsFromEnv({ REPL_CAPACITY_MAX_EXEC_SESSIONS: 'two' }),
    RangeError,
  );
  assert.throws(
    () => capacityLimitsFromEnv({ REPL_CAPACITY_EVICT_IDLE_MS: '-5' }),
    RangeError,
  );
});

test('CapacityExceededError carries the protocol payload', () => {
  const error = new CapacityExceededError({
    resource: 'exec_sessions',
    current: 8,
    limit: 8,
    scope: 'global',
  });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'CapacityExceededError');
  assert.equal(error.code, 'CAPACITY_EXCEEDED');
  assert.equal(error.resource, 'exec_sessions');
  assert.equal(error.current, 8);
  assert.equal(error.limit, 8);
  assert.equal(error.scope, 'global');
  assert.match(error.message, /exec_sessions/);
  assert.match(error.message, /global/);

  const workspace = new CapacityExceededError({
    code: 'WS_LIMIT',
    resource: 'workspaces_per_mcp_session',
    current: 4,
    limit: 4,
    scope: 'mcp_abc',
    message: 'workspace limit',
  });
  assert.equal(workspace.code, 'WS_LIMIT');
  assert.equal(workspace.message, 'workspace limit');
});
