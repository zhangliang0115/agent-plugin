/** End to end: a real stdio MCP server's media blocks survive result normalization. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ToolCallRequest } from '@zhangliang0115/repl-server-core/src/types.ts';

import { mcpClientFactory, mcpTransportFactory } from '../src/pool/adapters/client.ts';
import {
  createPoolRuntime,
  type PoolRuntimeServerRecord,
} from '../src/pool/runtime.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/media-mcp/server.mjs', import.meta.url));

function mediaRecord(): PoolRuntimeServerRecord {
  return {
    id: 'media',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    cwd: null,
    url: null,
    headers: {},
    enabled: true,
    revision: 1,
  };
}

test('a real MCP stdio tools/call result is normalized to text plus media', async (t) => {
  const runtime = createPoolRuntime({
    servers: { get: async (id) => (id === 'media' ? mediaRecord() : null) },
    secrets: { get: async () => undefined },
    transportFactory: mcpTransportFactory,
    clientFactory: mcpClientFactory,
    health: false,
    autoReconnect: false,
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  t.after(async () => {
    await runtime.dispose();
  });

  const call: ToolCallRequest = {
    evalId: 1,
    epoch: 1,
    callSeq: 1,
    server: 'media',
    tool: 'fetch',
    args: {},
  };

  assert.deepEqual(await runtime.callTool(call), {
    text: 'saved',
    images: [{ base64: 'aW1n', mediaType: 'image/png' }],
    documents: [{ base64: 'cGRm' }],
  });
});
