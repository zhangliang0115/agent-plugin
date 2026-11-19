import assert from 'node:assert/strict';
import test from 'node:test';

import { McpToolError } from '@zhangliang0115/repl-server-core';

import { createServeCallTool, type McpToolClient } from '../src/serve/adapter.ts';
import type { ServeClient } from '../src/serve/client.ts';

interface CallArgs {
  name: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function fakeServeClient(result: unknown, calls: CallArgs[] = []): ServeClient {
  return {
    callTool: async (name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number) => {
      calls.push({ name, args, signal, timeoutMs });
      return result;
    },
  } as unknown as ServeClient;
}

function request(tool: string, args: Record<string, unknown> = {}, server?: string) {
  return { evalId: 1, epoch: 1, callSeq: 1, tool, args, ...(server === undefined ? {} : { server }) };
}

test('official results keep image and PDF blocks instead of flattening to text', async () => {
  const calls: CallArgs[] = [];
  const client = fakeServeClient(
    {
      content: [
        { type: 'text', text: '{"file":{"content":"one\\ntwo\\n","startLine":1,"numLines":2}}' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a.pdf', mimeType: 'application/pdf', blob: 'cGRm' } },
      ],
      isError: false,
    },
    calls,
  );
  const adapter = createServeCallTool(client);

  const result = (await adapter(request('Read', { file_path: '/a' }))) as Record<string, unknown>;
  assert.match(String(result['content']), /one\n.*two/);
  assert.deepEqual(result['images'], [{ base64: 'aW1n', mediaType: 'image/png' }]);
  assert.deepEqual(result['documents'], [{ base64: 'cGRm' }]);
  assert.equal(calls[0]?.name, 'Read');
});

test('official failures resolve { error } and keep Bash structured', async () => {
  const failing = createServeCallTool(
    fakeServeClient({ content: [{ type: 'text', text: 'file not found' }], isError: true }),
  );
  assert.deepEqual(await failing(request('Read', { file_path: '/missing' })), { error: 'file not found' });

  const bash = createServeCallTool(
    fakeServeClient({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ stdout: 'hi\n', stderr: '', exitCode: 0 }),
        },
      ],
    }),
  );
  assert.deepEqual(await bash(request('Bash', { command: 'echo hi' })), {
    stdout: 'hi\n',
    stderr: '',
    exitCode: 0,
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  });
});

test('MCP results use normalizeMcpResult and forward the signal and deadline', async () => {
  const calls: CallArgs[] = [];
  const mcp: McpToolClient = {
    callTool: async (name, args, signal, timeoutMs) => {
      calls.push({ name, args, signal, timeoutMs });
      return {
        content: [
          { type: 'text', text: 'done' },
          { type: 'image', data: 'aW1n', mimeType: 'image/png' },
          { type: 'image', data: 'cGRm', mimeType: 'application/pdf' },
        ],
      };
    },
  };
  const adapter = createServeCallTool(fakeServeClient(null), { mcp: (server) => (server === 'pg' ? mcp : undefined) });
  const controller = new AbortController();
  const deadline = Date.now() + 5_000;

  const result = await adapter(request('query', { sql: 'select 1' }, 'pg'), {
    signal: controller.signal,
    deadline,
  });
  assert.deepEqual(result, {
    text: 'done',
    images: [{ base64: 'aW1n', mediaType: 'image/png' }],
    documents: [{ base64: 'cGRm' }],
  });
  assert.equal(calls[0]?.signal, controller.signal);
  assert.ok((calls[0]?.timeoutMs ?? 0) > 0);
});

test('unwired MCP routing still fails with MCP_SERVER_UNAVAILABLE', async () => {
  const adapter = createServeCallTool(fakeServeClient(null));
  await assert.rejects(
    adapter(request('query', {}, 'pg')),
    (error: unknown) =>
      error instanceof McpToolError &&
      error.code === 'MCP_SERVER_UNAVAILABLE' &&
      error.server === 'pg',
  );
});

test('a legacy mcp. tool name fails explicitly', async () => {
  const adapter = createServeCallTool(fakeServeClient(null));
  await assert.rejects(
    adapter(request('mcp.pg.query', {})),
    (error: unknown) => error instanceof McpToolError && error.code === 'MCP_SERVER_UNAVAILABLE',
  );
});
