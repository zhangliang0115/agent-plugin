#!/usr/bin/env node
import { threadId } from 'node:worker_threads';

import { newId, releaseInstanceLock, startupSweep } from '@zhangliang0115/repl-server-core';

import { assemble } from './assembly.ts';
import { isLoopbackBindAddress, parseHostAllowlist, type HostAllowlist } from './auth/tokens.ts';
import { createLog } from './log.ts';
import { createLayout, legacyLeftovers } from './layout.ts';
import { runStdioBridge } from './stdio-bridge.ts';

const log = createLog((line) => console.error(line), { threadId });

interface CliOptions {
  port: number;
  host: string;
  allowedHosts: HostAllowlist;
  adminAutoLogin: boolean;
  strictAuth: boolean;
  stdio: boolean;
  url: string;
  tokenFile: string | undefined;
}

function stringArg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readOptions(argv: readonly string[]): CliOptions {
  const raw = stringArg(argv, '--port') ?? process.env['REPL_SERVER_PORT'];
  const port = Number(raw ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log(`invalid port ${JSON.stringify(raw)}`, { level: 'error', scope: 'server' });
    process.exit(2);
  }
  const host = (stringArg(argv, '--host') ?? process.env['REPL_SERVER_HOST'] ?? '127.0.0.1').trim();
  if (host === '') {
    log('--host must not be empty', { level: 'error', scope: 'server' });
    process.exit(2);
  }
  const strictAuth = argv.includes('--strict-auth');
  if (!isLoopbackBindAddress(host) && !strictAuth) {
    log(
      `refusing to bind ${host} without --strict-auth: unbound /mcp requests would be accepted`,
      { level: 'error', scope: 'server' },
    );
    process.exit(2);
  }
  return {
    port,
    host,
    allowedHosts: parseHostAllowlist(
      stringArg(argv, '--allowed-hosts') ?? process.env['REPL_SERVER_ALLOWED_HOSTS'],
    ),
    adminAutoLogin: !argv.includes('--admin-require-token'),
    strictAuth,
    stdio: argv.includes('--stdio'),
    url: stringArg(argv, '--url') ?? 'http://127.0.0.1:8787/mcp',
    tokenFile: stringArg(argv, '--token-file'),
  };
}

const options = readOptions(process.argv.slice(2));
if (options.stdio) {
  process.exitCode = await runStdioBridge({
    url: options.url,
    ...(options.tokenFile === undefined ? {} : { tokenFile: options.tokenFile }),
    log,
  });
} else {
  const host = options.host;
  const layout = createLayout();
  const leftovers = legacyLeftovers(layout);
  if (leftovers.length > 0) {
    log(
      `legacy data layout at ${layout.root} (${leftovers.join(', ')}); ` +
        'run "node server/scripts/layout-switch.mjs" to move it into run/ and log/',
      { level: 'error', scope: 'server' },
    );
    process.exit(1);
  }
  const bootId = newId('boot');
  const sweep = startupSweep({
    root: layout.run,
    bootId,
    lockPath: layout.lockPath,
    reportDir: layout.boots,
  });
  log(
    `startup sweep ${sweep.status} boot=${bootId} killed=${sweep.killed.length} ai-runs-cleaned=${sweep.cleanedAiRuns.length} orphans=${sweep.reportPath ?? 'none'}`,
    { scope: 'server' },
  );
  if (sweep.status === 'locked') {
    log('another instance holds the instance lock', { level: 'error', scope: 'server' });
    process.exit(1);
  }

  const assembly = await assemble({
    host: options.host,
    port: options.port,
    allowedHosts: options.allowedHosts,
    adminAutoLogin: options.adminAutoLogin,
    strictAuth: options.strictAuth,
    bootId,
    log,
  });

  assembly.server.listen(options.port, host, () => {
    // stdout is reserved for the stdio bridge; logs go to stderr.
    const address = assembly.server.address();
    const actual = address !== null && typeof address === 'object' ? address.port : options.port;
    log(`listening on http://${host}:${actual}`, { scope: 'server', port: actual });
    if (assembly.adminBootstrapToken !== null) {
      log(`admin: http://${host}:${actual}/admin?token=${assembly.adminBootstrapToken}`, {
        scope: 'server',
        port: actual,
      });
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void assembly.close().finally(() => {
        releaseInstanceLock(layout.lockPath);
        process.exit(0);
      });
    });
  }
}

