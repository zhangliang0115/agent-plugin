/** Audit filter persistence and column configuration (pure logic, no DOM). */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_COLUMNS,
  COLUMN_STORAGE_KEY,
  DEFAULT_RANGE,
  FILTER_STORAGE_KEY,
  defaultAuditFilters,
  defaultColumnVisibility,
  expandedRangeMinutes,
  nextRangeMinutes,
  parsePersistedAuditFilters,
  parsePersistedColumns,
  rangeMinutes,
  serializeAuditFilters,
  serializeColumnVisibility,
  visibleAuditColumns,
} from '../src/pages/audit.ts';

/** Local wall-clock time so `datetime-local` strings compare exactly. */
const NOW = new Date(2026, 4, 6, 10, 30, 0, 0).getTime();

test('defaultAuditFilters starts at the last hour in local time', () => {
  const filters = defaultAuditFilters(NOW);
  assert.equal(filters.range, DEFAULT_RANGE);
  assert.equal(filters.from, '2026-05-06T09:30');
  assert.equal(filters.to, '');
  assert.equal(filters.live, true);
  assert.equal(filters.event, '');
  assert.equal(filters.status, '');
  assert.equal(filters.minMs, '');
});

test('storage keys are versioned and independent', () => {
  assert.match(FILTER_STORAGE_KEY, /\.v1$/);
  assert.match(COLUMN_STORAGE_KEY, /\.v1$/);
  assert.notEqual(FILTER_STORAGE_KEY, COLUMN_STORAGE_KEY);
});

test('parsePersistedAuditFilters restores a preset relative to now', () => {
  const raw = JSON.stringify({
    version: 1,
    range: '15',
    from: '2020-01-01T00:00',
    to: '2020-01-01T01:00',
    event: 'tool_call',
    client: 'claude-code/2.1.327',
    binding: 'cb_abc',
    tool: 'read',
    server: 'pg',
    status: 'error',
    minMs: '25',
    live: false,
  });
  const filters = parsePersistedAuditFilters(raw, NOW);
  assert.equal(filters.range, '15');
  assert.equal(filters.from, '2026-05-06T10:15');
  assert.equal(filters.to, '');
  assert.equal(filters.event, 'tool_call');
  assert.equal(filters.client, 'claude-code/2.1.327');
  assert.equal(filters.binding, 'cb_abc');
  assert.equal(filters.tool, 'read');
  assert.equal(filters.server, 'pg');
  assert.equal(filters.status, 'error');
  assert.equal(filters.minMs, '25');
  assert.equal(filters.live, false);
});

test('parsePersistedAuditFilters keeps a custom range and round-trips', () => {
  const custom = {
    ...defaultAuditFilters(NOW),
    range: '',
    from: '2026-05-06T08:00',
    to: '2026-05-06T09:00',
    tool: 'read',
    live: false,
  };
  const parsed = parsePersistedAuditFilters(serializeAuditFilters(custom), NOW);
  assert.deepEqual(parsed, custom);
});

test('parsePersistedAuditFilters falls back to defaults on corrupt payloads', () => {
  const fallback = defaultAuditFilters(NOW);
  const corrupt = [
    null,
    '',
    '{not json',
    JSON.stringify({ version: 2, range: '60' }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, range: '999' }),
    JSON.stringify({ version: 1, range: '', from: 'garbage', to: '' }),
    JSON.stringify({ version: 1, range: '', from: '2026-05-06', to: '' }),
    JSON.stringify({ version: 1, range: '', from: '', to: '' }),
    JSON.stringify({ version: 1, range: '60', from: 42, to: null }),
  ];
  for (const raw of corrupt) {
    assert.deepEqual(parsePersistedAuditFilters(raw, NOW), fallback, String(raw));
  }
});

test('parsePersistedAuditFilters drops only the corrupt optional fields', () => {
  const raw = JSON.stringify({
    version: 1,
    range: '60',
    event: 'bogus_event',
    status: 'bogus_status',
    minMs: '-5',
    client: 42,
    binding: null,
    tool: { nested: true },
    server: ['pg'],
  });
  const filters = parsePersistedAuditFilters(raw, NOW);
  assert.equal(filters.event, '');
  assert.equal(filters.status, '');
  assert.equal(filters.minMs, '');
  assert.equal(filters.client, '');
  assert.equal(filters.binding, '');
  assert.equal(filters.tool, '');
  assert.equal(filters.server, '');
  assert.equal(filters.live, true);
});

test('nextRangeMinutes walks the presets and never shrinks', () => {
  assert.equal(nextRangeMinutes(null), 60);
  assert.equal(nextRangeMinutes(15), 60);
  assert.equal(nextRangeMinutes(60), 360);
  assert.equal(nextRangeMinutes(360), 1_440);
  assert.equal(nextRangeMinutes(1_440), 10_080);
  assert.equal(nextRangeMinutes(10_080), 10_080);
});

test('expandedRangeMinutes keeps growing past the last preset', () => {
  assert.equal(expandedRangeMinutes(null), 60);
  assert.equal(expandedRangeMinutes(0), 60);
  assert.equal(expandedRangeMinutes(15), 60);
  assert.equal(expandedRangeMinutes(10_080), 20_160);
  assert.equal(expandedRangeMinutes(20_160), 40_320);
});

test('rangeMinutes reads presets and custom spans', () => {
  assert.equal(rangeMinutes({ range: '15', from: '', to: '' }, NOW), 15);
  assert.equal(
    rangeMinutes({ range: '', from: '2026-05-06T09:30', to: '2026-05-06T10:30' }, NOW),
    60,
  );
  assert.equal(rangeMinutes({ range: '', from: '', to: '' }, NOW), null);
});

test('column visibility defaults to all columns and round-trips overrides', () => {
  const defaults = defaultColumnVisibility();
  for (const column of AUDIT_COLUMNS) assert.equal(defaults[column.key], true);

  const restored = parsePersistedColumns(
    JSON.stringify({ version: 1, columns: { server: false, client: false } }),
  );
  assert.equal(restored['server'], false);
  assert.equal(restored['client'], false);
  assert.equal(restored['status'], true);
  assert.equal(restored['unknown'], undefined);

  const roundTrip = parsePersistedColumns(
    serializeColumnVisibility({ ...defaults, server: false }),
  );
  assert.equal(roundTrip['server'], false);
  assert.equal(roundTrip['tool'], true);
});

test('column persistence falls back to defaults on corrupt payloads', () => {
  const fallback = defaultColumnVisibility();
  const corrupt = [
    null,
    '',
    '{not json',
    JSON.stringify({ version: 2, columns: { server: false } }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, columns: 'nope' }),
  ];
  for (const raw of corrupt) {
    assert.deepEqual(parsePersistedColumns(raw), fallback, String(raw));
  }
});

test('visibleAuditColumns honours picker and narrow-screen rules', () => {
  const visibility = { ...defaultColumnVisibility(), server: true };
  const wide = visibleAuditColumns(visibility, false).map((column) => column.key);
  assert.ok(wide.includes('server'));
  assert.ok(wide.includes('client'));
  assert.ok(wide.includes('eval'));

  const narrow = visibleAuditColumns(visibility, true).map((column) => column.key);
  assert.ok(!narrow.includes('server'));
  assert.ok(!narrow.includes('client'));
  assert.ok(!narrow.includes('mode'));
  assert.ok(!narrow.includes('eval'));
  assert.ok(narrow.includes('time'));
  assert.ok(narrow.includes('tool'));
  assert.ok(narrow.includes('queueMs'));
  assert.ok(narrow.includes('ms'));
  assert.ok(narrow.includes('status'));

  const hidden = visibleAuditColumns({ ...visibility, server: false }, false).map(
    (column) => column.key,
  );
  assert.ok(!hidden.includes('server'));
});
