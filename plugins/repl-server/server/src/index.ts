#!/usr/bin/env node
import { join } from 'node:path';

import { newId, releaseInstanceLock, startupSweep } from '@zhangliang0115/repl-server-core';

import { FRAME_MODES, type FrameMode } from './audit/frames.ts';
import { assemble } from './assembly.ts';
import { stateDbPath } from './local-tokens.ts';
import { runStdioBridge } from './stdio-bridge.ts';

interface CliOptions {
  port: number;
  strictAuth: boolean;
  stdio: boolean;
  url: string;
  tokenFile: string | undefined;
  frameMode: FrameMode | undefined;
}

function stringArg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readOptions(argv: readonly string[]): CliOptions {
  const raw = stringArg(argv, '--port') ?? process.env['REPL_SERVER_PORT'];
  const port = Number(raw ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`repl-server: invalid port ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  const rawFrameMode = stringArg(argv, '--frame-mode') ?? process.env['REPL_FRAME_MODE'];
  if (rawFrameMode !== undefined && !(FRAME_MODES as readonly string[]).includes(rawFrameMode)) {
    console.error(
      `repl-server: invalid frame mode ${JSON.stringify(rawFrameMode)} (expected ${FRAME_MODES.join('|')})`,
    );
    process.exit(2);
  }
  return {
    port,
    strictAuth: argv.includes('--strict-auth'),
    stdio: argv.includes('--stdio'),
    url: stringArg(argv, '--url') ?? 'http://127.0.0.1:8787/mcp',
    tokenFile: stringArg(argv, '--token-file'),
    frameMode: rawFrameMode as FrameMode | undefined,
  };
}

const options = readOptions(process.argv.slice(2));
if (options.stdio) {
  process.exitCode = await runStdioBridge({
    url: options.url,
    ...(options.tokenFile === undefined ? {} : { tokenFile: options.tokenFile }),
    log: (line) => console.error(line),
  });
} else {
  const host = '127.0.0.1';
  const root = process.env['AGENTS_HOME'];
  const dataRoot = join(stateDbPath(root === undefined ? undefined : `${root}/repl-server`), '..');
  const bootId = newId('boot');
  const sweep = startupSweep({ root: dataRoot, bootId });
  console.error(
    `repl-server: startup sweep ${sweep.status} boot=${bootId} killed=${sweep.killed.length} ai-runs-cleaned=${sweep.cleanedAiRuns.length} orphans=${sweep.reportPath ?? 'none'}`,
  );
  if (sweep.status === 'locked') {
    console.error('repl-server: another instance holds the instance lock');
    process.exit(1);
  }

  const assembly = await assemble({
    strictAuth: options.strictAuth,
    bootId,
    ...(options.frameMode === undefined ? {} : { frameMode: options.frameMode }),
  });

  assembly.server.listen(options.port, host, () => {
    // stdout is reserved for the stdio bridge; logs go to stderr.
    const address = assembly.server.address();
    const actual = address !== null && typeof address === 'object' ? address.port : options.port;
    console.error(`repl-server listening on http://${host}:${actual}`);
    if (assembly.adminBootstrapToken !== null) {
      console.error(`repl-server admin: http://${host}:${actual}/admin?token=${assembly.adminBootstrapToken}`);
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void assembly.close().finally(() => {
        releaseInstanceLock(join(dataRoot, 'instance.lock'));
        process.exit(0);
      });
    });
  }
}

