/**
 * Browser data access for the MCP page: reads the manager's server entries and
 * this plugin's parallel list from Settings, and writes changes back with
 * revision fences. Pure over a remote-shaped object, so it runs under node:test. @module
 */
import type { ServerEntry } from '@zhangliang0115/mcp-ui-core';

/** Settings namespace of the official manager. Its row id is `mcp-manager`. */
export const MANAGER_NAMESPACE = 'mcp-manager';
/** Settings namespace of this plugin's host row (`cordis.patch.yml` id `mcp-ui`). */
export const PARALLEL_NAMESPACE = 'mcp-ui';

/** Failure shape of a remote call. */
export interface RemoteFailure {
  readonly ok: false;
  readonly error: { readonly code?: string; readonly message: string };
}

/** Success or failure of a remote call. */
export type RemoteResult<T> = { readonly ok: true; readonly value: T } | RemoteFailure;

/** One path-addressed edit, as the Settings remote accepts it. */
export interface PathOp {
  readonly op: 'set' | 'unset';
  readonly path: readonly string[];
  readonly value?: unknown;
}

/** One namespace in a describe response. */
export interface NamespaceLike {
  readonly ns: string;
  readonly revision: number;
  readonly value: unknown;
}

/** The part of `ctx.remote.settings` this page calls. */
export interface SettingsRemoteLike {
  describe(): Promise<RemoteResult<{ writable: boolean; namespaces: readonly NamespaceLike[] }>>;
  mutate(ns: string, ops: readonly PathOp[], expectedRevision?: number): Promise<RemoteResult<unknown>>;
}

/** What the page shows and edits, read in one describe call. */
export interface SettingsSnapshot {
  readonly writable: boolean;
  readonly servers: Readonly<Record<string, ServerEntry>>;
  readonly serversRevision: number;
  readonly parallelTools: readonly string[];
  readonly disabledTools: readonly string[];
  /** Revision of the mcp-ui namespace; both tool lists live in it. */
  readonly parallelRevision: number;
}

/** One change to a manager server entry. */
export type ServerChange =
  | { readonly kind: 'upsert'; readonly name: string; readonly entry: ServerEntry }
  | { readonly kind: 'remove'; readonly name: string }
  | { readonly kind: 'enabled'; readonly name: string; readonly enabled: boolean };


const SETTINGS_CONFLICT = 'settings/conflict';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function findNamespace(namespaces: readonly NamespaceLike[], ns: string): NamespaceLike | undefined {
  return namespaces.find(item => item.ns === ns);
}

/**
 * Read the manager's servers and this plugin's parallel list in one describe call.
 * @param remote - the Settings remote.
 */
export async function readSettings(remote: SettingsRemoteLike): Promise<RemoteResult<SettingsSnapshot>> {
  const described = await remote.describe();
  if (!described.ok) return described;
  const manager = findNamespace(described.value.namespaces, MANAGER_NAMESPACE);
  const parallel = findNamespace(described.value.namespaces, PARALLEL_NAMESPACE);
  if (manager === undefined || parallel === undefined) {
    return { ok: false, error: { message: 'Settings 中缺少 mcp-manager 或 mcp-ui 配置，请确认插件已安装并重启 DSH' } };
  }
  const managerValue = isRecord(manager.value) ? manager.value : {};
  const parallelValue = isRecord(parallel.value) ? parallel.value : {};
  return {
    ok: true,
    value: {
      writable: described.value.writable,
      servers: isRecord(managerValue.servers) ? (managerValue.servers as Record<string, ServerEntry>) : {},
      serversRevision: manager.revision,
      parallelTools: stringArray(parallelValue.parallelTools),
      disabledTools: stringArray(parallelValue.disabledTools),
      parallelRevision: parallel.revision,
    },
  };
}

/**
 * The path ops that apply one server change.
 * @param change - the change to make.
 */
export function serverChangeOps(change: ServerChange): PathOp[] {
  switch (change.kind) {
    case 'upsert':
      return [{ op: 'set', path: ['servers', change.name], value: change.entry }];
    case 'remove':
      return [{ op: 'unset', path: ['servers', change.name] }];
    case 'enabled':
      return [{ op: 'set', path: ['servers', change.name, 'enabled'], value: change.enabled }];
  }
}

/**
 * Apply one server change with the revision read before the edit.
 * @param remote - the Settings remote.
 * @param revision - `serversRevision` from the last read.
 * @param change - the change to make.
 */
export async function writeServerChange(
  remote: SettingsRemoteLike,
  revision: number,
  change: ServerChange,
): Promise<RemoteResult<unknown>> {
  return remote.mutate(MANAGER_NAMESPACE, serverChangeOps(change), revision);
}

/**
 * Replace one tool list in the mcp-ui namespace, fenced by its revision.
 * @param remote - the Settings remote.
 * @param revision - the namespace revision from the last read.
 * @param field - the config key, `parallelTools` or `disabledTools`.
 * @param tools - the complete new list.
 */
async function writeToolList(
  remote: SettingsRemoteLike,
  revision: number,
  field: 'parallelTools' | 'disabledTools',
  tools: readonly string[],
): Promise<RemoteResult<undefined>> {
  const written = await remote.mutate(
    PARALLEL_NAMESPACE,
    [{ op: 'set', path: [field], value: [...tools] }],
    revision,
  );
  return written.ok ? { ok: true, value: undefined } : written;
}

/**
 * Replace the parallel list with fenced revision.
 * @param remote - the Settings remote.
 * @param revision - `parallelRevision` from the last read.
 * @param tools - the complete new list.
 */
export async function writeParallelTools(
  remote: SettingsRemoteLike,
  revision: number,
  tools: readonly string[],
): Promise<RemoteResult<undefined>> {
  return writeToolList(remote, revision, 'parallelTools', tools);
}

/**
 * Replace the disabled list with fenced revision.
 * @param remote - the Settings remote.
 * @param revision - `parallelRevision` from the last read (same namespace).
 * @param tools - the complete new list.
 */
export async function writeDisabledTools(
  remote: SettingsRemoteLike,
  revision: number,
  tools: readonly string[],
): Promise<RemoteResult<undefined>> {
  return writeToolList(remote, revision, 'disabledTools', tools);
}

/**
 * The message a failed write shows. A revision conflict asks the user to
 * reload, because the page's data is out of date.
 * @param error - the failure from a remote call.
 */
export function settingsFailureMessage(error: { readonly code?: string; readonly message: string }): string {
  if (error.code === SETTINGS_CONFLICT) return '配置已在别处修改，列表已过期，请刷新后重试';
  return error.message;
}
