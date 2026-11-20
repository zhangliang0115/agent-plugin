/** Overview endpoint: the in-flight eval list and its cancel route. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminOverviewHandler, type OverviewSnapshot } from '../src/admin/overview.ts';
import type { AdminRequest } from '../src/admin/servers.ts';
import type { InFlightEvalsView } from '../src/ports.ts';

const SNAPSHOT: OverviewSnapshot = {
  capacity: {},
  pool: { total: 0, ready: 0, reconnecting: 0, failed: 0 },
  sessions: { transport: 0, exec: 0, inFlightEvals: 0 },
  servers: { total: 0, enabled: 0 },
};

const EVALS: InFlightEvalsView = {
  total: 1,
  items: [
    {
      exec: 'es_1',
      evalId: 7,
      binding: null,
      workspace: '.',
      async: true,
      startedAt: 1_000,
      ageMs: 2_000,
    },
  ],
};

function request(method: string, path: string): AdminRequest {
  return { method, path };
}

test('GET /overview carries evals only when the gateway is wired', async () => {
  const unwired = createAdminOverviewHandler({ overview: () => SNAPSHOT });
  const without = await unwired(request('GET', '/admin/api/overview'));
  assert.equal(without?.status, 200);
  assert.equal('evals' in (without?.body as Record<string, unknown>), false);

  const wired = createAdminOverviewHandler({ overview: () => SNAPSHOT, evals: () => EVALS });
  const withEvals = await wired(request('GET', '/overview'));
  assert.equal(withEvals?.status, 200);
  assert.deepEqual((withEvals?.body as Record<string, unknown>)['evals'], EVALS);
});

test('POST /evals/:exec/:evalId/cancel reports success and unknown evals', async () => {
  const calls: Array<[string, number]> = [];
  const handler = createAdminOverviewHandler({
    overview: () => SNAPSHOT,
    cancelEval: (exec, evalId) => {
      calls.push([exec, evalId]);
      return exec === 'es_1' && evalId === 7;
    },
  });

  const cancelled = await handler(request('POST', '/admin/api/evals/es_1/7/cancel'));
  assert.equal(cancelled?.status, 200);
  assert.deepEqual(cancelled?.body, { ok: true });
  assert.deepEqual(calls, [['es_1', 7]]);

  const missing = await handler(request('POST', '/evals/es_1/8/cancel'));
  assert.equal(missing?.status, 404);
  assert.equal(
    ((missing?.body as { error: { code: string } }).error).code,
    'EVAL_NOT_FOUND',
  );

  const unwired = createAdminOverviewHandler({ overview: () => SNAPSHOT });
  const off = await unwired(request('POST', '/evals/es_1/7/cancel'));
  assert.equal(off?.status, 404);
  assert.equal(((off?.body as { error: { code: string } }).error).code, 'EVAL_NOT_FOUND');
});

test('POST /evals/:exec/:evalId/cancel awaits an async cancelEval', async () => {
  const handler = createAdminOverviewHandler({
    overview: () => SNAPSHOT,
    cancelEval: async (exec, evalId) => exec === 'es_2' && evalId === 9,
  });

  const cancelled = await handler(request('POST', '/admin/api/evals/es_2/9/cancel'));
  assert.equal(cancelled?.status, 200);
  assert.deepEqual(cancelled?.body, { ok: true });

  const missing = await handler(request('POST', '/evals/es_2/10/cancel'));
  assert.equal(missing?.status, 404);
});
