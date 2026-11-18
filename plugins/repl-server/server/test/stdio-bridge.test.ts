// hook-allow: localhost-only test fetch, no external egress
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { assemble } from '../src/assembly.ts';

const INDEX = new URL('../src/index.ts', import.meta.url).pathname;

test('stdio bridge forwards JSON-RPC to the HTTP daemon', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'repl-stdio-'));
  const assembly = await assemble({ root, log: () => undefined });
  await new Promise<void>((resolve) => assembly.server.listen(0, '127.0.0.1', resolve));
  const address = assembly.server.address();
  assert.ok(address !== null && typeof address === 'object');
  const base = `http://127.0.0.1:${(address as AddressInfo).port}/mcp`;

  const bridge = spawn(process.execPath, [INDEX, '--stdio', '--url', base], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    bridge.kill('SIGTERM');
    await assembly.close();
    await rm(root, { recursive: true, force: true });
  });

  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge timed out')), 10_000);
    let buffer = '';
    bridge.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index >= 0) {
        clearTimeout(timer);
        resolve(buffer.slice(0, index));
      }
    });
    bridge.on('error', reject);
    bridge.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} })}\n`,
    );
  });

  const response = JSON.parse(line) as { id: number; result: { supportedVersions: string[] } };
  assert.equal(response.id, 1);
  assert.deepEqual(response.result.supportedVersions, ['2026-07-28']);
});
