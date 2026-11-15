/** DSH entry point. Installs Code Mode as the deployment's tool executor. @module */
import type { Context } from '@deepseek-ai/cordis';
import { CodeModeExecutor } from './executor.ts';

/** Cordis plugin name. */
export const name = 'code-mode-dsh';

/** Wait for the tools service, which owns the single executor slot, and the prompt service. */
export const inject = ['tools', 'systemPrompt'];

/** Register the executor and release its sandboxes when the plugin is disposed. */
export function setupCodeModeExecutor(ctx: Context): CodeModeExecutor {
  const executor = new CodeModeExecutor(ctx);
  ctx.tools.setExecutor(executor);
  ctx.effect(() => () => executor.dispose(), 'Code Mode sandboxes');
  return executor;
}

export function apply(ctx: Context): void {
  setupCodeModeExecutor(ctx);
}
