// hook-allow: localhost-only test fetch, no external egress
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { assemble, type AssemblyOptions } from '../src/assembly.ts';
import { createClientBinding } from '../src/db/clients.ts';
import { getRevision } from '../src/db/meta.ts';
import { BUILTIN_SERVER_ID, OFFICIAL_SERVER_ID, createServer } from '../src/db/servers.ts';
import { upsertTool, getTool } from '../src/db/tools.ts';
import { searchTools as searchSnapshot } from '../src/tools/search.ts';

const ADMIN_TOKEN = 'test-admin-token';

interface Started {
  base: string;
  close: () => Promise<void>;
  root: string;
  assembly: Awaited<ReturnType<typeof assemble>>;
}

async function startIn(root: string, options: AssemblyOptions = {}): Promise<Started> {
  const assembly = await assemble({ root, log: () => undefined, ...options });
  await new Promise<void>((resolve) => assembly.server.listen(0, '127.0.0.1', resolve));
  const address = assembly.server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    base: `http://127.0.0.1:${(address as AddressInfo).port}`,
    root,
    assembly,
    close: async () => {
      await assembly.close();
    },
  };
}

async function start(options: AssemblyOptions = {}): Promise<Started> {
  const root = await mkdtemp(join(tmpdir(), 'repl-assembly-'));
  const started = await startIn(root, options);
  return {
    ...started,
    close: async () => {
      await started.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Applies env overrides for one test body, restoring them afterwards. */
async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function rpc(
  base: string,
  body: unknown,
  session?: string,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
      ...(session === undefined ? {} : { 'mcp-session-id': session }),
    },
    body: JSON.stringify(body),
  });
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}`, ...extra };
}

/** Races one promise against a timer, clearing the timer when it settles. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/** Reads SSE frames until `done(frames)` is true or the deadline passes. */
async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (frames: SseFrame[]) => boolean,
  timeoutMs = 8_000,
): Promise<SseFrame[]> {
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const next = await withTimeout(reader.read(), Math.max(1, deadline - Date.now()));
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = /^event: (.+)$/m.exec(raw)?.[1];
      const data = /^data: (.+)$/m.exec(raw)?.[1];
      if (event !== undefined && data !== undefined) {
        frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
      }
      boundary = buffer.indexOf('\n\n');
    }
    if (done(frames)) return frames;
  }
  return frames;
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
  assert.match(
    body.result.content[0]?.text ?? '',
    /<repl-output eval="\d+" run="[0-9a-f-]+"><result>42<\/result><\/repl-output>/,
  );
});

test('scripts call protocol tools by bare name, except run_script', async (t) => {
  const app = await start();
  t.after(app.close);
  const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';
  const run = async (id: number, code: string) => {
    const call = await rpc(
      app.base,
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'run_script', arguments: { code } } },
      session,
    );
    const body = (await call.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    return body.result;
  };

  const found = await run(2, 'const r = await tools.search_tools({ query: "" }); return Array.isArray(r)');
  assert.equal(found.isError, false, found.content[0]?.text);
  assert.match(found.content[0]?.text ?? '', /<result>true<\/result>/);

  const scripts = await run(3, 'const r = await tools.search_scripts({}); return Array.isArray(r.scripts)');
  assert.equal(scripts.isError, false, scripts.content[0]?.text);
  assert.match(scripts.content[0]?.text ?? '', /<result>true<\/result>/);

  const nested = await run(4, 'await tools.run_script({ code: "1" })');
  assert.match(nested.content[0]?.text ?? '', /run_script/);
  assert.match(nested.content[0]?.text ?? '', /not callable|TOOL_NOT_VISIBLE|nested/i);
});

test('tool_result events accumulate lifetime usage; denied calls do not', async (t) => {
  let calls = 0;
  const app = await start({
    callTool: async () => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return { ok: true };
    },
  });
  t.after(app.close);

  createServer(app.assembly.db, { id: 'fake', label: 'Fake', transport: 'stdio', command: 'node' });
  upsertTool(app.assembly.db, 'fake', {
    name: 'query',
    inputSchema: { type: 'object', properties: {} },
  });
  app.assembly.catalog.refreshServer('fake');

  const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';
  const run = async (id: number, code: string, extra: Record<string, unknown> = {}) =>
    await rpc(
      app.base,
      {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'run_script', arguments: { code, ...extra } },
      },
      session,
    );

  await run(2, 'return await tools.mcp.fake.query({});');
  let usage = getTool(app.assembly.db, 'fake', 'query');
  assert.ok(usage);
  assert.equal(usage.callCount, 1);
  assert.equal(usage.successCount, 1);
  assert.ok(usage.lastCalledAt !== null);

  await run(3, 'return await tools.mcp.fake.query({});');
  usage = getTool(app.assembly.db, 'fake', 'query');
  assert.ok(usage);
  assert.equal(usage.callCount, 2);
  assert.equal(usage.successCount, 1, 'a failed tool_result still counts as a call');

  // `visibleTools` denies before the transport, so no `tool_result` exists.
  await run(4, 'return await tools.mcp.fake.query({});', { visibleTools: ['fake.other'] });
  usage = getTool(app.assembly.db, 'fake', 'query');
  assert.ok(usage);
  assert.equal(usage.callCount, 2, 'tool_denied must not count');
  assert.equal(usage.successCount, 1);
});

test('admin tool test reuses the gateway transport without counting usage', async (t) => {
  await withEnv({ REPL_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
    const calls: Array<{ server?: string; tool: string; args: Record<string, unknown> }> = [];
    const app = await start({
      callTool: async (call) => {
        calls.push(call);
        if (call.tool === 'broken') throw new Error('boom');
        return { echoed: call.args };
      },
    });
    t.after(app.close);

    createServer(app.assembly.db, { id: 'fake', label: 'Fake', transport: 'stdio', command: 'node' });
    upsertTool(app.assembly.db, 'fake', {
      name: 'query',
      inputSchema: { type: 'object', properties: {} },
    });
    upsertTool(app.assembly.db, 'fake', {
      name: 'broken',
      inputSchema: { type: 'object', properties: {} },
    });
    app.assembly.catalog.refreshServer('fake');

    const post = async (path: string, body: unknown) =>
      await fetch(`${app.base}/admin/api${path}`, {
        method: 'POST',
        headers: adminHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      });

    const response = await post('/tools/fake/query/test', {
      args: { sql: 'select 1' },
      timeoutMs: 5_000,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ok: boolean;
      result: unknown;
      resultBytes: number;
      durationMs: number;
      testedAt: string;
    };
    assert.equal(body.ok, true);
    assert.deepEqual(body.result, { echoed: { sql: 'select 1' } });
    assert.ok(body.resultBytes > 0);
    assert.ok(body.durationMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(body.testedAt)));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.server, 'fake');
    assert.equal(calls[0]?.tool, 'query');

    // The admin test never goes through an eval's `tool_result`, so lifetime
    // usage (and the model-visible counters) stay untouched.
    const usage = getTool(app.assembly.db, 'fake', 'query');
    assert.ok(usage);
    assert.equal(usage.callCount, 0);
    assert.equal(usage.successCount, 0);
    assert.equal(usage.lastCalledAt, null);

    const failed = await post('/tools/fake/broken/test', {});
    assert.equal(failed.status, 200, 'tool failures stay HTTP 200');
    const failedBody = (await failed.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    assert.equal(failedBody.ok, false);
    assert.equal(failedBody.error.code, 'TOOL_CALL_FAILED');
    assert.equal(failedBody.error.message, 'boom');
    const failedUsage = getTool(app.assembly.db, 'fake', 'broken');
    assert.ok(failedUsage);
    assert.equal(failedUsage.callCount, 0);

    const builtin = await post('/tools/__builtin__/search_tools/test', {
      args: { query: 'query' },
    });
    assert.equal(builtin.status, 200);
    const builtinBody = (await builtin.json()) as {
      ok: boolean;
      result: { isError: boolean; content: Array<{ type: string; text: string }> };
    };
    assert.equal(builtinBody.ok, true);
    assert.equal(builtinBody.result.isError, false);
    assert.match(builtinBody.result.content[0]?.text ?? '', /fake\.query/);
    const builtinUsage = getTool(app.assembly.db, BUILTIN_SERVER_ID, 'search_tools');
    assert.ok(builtinUsage);
    assert.equal(builtinUsage.callCount, 0, 'admin builtin tests do not count as usage');

    const unsupported = await post('/tools/__builtin__/run_script/test', {
      args: { code: 'return 1' },
    });
    assert.equal(unsupported.status, 400);
    const unsupportedBody = (await unsupported.json()) as { error: { code: string } };
    assert.equal(unsupportedBody.error.code, 'TOOL_TEST_UNSUPPORTED');

    // `__official__` tools are bare: the call reaches the serve transport with
    // no `server`, exactly like a model call through the gateway.
    upsertTool(app.assembly.db, OFFICIAL_SERVER_ID, {
      name: 'Read',
      inputSchema: { type: 'object', properties: {} },
    });
    const official = await post('/tools/__official__/Read/test', {
      args: { file_path: '/tmp/x' },
    });
    assert.equal(official.status, 200);
    const officialBody = (await official.json()) as { ok: boolean; result: unknown };
    assert.equal(officialBody.ok, true);
    const officialCall = calls.at(-1);
    assert.equal(officialCall?.server, undefined);
    assert.equal(officialCall?.tool, 'Read');
    assert.deepEqual(officialBody.result, { echoed: { file_path: '/tmp/x' } });
  });
});

test('top-level builtin calls accumulate lifetime usage under __builtin__', async (t) => {
  const app = await start();
  t.after(app.close);
  const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';
  const call = async (id: number, name: string, args: Record<string, unknown>) =>
    await rpc(
      app.base,
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      session,
    );

  await call(2, 'search_tools', { query: 'sql' });
  const failed = await call(3, 'search_tools', { max: 0 });
  const body = (await failed.json()) as { result: { isError: boolean } };
  assert.equal(body.result.isError, true);

  const usage = getTool(app.assembly.db, BUILTIN_SERVER_ID, 'search_tools');
  assert.ok(usage);
  assert.equal(usage.callCount, 2);
  assert.equal(usage.successCount, 1, 'an isError result still counts as a call');
  assert.ok(usage.lastCalledAt !== null);
});

test('run_script reports the user line for a syntax error', async (t) => {
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
      params: { name: 'run_script', arguments: { code: 'const x = ;\nconsole.log(x)' } },
    },
    session,
  );
  const body = (await call.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(body.result.isError, true);
  const text = body.result.content[0]?.text ?? '';
  assert.match(text, /<error>Unexpected token '[^']*' \(line 1\)<\/error>/);
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
  const tools = (await list.json()) as {
    result: {
      resultType: string;
      ttlMs: number;
      cacheScope: string;
      tools: Array<{ name: string }>;
    };
  };
  assert.equal(tools.result.resultType, 'complete');
  assert.equal(tools.result.ttlMs, 0);
  assert.equal(tools.result.cacheScope, 'private');
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
    'run_script',
    'search_tools',
    'describe_tools',
    'wait_tasks',
    'report_problem',
    'save_script',
    'search_scripts',
  ]);

  // Declaring the tasks extension switches collection to tasks/get, so wait_tasks
  // disappears from the list and is rejected at call time.
  const tasksMeta = {
    _meta: {
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} },
      },
    },
  };
  const tasksList = await rpc(
    app.base,
    { jsonrpc: '2.0', id: 21, method: 'tools/list', params: tasksMeta },
    session,
  );
  const tasksTools = (await tasksList.json()) as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(tasksTools.result.tools.map((tool) => tool.name), [
    'run_script',
    'search_tools',
    'describe_tools',
    'report_problem',
    'save_script',
    'search_scripts',
  ]);

  const blocked = await rpc(
    app.base,
    {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'wait_tasks', arguments: { taskIds: ['t_missing'] }, ...tasksMeta },
    },
    session,
  );
  const blockedBody = (await blocked.json()) as { error?: { code: number } };
  assert.equal(blockedBody.error?.code, -32602);

  const search = await rpc(
    app.base,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_tools', arguments: {} } },
    session,
  );
  const searched = (await search.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(searched.result.isError, false);
  assert.ok(Array.isArray(JSON.parse(searched.result.content[0]?.text ?? 'null')));
});

test('search_tools serves non-empty queries from SQLite, not the cached snapshot', async (t) => {
  const app = await start();
  t.after(app.close);
  const db = app.assembly.db;

  createServer(db, {
    id: 'fresh',
    label: 'Fresh',
    transport: 'stdio',
    command: 'node',
    summary: 'Inserted without a catalog refresh',
  });
  upsertTool(db, 'fresh', {
    name: 'fresh_tool',
    description: 'Reachable only through the search port',
    inputSchema: { type: 'object' },
  });
  // The row is committed to SQLite but never refreshed into the in-memory
  // snapshot. Only a search_tools call routed to the FTS/LIKE port can see it.
  assert.deepEqual(
    searchSnapshot(app.assembly.catalog.snapshot(), { query: 'fresh_tool' }),
    [],
    'the cached snapshot never saw the row',
  );

  const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';
  await discover.json();
  const search = await rpc(
    app.base,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search_tools', arguments: { query: 'fresh_tool' } },
    },
    session,
  );
  const body = (await search.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(body.result.isError, false);
  assert.deepEqual(
    (JSON.parse(body.result.content[0]?.text ?? '[]') as Array<{ name: string }>).map(
      (item) => item.name,
    ),
    ['fresh.fresh_tool'],
  );
});

test('assembled server records full protocol frames with request and response payloads', async (t) => {
  const app = await start();
  t.after(app.close);

  const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';
  await discover.json();
  await rpc(app.base, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session);

  // Closing flushes the audit writers before the files are read; the wrapper's
  // `close` also removes the temp root, so flush the assembly directly.
  await app.assembly.close();
  const dir = join(app.root, 'repl-server', 'log');
  const files = (await readdir(dir)).filter(
    (name) => name.startsWith('events-') && name.endsWith('.jsonl'),
  );
  assert.ok(files.length > 0);
  const lines = (await readFile(join(dir, files[0]!), 'utf8')).trim().split('\n').filter(Boolean);
  const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const request = frames.find(
    (frame) => frame['event'] === 'proto_in' && frame['method'] === 'tools/list',
  );
  const response = frames.find(
    (frame) => frame['event'] === 'proto_out' && frame['method'] === 'tools/list',
  );
  assert.ok(request !== undefined);
  assert.ok(response !== undefined);
  // Small bodies stay inline. `tools/list` is hundreds of KB, so the row keeps
  // a ref plus a preview and the body lives under `payload/` (`09 §三`).
  assert.ok(request['params'] !== undefined, 'full mode must keep request payloads');
  const resultRef = response['resultRef'];
  assert.equal(typeof resultRef, 'string', 'full mode must keep response payloads');
  assert.equal('result' in response, false, 'an externalised body must not stay inline');
  const body = JSON.parse(await readFile(join(dir, String(resultRef)), 'utf8')) as {
    tools?: unknown[];
  };
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'the blob holds the full result');
});

test('run_script description and instructions follow the client binding visibility', async (t) => {
  const app = await start();
  t.after(app.close);
  const db = app.assembly.db;

  createServer(db, {
    id: 'alpha',
    label: 'Alpha',
    transport: 'stdio',
    command: 'node',
    summary: 'Alpha database tools',
    category: 'database',
    tags: ['db'],
  });
  createServer(db, {
    id: 'beta',
    label: 'Beta',
    transport: 'stdio',
    command: 'node',
    summary: 'Beta repository tools',
    category: 'vcs',
    tags: ['git'],
  });
  upsertTool(db, 'alpha', { name: 'query', inputSchema: { type: 'object' } });
  upsertTool(db, 'beta', { name: 'issues', inputSchema: { type: 'object' } });
  app.assembly.catalog.refreshServer('alpha');
  app.assembly.catalog.refreshServer('beta');

  const alphaClient = createClientBinding(db, {
    label: 'alpha only',
    allowedServers: ['alpha'],
  });
  const gitClient = createClientBinding(db, {
    label: 'git tags only',
    allowedTags: ['git'],
  });

  async function look(
    token?: string,
  ): Promise<{
    description: string;
    instructions: string;
    searchSchema: Record<string, unknown>;
  }> {
    const headers: Record<string, string> =
      token === undefined ? {} : { authorization: `Bearer ${token}` };
    const list = await rpc(
      app.base,
      { jsonrpc: '2.0', id: 11, method: 'tools/list' },
      undefined,
      headers,
    );
    const listed = (await list.json()) as {
      result: {
        tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      };
    };
    const runScript = listed.result.tools.find((tool) => tool.name === 'run_script');
    const searchTools = listed.result.tools.find((tool) => tool.name === 'search_tools');
    const description = runScript?.description ?? '';
    const searchSchema = searchTools?.inputSchema ?? {};

    const discover = await rpc(
      app.base,
      { jsonrpc: '2.0', id: 12, method: 'server/discover' },
      undefined,
      headers,
    );
    const discovered = (await discover.json()) as { result: { instructions: string } };
    return { description, instructions: discovered.result.instructions, searchSchema };
  }

  async function search(
    token: string | undefined,
    args: Record<string, unknown>,
  ): Promise<{
    isError: boolean;
    text: string;
    items: Array<{ name: string; category?: string; summary?: string }>;
  }> {
    const headers: Record<string, string> =
      token === undefined ? {} : { authorization: `Bearer ${token}` };
    const response = await rpc(
      app.base,
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'search_tools', arguments: args },
      },
      undefined,
      headers,
    );
    const body = (await response.json()) as {
      result: { isError: boolean; content: Array<{ type: string; text: string }> };
    };
    const text = body.result.content[0]?.text ?? 'null';
    return {
      isError: body.result.isError,
      text,
      items: JSON.parse(text) as Array<{ name: string; category?: string; summary?: string }>,
    };
  }

  const alpha = await look(alphaClient.token);
  assert.ok(alpha.description.includes('alpha  [database]  1 tools'));
  assert.ok(!alpha.description.includes('Alpha database tools'), 'summary stays out of the 2KB line');
  assert.ok(!alpha.description.includes('beta'));
  assert.ok(!alpha.description.includes('issues'));
  assert.ok(alpha.instructions.includes('skills/list'));
  assert.ok(!alpha.instructions.includes('- alpha'));
  assert.ok(!alpha.instructions.includes('- beta'));

  const alphaProperties = alpha.searchSchema['properties'] as Record<string, Record<string, unknown>>;
  assert.deepEqual(alphaProperties['server']?.['enum'], ['alpha']);
  assert.deepEqual(alphaProperties['category']?.['enum'], ['database']);
  assert.deepEqual((alphaProperties['tags']?.['items'] as Record<string, unknown>)?.['enum'], ['db']);

  const byServer = await search(alphaClient.token, { server: 'alpha' });
  assert.equal(byServer.isError, false);
  assert.deepEqual(byServer.items.map((item) => item.name), ['alpha.query']);
  assert.equal(byServer.items[0]?.category, 'database');
  assert.equal(byServer.items[0]?.summary, 'Alpha database tools');

  const invisibleServer = await search(alphaClient.token, { server: 'beta' });
  assert.equal(invisibleServer.isError, true);
  assert.match(invisibleServer.text, /INVALID_ARGUMENT/);

  const invisibleCategory = await search(alphaClient.token, { category: 'vcs' });
  assert.equal(invisibleCategory.isError, true, 'enum-out category is INVALID_ARGUMENT');

  const git = await look(gitClient.token);
  assert.ok(git.description.includes('beta  [vcs]  1 tools'));
  assert.ok(!git.description.includes('alpha'));
  assert.ok(git.instructions.includes('skills/list'));
  assert.ok(!git.instructions.includes('- beta'));
  assert.ok(!git.instructions.includes('- alpha'));
  const gitProperties = git.searchSchema['properties'] as Record<string, Record<string, unknown>>;
  assert.deepEqual(gitProperties['server']?.['enum'], ['beta']);
  assert.deepEqual((gitProperties['tags']?.['items'] as Record<string, unknown>)?.['enum'], ['git']);

  const unrestricted = await look();
  assert.ok(unrestricted.description.includes('alpha  [database]'));
  assert.ok(unrestricted.description.includes('beta  [vcs]'));
  assert.ok(unrestricted.instructions.includes('skills/list'));
  assert.ok(!unrestricted.instructions.includes('- alpha'));
  assert.ok(!unrestricted.instructions.includes('- beta'));
  assert.ok(Buffer.byteLength(unrestricted.description, 'utf8') <= 2048);
  const unrestrictedProperties = unrestricted.searchSchema['properties'] as Record<
    string,
    Record<string, unknown>
  >;
  assert.deepEqual(unrestrictedProperties['server']?.['enum'], ['alpha', 'beta']);
});

test('overview capacity reflects the REPL_CAPACITY_* limits', async (t) => {
  await withEnv(
    {
      REPL_ADMIN_TOKEN: ADMIN_TOKEN,
      REPL_CAPACITY_MAX_EXEC_SESSIONS: '3',
      REPL_CAPACITY_MAX_IN_FLIGHT_EVALS_PER_EXEC_SESSION: '5',
    },
    async () => {
      const app = await start();
      t.after(app.close);

      // hook-allow: localhost-only test fetch, no external egress
      const response = await fetch(`${app.base}/admin/api/overview`, {
        headers: adminHeaders(),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        capacity: Record<string, number>;
        bindings: unknown[];
        resources: {
          intervalMs: number;
          current: {
            selfRssBytes: number;
            childRssBytes: number;
            totalRssBytes: number;
          } | null;
        };
      };
      assert.deepEqual(body.capacity, {
        maxExecSessions: 3,
        maxExecSessionsPerBinding: 64,
        maxInFlightEvalsPerExecSession: 5,
        maxInFlightEvalsPerBinding: 256,
        maxServeProcesses: 64,
        maxWorkers: 64,
        maxInFlightCallsPerBindingPerServer: 64,
        maxQueuedCallsPerBindingPerServer: 256,
      });
      assert.deepEqual(body.bindings, []);
      assert.ok(body.resources.intervalMs > 0);
      assert.ok(body.resources.current !== null);
      assert.equal(
        body.resources.current.totalRssBytes,
        body.resources.current.selfRssBytes + body.resources.current.childRssBytes,
      );
    },
  );
});

test('persists resource samples as daily JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repl-resource-'));
  const app = await startIn(root);
  try {
    await app.close();
    const dir = join(root, 'repl-server', 'log');
    const names = await readdir(dir);
    const file = names.find((name) => /^metrics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
    assert.ok(file !== undefined, `metrics files: ${names.join(', ')}`);
    const lines = (await readFile(join(dir, file), 'utf8'))
      .trim()
      .split('\n')
      .filter((line) => line !== '');
    assert.ok(lines.length >= 1);
    const sample = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    assert.equal(sample['event'], 'resource_sample');
    assert.equal(typeof sample['ts'], 'string');
    assert.equal(typeof sample['totalRssBytes'], 'number');
    assert.ok(Array.isArray(sample['children']), 'per-child details reach the metrics file');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('switching discovery back to static refreshes the catalog', async (t) => {
  await withEnv({ REPL_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
    const app = await start();
    t.after(app.close);

    // hook-allow: localhost-only test fetch, no external egress
    const created = await fetch(`${app.base}/admin/api/servers`, {
      method: 'POST',
      headers: adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        id: 'scan',
        label: 'Scan',
        transport: 'http',
        url: 'https://example.test/mcp',
        toolDiscovery: { mode: 'search', searchTool: 'search_tools' },
      }),
    });
    assert.equal(created.status, 201);

    upsertTool(app.assembly.db, 'scan', {
      name: 'scan_tool',
      inputSchema: { type: 'object' },
      discoveredVia: 'search',
    });
    app.assembly.catalog.refreshServer('scan');
    assert.ok(
      app.assembly.catalog.snapshot().tools.some((tool) => tool.name === 'scan.scan_tool'),
      'the discovered row is visible before the switch',
    );

    // hook-allow: localhost-only test fetch, no external egress
    const patched = await fetch(`${app.base}/admin/api/servers/scan`, {
      method: 'PATCH',
      headers: adminHeaders({
        'content-type': 'application/json',
        'if-match': String(getRevision(app.assembly.db)),
      }),
      body: JSON.stringify({ toolDiscovery: { mode: 'static' } }),
    });
    assert.equal(patched.status, 200);
    assert.equal(
      app.assembly.catalog.snapshot().tools.some((tool) => tool.name === 'scan.scan_tool'),
      false,
      'the static switch demotes discovered rows and rebuilds the snapshot',
    );
  });
});

test('GET /clients reports live sessions and PUT destroys the binding sessions', async (t) => {
  await withEnv({ REPL_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
    const app = await start();
    t.after(app.close);

    // hook-allow: localhost-only test fetch, no external egress
    const created = await fetch(`${app.base}/admin/api/clients`, {
      method: 'POST',
      headers: adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'bound' }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { client: { id: string }; token: string };
    const clientAuth = { authorization: `Bearer ${createdBody.token}` };

    const discover = await rpc(
      app.base,
      { jsonrpc: '2.0', id: 1, method: 'server/discover' },
      undefined,
      clientAuth,
    );
    const session = discover.headers.get('mcp-session-id') ?? '';
    const call = await rpc(
      app.base,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'run_script',
          arguments: { code: 'return 1' },
          _meta: {
            'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.327' },
          },
        },
      },
      session,
      clientAuth,
    );
    assert.equal(call.status, 200);

    // hook-allow: localhost-only test fetch, no external egress
    const listed = await fetch(`${app.base}/admin/api/clients`, { headers: adminHeaders() });
    const listedBody = (await listed.json()) as {
      clients: Array<{ id: string; activeSessions: number }>;
      sessions: Array<{
        mcpSessionId: string;
        bindingId: string | null;
        client: string;
        clientName: string;
        clientVersion: string;
        execSessionIds?: string[];
      }>;
    };
    assert.equal(listedBody.clients[0]?.activeSessions, 1, 'activeSessions is no longer always 0');
    const listedSession = listedBody.sessions.find((entry) => entry.mcpSessionId === session);
    assert.equal(listedSession?.bindingId, createdBody.client.id);
    assert.equal(listedSession?.client, 'claude-code/2.1.327');
    assert.equal(listedSession?.clientName, 'claude-code');
    assert.equal(listedSession?.clientVersion, '2.1.327');
    assert.equal(listedSession?.execSessionIds?.length, 1);

    // hook-allow: localhost-only test fetch, no external egress
    const updated = await fetch(`${app.base}/admin/api/clients/${createdBody.client.id}`, {
      method: 'PUT',
      headers: adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'renamed' }),
    });
    assert.equal(updated.status, 200);
    assert.equal(
      ((await updated.json()) as { affectedSessions: number }).affectedSessions,
      1,
      'the live execution session is counted and destroyed',
    );

    // hook-allow: localhost-only test fetch, no external egress
    const again = await fetch(`${app.base}/admin/api/clients/${createdBody.client.id}`, {
      method: 'PUT',
      headers: adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'renamed-again' }),
    });
    assert.equal(((await again.json()) as { affectedSessions: number }).affectedSessions, 0);
  });
});

test('admin event stream publishes eval frames and the server_state payload', async (t) => {
  await withEnv({ REPL_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
    const app = await start();
    t.after(app.close);

    const controller = new AbortController();
    t.after(() => controller.abort());
    // hook-allow: localhost-only test fetch, no external egress
    const stream = await fetch(`${app.base}/admin/api/events`, {
      headers: {
        ...adminHeaders(),
        'last-event-id': '0',
      },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.ok(stream.body !== null);
    const reader = stream.body.getReader();

    const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
    const session = discover.headers.get('mcp-session-id') ?? '';
    const call = await rpc(
      app.base,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'run_script', arguments: { code: 'return 41 + 1' } },
      },
      session,
    );
    assert.equal(call.status, 200);

    const frames = await readFrames(reader, (seen) =>
      seen.some((frame) => frame.event === 'eval' && frame.data['phase'] === 'end'),
    );
    const evals = frames.filter((frame) => frame.event === 'eval').map((frame) => frame.data);
    const startFrame = evals.find((frame) => frame['phase'] === 'start');
    const endFrame = evals.find((frame) => frame['phase'] === 'end');
    assert.ok(startFrame !== undefined, 'the stream carries the eval start frame');
    assert.ok(endFrame !== undefined, 'the stream carries the eval end frame');
    assert.match(String(startFrame['execSessionId']), /^es_/);
    assert.equal(startFrame['binding'], null);
    assert.equal(startFrame['phase'], 'start');
    assert.equal(endFrame['ok'], true);
    assert.equal(typeof endFrame['evalId'], 'number');

    const serverState = frames.find((frame) => frame.event === 'server_state');
    assert.ok(serverState !== undefined, 'the startup pool snapshot is replayed');
    assert.ok(Array.isArray(serverState.data['entries']));
    assert.equal(typeof (serverState.data['pool'] as Record<string, unknown>)['total'], 'number');
  });
});

test('admin event stream publishes the operation payload', async (t) => {
  await withEnv({ REPL_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
    const app = await start();
    t.after(app.close);

    const controller = new AbortController();
    t.after(() => controller.abort());
    // hook-allow: localhost-only test fetch, no external egress
    const stream = await fetch(`${app.base}/admin/api/events`, {
      headers: { ...adminHeaders(), 'last-event-id': '0' },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.ok(stream.body !== null);
    const reader = stream.body.getReader();

    // hook-allow: localhost-only test fetch, no external egress
    const created = await fetch(`${app.base}/admin/api/servers`, {
      method: 'POST',
      headers: adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        id: 'dead',
        label: 'Dead',
        transport: 'http',
        url: 'http://127.0.0.1:9/mcp',
      }),
    });
    assert.equal(created.status, 201);

    // hook-allow: localhost-only test fetch, no external egress
    const connected = await fetch(`${app.base}/admin/api/servers/dead/connect`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    assert.equal(connected.status, 202);

    const frames = await readFrames(reader, (seen) =>
      seen.some(
        (frame) =>
          frame.event === 'operation'
          && frame.data['target'] === 'dead'
          && (frame.data['state'] === 'error' || frame.data['state'] === 'ok'),
      ),
      10_000,
    );
    const operation = frames
      .filter((frame) => frame.event === 'operation')
      .map((frame) => frame.data)
      .find(
        (data) =>
          data['target'] === 'dead' && (data['state'] === 'error' || data['state'] === 'ok'),
      );
    assert.ok(operation !== undefined, 'the connect operation is published');
    assert.equal(typeof operation['operationId'], 'string');
    assert.equal(operation['kind'], 'connect');
    assert.equal(operation['state'], 'error');
    assert.equal(typeof (operation['error'] as Record<string, unknown>)['message'], 'string');
  });
});

test('the lifecycle sweep expires idle transport sessions and cascades', async (t) => {
  const app = await start({ transportIdleMs: 10, sweepIntervalMs: 3_600_000 });
  t.after(app.close);

  const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const session = discover.headers.get('mcp-session-id') ?? '';
  assert.match(session, /^mcp_/);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const swept = await app.assembly.sweep();
  assert.ok(swept !== null);
  assert.equal(typeof swept?.recycled, 'number');

  const after = await rpc(app.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  assert.equal(after.status, 404);
});

test('close is idempotent and a disposed gateway rejects new evals', async (t) => {
  const app = await start();
  await app.assembly.close();
  await app.assembly.close();

  await assert.rejects(
    app.assembly.gateway.runScript({
      code: 'return 1;',
      timeoutMs: 1_000,
      async: false,
      identity: { identity: 'unbound', binding: null, client: '', mcp: 'mcp_closed' },
    }),
    (error: unknown) => (error as { code?: string }).code === 'MCP_SERVER_UNAVAILABLE',
  );

  await app.close();
});

test('PATCH /settings hot-applies capacity limits to every component', async (t) => {
  await withEnv({ REPL_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
    const app = await start();
    try {
      const before = await fetch(`${app.base}/admin/api/settings`, { headers: adminHeaders() });
      assert.equal(before.status, 200);
      const { revision } = (await before.json()) as { revision: number };

      const patched = await fetch(`${app.base}/admin/api/settings`, {
        method: 'PATCH',
        headers: adminHeaders({ 'content-type': 'application/json', 'if-match': String(revision) }),
        body: JSON.stringify({
          capacity: {
            maxExecSessions: 30,
            maxExecSessionsPerBinding: 10,
            maxWorkers: 30,
            maxServeProcesses: 30,
            maxInFlightEvalsPerExecSession: 4,
            maxInFlightCallsPerBindingPerServer: 2,
            maxQueuedCallsPerBindingPerServer: 5,
          },
        }),
      });
      assert.equal(patched.status, 200);

      const limits = app.assembly.gateway.sessions.limits;
      assert.equal(limits.maxExecSessions, 30);
      assert.equal(limits.maxExecSessionsPerBinding, 10);
      assert.equal(limits.maxInFlightEvalsPerExecSession, 4);
      assert.deepEqual(app.assembly.gateway.taskLimits, {
        capacity: Math.max(64, 30 * 4),
        ownerCapacity: Math.max(32, 10 * 4),
      });

      // The cold keys reach their live owners, not just the settings row.
      const capacity = app.assembly.capacity();
      assert.equal(capacity.maxServeProcesses, 30);
      assert.equal(capacity.maxWorkers, 30);
      assert.equal(capacity.maxInFlightCallsPerBindingPerServer, 2);
      assert.equal(capacity.maxQueuedCallsPerBindingPerServer, 5);
    } finally {
      await app.close();
    }
  });
});

test('maxWorkers limits how many execution sessions can exist', async (t) => {
  await withEnv(
    { REPL_ADMIN_TOKEN: ADMIN_TOKEN, REPL_CAPACITY_MAX_WORKERS: '1' },
    async () => {
      const app = await start();
      t.after(app.close);
      const firstWorkspace = join(app.root, 'ws-one');
      const secondWorkspace = join(app.root, 'ws-two');
      await mkdir(firstWorkspace, { recursive: true });
      await mkdir(secondWorkspace, { recursive: true });

      const discover = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
      const session = discover.headers.get('mcp-session-id') ?? '';
      const run = async (id: number, workspace: string) =>
        await rpc(
          app.base,
          {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'run_script', arguments: { code: 'return 1', workspace } },
          },
          session,
        );

      const first = (await (await run(2, firstWorkspace)).json()) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      assert.equal(first.result.isError, false);

      const second = (await (await run(3, secondWorkspace)).json()) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      assert.equal(second.result.isError, true);
      assert.match(
        second.result.content[0]?.text ?? '',
        /CAPACITY_EXCEEDED/,
        'a second workspace needs a second worker, which maxWorkers forbids',
      );
    },
  );
});

test('PATCH /settings caps the effective exec-session limit by maxWorkers', async (t) => {
  await withEnv({ REPL_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
    const app = await start();
    try {
      const before = await fetch(`${app.base}/admin/api/settings`, { headers: adminHeaders() });
      const { revision } = (await before.json()) as { revision: number };

      const patched = await fetch(`${app.base}/admin/api/settings`, {
        method: 'PATCH',
        headers: adminHeaders({ 'content-type': 'application/json', 'if-match': String(revision) }),
        body: JSON.stringify({
          capacity: { maxExecSessions: 30, maxWorkers: 4, maxServeProcesses: 30 },
        }),
      });
      assert.equal(patched.status, 200);

      // One worker per exec session: four workers mean four usable sessions,
      // while GET /settings keeps showing the raw values.
      assert.equal(app.assembly.capacity().maxExecSessions, 4);
      assert.equal(app.assembly.capacity().maxWorkers, 4);
      assert.equal(app.assembly.gateway.sessions.limits.maxExecSessions, 4);

      const view = await fetch(`${app.base}/admin/api/settings`, { headers: adminHeaders() });
      const settings = ((await view.json()) as { settings: { capacity: Record<string, number> } })
        .settings;
      assert.equal(settings.capacity['maxExecSessions'], 30);
      assert.equal(settings.capacity['maxWorkers'], 4);
    } finally {
      await app.close();
    }
  });
});

test('startup reads settings.capacity for every component', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'repl-assembly-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await withEnv({ REPL_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
    const first = await startIn(root);
    try {
      const before = await fetch(`${first.base}/admin/api/settings`, { headers: adminHeaders() });
      const { revision } = (await before.json()) as { revision: number };

      const patched = await fetch(`${first.base}/admin/api/settings`, {
        method: 'PATCH',
        headers: adminHeaders({ 'content-type': 'application/json', 'if-match': String(revision) }),
        body: JSON.stringify({
          capacity: {
            maxExecSessions: 6,
            maxWorkers: 3,
            maxServeProcesses: 6,
            maxInFlightCallsPerBindingPerServer: 1,
            maxQueuedCallsPerBindingPerServer: 2,
          },
        }),
      });
      assert.equal(patched.status, 200);
    } finally {
      await first.close();
    }

    const second = await startIn(root);
    try {
      const capacity = second.assembly.capacity();
      assert.equal(capacity.maxExecSessions, 3, 'min(maxExecSessions, maxWorkers) applies at boot');
      assert.equal(capacity.maxWorkers, 3);
      assert.equal(capacity.maxServeProcesses, 6);
      assert.equal(capacity.maxInFlightCallsPerBindingPerServer, 1);
      assert.equal(capacity.maxQueuedCallsPerBindingPerServer, 2);
      assert.equal(second.assembly.gateway.sessions.limits.maxExecSessions, 3);
    } finally {
      await second.close();
    }
  });
});

test('startup lets REPL_CAPACITY_* override stored settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'repl-assembly-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await withEnv({ REPL_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
    const first = await startIn(root);
    try {
      const before = await fetch(`${first.base}/admin/api/settings`, { headers: adminHeaders() });
      const { revision } = (await before.json()) as { revision: number };
      const patched = await fetch(`${first.base}/admin/api/settings`, {
        method: 'PATCH',
        headers: adminHeaders({ 'content-type': 'application/json', 'if-match': String(revision) }),
        body: JSON.stringify({ capacity: { maxExecSessions: 4, maxServeProcesses: 6 } }),
      });
      assert.equal(patched.status, 200);
    } finally {
      await first.close();
    }
  });

  await withEnv(
    {
      REPL_ADMIN_TOKEN: ADMIN_TOKEN,
      REPL_CAPACITY_MAX_SERVE_PROCESSES: '2',
      REPL_CAPACITY_MAX_QUEUED_CALLS_PER_BINDING_PER_SERVER: '3',
    },
    async () => {
      const second = await startIn(root);
      try {
        const capacity = second.assembly.capacity();
        assert.equal(capacity.maxServeProcesses, 2, 'env overrides the stored value at boot');
        assert.equal(capacity.maxQueuedCallsPerBindingPerServer, 3);
      } finally {
        await second.close();
      }
    },
  );
});

test('a rejected relation change is not written or applied', async (t) => {
  await withEnv({ REPL_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
    const app = await start();
    try {
      const before = await fetch(`${app.base}/admin/api/settings`, { headers: adminHeaders() });
      const { revision } = (await before.json()) as { revision: number };

      const rejected = await fetch(`${app.base}/admin/api/settings`, {
        method: 'PATCH',
        headers: adminHeaders({ 'content-type': 'application/json', 'if-match': String(revision) }),
        body: JSON.stringify({ capacity: { maxServeProcesses: 2 } }),
      });
      assert.equal(rejected.status, 422);
      const error = (await rejected.json()) as { error: { code: string } };
      assert.equal(error.error.code, 'INVALID_CAPACITY');

      const after = await fetch(`${app.base}/admin/api/settings`, { headers: adminHeaders() });
      const body = (await after.json()) as {
        revision: number;
        settings: { capacity: Record<string, number> };
      };
      assert.equal(body.revision, revision, 'a rejected PATCH must not bump the revision');
      assert.equal(body.settings.capacity['maxServeProcesses'], 64);
      assert.equal(app.assembly.capacity().maxServeProcesses, 64);
    } finally {
      await app.close();
    }
  });
});
