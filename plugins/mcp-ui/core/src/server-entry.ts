/**
 * Server entry rules mirrored from the official manager's write-time checks
 * (`dsh-mcp-manager` validateEntries and `dsh-mcp-client` template syntax), so
 * the page refuses a form before it reaches Settings. Field names match the
 * manager's entry shape. @module
 */

export type ServerTransport = 'stdio' | 'streamable-http';

/** Largest timer delay the manager accepts for startup and close budgets. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Server key pattern used by the manager. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const SUSPECT_TEMPLATE = /\$\{[^}]*\}/g;
const CREDENTIAL_TOKEN = /^\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}$/;

/** Editable fields of one server, as the form holds them. */
export interface ServerForm {
  readonly name: string;
  readonly transport: ServerTransport;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly startupTimeoutMs: number;
  readonly toolCallTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

/** A server entry as stored under the manager's `servers` key. */
export interface ServerEntry {
  readonly transport: ServerTransport;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly startupTimeoutMs: number;
  readonly toolCallTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

function templateErrors(value: string, where: string): string[] {
  return [...value.matchAll(SUSPECT_TEMPLATE)]
    .map(match => match[0])
    .filter(token => !CREDENTIAL_TOKEN.test(token))
    .map(token => `${where}：「${token}」不是合法模板，请写成 \${credential:REF}`);
}

function transportErrors(form: ServerForm): string[] {
  if (form.transport === 'stdio') {
    const errors: string[] = [];
    if (form.command.trim() === '') errors.push('stdio 服务器必须填写 command');
    if (form.url !== '') errors.push('stdio 服务器不能填写 url');
    if (Object.keys(form.headers).length > 0) errors.push('stdio 服务器不能填写 headers');
    return errors;
  }
  const errors: string[] = [];
  if (form.url.trim() === '') errors.push('streamable-http 服务器必须填写 url');
  if (form.command !== '') errors.push('streamable-http 服务器不能填写 command');
  if (form.args.length > 0) errors.push('streamable-http 服务器不能填写 args');
  if (Object.keys(form.env).length > 0) errors.push('streamable-http 服务器不能填写 env');
  if (form.cwd !== '') errors.push('streamable-http 服务器不能填写 cwd');
  return errors;
}

function timeoutErrors(form: ServerForm): string[] {
  const errors: string[] = [];
  const inRange = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= MAX_TIMER_DELAY_MS;
  if (!inRange(form.startupTimeoutMs)) errors.push('启动超时必须是 1 到 2147483647 之间的整数（毫秒）');
  if (form.toolCallTimeoutMs !== undefined && !inRange(form.toolCallTimeoutMs)) errors.push('工具调用超时必须是 1 到 2147483647 之间的整数（毫秒）');
  if (form.closeTimeoutMs !== undefined && !inRange(form.closeTimeoutMs)) errors.push('关闭超时必须是 1 到 2147483647 之间的整数（毫秒）');
  return errors;
}

function templateFieldErrors(form: ServerForm): string[] {
  const fields: Array<[string, string]> = [
    [form.command, 'command'],
    [form.cwd, 'cwd'],
    [form.url, 'url'],
    ...form.args.map((arg, index): [string, string] => [arg, `args[${String(index)}]`]),
    ...Object.entries(form.env).map(([key, value]): [string, string] => [value, `env.${key}`]),
    ...Object.entries(form.headers).map(([key, value]): [string, string] => [value, `headers.${key}`]),
  ];
  return fields.flatMap(([value, where]) => templateErrors(value, where));
}

/**
 * Every reason the form cannot be saved. Empty when the form is valid.
 * @param form - the form values.
 * @returns messages in Chinese, one per problem.
 */
export function validateServerEntry(form: ServerForm): string[] {
  const nameErrors = !SERVER_NAME_PATTERN.test(form.name)
    ? ['服务器名只能包含字母、数字、下划线和连字符，长度 1 到 32']
    // `mcp__<server>__<tool>`: a `__` in the name makes `mcp__fs__*` also match server `fs__x`.
    : form.name.includes('__')
      ? ['服务器名不能包含双下划线（会让并行名单误匹配其他服务器）']
      : [];
  return [
    ...nameErrors,
    ...transportErrors(form),
    ...timeoutErrors(form),
    ...templateFieldErrors(form),
  ];
}

/**
 * The entry to store for a valid form. Transport fields the transport does not
 * use are written as empty values, and optional timeouts appear only when set.
 * @param form - a form that passed {@link validateServerEntry}.
 */
export function buildServerEntry(form: ServerForm): ServerEntry {
  const isStdio = form.transport === 'stdio';
  return {
    transport: form.transport,
    command: isStdio ? form.command : '',
    args: isStdio ? [...form.args] : [],
    env: isStdio ? { ...form.env } : {},
    cwd: isStdio ? form.cwd : '',
    url: isStdio ? '' : form.url,
    headers: isStdio ? {} : { ...form.headers },
    enabled: form.enabled,
    startupTimeoutMs: form.startupTimeoutMs,
    ...form.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: form.toolCallTimeoutMs },
    ...form.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: form.closeTimeoutMs },
  };
}
