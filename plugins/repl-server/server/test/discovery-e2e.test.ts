import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ToolCallRequest } from '@zhangliang0115/repl-server-core/src/types.ts';

import {
  createAdminDiscoveryHandler,
} from '../src/discovery/handler.ts';
import { decodeStoredDiscovery } from '../src/discovery/config.ts';
import {
  createDiscoveryService,
  type DiscoveryServerRecord,
  type DiscoveryServerSource,
  type DiscoveryService,
} from '../src/discovery/service.ts';
import { createPoolRuntime, type PoolRuntime, type PoolRuntimeServerRecord } from '../src/pool/runtime.ts';
import { mcpClientFactory, mcpTransportFactory } from '../src/pool/adapters/client.ts';
import { openStateDb } from '../src/db/migrate.ts';
import { getRevision } from '../src/db/meta.ts';
import { createServer, getServer } from '../src/db/servers.ts';
import { getTool, upsertTool } from '../src/db/tools.ts';
import type { AdminHandler, AdminRequest, AdminResponse } from '../src/admin/servers.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(TEST_DIR, 'fixtures/discovery-mcp/server.mjs');

interface Fixture {
  child: ChildProcess;
  url: string;
}

async function startFixture(t: TestContext, args: string[] = []): Promise<Fixture> {
  const child = spawn(process.execPath, [FIXTURE, '--port', '0', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit').then(() => undefined);
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let stderr = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture start timeout: ${stderr}`)), 5_000);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      const match = /fixture listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(`${match[1]}/mcp`);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited with ${code}: ${stderr}`));
    });
  });
  return { child, url };
}

interface Harness {
  db: ReturnType<typeof openStateDb>;
  runtime: PoolRuntime;
  handler: AdminHandler;
  refreshes: string[];
}

function harness(db: ReturnType<typeof openStateDb>, url: string): Harness {
  createServer(db, {
    id: 'lazy',
    label: 'Lazy',
    transport: 'http',
    url,
    discoveryJson: JSON.stringify({ mode: 'search', searchTool: 'search_tools' }),
  });

  const serverSource: DiscoveryServerSource = {
    get(id: string): DiscoveryServerRecord | null {
      const row = getServer(db, id);
      if (row === null) return null;
      return {
        id: row.id,
        transport: row.transport,
        enabled: row.enabled,
        toolDiscovery: decodeStoredDiscovery(row.discoveryJson),
      };
    },
    revision: () => getRevision(db),
  };

  const runtimeRecords = {
    async get(id: string): Promise<PoolRuntimeServerRecord | null> {
      const row = getServer(db, id);
      if (row === null) return null;
      return {
        id: row.id,
        transport: row.transport,
        command: row.command,
        args: row.args,
        env: row.env,
        cwd: row.cwd,
        url: row.url,
        headers: row.headers,
        enabled: row.enabled,
        revision: row.revision,
        connectMode: row.connectMode,
        toolDiscovery: decodeStoredDiscovery(row.discoveryJson),
      };
    },
  };

  const refreshes: string[] = [];
  let service!: DiscoveryService;
  const runtime = createPoolRuntime({
    servers: runtimeRecords,
    secrets: { get: async () => undefined },
    transportFactory: mcpTransportFactory,
    clientFactory: mcpClientFactory,
    health: false,
    connectTimeoutMs: 5_000,
    callTimeoutMs: 10_000,
    policies: {
      get: (serverId, toolName) => {
        const row = getTool(db, serverId, toolName);
        return row === null
          ? null
          : {
              concurrency: row.concurrency,
              enabled: row.enabled,
              discoveredVia: row.discoveredVia,
              stale: row.stale,
              staleOverride: row.staleOverride,
            };
      },
    },
    onTools: async (serverId, tools) => {
      for (const tool of tools) {
        upsertTool(db, serverId, {
          name: tool.name,
          description: tool.description ?? null,
          inputSchema: tool.inputSchema ?? {},
        });
      }
    },
    // The provider closes over the service, which needs the runtime; the call
    // only happens after both are constructed.
    prepareProvider: (serverId, toolName) => service.prepareProvider(serverId, toolName),
  });

  service = createDiscoveryService({
    db,
    servers: serverSource,
    catalog: {
      refreshServer: (serverId: string) => {
        refreshes.push(serverId);
      },
    },
    pool: runtime,
  });

  return {
    db,
    runtime,
    handler: createAdminDiscoveryHandler({ service }),
    refreshes,
  };
}

function request(method: string, url: string, body?: unknown, ifMatch?: number): AdminRequest {
  const headers: Record<string, string> = {};
  if (ifMatch !== undefined) headers['if-match'] = String(ifMatch);
  const value: AdminRequest = { method, path: url, headers };
  if (body !== undefined) value.body = body;
  return value;
}

async function call(handler: AdminHandler, value: AdminRequest): Promise<AdminResponse> {
  const response = await handler(value);
  assert.ok(response !== null, `expected ${value.method} ${value.path} to be handled`);
  return response;
}

function bodyOf(response: AdminResponse): Record<string, unknown> {
  assert.ok(typeof response.body === 'object' && response.body !== null);
  return response.body as Record<string, unknown>;
}

async function requestLog(fixture: Fixture): Promise<Array<{ tool: string; args: unknown }>> {
  const base = fixture.url.replace(/\/mcp$/, '');
  const response = await fetch(`${base}/log`);
  const body = (await response.json()) as { requests: Array<{ tool: string; args: unknown }> };
  return body.requests;
}

function toolCall(tool: string): ToolCallRequest {
  return { evalId: 1, epoch: 1, callSeq: 1, server: 'lazy', tool, args: {} };
}

test('E-01: preview → apply → prepared run_script call over a real HTTP MCP server', async (t) => {
  const fixture = await startFixture(t, ['--strict', '--shape', 'call_result_tools', '--elements', '3']);
  const env = harness(openStateDb(':memory:'), fixture.url);
  t.after(async () => {
    await env.runtime.dispose();
  });

  // Connect so tools/list publishes the static search tool.
  await env.runtime.control.connect('lazy');
  assert.ok(getTool(env.db, 'lazy', 'search_tools'));

  // Before discovery the lazy tool is unknown to the upstream session.
  await assert.rejects(env.runtime.callTool(toolCall('list_tables')), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'METHOD_NOT_FOUND');
    return true;
  });

  const noMatch = await call(
    env.handler,
    request('POST', '/admin/api/servers/lazy/tools/discover', {
      preview: false,
      discoveryId: 'disc_x',
    }),
  );
  assert.equal(noMatch.status, 400);
  assert.equal((bodyOf(noMatch)['error'] as Record<string, unknown>)['code'], 'IF_MATCH_REQUIRED');

  const unknownField = await call(
    env.handler,
    request('POST', '/admin/api/servers/lazy/tools/discover', { wat: true }),
  );
  assert.equal(unknownField.status, 400);
  assert.equal((bodyOf(unknownField)['error'] as Record<string, unknown>)['code'], 'UNKNOWN_FIELD');

  const secretPreview = await call(
    env.handler,
    request('POST', '/admin/api/servers/lazy/tools/discover', {
      searchTool: 'search_tools',
      args: { token: { $secret: 'TOKEN' } },
    }),
  );
  assert.equal(secretPreview.status, 422);
  assert.equal(
    (bodyOf(secretPreview)['error'] as Record<string, unknown>)['code'],
    'DISCOVERY_SECRET_NOT_ALLOWED',
  );

  const preview = await call(
    env.handler,
    request('POST', '/admin/api/servers/lazy/tools/discover', {
      searchTool: 'search_tools',
      query: 'table',
    }),
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const previewBody = bodyOf(preview);
  assert.equal(previewBody['parsed'], true);
  assert.equal(previewBody['shape'], 'call_result_tools');
  const previewTools = previewBody['tools'] as Array<Record<string, unknown>>;
  assert.deepEqual(
    previewTools.map((tool) => tool['name']),
    ['list_tables', 'tool_1', 'tool_2'],
  );
  assert.ok(previewTools.every((tool) => tool['action'] === 'create'));
  assert.deepEqual(
    (previewBody['effectiveConfig'] as Record<string, unknown>)['args'],
    {},
  );
  assert.equal(getTool(env.db, 'lazy', 'list_tables'), null, 'preview wrote no rows');

  const apply = await call(
    env.handler,
    request(
      'POST',
      '/admin/api/servers/lazy/tools/discover',
      { preview: false, discoveryId: previewBody['discoveryId'] },
      getRevision(env.db),
    ),
  );
  assert.equal(apply.status, 200, JSON.stringify(apply.body));
  assert.deepEqual(bodyOf(apply), {
    serverId: 'lazy',
    applied: 3,
    created: 3,
    updated: 0,
    skippedStatic: 0,
    skippedOther: 0,
    stale: 0,
    revision: getRevision(env.db),
  });
  assert.equal(getTool(env.db, 'lazy', 'list_tables')?.discoveredVia, 'search');
  assert.deepEqual(env.refreshes, ['lazy']);

  const result = (await env.runtime.callTool(toolCall('list_tables'))) as {
    content: Array<{ text: string }>;
  };
  assert.equal(result.content[0]?.text, 'ok:list_tables');

  const afterFirst = (await requestLog(fixture)).map((entry) => entry.tool);
  assert.deepEqual(afterFirst.slice(-2), ['search_tools', 'list_tables']);

  await env.runtime.callTool(toolCall('list_tables'));
  const afterSecond = (await requestLog(fixture)).map((entry) => entry.tool);
  assert.deepEqual(afterSecond.slice(-1), ['list_tables'], 'the prepared cache is hit');
});

test('A-10: a JSON-RPC search failure maps to DISCOVERY_SEARCH_TOOL_ERROR', async (t) => {
  const fixture = await startFixture(t, ['--fail-search', 'rpc']);
  const env = harness(openStateDb(':memory:'), fixture.url);
  t.after(async () => {
    await env.runtime.dispose();
  });

  await env.runtime.control.connect('lazy');
  const response = await call(
    env.handler,
    request('POST', '/admin/api/servers/lazy/tools/discover', {
      searchTool: 'search_tools',
      timeoutMs: 1_000,
    }),
  );
  assert.equal(response.status, 503);
  const error = bodyOf(response)['error'] as Record<string, unknown>;
  assert.equal(error['code'], 'DISCOVERY_SEARCH_TOOL_ERROR');
});

test('P-11 via fixture: preview paginates with cursor and reports nextCursor', async (t) => {
  const fixture = await startFixture(t, [
    '--shape',
    'tools_object',
    '--tools-count',
    '3',
    '--page-size',
    '2',
  ]);
  const env = harness(openStateDb(':memory:'), fixture.url);
  t.after(async () => {
    await env.runtime.dispose();
  });
  await env.runtime.control.connect('lazy');

  const first = await call(
    env.handler,
    request('POST', '/admin/api/servers/lazy/tools/discover', {
      searchTool: 'search_tools',
      timeoutMs: 2_000,
    }),
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstBody = bodyOf(first);
  assert.deepEqual(
    (firstBody['tools'] as Array<Record<string, unknown>>).map((tool) => tool['name']),
    ['list_tables', 'tool_1'],
  );
  assert.equal(firstBody['nextCursor'], '2');
  assert.equal(firstBody['partial'], true);

  const second = await call(
    env.handler,
    request('POST', '/admin/api/servers/lazy/tools/discover', {
      searchTool: 'search_tools',
      cursor: '2',
      timeoutMs: 2_000,
    }),
  );
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const secondBody = bodyOf(second);
  assert.deepEqual(
    (secondBody['tools'] as Array<Record<string, unknown>>).map((tool) => tool['name']),
    ['tool_2'],
  );
  assert.equal(secondBody['nextCursor'], null);
  assert.equal(secondBody['partial'], false);
});

test('A-01/A-04: preview needs no If-Match, and a stale preview id is a 404', async (t) => {
  const fixture = await startFixture(t, ['--shape', 'tools_object', '--elements', '1']);
  const env = harness(openStateDb(':memory:'), fixture.url);
  t.after(async () => {
    await env.runtime.dispose();
  });

  await env.runtime.control.connect('lazy');
  const preview = await call(
    env.handler,
    request('POST', '/admin/api/servers/lazy/tools/discover', { searchTool: 'search_tools' }),
  );
  assert.equal(preview.status, 200);
  assert.equal(getRevision(env.db), getRevision(env.db));

  const missing = await call(
    env.handler,
    request(
      'POST',
      '/admin/api/servers/lazy/tools/discover',
      { preview: false, discoveryId: 'disc_unknown' },
      getRevision(env.db),
    ),
  );
  assert.equal(missing.status, 404);
  assert.equal((bodyOf(missing)['error'] as Record<string, unknown>)['code'], 'DISCOVERY_PREVIEW_NOT_FOUND');
});
