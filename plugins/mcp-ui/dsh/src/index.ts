/**
 * DSH host half. Owns the live `parallelTools` setting, provides the
 * `mcpParallel` service that Code Mode can read, and serves the `mcpTools`
 * stream (servers, status, tools and descriptions) to the page. The browser page that edits
 * the setting is in `./client`. @module
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { createParallelService, type McpParallelService } from './parallel-service.ts';
import { createDisabledService, type McpDisabledService } from './disabled-service.ts';
import { createDisabledToolGate, type ToolCallLike } from './pre-execute-gate.ts';
import { createToolsSource, type HostLike } from './tools-source.ts';
import { McpToolsServiceImpl, SERVICE_KEY, type McpToolsService } from './tools-service.ts';

/** Cordis plugin name. */
export const name = 'mcp-ui';

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpParallel: McpParallelService;
    mcpDisabled: McpDisabledService;
    mcpTools: McpToolsService;
  }
}

/** Deployment settings. `parallelTools` and `disabledTools` are volatile: a saved change applies without a reload. */
export interface Config {
  /** Full tool names (`mcp__<server>__<tool>`) or prefixes ending in `*` that may run in parallel. */
  parallelTools: Volatile<string[]>;
  /** Full tool names or prefixes ending in `*` that are refused when called. Default: nothing disabled. */
  disabledTools: Volatile<string[]>;
}

/** Runtime schema; Cordis validates the mounted row's `config` against it. */
export const Config: z<{ parallelTools?: string[]; disabledTools?: string[] }, Config> = z.object({
  parallelTools: z.array(z.string()).default([]).volatile(),
  disabledTools: z.array(z.string()).default([]).volatile(),
}) as z<{ parallelTools?: string[]; disabledTools?: string[] }, Config>;

/**
 * The part of the Cordis context this plugin uses to listen to `tools/pre-execute`. The event type
 * comes from `@deepseek-ai/dsh-tools`, which is not a dependency here, so the call is typed locally.
 */
interface PreExecuteContext {
  on(
    event: 'tools/pre-execute',
    listener: (call: ToolCallLike, next: () => Promise<unknown>) => Promise<unknown>,
    options: { prepend: boolean },
  ): unknown;
}

/**
 * Register the disabled-tool gate ahead of other pre-execute listeners.
 * @param ctx - plugin context; the listener is removed when the plugin unloads.
 * @param gate - the listener from `createDisabledToolGate`.
 */
function registerPreExecute(ctx: Context, gate: (call: ToolCallLike, next: () => Promise<unknown>) => Promise<unknown>): void {
  (ctx as unknown as PreExecuteContext).on('tools/pre-execute', gate, { prepend: true });
}

/**
 * Provide `mcpParallel` and `mcpDisabled`, both reading the live lists on each query, and refuse
 * calls to disabled tools through a `tools/pre-execute` listener. The listener is registered with
 * `ctx.on`, so Cordis removes it when this plugin unloads.
 * @param ctx - plugin context.
 * @param config - deployment config; the lists are volatile.
 */
export function apply(ctx: Context, config: Config): void {
  const readDisabled = (): readonly string[] => config.disabledTools.get();
  ctx.provide('mcpParallel', createParallelService(() => config.parallelTools.get()));
  ctx.provide('mcpDisabled', createDisabledService(readDisabled));
  registerPreExecute(ctx, createDisabledToolGate(readDisabled));
  const source = createToolsSource(ctx as unknown as HostLike);
  ctx.provide(SERVICE_KEY, new McpToolsServiceImpl(source));
}
