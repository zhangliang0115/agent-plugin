/** Locator metadata for one request pair, shown in the detail drawer; the copy action takes the MCP session only.
 *
 * There is no global request-record id: `#32` is the JSON-RPC id, which a session
 * may reuse and every session repeats. Locating a request therefore means the
 * `mcp` session plus that id plus the request time; times are rendered with
 * `formatTimestamp` (local, same as the rest of the UI).
 * Never include `params`/`args` here — they may carry secrets.
 * @module
 */

import { formatBytes, formatTimestamp } from './format.ts';

export interface RequestLocatorField {
  key: string;
  label: string;
  value: string;
}

/** Minimal frame shape: keeps this module free of React component imports. */
export interface LocatorFrame {
  ts?: string;
  [key: string]: unknown;
}

export interface LocatorPair {
  mcp: string;
  id: string | number | null;
  method: string | null;
  request: LocatorFrame | null;
  response: LocatorFrame | null;
  durMs?: number;
  ok?: boolean;
}

const MISSING = '—';

function text(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `name/version`, falling back to the legacy `client` label. */
function clientLabel(frame: LocatorFrame | null): string | null {
  if (frame === null) return null;
  const name = text(frame['clientName']);
  const version = text(frame['clientVersion']);
  if (name !== null || version !== null) {
    return name !== null && version !== null ? `${name}/${version}` : (name ?? version);
  }
  return text(frame['client']);
}

/** `params.name` of a `tools/call`; externalised params have no name to read. */
function toolName(pair: LocatorPair): string | null {
  if (pair.method !== 'tools/call') return null;
  const params = pair.request?.['params'];
  if (typeof params !== 'object' || params === null) return null;
  const name = (params as Record<string, unknown>)['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

function statusLabel(pair: LocatorPair): string {
  if (pair.response === null) return '无响应';
  return pair.ok === false ? '失败' : '正常';
}

/** First non-empty value of an audit-event key across the loaded events. */
function firstEventValue(events: readonly LocatorFrame[] | null, key: string): string | null {
  if (events === null) return null;
  for (const event of events) {
    const value = text(event[key]);
    if (value !== null) return value;
  }
  return null;
}

/** Ordered locator fields; core fields always appear, optional ones are omitted when empty. */
export function requestLocatorFields(
  pair: LocatorPair,
  events: readonly LocatorFrame[] | null,
): RequestLocatorField[] {
  const fields: RequestLocatorField[] = [
    { key: 'mcp', label: 'MCP 会话', value: pair.mcp === '' ? MISSING : pair.mcp },
    { key: 'id', label: 'JSON-RPC ID', value: text(pair.id) ?? MISSING },
    { key: 'method', label: '方法', value: text(pair.method) ?? MISSING },
  ];

  const tool = toolName(pair);
  if (tool !== null) fields.push({ key: 'tool', label: '工具', value: tool });

  const requestTs = text(pair.request?.['ts']);
  if (requestTs !== null) {
    fields.push({ key: 'requestTs', label: '请求时间', value: formatTimestamp(requestTs) });
  }
  const responseTs = text(pair.response?.['ts']);
  if (responseTs !== null) {
    fields.push({ key: 'responseTs', label: '响应时间', value: formatTimestamp(responseTs) });
  }

  fields.push({ key: 'status', label: '状态', value: statusLabel(pair) });

  const durMs = asNumber(pair.durMs);
  if (durMs !== null) fields.push({ key: 'durMs', label: '耗时', value: `${Math.round(durMs)} ms` });

  const requestBytes = asNumber(pair.request?.['bytes']);
  const responseBytes = asNumber(pair.response?.['bytes']);
  if (requestBytes !== null || responseBytes !== null) {
    fields.push({
      key: 'bytes',
      label: '请求 / 响应字节',
      value: `${formatBytes(requestBytes)} / ${formatBytes(responseBytes)}`,
    });
  }

  const client = clientLabel(pair.request) ?? clientLabel(pair.response);
  if (client !== null) fields.push({ key: 'client', label: '客户端', value: client });

  const binding =
    text(pair.request?.['binding']) ??
    text(pair.response?.['binding']) ??
    text(pair.request?.['identity']) ??
    text(pair.response?.['identity']);
  if (binding !== null) fields.push({ key: 'binding', label: '绑定', value: binding });

  const exec = firstEventValue(events, 'exec');
  if (exec !== null) fields.push({ key: 'exec', label: '执行会话', value: exec });
  const runId = firstEventValue(events, 'runId');
  if (runId !== null) fields.push({ key: 'runId', label: 'runId', value: runId });
  // evalId is only unique inside one exec session.
  const evalId = exec === null ? null : firstEventValue(events, 'evalId');
  if (evalId !== null) fields.push({ key: 'evalId', label: 'evalId', value: evalId });
  const evalTaskId = firstEventValue(events, 'evalTaskId');
  if (evalTaskId !== null) fields.push({ key: 'evalTaskId', label: '异步任务', value: evalTaskId });
  const scriptId = firstEventValue(events, 'scriptId');
  if (scriptId !== null) fields.push({ key: 'scriptId', label: '脚本 ID', value: scriptId });

  return fields;
}

/** Copy text for the card action: the MCP session value only, `—` when it is unknown. */
export function mcpSessionText(fields: readonly RequestLocatorField[]): string {
  return fields.find((field) => field.key === 'mcp')?.value ?? MISSING;
}
