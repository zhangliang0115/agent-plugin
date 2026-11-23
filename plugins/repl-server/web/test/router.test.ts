/** Hash route parsing and canonical hashes for the React admin. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRoute, routeHash } from '../src/app/router.ts';

test('parseRoute normalizes known paths and falls back to overview', () => {
  assert.deepEqual(parseRoute('#/logs'), { path: '/logs', tab: 'servers', server: null });
  assert.deepEqual(parseRoute('#/reports/'), { path: '/reports', tab: 'servers', server: null });
  assert.deepEqual(parseRoute('#/reports?status=open'), { path: '/reports', tab: 'servers', server: null });
  assert.deepEqual(parseRoute('#/requests'), { path: '/requests', tab: 'servers', server: null });
  assert.deepEqual(parseRoute('#/nope'), { path: '/overview', tab: 'servers', server: null });
  assert.deepEqual(parseRoute(''), { path: '/overview', tab: 'servers', server: null });
});

test('parseRoute keeps valid manage tabs and rejects unknown ones', () => {
  assert.deepEqual(parseRoute('#/manage?tab=tags'), { path: '/manage', tab: 'tags', server: null });
  assert.deepEqual(parseRoute('#/manage?tab=discover'), { path: '/manage', tab: 'discover', server: null });
  assert.deepEqual(parseRoute('#/manage?tab=bogus'), { path: '/manage', tab: 'servers', server: null });
});

test('parseRoute reads the tools server filter', () => {
  assert.deepEqual(parseRoute('#/manage?tab=tools&server=pg'), {
    path: '/manage',
    tab: 'tools',
    server: 'pg',
  });
  assert.deepEqual(parseRoute('#/manage?tab=tools&server='), {
    path: '/manage',
    tab: 'tools',
    server: null,
  });
  // The filter only applies to the tools tab.
  assert.deepEqual(parseRoute('#/manage?tab=servers&server=pg'), {
    path: '/manage',
    tab: 'servers',
    server: null,
  });
});

test('routeHash emits a clean /manage hash for the default tab', () => {
  assert.equal(routeHash('/overview'), '#/overview');
  assert.equal(routeHash('/requests'), '#/requests');
  assert.equal(routeHash('/manage'), '#/manage');
  assert.equal(routeHash('/manage', 'servers'), '#/manage');
  assert.equal(routeHash('/manage', 'alerts'), '#/manage?tab=alerts');
  assert.equal(routeHash('/manage', 'tools'), '#/manage?tab=tools');
  assert.equal(routeHash('/manage', 'tools', 'pg'), '#/manage?tab=tools&server=pg');
  assert.equal(routeHash('/manage', 'tags', 'pg'), '#/manage?tab=tags');
});
