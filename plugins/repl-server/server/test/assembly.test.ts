// hook-allow: localhost-only test fetch, no external egress
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { assemble } from '../src/assembly.ts';

async function start(): Promise<{ base: string; close: () => Promise<void>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'repl-assembly-'));
  const assembly = await assemble({ root, log: () => undefined });
  await new Promise<void>((resolve) => assembly.server.listen(0, '127.0.0.1', resolve));
  const address = assembly.server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    base: `http://127.0.0.1:${(address as AddressInfo).port}`,
    root,
    close: async () => {
      await assembly.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function rpc(base: string, body: unknown, session?: string) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session === undefined ? {} : { 'mcp-session-id': session }),
    },
    body: JSON.stringify(body),
  });
}

test('admin API accepts the admin token and creates a client binding', async (t) => {
  // hook-allow: localhost-only test fetch, no external egress
  const previous = process.env['REPL_ADMIN_TOKEN'];
  process.env['REPL_ADMIN_TOKEN'] = 'test-admin-token';
  const app = await start();
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env['REPL_ADMIN_TOKEN'];
    else process.env['REPL_ADMIN_TOKEN'] = previous;
  });

  const overview = await fetch(`${app.base}/admin/api/overview`, {
    headers: { authorization: 'Bearer test-admin-token' },
  });
  assert.equal(overview.status, 200);

  const created = await fetch(`${app.base}/admin/api/clients`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'test-client' }),
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { token?: string };
  assert.ok((body.token ?? '').length >= 32);
});

test('run_script executes JavaScript end to end', async (t) => {
  const app = await start();
  t.after(app.close);
  const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';

  const call = await rpc(
    app.base,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'run_script', arguments: { code: 'const a = 20; return a + 22' } },
    },
    session,
  );
  const body = (await call.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(body.result.isError, false);
  assert.match(body.result.content[0]?.text ?? '', /<repl-output eval="\d+"><result>42<\/result><\/repl-output>/);
});

test('async run_script returns a task and wait_tasks collects it', async (t) => {
  const app = await start();
  t.after(app.close);
  const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';

  const call = await rpc(
    app.base,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'run_script',
        arguments: { code: 'await Promise.resolve(); return 7', async: true },
      },
    },
    session,
  );
  const body = (await call.json()) as { result: { content: Array<{ text: string }> } };
  const text = body.result.content[0]?.text ?? '';
  const taskId = /task="([^"]+)"/.exec(text)?.[1];
  assert.ok(taskId !== undefined, text);

  const waited = await rpc(
    app.base,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'wait_tasks', arguments: { taskIds: [taskId] } },
    },
    session,
  );
  const waitedBody = (await waited.json()) as { result: { content: Array<{ text: string }>; isError: boolean } };
  assert.equal(waitedBody.result.isError, false);
  const payload = JSON.parse(waitedBody.result.content[0]?.text ?? '{}') as {
    events: Array<{ taskId: string; status: string; result: string }>;
  };
  assert.equal(payload.events[0]?.taskId, taskId);
  assert.equal(payload.events[0]?.status, 'completed');
  assert.match(payload.events[0]?.result ?? '', /<result>7<\/result>/);
});

test('assembled server answers discover, tools/list and search_tools', async (t) => {
  const app = await start();
  t.after(app.close);

  const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  assert.equal(discover.status, 200);
  const session = discover.headers.get('mcp-session-id') ?? '';
  const discovered = (await discover.json()) as { result: { supportedVersions: string[] } };
  assert.deepEqual(discovered.result.supportedVersions, ['2026-07-28']);

  const list = await rpc(app.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  const tools = (await list.json()) as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
    'run_script',
    'search_tools',
    'describe_tools',
    'wait_tasks',
    'report_problem',
  ]);

  const search = await rpc(
    app.base,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_tools', arguments: {} } },
    session,
  );
  const searched = (await search.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(searched.result.isError, false);
  assert.ok(Array.isArray(JSON.parse(searched.result.content[0]?.text ?? 'null')));
});
