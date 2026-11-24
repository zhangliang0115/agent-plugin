import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ExecGateway, type ExecGatewayOptions } from '../src/exec/gateway.ts';
import type { RequestIdentity, ScriptRequest } from '../src/ports.ts';
import type { ArchiveRunOptions } from '../src/scripts/service.ts';

const IDENTITY: RequestIdentity = {
  identity: 'bound',
  binding: 'cb_archive',
  client: 'test-client/1.0',
  clientName: 'test-client',
  clientVersion: '1.0',
  mcp: 'mcp_archive',
};

interface Harness {
  gateway: ExecGateway;
  archives: ArchiveRunOptions[];
  audits: Array<Record<string, unknown> & { event: string }>;
}

function harness(t: TestContext, options: Partial<ExecGatewayOptions> = {}): Harness {
  const archives: ArchiveRunOptions[] = [];
  const audits: Array<Record<string, unknown> & { event: string }> = [];
  const gateway = new ExecGateway({
    callTool: async () => ({ ok: true }),
    onScriptRun: (record) => archives.push(record),
    onAudit: (event) => audits.push(event),
    ...options,
  });
  t.after(async () => {
    await gateway.disposeAll();
  });
  return { gateway, archives, audits };
}

function request(code: string, extra: Partial<ScriptRequest> = {}): ScriptRequest {
  return {
    code,
    timeoutMs: 30_000,
    async: false,
    identity: IDENTITY,
    entryMode: 'code',
    purpose: 'run',
    ...extra,
  };
}

function runIdOf(envelope: string): string | undefined {
  return /run="([^"]+)"/.exec(envelope)?.[1];
}

test('a synchronous run archives the code and returns the same runId in the envelope', async (t) => {
  const { gateway, archives, audits } = harness(t);
  const outcome = await gateway.runScript(request('return 6 * 7;'));

  assert.equal(outcome.isError, false);
  assert.match(outcome.content, /<repl-output eval="\d+" run="[0-9a-f-]+"><result>42<\/result>/);
  const runId = runIdOf(outcome.content);
  assert.equal(outcome.runId, runId);
  assert.equal(archives.length, 1);

  const archived = archives[0];
  assert.ok(archived !== undefined);
  assert.equal(archived.runId, runId);
  assert.equal(archived.entryMode, 'code');
  assert.equal(archived.entryTool, 'run_script');
  assert.equal(archived.purpose, 'run');
  assert.equal(archived.code, 'return 6 * 7;');
  assert.equal(archived.ok, true);
  assert.equal(archived.error, null);
  assert.equal(archived.evalId, 1);
  assert.equal(archived.binding, 'cb_archive');
  assert.equal(archived.clientName, 'test-client');
  assert.deepEqual(archived.toolsUsed, []);
  assert.equal(typeof archived.durationMs, 'number');

  const start = audits.find((event) => event['event'] === 'eval_start');
  const end = audits.find((event) => event['event'] === 'eval_end');
  assert.equal(start?.['runId'], runId);
  assert.equal(start?.['entryTool'], 'run_script');
  assert.equal(start?.['entryMode'], 'code');
  assert.equal(end?.['runId'], runId);
  assert.equal(end?.['entryMode'], 'code');
});

test('a failed run archives its status but no code', async (t) => {
  const { gateway, archives } = harness(t);
  const outcome = await gateway.runScript(request('throw new Error("boom");'));
  assert.equal(outcome.isError, true);
  assert.equal(archives.length, 1);
  assert.equal(archives[0]?.ok, false);
  assert.equal(archives[0]?.code, null);
  assert.match(archives[0]?.error ?? '', /boom/);
});

test('an async run archives once it settles and exposes runId through tasks', async (t) => {
  const { gateway, archives, audits } = harness(t);
  const requestFields: ScriptRequest = request('return await tools.probe({ value: 3 });', {
    async: true,
    entryMode: 'script',
    scriptId: 's_01JABCDEFGHJKMNPQRSTVWXYZ0',
    scriptVersion: 2,
    scriptMode: 'parameterized',
    args: { value: 3 },
    purpose: 'test',
  });
  const dispatched = await gateway.dispatchScript({
    ...requestFields,
    code: 'async function __savedScript(args) { return await tools.probe({ value: args.value }); }\nreturn __savedScript({ value: 3 });',
  });

  const waited = (await gateway.waitTasks(IDENTITY.binding as string, [dispatched.taskId], 5_000)) as {
    events: Array<Record<string, unknown>>;
  };
  assert.equal(waited.events.length, 1);
  const event = waited.events[0];
  assert.equal(event?.['runId'], dispatched.runId);
  assert.equal(event?.['entryMode'], 'script');
  assert.equal(event?.['scriptId'], requestFields.scriptId);
  assert.equal(event?.['scriptVersion'], 2);
  assert.equal(event?.['scriptMode'], 'parameterized');
  assert.equal(event?.['argsPreview'], '{"value":3}');
  assert.equal(event?.['status'], 'completed');

  const snapshot = await gateway.getTask(IDENTITY.binding as string, dispatched.taskId);
  assert.equal(snapshot?.runId, dispatched.runId);
  assert.equal(snapshot?.scriptId, requestFields.scriptId);
  assert.equal(snapshot?.scriptVersion, 2);
  assert.equal(snapshot?.scriptMode, 'parameterized');
  assert.equal(snapshot?.argsPreview, '{"value":3}');

  assert.equal(archives.length, 1);
  const archived = archives[0];
  assert.ok(archived !== undefined);
  assert.equal(archived.runId, dispatched.runId);
  assert.equal(archived.entryMode, 'script');
  assert.equal(archived.scriptId, requestFields.scriptId);
  assert.equal(archived.scriptVersion, 2);
  assert.equal(archived.scriptMode, 'parameterized');
  assert.deepEqual(archived.args, { value: 3 });
  assert.equal(archived.argsPreview, '{"value":3}');
  assert.equal(archived.code, null, 'saved-script runs do not archive the code');
  assert.equal(archived.purpose, 'test');
  assert.deepEqual(archived.toolsUsed, ['probe']);

  const dispatch = audits.find((item) => item['event'] === 'async_dispatch');
  assert.equal(dispatch?.['runId'], dispatched.runId);
  assert.equal(dispatch?.['entryMode'], 'script');
  assert.equal(dispatch?.['scriptId'], requestFields.scriptId);
  assert.equal(dispatch?.['scriptVersion'], 2);
  assert.equal(dispatch?.['scriptMode'], 'parameterized');
  assert.equal(dispatch?.['argsBytes'], Buffer.byteLength('{"value":3}'));
  assert.equal(dispatch?.['argsPreview'], '{"value":3}');
});

test('script args preview is capped at 512 characters in audit and archive', async (t) => {
  const { gateway, archives, audits } = harness(t);
  const args = { payload: 'x'.repeat(600) };
  const outcome = await gateway.runScript(
    request('return 1;', {
      entryMode: 'script',
      scriptId: 's_01JABCDEFGHJKMNPQRSTVWXYZ0',
      scriptVersion: 1,
      scriptMode: 'parameterized',
      args,
    }),
  );
  assert.equal(outcome.isError, false);
  assert.equal(archives[0]?.argsPreview?.length, 512);
  const start = audits.find((event) => event['event'] === 'eval_start');
  assert.equal((start?.['argsPreview'] as string | undefined)?.length, 512);
  const end = audits.find((event) => event['event'] === 'eval_end');
  assert.equal((end?.['argsPreview'] as string | undefined)?.length, 512);
});

test('an archive sink failure does not change the execution result', async (t) => {
  const { gateway } = harness(t, {
    onScriptRun: () => {
      throw new Error('disk full');
    },
  });
  const outcome = await gateway.runScript(request('return 5;'));
  assert.equal(outcome.isError, false);
  assert.match(outcome.content, /<result>5<\/result>/);
});

test('secret-looking script args are redacted in previews and flagged, never blocked', async (t) => {
  const { gateway, archives, audits } = harness(t);
  const token = 'ghp_' + 'A'.repeat(36);
  const args = { value: token, query: 'safe' };
  const outcome = await gateway.runScript(
    request('return 1;', {
      entryMode: 'script',
      scriptId: 's_01JABCDEFGHJKMNPQRSTVWXYZ0',
      scriptVersion: 1,
      scriptMode: 'parameterized',
      args,
    }),
  );
  assert.equal(outcome.isError, false, 'a secret warning never blocks execution');

  const archived = archives[0];
  assert.ok(archived !== undefined);
  assert.ok(!archived.argsPreview?.includes(token), 'args_preview never carries the token');
  assert.match(archived.argsPreview ?? '', /<redacted>/);
  assert.deepEqual(archived.args, args, 'args_json keeps the original (known risk)');

  for (const eventName of ['eval_start', 'eval_end']) {
    const event = audits.find((entry) => entry['event'] === eventName);
    assert.ok(event !== undefined);
    assert.ok(!String(event['argsPreview']).includes(token), `${eventName} argsPreview is redacted`);
    const warnings = event['secretWarnings'] as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(warnings) && warnings.length > 0, `${eventName} carries secretWarnings`);
    assert.equal(warnings[0]?.['kind'], 'provider_token');
    assert.equal(warnings[0]?.['field'], 'args');
    assert.ok(!JSON.stringify(warnings).includes(token), `${eventName} warnings carry no token`);
  }

  const snapshot = await gateway.dispatchScript(
    request('return await tools.probe({});', {
      async: true,
      entryMode: 'script',
      scriptId: 's_01JABCDEFGHJKMNPQRSTVWXYZ0',
      scriptVersion: 1,
      scriptMode: 'parameterized',
      args,
    }),
  );
  const dispatch = audits.filter((entry) => entry['event'] === 'async_dispatch').at(-1);
  assert.ok(dispatch !== undefined);
  assert.ok(!String(dispatch['argsPreview']).includes(token));
  assert.ok(Array.isArray(dispatch['secretWarnings']));
  assert.ok(!String(dispatch['runId'] ?? '').includes(token));
  assert.equal(typeof snapshot.taskId, 'string');
  await gateway.waitTasks(IDENTITY.binding as string, [snapshot.taskId], 5_000);
});
