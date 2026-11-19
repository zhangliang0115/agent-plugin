/** Per-row server actions: which buttons stay visible and which fold into 「更多」. */
export type ServerRowActionKey =
  | 'connect'
  | 'disconnect'
  | 'restart'
  | 'test'
  | 'edit'
  | 'detail'
  | 'delete'
  | 'pending';

export interface ServerRowAction {
  key: ServerRowActionKey;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}

export interface ServerRowPlan {
  primary: ServerRowAction[];
  more: ServerRowAction[];
}

const EDIT: ServerRowAction = { key: 'edit', label: '编辑' };
const DETAIL: ServerRowAction = { key: 'detail', label: '详情' };
const DELETE: ServerRowAction = { key: 'delete', label: '删除', danger: true };
const TEST: ServerRowAction = { key: 'test', label: '测试连接' };
const CONNECT: ServerRowAction = { key: 'connect', label: '连接' };
const DISCONNECT: ServerRowAction = { key: 'disconnect', label: '断开' };
const RESTART: ServerRowAction = { key: 'restart', label: '重启' };
const STOP: ServerRowAction = { key: 'disconnect', label: '停止' };
const PENDING: ServerRowAction = { key: 'pending', label: '进行中', disabled: true };

export const TRANSIENT_STATES: ReadonlySet<string> = new Set(['starting', 'connecting', 'reconnecting']);

/** Rows in a transient state only offer a progress indicator and a stop action. */
export function serverRowActions(
  server: { transport: string; state: string; enabled: boolean },
  busy: boolean,
): ServerRowPlan {
  const gate = (action: ServerRowAction): ServerRowAction =>
    busy && action.key !== 'detail' && action.key !== 'pending' ? { ...action, disabled: true } : action;

  if (server.transport === 'builtin') return { primary: [EDIT], more: [] };
  if (TRANSIENT_STATES.has(server.state)) {
    return { primary: [PENDING, gate(STOP)], more: [] };
  }
  if (!server.enabled || server.state === 'disabled') {
    return { primary: [EDIT, gate(DELETE)], more: [] };
  }
  if (server.state === 'ready') {
    return {
      primary: [gate(DISCONNECT), gate(RESTART), EDIT],
      more: [gate(TEST), DETAIL, gate(DELETE)],
    };
  }
  return {
    primary: [gate(CONNECT), gate(RESTART), EDIT],
    more: [gate(TEST), DETAIL, gate(DELETE)],
  };
}
