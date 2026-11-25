import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTIVE_SESSION_WINDOW_MS, isActiveSession } from '../src/lib/active-sessions.ts';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

test('isActiveSession uses the 15-minute window by default', () => {
  assert.equal(ACTIVE_SESSION_WINDOW_MS, 15 * 60_000);
  assert.equal(isActiveSession({ lastRequestAt: ago(14) }, NOW), true);
  assert.equal(isActiveSession({ lastRequestAt: ago(16) }, NOW), false);
});

test('isActiveSession falls back to connectedAt when lastRequestAt is missing', () => {
  assert.equal(isActiveSession({ connectedAt: ago(5) }, NOW), true);
  assert.equal(isActiveSession({ connectedAt: ago(20) }, NOW), false);
  assert.equal(isActiveSession({ lastRequestAt: ago(20), connectedAt: ago(5) }, NOW), false);
});

test('isActiveSession treats missing or invalid timestamps as inactive', () => {
  assert.equal(isActiveSession({}, NOW), false);
  assert.equal(isActiveSession({ lastRequestAt: '' }, NOW), false);
  assert.equal(isActiveSession({ lastRequestAt: 'not-a-date' }, NOW), false);
});

test('isActiveSession accepts a custom window', () => {
  assert.equal(isActiveSession({ lastRequestAt: ago(45) }, NOW, 60 * 60_000), true);
  assert.equal(isActiveSession({ lastRequestAt: ago(10) }, NOW, 5 * 60_000), false);
});
