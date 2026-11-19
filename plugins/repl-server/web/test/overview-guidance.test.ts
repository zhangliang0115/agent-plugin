/** Pure guidance logic: onboarding progress, attention rows and capacity precedence.
 *
 * These tests import the page module directly. It has no top-level DOM access; only the
 * factory touches `document`, so the exported pure functions run under `node --test`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateAttention,
  evaluateOnboarding,
  isBuiltinServer,
  mergeCapacity,
} from '../src/pages/overview.ts';

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

test('evaluateOnboarding marks every empty counter as todo', () => {
  const result = evaluateOnboarding({ serversTotal: 0, toolCount: 0, clientsTotal: 0 });

  assert.deepEqual(
    result.steps.map((step) => [step.id, step.status]),
    [
      ['servers', 'todo'],
      ['tools', 'todo'],
      ['clients', 'todo'],
    ],
  );
  assert.equal(result.completed, 0);
  assert.equal(result.total, 3);
  assert.equal(result.allDone, false);
  assert.equal(result.hasUnknown, false);
});

test('evaluateOnboarding completes steps independently', () => {
  const result = evaluateOnboarding({ serversTotal: 2, toolCount: 0, clientsTotal: 1 });

  assert.deepEqual(
    result.steps.map((step) => step.status),
    ['done', 'todo', 'done'],
  );
  assert.equal(result.completed, 2);
  assert.equal(result.allDone, false);
});

test('evaluateOnboarding folds the card only after all three counters are positive', () => {
  const result = evaluateOnboarding({ serversTotal: 1, toolCount: 3, clientsTotal: 2 });

  assert.equal(result.completed, 3);
  assert.equal(result.allDone, true);
  assert.equal(result.hasUnknown, false);
});

test('evaluateOnboarding keeps unavailable counters unknown instead of guessing', () => {
  const result = evaluateOnboarding({ serversTotal: null, toolCount: null, clientsTotal: 1 });

  assert.deepEqual(
    result.steps.map((step) => step.status),
    ['unknown', 'unknown', 'done'],
  );
  assert.equal(result.completed, 1);
  assert.equal(result.allDone, false);
  assert.equal(result.hasUnknown, true);
});

test('evaluateOnboarding never folds the card while any counter is unknown', () => {
  const result = evaluateOnboarding({ serversTotal: 1, toolCount: 2, clientsTotal: null });

  assert.equal(result.completed, 2);
  assert.equal(result.hasUnknown, true);
  assert.equal(result.allDone, false);
});

test('isBuiltinServer excludes the seed rows from onboarding counts', () => {
  assert.equal(isBuiltinServer({ id: '__official__' }), true);
  assert.equal(isBuiltinServer({ id: '__builtin__', transport: 'stdio' }), true);
  assert.equal(isBuiltinServer({ id: 'my-server', transport: 'builtin' }), true);
  assert.equal(isBuiltinServer({ id: 'my-server', transport: 'http' }), false);
  assert.equal(isBuiltinServer({ id: 'my-server' }), false);
});

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

test('evaluateAttention points an empty install at the servers tab', () => {
  const items = evaluateAttention({ servers: [], alerts: null, openReports: null });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, 'servers-empty');
  assert.equal(items[0]?.tone, 'info');
  assert.equal(items[0]?.href, '#/manage?tab=servers');
});

test('evaluateAttention groups disabled, failed and unstable servers', () => {
  const items = evaluateAttention({
    servers: [
      { id: 'off', enabled: false, state: 'disabled' },
      { id: 'broken', enabled: true, state: 'failed', lastError: 'ECONNREFUSED' },
      { id: 'retrying', enabled: true, state: 'reconnecting' },
      { id: 'healthy', enabled: true, state: 'ready' },
    ],
    alerts: null,
    openReports: null,
  });

  assert.deepEqual(
    items.map((item) => item.id),
    ['servers-disabled', 'servers-failed', 'servers-unstable'],
  );
  assert.equal(items[0]?.title, '1 个 server 已停用');
  assert.equal(items[1]?.tone, 'error');
  assert.equal(items[1]?.detail, '最近的错误：ECONNREFUSED');
  assert.equal(items[2]?.tone, 'queue');
});

test('evaluateAttention does not double-count a disabled server as failed', () => {
  const items = evaluateAttention({
    servers: [{ id: 'off', enabled: false, state: 'failed' }],
    alerts: null,
    openReports: null,
  });

  assert.deepEqual(
    items.map((item) => item.id),
    ['servers-disabled'],
  );
});

test('evaluateAttention handles the alert switch and webhook independently', () => {
  const server = { id: 'a', enabled: true, state: 'ready' };

  const disabled = evaluateAttention({
    servers: [server],
    alerts: { enabled: false, webhookConfigured: true },
    openReports: null,
  });
  assert.deepEqual(
    disabled.map((item) => item.id),
    ['alerts-disabled'],
  );

  const missingWebhook = evaluateAttention({
    servers: [server],
    alerts: { enabled: true, webhookConfigured: false },
    openReports: null,
  });
  assert.deepEqual(
    missingWebhook.map((item) => item.id),
    ['alerts-webhook-missing'],
  );

  const healthy = evaluateAttention({
    servers: [server],
    alerts: { enabled: true, webhookConfigured: true },
    openReports: 0,
  });
  assert.deepEqual(healthy, []);
});

test('evaluateAttention surfaces open reports and notes when the list has more', () => {
  const items = evaluateAttention({
    servers: [{ id: 'a', enabled: true, state: 'ready' }],
    alerts: { enabled: true, webhookConfigured: true },
    openReports: 7,
    openReportsHasMore: true,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, 'reports-open');
  assert.equal(items[0]?.title, '7 条问题报告未处理');
  assert.equal(items[0]?.href, '#/manage?tab=alerts');
  assert.ok((items[0]?.detail ?? '').includes('还有更多'));
});

test('evaluateAttention falls back to overview counts when the server list is unavailable', () => {
  const disabled = evaluateAttention({
    servers: null,
    serverSummary: { total: 4, enabled: 3 },
    alerts: null,
    openReports: null,
  });
  assert.deepEqual(
    disabled.map((item) => item.id),
    ['servers-disabled-summary'],
  );
  assert.equal(disabled[0]?.title, '1 个 server 已停用');

  // The seed rows are always present, so an all-enabled summary must not claim an empty install.
  const seeded = evaluateAttention({
    servers: null,
    serverSummary: { total: 2, enabled: 2 },
    alerts: null,
    openReports: null,
  });
  assert.deepEqual(seeded, []);
});

test('evaluateAttention reports nothing when every input is unavailable', () => {
  const items = evaluateAttention({
    servers: null,
    serverSummary: null,
    alerts: null,
    openReports: null,
  });

  assert.deepEqual(items, []);
});

// ---------------------------------------------------------------------------
// Capacity precedence
// ---------------------------------------------------------------------------

test('mergeCapacity prefers the live snapshot over settings', () => {
  const view = mergeCapacity(
    { maxExecSessions: 4, maxServeProcesses: 6 },
    { maxExecSessions: 8, maxServeProcesses: 99, maxWorkers: 8 },
  );

  assert.equal(view.values['maxExecSessions'], 4);
  assert.equal(view.sources['maxExecSessions'], 'effective');
  assert.equal(view.values['maxServeProcesses'], 6);
  assert.equal(view.sources['maxServeProcesses'], 'effective');
  assert.equal(view.values['maxWorkers'], 8);
  assert.equal(view.sources['maxWorkers'], 'settings');
});

test('mergeCapacity keeps settings values for keys the snapshot omits', () => {
  const view = mergeCapacity(
    { maxExecSessions: 4 },
    { maxExecSessionsPerBinding: 2, maxInFlightEvalsPerBinding: 16, evictIdleMs: 300_000 },
  );

  assert.deepEqual(Object.keys(view.values).sort(), [
    'evictIdleMs',
    'maxExecSessions',
    'maxExecSessionsPerBinding',
    'maxInFlightEvalsPerBinding',
  ]);
  assert.equal(view.sources['maxExecSessionsPerBinding'], 'settings');
  assert.equal(view.sources['maxExecSessions'], 'effective');
});

test('mergeCapacity ignores non-finite values and null inputs', () => {
  const view = mergeCapacity({ maxExecSessions: Number.NaN }, { maxExecSessions: 8 });
  assert.equal(view.values['maxExecSessions'], 8);
  assert.equal(view.sources['maxExecSessions'], 'settings');

  const empty = mergeCapacity(null, undefined);
  assert.deepEqual(empty.values, {});
  assert.deepEqual(empty.sources, {});
});
