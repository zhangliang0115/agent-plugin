/**
 * Display helpers for the server list: status labels, masked secret values, and
 * the row model that joins stored entries with live manager views. @module
 */

/** A live status as the manager reports it. Only the fields the labels read are typed. */
export interface StatusLike {
  readonly state: string;
  readonly toolCount?: number;
  readonly attempt?: number;
  readonly reason?: string;
  readonly lastError?: string;
}

/** One list view from `ctx.remote.mcpManager.watch`. */
export interface ServerViewLike {
  readonly name: string;
  readonly configured: boolean;
  readonly status: StatusLike;
}

/** Only the stored fields the list shows. */
export interface StoredEntryLike {
  readonly transport: string;
  readonly enabled: boolean;
}

/** One row of the server list. */
export interface ServerRow {
  readonly name: string;
  readonly configured: boolean;
  readonly transport: string | undefined;
  readonly enabled: boolean;
  readonly label: string;
  readonly status: StatusLike | undefined;
}

const MASK = '••••••';
const CREDENTIAL_TEMPLATE = /^\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * Show a secret value without revealing it. Credential templates name a
 * reference, not a secret, so they stay readable.
 * @param value - stored env or header value.
 */
export function maskValue(value: string): string {
  if (value === '') return '';
  return CREDENTIAL_TEMPLATE.test(value) ? value : MASK;
}

/** How a live state is drawn: the colour of its dot. */
export type StatusTone = 'ok' | 'warn' | 'error' | 'idle';

/**
 * Tone of one live state. Unknown states read as idle so a new manager state never breaks the page.
 * @param state - `status.state` from the manager, if any.
 */
export function statusTone(state: string | undefined): StatusTone {
  switch (state) {
    case 'connected':
      return 'ok';
    case 'connecting':
    case 'reconnecting':
    case 'waiting-credentials':
      return 'warn';
    case 'failed':
      return 'error';
    default:
      return 'idle';
  }
}

/**
 * The Chinese label for one live status.
 * @param status - status from a list view.
 */
export function statusLabel(status: StatusLike): string {
  switch (status.state) {
    case 'connected':
      return `已连接 · ${String(status.toolCount ?? 0)} 个工具`;
    case 'connecting':
      return '连接中';
    case 'reconnecting':
      return `重连中（第 ${String(status.attempt ?? 0)} 次）`;
    case 'waiting-credentials':
      return '等待凭据';
    case 'disabled':
      return '已停用';
    case 'closed':
      return '已关闭';
    case 'failed':
      return failedLabel(status);
    default:
      return status.state;
  }
}

function idleLabel(enabled: boolean): string {
  return enabled ? '未运行' : '已停用';
}

function failedLabel(status: StatusLike): string {
  if (status.reason === 'load') return '加载失败';
  if (status.reason === 'cleanup') return '清理失败，需重启 DSH';
  return '连接失败';
}

/**
 * Join stored entries with live views. Configured entries come first in name
 * order. A view with no stored entry, such as a retained cleanup failure, is
 * appended as unconfigured.
 * @param entries - stored entries keyed by server name.
 * @param views - the latest list from the manager.
 */
export function buildServerRows(
  entries: Readonly<Record<string, StoredEntryLike>>,
  views: readonly ServerViewLike[],
): ServerRow[] {
  const viewByName = new Map(views.map(view => [view.name, view]));
  const configured = Object.keys(entries).sort().map((name): ServerRow => {
    const entry = entries[name] as StoredEntryLike;
    const view = viewByName.get(name);
    const status = view?.status;
    return {
      name,
      configured: true,
      transport: entry.transport,
      enabled: entry.enabled,
      label: status === undefined ? idleLabel(entry.enabled) : statusLabel(status),
      status,
    };
  });
  const unconfigured = views
    .filter(view => !view.configured || !(view.name in entries))
    .map((view): ServerRow => ({
      name: view.name,
      configured: false,
      transport: undefined,
      enabled: false,
      label: statusLabel(view.status),
      status: view.status,
    }));
  return [...configured, ...unconfigured];
}
