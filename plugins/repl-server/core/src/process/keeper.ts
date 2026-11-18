/** Host-side launcher for the detached serve keeper. @module */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Command the keeper starts, passed verbatim after its `--` separator. */
export interface KeeperServeCommand {
  readonly command: string;
  readonly args?: readonly string[];
}

export interface KeeperLaunchOptions {
  readonly sessionId: string;
  readonly bootId: string;
  readonly stateDir: string;
  readonly serve: KeeperServeCommand;
}

/** Shape accepted by stdio transports that take a command plus argv. */
export interface KeeperLaunch {
  readonly command: string;
  readonly args: string[];
}

/** Absolute path of the executable keeper script that ships next to this module. */
export function keeperScriptPath(): string {
  return fileURLToPath(new URL('./keeper.mjs', import.meta.url));
}

/** `keeper.mjs` writes this file; the sweep and reconcile jobs read it back. */
export function serveRecordPath(stateDir: string, sessionId: string): string {
  return join(stateDir, 'sessions', sessionId, 'serve.json');
}

/** Keeper argv without the script path: `--session … --boot … --state-dir … -- <serve…>`. */
export function buildKeeperArgs(options: KeeperLaunchOptions): string[] {
  return [
    '--session',
    options.sessionId,
    '--boot',
    options.bootId,
    '--state-dir',
    options.stateDir,
    '--',
    options.serve.command,
    ...(options.serve.args ?? []),
  ];
}

/** Full launch pair for `StdioClientTransport({ command, args })`. */
export function keeperLaunch(options: KeeperLaunchOptions): KeeperLaunch {
  return {
    command: process.execPath,
    args: [keeperScriptPath(), ...buildKeeperArgs(options)],
  };
}
