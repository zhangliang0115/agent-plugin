/**
 * Minimal typed surface of what the browser bundle uses from the host: React
 * (passed in by the module loader), the slot registry, and the remote namespaces.
 * Declared here instead of importing host packages, so the bundle has no
 * build-time dependency on them. @module
 */
import type { RemoteResult, SettingsRemoteLike } from './remote.ts';

/** The React functions the page calls. */
export interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void];
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}

/** The manager's browser surface, as `ctx.remote.mcpManager`. */
export interface McpManagerRemoteLike {
  restart(name: string): Promise<unknown>;
}

/** This package's own stream, as `ctx.remote.mcpTools`: servers with status and tools. */
export interface McpToolsRemoteLike {
  watch(signal: AbortSignal): AsyncIterable<unknown>;
}

/** The client context fields this bundle reads. */
export interface ClientContext {
  readonly slots: {
    inject(name: string, factory: () => unknown): unknown;
    register(spec: Record<string, unknown>, component: unknown): unknown;
  };
  readonly remote: {
    readonly settings: SettingsRemoteLike;
    readonly mcpManager: McpManagerRemoteLike;
    readonly mcpTools: McpToolsRemoteLike;
    $on(event: 'settings/document-updated', handler: () => void): () => void;
    /** Mount a Remote contribution; resolves to the function that unmounts it. */
    $mount(contribution: unknown): Promise<() => Promise<void>>;
  };
  /** Mount a child plugin whose `inject` list gates when it starts. */
  plugin(spec: { name: string; inject: string[]; apply(ctx: ClientContext): unknown }): unknown;
}

/** The module loader the page exposes before plugin bundles run. */
export interface ModuleLoaderLike {
  load(spec: {
    id: string;
    factory(require: (id: string) => unknown): {
      inject: string[];
      apply(ctx: ClientContext): void;
    };
  }): void;
}

export type { RemoteResult };
