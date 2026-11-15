/**
 * Minimal Cordis-like context for adapter contract tests. It implements only the
 * members the shared pipeline and the executor read, and records every event in
 * `trace` so tests can assert the order of pipeline stages.
 */
import { defineTool, projectToolSchema, type ToolDefinition, type ToolExecutor } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';

export type Hook = (payload: any, next: (...args: any[]) => any) => any;

export interface FakeOptions {
  readonly tools?: readonly ToolDefinition[];
  readonly guardDenial?: (name: string) => { reason: string } | undefined;
  /** Services returned by `ctx.get(name)`, for example `approval` or `spillStore`. */
  readonly services?: Readonly<Record<string, unknown>>;
  /** Collects `logger.warn` messages. */
  readonly warnings?: string[];
}

export interface FakeContext {
  readonly ctx: Context;
  readonly trace: string[];
  readonly hooks: Map<string, Hook[]>;
  /** Disposers registered with `ctx.effect`. */
  readonly disposers: Array<() => void>;
  /** Disposers returned by `ctx.on`. */
  readonly listenerDisposers: Array<() => void>;
  readonly executors: ToolExecutor[];
  addHook(event: string, hook: Hook): void;
}

export function readTool(trace: string[], name = 'Read', pathField = 'path'): ToolDefinition {
  return defineTool({
    name,
    description: 'Read a file.',
    parameters: { [pathField]: { type: 'string', required: true, description: 'File path.' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      trace.push(`body:${name}`);
      return `content of ${String((args as Record<string, unknown>)[pathField])}`;
    },
  });
}

export function fakeContext(options: FakeOptions = {}): FakeContext {
  const trace: string[] = [];
  const hooks = new Map<string, Hook[]>();
  const disposers: Array<() => void> = [];
  const listenerDisposers: Array<() => void> = [];
  const executors: ToolExecutor[] = [];
  const definitions = new Map<string, ToolDefinition>();
  for (const tool of options.tools ?? [readTool(trace)]) definitions.set(tool.name, tool);

  const tools = {
    executable(name: string): ToolDefinition | undefined {
      return definitions.get(name);
    },
    schemas(): unknown[] {
      return [...definitions.values()].map((definition) => projectToolSchema(definition, true));
    },
    checkGuards(exec: { name: string }): { reason: string } | undefined {
      trace.push(`guard:${exec.name}`);
      return options.guardDenial?.(exec.name);
    },
    setExecutor(executor: ToolExecutor): () => void {
      executors.push(executor);
      return () => undefined;
    },
  };

  /** Runs one waterfall through the registered hooks. */
  const waterfall = (_target: unknown, event: string, ...args: unknown[]): Promise<unknown> => {
    const fallback = args.pop() as (...payload: unknown[]) => unknown;
    const handlers = hooks.get(event) ?? [];
    const payload = args;
    const name = (payload[0] as { name?: string } | undefined)?.name;
    trace.push(name === undefined ? event : `${event}:${name}`);
    const step = (index: number, current: unknown[]): unknown => {
      const handler = handlers[index];
      if (handler === undefined) return fallback(...current);
      return handler(current[0], (...next: unknown[]) => step(index + 1, next.length > 0 ? next : current));
    };
    return Promise.resolve(step(0, payload));
  };

  const ctx = {
    tools,
    systemPrompt: { getSectionOrder: () => 100 },
    logger: { warn: (message: string) => { options.warnings?.push(String(message)); }, info: () => undefined },
    events: { dispatch: () => [] },
    get(name: string): unknown {
      const service = options.services?.[name];
      // The real approval service raises `approval/request` before it asks, so the fake does too:
      // deadline holders must see the wait exactly as they do in DSH.
      if (name !== 'approval' || service === undefined) return service;
      return {
        request: (payload: unknown): Promise<unknown> =>
          waterfall(undefined, 'approval/request', payload, () => (service as { request(payload: unknown): Promise<unknown> }).request(payload)),
      };
    },
    effect(fn: () => () => void): void {
      disposers.push(fn());
    },
    /** `ctx.on(event, listener, options?)`: a boolean or `{ prepend: true }` puts the listener ahead of the others. Returns the disposer. */
    on(event: string, hook: Hook, options?: boolean | { prepend?: boolean }): () => void {
      const prepend = options === true || (typeof options === 'object' && options.prepend === true);
      const list = hooks.get(event) ?? [];
      hooks.set(event, prepend ? [hook, ...list] : [...list, hook]);
      const dispose = (): void => {
        hooks.set(event, (hooks.get(event) ?? []).filter((candidate) => candidate !== hook));
      };
      listenerDisposers.push(dispose);
      return dispose;
    },
    waterfall,
  };

  return {
    ctx: ctx as unknown as Context,
    trace,
    hooks,
    disposers,
    listenerDisposers,
    executors,
    addHook(event: string, hook: Hook): void {
      hooks.set(event, [...hooks.get(event) ?? [], hook]);
    },
  };
}

export interface FakeAgent {
  readonly ctx: { effect(fn: () => () => void): void };
  readonly session: {
    readonly header: { readonly id: string };
    readonly appended: Array<{ type: string; data: any }>;
    append(type: string, data: unknown): void;
  };
}

/**
 * An agent with a recording session. Every append also lands in `trace` as
 * `session:<type>:<name>` so tests can order events against pipeline stages.
 * `failAppend` makes every append throw.
 */
export function fakeAgent(trace: string[], id = 'session-1', options: { failAppend?: boolean } = {}): FakeAgent {
  const appended: Array<{ type: string; data: any }> = [];
  return {
    ctx: { effect: () => undefined },
    session: {
      header: { id },
      appended,
      append(type: string, data: unknown): void {
        if (options.failAppend === true) throw new Error('append failed');
        appended.push({ type, data });
        trace.push(`session:${type}:${String((data as { name?: string }).name)}`);
      },
    },
  };
}
