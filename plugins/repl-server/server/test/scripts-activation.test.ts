import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { openStateDb } from '../src/db/migrate.ts';
import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { RequestIdentity, ScriptRequest } from '../src/ports.ts';
import {
  ScriptService,
  type ArchiveRunResult,
  type ResolvedExecution,
  type SaveScriptResult,
} from '../src/scripts/service.ts';

const NOW = Date.UTC(2026, 10, 24, 6, 0, 0);
const IDENTITY: RequestIdentity = {
  identity: 'bound',
  binding: 'cb_activation',
  client: 'test-client/1.0',
  clientName: 'test-client',
  clientVersion: '1.0',
  mcp: 'mcp_activation',
};

interface Harness {
  db: DatabaseSync;
  service: ScriptService;
  gateway: ExecGateway;
  archiveResults: ArchiveRunResult[];
}

/**
 * Mirrors assembly's `onScriptRun`: archive (with conditional activation), then
 * count only successful non-test script runs.
 */
function harness(t: TestContext, options: Partial<ExecGatewayOptions> = {}): Harness {
  const db = openStateDb(':memory:');
  const service = new ScriptService({ db, now: () => NOW });
  const archiveResults: ArchiveRunResult[] = [];
  const gateway = new ExecGateway({
    callTool: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true };
    },
    onScriptRun: (record) => {
      archiveResults.push(service.archiveRun(record));
      if (record.ok && record.entryMode === 'script' && record.purpose !== 'test' && record.scriptId) {
        service.noteUsage(record.scriptId);
      }
    },
    ...options,
  });
  t.after(async () => {
    await gateway.disposeAll();
    db.close();
  });
  return { db, service, gateway, archiveResults };
}

let sequence = 0;

function createDraft(harnessRef: Harness, code = 'return args.x + 1;'): SaveScriptResult {
  sequence += 1;
  return harnessRef.service.save(
    { createdBy: 'tester' },
    {
      mode: 'parameterized',
      name: `activation-${sequence}`,
      description: 'activation fixture',
      code,
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'integer' } },
        required: ['x'],
        additionalProperties: false,
      },
    },
  );
}

function resolve(harnessRef: Harness, saved: SaveScriptResult): ResolvedExecution {
  return harnessRef.service.resolveExecution(
    {
      scriptId: saved.scriptId,
      scriptVersion: saved.version,
      args: { x: 1 },
    },
    { actor: { createdBy: 'tester' } },
  );
}

function requestOf(resolved: ResolvedExecution, extra: Partial<ScriptRequest> = {}): ScriptRequest {
  return {
    code: resolved.code,
    timeoutMs: 30_000,
    async: false,
    identity: IDENTITY,
    entryMode: 'script',
    actor: { createdBy: 'tester' },
    scriptId: resolved.script.scriptId,
    scriptVersion: resolved.version.version,
    scriptMode: resolved.version.mode,
    args: resolved.args,
    purpose: 'test',
    activateOnSuccess: true,
    ...extra,
  };
}

async function waitForTask(harnessRef: Harness, taskId: string): Promise<Record<string, unknown>> {
  const waited = (await harnessRef.gateway.waitTasks(
    IDENTITY.binding as string,
    [taskId],
    5_000,
  )) as { events: Array<Record<string, unknown>> };
  const event = waited.events[0];
  assert.ok(event !== undefined, 'the async task must settle');
  return event;
}

test('a successful sync test activates its draft inside the archive transaction', async (t) => {
  const h = harness(t);
  const saved = createDraft(h);
  const resolved = resolve(h, saved);

  const outcome = await h.gateway.runScript(requestOf(resolved));
  assert.equal(outcome.isError, false);
  assert.ok(outcome.runId);

  const version = h.service.version(saved.scriptId, 1);
  assert.equal(version.status, 'active');
  assert.equal(version.verifiedRunId, outcome.runId);
  const script = h.service.get(saved.scriptId);
  assert.equal(script?.status, 'active');
  assert.equal(script?.activeVersion, 1);
  assert.equal(script?.useCount, 0, 'a test run does not count as usage');
  assert.deepEqual(h.archiveResults, [{ activated: true }]);
  assert.equal(h.service.getRun(outcome.runId as string)?.purpose, 'test');
});

test('a failed sync test keeps the draft and archives the failure', async (t) => {
  const h = harness(t);
  const saved = createDraft(h, 'throw new Error("sync boom");');
  const resolved = resolve(h, saved);

  const outcome = await h.gateway.runScript(requestOf(resolved));
  assert.equal(outcome.isError, true);
  const script = h.service.get(saved.scriptId);
  assert.equal(script?.status, 'draft');
  assert.equal(script?.activeVersion, null);
  assert.equal(script?.useCount, 0);
  assert.deepEqual(h.archiveResults, [{ activated: false }]);
  const archived = h.service.getRun(outcome.runId as string);
  assert.equal(archived?.ok, false);
  assert.equal(archived?.purpose, 'test');
});

test('a successful async test activates at settle and reports the runId', async (t) => {
  const h = harness(t);
  const saved = createDraft(h);
  const resolved = resolve(h, saved);

  const dispatched = await h.gateway.dispatchScript(requestOf(resolved, { async: true }));
  const event = await waitForTask(h, dispatched.taskId);
  assert.equal(event['status'], 'completed');

  const version = h.service.version(saved.scriptId, 1);
  assert.equal(version.status, 'active');
  assert.equal(version.verifiedRunId, dispatched.runId);
  const script = h.service.get(saved.scriptId);
  assert.equal(script?.status, 'active');
  assert.equal(script?.useCount, 0);
  assert.deepEqual(h.archiveResults, [{ activated: true }]);
  assert.equal(h.service.getRun(dispatched.runId)?.purpose, 'test');
});

test('a failed async test keeps the draft', async (t) => {
  const h = harness(t);
  const saved = createDraft(h, 'throw new Error("async boom");');
  const resolved = resolve(h, saved);

  const dispatched = await h.gateway.dispatchScript(requestOf(resolved, { async: true }));
  const event = await waitForTask(h, dispatched.taskId);
  assert.equal(event['status'], 'failed');

  const script = h.service.get(saved.scriptId);
  assert.equal(script?.status, 'draft');
  assert.equal(script?.activeVersion, null);
  assert.deepEqual(h.archiveResults, [{ activated: false }]);
  assert.equal(h.service.getRun(dispatched.runId)?.ok, false);
});

test('two tests resolved against the same draft activate only once', async (t) => {
  const h = harness(t);
  const saved = createDraft(h);
  const first = resolve(h, saved);
  const second = resolve(h, saved);

  const firstOutcome = await h.gateway.runScript(requestOf(first));
  const secondOutcome = await h.gateway.runScript(requestOf(second));

  assert.equal(firstOutcome.isError, false);
  assert.equal(secondOutcome.isError, false, 'the losing run still succeeds');
  assert.deepEqual(h.archiveResults, [
    { activated: true },
    { activated: false, activationSkipped: 'active' },
  ]);
  const version = h.service.version(saved.scriptId, 1);
  assert.equal(version.status, 'active');
  assert.equal(version.verifiedRunId, firstOutcome.runId, 'the first successful test stays the verifier');
  assert.equal(h.service.getRun(secondOutcome.runId as string)?.ok, true, 'the second run is still archived');
});

test('an async test whose version was activated meanwhile keeps its task result', async (t) => {
  const h = harness(t);
  const saved = createDraft(h);
  const resolved = resolve(h, saved);

  const dispatched = await h.gateway.dispatchScript(
    requestOf(resolved, {
      async: true,
      code: 'await tools.probe({});\nreturn 7;',
    }),
  );
  // A concurrent admin activation wins before this eval settles.
  h.service.activate(saved.scriptId, 1, 'run_admin', { createdBy: 'admin', isAdmin: true });

  const event = await waitForTask(h, dispatched.taskId);
  assert.equal(event['status'], 'completed');
  assert.match(String(event['result']), /<result>7<\/result>/);

  const version = h.service.version(saved.scriptId, 1);
  assert.equal(version.status, 'active');
  assert.equal(version.verifiedRunId, 'run_admin', 'the concurrent activation is not overwritten');
  assert.deepEqual(h.archiveResults, [{ activated: false, activationSkipped: 'active' }]);
  assert.equal(h.service.getRun(dispatched.runId)?.ok, true, 'the settled run is still archived');
});

test('a script disabled during its test does not get resurrected by activation', async (t) => {
  const h = harness(t);
  const saved = createDraft(h);
  const resolved = resolve(h, saved);

  const dispatched = await h.gateway.dispatchScript(
    requestOf(resolved, {
      async: true,
      code: 'await tools.probe({});\nreturn 9;',
    }),
  );
  h.service.patch(saved.scriptId, { status: 'disabled' });

  const event = await waitForTask(h, dispatched.taskId);
  assert.equal(event['status'], 'completed');
  assert.equal(h.service.get(saved.scriptId)?.status, 'disabled');
  assert.equal(h.service.version(saved.scriptId, 1).status, 'draft');
  assert.deepEqual(h.archiveResults, [{ activated: false, activationSkipped: 'disabled' }]);
});

test('a non-owner test settles successfully but never activates the draft', async (t) => {
  const h = harness(t);
  const saved = createDraft(h);
  const resolved = resolve(h, saved);
  const outsider = { createdBy: 'someone-else' };

  const outcome = await h.gateway.runScript(
    requestOf(resolved, { actor: outsider, identity: { ...IDENTITY, binding: 'cb_other', mcp: 'mcp_other' } }),
  );
  assert.equal(outcome.isError, false, 'the execution itself is not an authorization failure');
  assert.deepEqual(h.archiveResults, [{ activated: false, activationSkipped: 'forbidden' }]);
  assert.equal(h.service.version(saved.scriptId, 1).status, 'draft');
  assert.equal(h.service.get(saved.scriptId)?.status, 'draft');
  assert.equal(h.service.getRun(outcome.runId as string)?.ok, true, 'the run is still archived as successful');
});

test('an admin-run test may activate a draft owned by someone else', async (t) => {
  const h = harness(t);
  const saved = createDraft(h);
  const resolved = resolve(h, saved);

  const outcome = await h.gateway.runScript(
    requestOf(resolved, {
      actor: { createdBy: 'admin', isAdmin: true },
      identity: { ...IDENTITY, binding: 'admin', mcp: 'admin' },
    }),
  );
  assert.equal(outcome.isError, false);
  assert.deepEqual(h.archiveResults, [{ activated: true }]);
  assert.equal(h.service.version(saved.scriptId, 1).status, 'active');
});
