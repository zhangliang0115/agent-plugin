/** Hash route parsing and canonical hashes for the React admin. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRoute, routeHash } from '../src/app/router.ts';

test('parseRoute normalizes known paths and falls back to overview', () => {
  assert.deepEqual(parseRoute('#/audit'), { path: '/audit', tab: 'servers' });
  assert.deepEqual(parseRoute('#/reports/'), { path: '/reports', tab: 'servers' });
  assert.deepEqual(parseRoute('#/reports?status=open'), { path: '/reports', tab: 'servers' });
  assert.deepEqual(parseRoute('#/nope'), { path: '/overview', tab: 'servers' });
  assert.deepEqual(parseRoute(''), { path: '/overview', tab: 'servers' });
});

test('parseRoute keeps valid manage tabs and rejects unknown ones', () => {
  assert.deepEqual(parseRoute('#/manage?tab=tags'), { path: '/manage', tab: 'tags' });
  assert.deepEqual(parseRoute('#/manage?tab=discover'), { path: '/manage', tab: 'discover' });
  assert.deepEqual(parseRoute('#/manage?tab=bogus'), { path: '/manage', tab: 'servers' });
});

test('routeHash emits a clean /manage hash for the default tab', () => {
  assert.equal(routeHash('/overview'), '#/overview');
  assert.equal(routeHash('/manage'), '#/manage');
  assert.equal(routeHash('/manage', 'servers'), '#/manage');
  assert.equal(routeHash('/manage', 'alerts'), '#/manage?tab=alerts');
});
