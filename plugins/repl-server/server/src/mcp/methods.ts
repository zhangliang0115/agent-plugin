/** The frozen v1 MCP method table. @module */

import { createDiscoverHandler, createInitializeHandler, type DiscoverOptions } from './discover.ts';
import { JsonRpcError, JSON_RPC_INTERNAL_ERROR } from './errors.ts';
import { JsonRpcDispatcher, type JsonRpcHandler } from './jsonrpc.ts';

/** Methods served by the MCP endpoint, in the order exposed by `methods()`. */
export const METHOD_TABLE = [
  'server/discover',
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'tools/call',
  'tasks/get',
  'tasks/cancel',
  'tasks/update',
] as const;

export type MethodName = (typeof METHOD_TABLE)[number];

/**
 * Handlers owned by later modules. Anything left out still appears in the
 * method table but answers `-32603`, so a known-but-unwired method is never
 * mistaken for an unknown one (`-32601`).
 */
export interface MethodTableOptions<Context = undefined> {
  /** Static prompt, or a per-request provider for session-specific instructions. */
  instructions?: DiscoverOptions<Context>['instructions'];
  toolsList?: JsonRpcHandler<Context>;
  toolsCall?: JsonRpcHandler<Context>;
  tasksGet?: JsonRpcHandler<Context>;
  tasksCancel?: JsonRpcHandler<Context>;
  tasksUpdate?: JsonRpcHandler<Context>;
}

function notWired<Context>(method: MethodName): JsonRpcHandler<Context> {
  return () => {
    throw new JsonRpcError(JSON_RPC_INTERNAL_ERROR, `${method} is not wired`);
  };
}

export function createMethodTable<Context = undefined>(
  options: MethodTableOptions<Context> = {},
): JsonRpcDispatcher<Context> {
  const discoverOptions: DiscoverOptions<Context> = { instructions: options.instructions };
  const dispatcher = new JsonRpcDispatcher<Context>();

  dispatcher.register('server/discover', createDiscoverHandler<Context>(discoverOptions));
  dispatcher.register('initialize', createInitializeHandler<Context>(discoverOptions));
  dispatcher.register('notifications/initialized', () => undefined);
  dispatcher.register('ping', () => ({}));
  dispatcher.register('tools/list', options.toolsList ?? notWired('tools/list'));
  dispatcher.register('tools/call', options.toolsCall ?? notWired('tools/call'));
  dispatcher.register('tasks/get', options.tasksGet ?? notWired('tasks/get'));
  dispatcher.register('tasks/cancel', options.tasksCancel ?? notWired('tasks/cancel'));
  dispatcher.register('tasks/update', options.tasksUpdate ?? notWired('tasks/update'));

  return dispatcher;
}
