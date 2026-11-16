/** DSH entry point. Installs Code Mode as the deployment's tool executor. @module */
import type { Context } from '@deepseek-ai/cordis';
import { CodeMode } from '@zhangliang0115/code-mode-core';
import { codeLimits, type Config } from './config.ts';
import { CodeModeExecutor } from './executor.ts';

/** Cordis plugin name. */
export const name = 'code-mode-dsh';

/** Deployment-owned limits. Cordis validates and defaults a mounted row's `config` before activation. */
export { Config } from './config.ts';

/** Wait for the tools service, which owns the single executor slot, and the prompt service. */
export const inject = ['tools', 'systemPrompt'];

/** Register the executor with the deployment's limits and release its sandboxes when the plugin is disposed. */
export function setupCodeModeExecutor(ctx: Context, config: Partial<Config> = {}): CodeModeExecutor {
  const executor = new CodeModeExecutor(ctx, {
    mode: new CodeMode(codeLimits(config)),
    // Read on every classification: an edit to the profile row applies to the next sub-call.
    concurrentTools: () => {
      const live = config.concurrentTools;
      // Cordis hands over a volatile reference; a plain array (a caller outside Cordis) is read as is.
      return typeof live?.get === 'function' ? live.get() : Array.isArray(live) ? live : [];
    },
  });
  ctx.tools.setExecutor(executor);
  ctx.effect(() => () => executor.dispose(), 'Code Mode sandboxes');
  return executor;
}

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  setupCodeModeExecutor(ctx, config);
}
