import assert from 'node:assert/strict';
import test from 'node:test';

import { McpToolError, ReplError } from '../src/errors.ts';
import { LIMITS } from '../src/constants.ts';
import {
  DEFAULT_CALL_TIMEOUTS,
  ServeProxy,
  type ServeClient,
  type ServeToolResult,
} from '../src/bridge/serve-proxy.ts';

function reply(text: string, options: { isError?: boolean } = {}): ServeToolResult {
  return { content: [{ type: 'text', text }], ...(options.isError === true ? { isError: true } : {}) };
}

function client(handler: ServeClient['callTool']): ServeClient {
  return { callTool: handler };
}

function never(): Promise<ServeToolResult> {
  return new Promise<ServeToolResult>(() => {});
}

test('official Read results are normalized and the request carries args and a signal', async () => {
  const seen: Array<{ name: string; args: Record<string, unknown>; signal: AbortSignal }> = [];
  const proxy = new ServeProxy({
    client: client(async (request) => {
      seen.push(request);
      return reply(JSON.stringify({
        type: 'text',
        file: { filePath: '/tmp/a.txt', content: 'alpha\nbeta\n', numLines: 2, startLine: 1 },
      }));
    }),
  });

  const result = await proxy.call({ tool: 'Read', args: { file_path: '/tmp/a.txt' } });

  assert.deepEqual(result, {
    content: '     1→alpha\n     2→beta\n',
    file_path: '/tmp/a.txt',
    numLines: 2,
    startLine: 1,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.name, 'Read');
  assert.deepEqual(seen[0]!.args, { file_path: '/tmp/a.txt' });
  assert.equal(seen[0]!.signal.aborted, false);
});

test('official errors resolve { error } instead of rejecting', async () => {
  const proxy = new ServeProxy({
    client: client(async () => reply('Tool Edit input is invalid: String to replace not found in file.', { isError: true })),
  });

  assert.deepEqual(await proxy.call({ tool: 'Edit', args: {} }), {
    error: 'Tool Edit input is invalid: String to replace not found in file.',
  });
});

test('official transport failures resolve { error }', async () => {
  const proxy = new ServeProxy({
    client: client(async () => {
      throw new Error('serve exited');
    }),
  });

  assert.deepEqual(await proxy.call({ tool: 'Read', args: {} }), { error: 'serve exited' });
});

test('official non-JSON text falls back to the raw text', async () => {
  const proxy = new ServeProxy({ client: client(async () => reply('plain output')) });

  assert.equal(await proxy.call({ tool: 'Write', args: {} }), 'plain output');
});

test('third-party MCP tool errors throw McpToolError with the parsed body', async () => {
  const body = { message: 'rate limited', retryAfterMs: 250, retryable: true };
  const proxy = new ServeProxy({
    client: client(async () => reply(JSON.stringify(body), { isError: true })),
  });

  await assert.rejects(proxy.call({ server: 'pg', tool: 'query', args: {} }), (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.code, 'MCP_TOOL_ERROR');
    assert.equal(error.server, 'pg');
    assert.equal(error.tool, 'query');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 250);
    assert.equal(error.message, 'rate limited');
    assert.deepEqual(error.detail, body);
    return true;
  });
});

test('third-party MCP transport failures throw McpToolError', async () => {
  const proxy = new ServeProxy({
    client: client(async () => {
      throw Object.assign(new Error('socket closed'), { data: { detail: 'reset by peer' } });
    }),
  });

  await assert.rejects(proxy.call({ server: 'pg', tool: 'query', args: {} }), (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.code, 'MCP_CALL_FAILED');
    assert.equal(error.retryable, true);
    assert.deepEqual(error.detail, { detail: 'reset by peer' });
    return true;
  });
});

test('an AbortError thrown by the MCP client maps to MCP_CALL_CANCELLED', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const proxy = new ServeProxy({
    client: client(async () => {
      throw abort;
    }),
  });

  await assert.rejects(proxy.call({ server: 'pg', tool: 'query', args: {} }), (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.code, 'MCP_CALL_CANCELLED');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('a plain-text MCP error keeps the text as message and detail', async () => {
  const proxy = new ServeProxy({
    client: client(async () => reply('permission denied', { isError: true })),
  });

  await assert.rejects(proxy.call({ server: 'fs', tool: 'write', args: {} }), (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.code, 'MCP_TOOL_ERROR');
    assert.equal(error.message, 'permission denied');
    assert.equal(error.detail, 'permission denied');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('an empty MCP error still throws with a generic message', async () => {
  const proxy = new ServeProxy({
    client: client(async () => ({ content: [], isError: true })),
  });

  await assert.rejects(proxy.call({ server: 'pg', tool: 'query', args: {} }), (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.code, 'MCP_TOOL_ERROR');
    assert.equal(error.message, 'tool pg.query failed');
    assert.equal(error.detail, undefined);
    return true;
  });
});

test('visibleTools rejects names outside the set and never reaches the client', async () => {
  let calls = 0;
  const proxy = new ServeProxy({
    client: client(async () => {
      calls += 1;
      return reply('ok');
    }),
    visibleTools: ['Read', 'pg.query'],
  });

  await assert.rejects(proxy.call({ tool: 'Write', args: {} }), (error: unknown) => {
    assert.ok(error instanceof ReplError);
    assert.equal(error.name, 'ReplError');
    assert.equal(error.code, 'TOOL_NOT_VISIBLE');
    assert.equal(error.message, 'Write is not visible in this call');
    return true;
  });
  await assert.rejects(proxy.call({ server: 'pg', tool: 'insert', args: {} }), (error: unknown) => {
    assert.ok(error instanceof ReplError);
    assert.equal(error.name, 'ReplError');
    assert.equal(error.message, 'pg.insert is not visible in this call');
    return true;
  });
  assert.equal(calls, 0);

  assert.deepEqual(await proxy.call({ server: 'pg', tool: 'query', args: {} }), {
    text: 'ok',
    images: [],
    documents: [],
  });
  assert.equal(calls, 1);
});

test('MCP calls resolve their client by server', async () => {
  const officialCalls: string[] = [];
  const mcpCalls: string[] = [];
  const proxy = new ServeProxy({
    client: client(async ({ name }) => {
      officialCalls.push(name);
      return reply('official');
    }),
    mcpClient: (server) => client(async ({ name }) => {
      mcpCalls.push(`${server}.${name}`);
      return reply('mcp');
    }),
  });

  await proxy.call({ tool: 'Read', args: {} });
  await proxy.call({ server: 'pg', tool: 'query', args: {} });

  assert.deepEqual(officialCalls, ['Read']);
  assert.deepEqual(mcpCalls, ['pg.query']);
});

test('an official call past its L1 timeout resolves { error }', async () => {
  const proxy = new ServeProxy({ client: client(never), officialTimeoutMs: 10 });

  assert.deepEqual(await proxy.call({ tool: 'Read', args: {} }), {
    error: 'Read timed out after 10ms',
  });
});

test('an MCP call past its L1 timeout throws MCP_CALL_TIMEOUT', async () => {
  const proxy = new ServeProxy({ client: client(never), mcpTimeoutMs: 10 });

  await assert.rejects(proxy.call({ server: 'pg', tool: 'query', args: {} }), (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.code, 'MCP_CALL_TIMEOUT');
    assert.equal(error.retryable, true);
    assert.equal(error.server, 'pg');
    assert.equal(error.tool, 'query');
    assert.deepEqual(error.detail, { timeoutMs: 10 });
    return true;
  });
});

test('a per-call timeout overrides the default', async () => {
  const proxy = new ServeProxy({ client: client(never), officialTimeoutMs: 60_000 });

  assert.deepEqual(await proxy.call({ tool: 'Read', args: {}, timeoutMs: 10 }), {
    error: 'Read timed out after 10ms',
  });
});

test('an abort cancels an official call and propagates to the client signal', async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const proxy = new ServeProxy({
    client: client(({ signal }) => {
      seen = signal;
      return never();
    }),
    officialTimeoutMs: 60_000,
  });

  const pending = proxy.call({ tool: 'Read', args: {}, signal: controller.signal });
  await Promise.resolve();
  assert.ok(seen !== undefined);
  controller.abort();

  assert.deepEqual(await pending, { error: 'Read was cancelled' });
  assert.equal(seen.aborted, true);
});

test('an already-aborted signal resolves official { error } without calling the client', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const proxy = new ServeProxy({
    client: client(async () => {
      calls += 1;
      return reply('ok');
    }),
  });

  assert.deepEqual(await proxy.call({ tool: 'Read', args: {}, signal: controller.signal }), {
    error: 'Read was cancelled',
  });
  assert.equal(calls, 0);
});

test('an abort makes an MCP call throw MCP_CALL_CANCELLED', async () => {
  const controller = new AbortController();
  const proxy = new ServeProxy({ client: client(never), mcpTimeoutMs: 60_000 });

  const pending = proxy.call({ server: 'pg', tool: 'query', args: {}, signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.code, 'MCP_CALL_CANCELLED');
    assert.equal(error.retryable, false);
    assert.equal(error.server, 'pg');
    assert.equal(error.tool, 'query');
    return true;
  });
});

test('a client rejection after the timeout does not leak', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const proxy = new ServeProxy({
      client: client(() => new Promise<ServeToolResult>((_resolve, reject) => {
        setTimeout(() => reject(new Error('too late')), 25);
      })),
      officialTimeoutMs: 10,
    });

    assert.deepEqual(await proxy.call({ tool: 'Read', args: {} }), {
      error: 'Read timed out after 10ms',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('default L1 timeouts follow constants.ts', () => {
  assert.equal(DEFAULT_CALL_TIMEOUTS.officialMs, LIMITS.syncDefaultMs);
  assert.equal(DEFAULT_CALL_TIMEOUTS.mcpMs, LIMITS.syncDefaultMs * 2);
});
