/**
 * The one persistent vm context a worker creates.
 *
 * The context carries `tools`, `state`, `console` and host timers; `state` is
 * getter-only so a script can assign fields but never replace the snapshot
 * source.
 * `codeGeneration` is disabled for strings and wasm, and the globals that
 * would hand the script another compilation or shared-memory path are
 * deleted after context creation. `microtaskMode` is deliberately not set:
 * concurrent evals share this context, and `afterEvaluate` would run another
 * eval's continuations inside this eval's timeout budget.
 *
 * @module
 */
import * as vm from 'node:vm';

const DELETE_DANGEROUS_GLOBALS =
  'delete globalThis.WebAssembly; delete globalThis.SharedArrayBuffer; delete globalThis.ShadowRealm;';

export interface VmContextOptions {
  tools: object;
  console: object;
  state?: unknown;
}

export interface VmContext {
  readonly context: vm.Context;
  /** The same object the script sees as `state`; snapshots serialize this. */
  readonly state: unknown;
}

export function createVmContext(options: VmContextOptions): VmContext {
  const state = options.state ?? {};
  const sandbox: Record<string, unknown> = {
    tools: options.tools,
    console: options.console,
    // Scripts need timers for polling and delays; learn-ai 02 §1.4 also assumes
    // a settled eval can leave a `setTimeout` behind (its call is then rejected
    // as stale). The vm is not a security boundary, so host timers are fine.
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  };

  Object.defineProperty(sandbox, 'state', {
    get: () => state,
    set: () => {
      throw new TypeError('state cannot be replaced; assign fields instead');
    },
    enumerable: true,
    configurable: false,
  });

  const context = vm.createContext(sandbox, {
    name: 'repl',
    codeGeneration: { strings: false, wasm: false },
  });

  vm.runInContext(DELETE_DANGEROUS_GLOBALS, context, { filename: 'repl-sandbox.js' });

  return { context, state };
}

/**
 * Wraps the eval body in an async IIFE so top-level `await` (and `return`)
 * compile. This is the shape fixed by learn-ai 01 §5.2.
 */
export function wrapEvalSource(code: string): string {
  return `(async () => {\n${code}\n})()`;
}

export function compileEvalScript(code: string, evalId: number): vm.Script {
  return new vm.Script(wrapEvalSource(code), { filename: `repl-eval-${evalId}.js` });
}

/**
 * Runs the synchronous slice of one eval under the L0 timeout.
 * The returned value is normally the async IIFE's promise; `await` after
 * that point is outside this timeout by design (L2/L3 cover it).
 */
export function runEvalScript(context: vm.Context, code: string, evalId: number, syncMs: number): unknown {
  return compileEvalScript(code, evalId).runInContext(context, { timeout: syncMs, displayErrors: true });
}
