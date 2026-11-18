// hook-allow: localhost-only test fetch, no external egress
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { assemble } from '../src/assembly.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'fake-serve', 'claude');

async function start(): Promise<{ base: string; close: () => Promise<void>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'repl-serve-'));
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

test('run_script calls official tools through a fake claude mcp serve', async (t) => {
  await chmod(FAKE, 0o755);
  const previous = process.env['REPL_CLAUDE_BIN'];
  process.env['REPL_CLAUDE_BIN'] = FAKE;
  const app = await start();
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env['REPL_CLAUDE_BIN'];
    else process.env['REPL_CLAUDE_BIN'] = previous;
  });

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
        arguments: { code: "const r = await tools.Bash({ command: 'echo hi' }); return r.stdout" },
      },
    },
    session,
  );
  const body = (await call.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(body.result.isError, false, body.result.content[0]?.text);
  assert.match(body.result.content[0]?.text ?? '', /<result>hi\n<\/result>/);
});
