/** P4 minimal ACL and secret-warning behaviour for the saved-script library. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { openStateDb } from '../src/db/migrate.ts';
import type {
  CatalogSnapshot,
  ExecutionGateway,
  RequestIdentity,
  ScriptOutcome,
  TaskSnapshot,
} from '../src/ports.ts';
import { ScriptError, ScriptService } from '../src/scripts/service.ts';
import { callTool, type ToolCallContext } from '../src/tools/call.ts';
import type { CallToolResult } from '../src/tools/registry.ts';
import { McpTaskStore } from '../src/tasks/mcp-tasks.ts';

const NOW = Date.UTC(2026, 10, 24, 6, 0, 0);
const IDENTITY: RequestIdentity = {
  identity: 'bound',
  binding: 'cb_owner',
  client: 'test-client/1.0',
  mcp: 'mcp_owner',
};
const OTHER_IDENTITY: RequestIdentity = {
  identity: 'bound',
  binding: 'cb_other',
  client: 'other-client/1.0',
  mcp: 'mcp_other',
};
const GITHUB_TOKEN = 'ghp_' + 'A'.repeat(36);
const PASSWORD = 'pw-' + 'Z'.repeat(20);

class FakeGateway implements ExecutionGateway {
  runOutcome: ScriptOutcome = {
    content: '<repl-output eval="1" run="run_ok"><result>ok</result></repl-output>',
    isError: false,
    runId: 'run_ok',
  };

  async runScript(): Promise<ScriptOutcome> {
    return this.runOutcome;
  }

  async dispatchScript(): Promise<{ taskId: string; evalId: number; runId: string }> {
    return { taskId: 't_1', evalId: 2, runId: 'run_async' };
  }

  async waitTasks(): Promise<unknown> {
    return { ok: true, timedOut: false, events: [], pending: 0 };
  }

  async getTask(): Promise<TaskSnapshot | null> {
    return null;
  }

  async cancelTask(): Promise<boolean> {
    return true;
  }

  async destroyOwner(): Promise<void> {}
  async destroyTransport(): Promise<void> {}
}

interface Fixture {
  db: DatabaseSync;
  service: ScriptService;
  ctx: ToolCallContext;
  audits: Array<Record<string, unknown> & { event: string }>;
}

function fixture(t: TestContext, identity: RequestIdentity = IDENTITY): Fixture {
  const db = openStateDb(':memory:');
  t.after(() => db.close());
  const service = new ScriptService({ db, now: () => NOW });
  const audits: Array<Record<string, unknown> & { event: string }> = [];
  const catalog = {
    snapshot: (): CatalogSnapshot => ({ revision: 1, tools: [] }),
  };
  const ctx: ToolCallContext = {
    identity,
    gateway: new FakeGateway(),
    catalog,
    tasks: new McpTaskStore({ clock: { now: () => NOW } }),
    scripts: service,
    audit: (event) => audits.push(event),
  };
  return { db, service, ctx, audits };
}

function resultText(result: unknown): string {
  const call = result as CallToolResult;
  const block = call.content[0];
  assert.ok(block !== undefined && block.type === 'text');
  return block.text;
}

function errorCodeOf(error: unknown): string | undefined {
  return error instanceof ScriptError ? error.code : undefined;
}

function createDraft(
  f: Fixture,
  name: string,
  code = 'return args.x + 1;',
  owner = IDENTITY.binding as string,
): { scriptId: string; version: number } {
  return f.service.save(
    { createdBy: owner },
    {
      mode: 'parameterized',
      name,
      description: 'acl fixture',
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

test('only the owner or an admin may update a script', (t) => {
  const f = fixture(t);
  const saved = createDraft(f, 'owned');

  const ownerUpdate = f.service.save(
    { createdBy: IDENTITY.binding as string },
    { scriptId: saved.scriptId, description: 'owner edit' },
  );
  assert.equal(ownerUpdate.version, 1);
  assert.equal(f.service.get(saved.scriptId)?.description, 'owner edit');

  const outsider = { createdBy: OTHER_IDENTITY.binding as string };
  assert.throws(
    () => f.service.save(outsider, { scriptId: saved.scriptId, description: 'not mine' }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_FORBIDDEN',
  );
  assert.throws(
    () =>
      f.service.save(outsider, {
        scriptId: saved.scriptId,
        baseVersion: 1,
        code: 'return args.x + 2;',
        inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
      }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_FORBIDDEN',
  );
  assert.equal(f.service.get(saved.scriptId)?.description, 'owner edit', 'rejected writes change nothing');

  const adminUpdate = f.service.save(
    { createdBy: 'admin', isAdmin: true },
    { scriptId: saved.scriptId, description: 'admin edit' },
  );
  assert.equal(adminUpdate.version, 1);
  assert.equal(f.service.get(saved.scriptId)?.description, 'admin edit');
  assert.equal(f.service.get(saved.scriptId)?.createdBy, IDENTITY.binding, 'owner never changes');
});

test('draft versions are testable only by owner or admin; active versions are global', (t) => {
  const f = fixture(t);
  const saved = createDraft(f, 'draft-acl');
  const input = { scriptId: saved.scriptId, scriptVersion: saved.version, args: { x: 1 } };

  const owner = f.service.resolveExecution(input, {
    actor: { createdBy: IDENTITY.binding as string },
  });
  assert.equal(owner.purpose, 'test');

  assert.throws(
    () =>
      f.service.resolveExecution(input, {
        actor: { createdBy: OTHER_IDENTITY.binding as string },
      }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_FORBIDDEN',
  );
  assert.throws(
    () => f.service.resolveExecution(input),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_FORBIDDEN',
    'missing actor fails closed',
  );

  const admin = f.service.resolveExecution(input, {
    actor: { createdBy: 'admin', isAdmin: true },
  });
  assert.equal(admin.purpose, 'test');

  f.service.activate(saved.scriptId, saved.version, 'run_verified', {
    createdBy: IDENTITY.binding as string,
  });
  const outsider = f.service.resolveExecution(
    { scriptId: saved.scriptId, args: { x: 2 } },
    { actor: { createdBy: OTHER_IDENTITY.binding as string } },
  );
  assert.equal(outsider.purpose, 'run', 'the active version is executable by every agent');
});

test('run_script returns SCRIPT_FORBIDDEN when another agent tests a draft', async (t) => {
  const ownerFixture = fixture(t);
  const saved = createDraft(ownerFixture, 'tool-acl');

  const outsiderFixture = fixture(
    t,
    { ...OTHER_IDENTITY },
  );
  outsiderFixture.ctx.scripts = ownerFixture.service;
  const result = (await callTool(
    'run_script',
    { scriptId: saved.scriptId, scriptVersion: saved.version, args: { x: 1 } },
    outsiderFixture.ctx,
  )) as CallToolResult;
  assert.equal(result.isError, true);
  assert.match(resultText(result), /SCRIPT_FORBIDDEN/);

  const ownerResult = (await callTool(
    'run_script',
    { scriptId: saved.scriptId, scriptVersion: saved.version, args: { x: 1 } },
    ownerFixture.ctx,
  )) as CallToolResult;
  assert.equal(ownerResult.isError, false, 'the owner can still test its draft');
});

test('save and save_script report secret warnings without blocking or rewriting code', async (t) => {
  const f = fixture(t);
  const code = `const value = '${GITHUB_TOKEN}';\nreturn args.x + 1;`;
  const saved = f.service.save(
    { createdBy: IDENTITY.binding as string },
    {
      mode: 'parameterized',
      name: 'secret-warning',
      description: 'contains a provider token',
      code,
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'integer' },
          password: { type: 'string' },
        },
        required: ['x'],
        additionalProperties: false,
      },
      exampleArgs: { x: 1, password: PASSWORD },
    },
  );

  assert.equal(saved.status, 'draft', 'saving is never blocked');
  assert.deepEqual(
    saved.warnings.map((warning) => [warning.field, warning.kind, warning.count]).sort(),
    [
      ['code', 'provider_token', 1],
      ['exampleArgs', 'env_assignment', 1],
    ],
    'both the code and exampleArgs are scanned',
  );
  const stored = f.service.version(saved.scriptId, saved.version);
  assert.equal(stored.code, code, 'the stored code is not rewritten');

  const normal = f.service.save(
    { createdBy: IDENTITY.binding as string },
    {
      mode: 'parameterized',
      name: 'ordinary',
      description: 'nothing secret',
      code: 'return args.x + 1;',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'integer' } },
        required: ['x'],
        additionalProperties: false,
      },
      exampleArgs: { x: 3 },
    },
  );
  assert.deepEqual(normal.warnings, [], 'ordinary code raises no warning');

  const toolResult = (await callTool(
    'save_script',
    {
      mode: 'parameterized',
      name: 'secret-tool',
      description: 'saved through the tool',
      code: `const value = '${GITHUB_TOKEN}';\nreturn 1;`,
      inputSchema: { type: 'object', properties: {} },
    },
    f.ctx,
  )) as CallToolResult;
  assert.equal(toolResult.isError, false);
  const payload = JSON.parse(resultText(toolResult)) as {
    warnings: Array<{ field: string; kind: string; count: number }>;
  };
  assert.deepEqual(payload.warnings, [{ field: 'code', kind: 'provider_token', severity: 'high', count: 1 }]);
  const audit = f.audits.at(-1);
  assert.equal(audit?.['event'], 'script_saved');
  assert.deepEqual(audit?.['warnings'], payload.warnings);
});

test('an admin activation needs the actor; non-admins only activate their own script', (t) => {
  const f = fixture(t);
  const saved = createDraft(f, 'activate-acl');
  assert.throws(
    () =>
      f.service.activate(saved.scriptId, saved.version, 'run_x', {
        createdBy: OTHER_IDENTITY.binding as string,
      }),
    (error: unknown) => errorCodeOf(error) === 'SCRIPT_FORBIDDEN',
  );
  f.service.activate(saved.scriptId, saved.version, 'run_x', {
    createdBy: 'admin',
    isAdmin: true,
  });
  assert.equal(f.service.version(saved.scriptId, saved.version).status, 'active');
});
