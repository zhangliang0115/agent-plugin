/**
 * The add/edit server form. It keeps the text fields in local state and reports
 * the draft on save; validation lives in `draft.ts`. @module
 */
import type { ReactLike } from './types.ts';
import type { ServerDraft } from './draft.ts';

/** Props of the form. */
export interface ServerFormProps {
  readonly initial: ServerDraft;
  readonly isNew: boolean;
  readonly errors: readonly string[];
  onSave(draft: ServerDraft): void;
  onCancel(): void;
}

const TEMPLATE_HINT = '凭据请写成 ${credential:REF} 引用，不要粘贴明文。';

/**
 * @param react - the React functions from the module loader.
 * @returns the form component.
 */
export function createServerForm(react: ReactLike): (props: ServerFormProps) => unknown {
  const h = react.createElement;
  return function ServerForm(props: ServerFormProps): unknown {
    const [draft, setDraft] = react.useState<ServerDraft>(props.initial);
    const set = (patch: Partial<ServerDraft>): void => setDraft(previous => ({ ...previous, ...patch }));
    const text = (label: string, value: string, key: keyof ServerDraft, options: Record<string, unknown> = {}): unknown =>
      h('label', { className: 'mcp-field' },
        h('span', null, label),
        h(options.multiline === true ? 'textarea' : 'input', {
          value,
          disabled: options.disabled === true,
          onChange: (event: { target: { value: string } }) => set({ [key]: event.target.value } as Partial<ServerDraft>),
        }),
        typeof options.hint === 'string' ? h('small', null, options.hint) : null);
    const isStdio = draft.transport === 'stdio';
    return h('div', { className: 'mcp-form' },
      h('h3', null, props.isNew ? '添加服务器' : `编辑 ${props.initial.name}`),
      text('名称（1–32 位字母、数字、_ 或 -）', draft.name, 'name', { disabled: !props.isNew }),
      h('label', { className: 'mcp-field' },
        h('span', null, '传输方式'),
        h('select', {
          value: draft.transport,
          onChange: (event: { target: { value: string } }) => set({ transport: event.target.value === 'stdio' ? 'stdio' : 'streamable-http' }),
        },
          h('option', { value: 'stdio' }, 'stdio（本地进程）'),
          h('option', { value: 'streamable-http' }, 'streamable-http（远程地址）'))),
      isStdio
        ? h('div', null,
          text('命令 command', draft.command, 'command'),
          text('参数 args（每行一个）', draft.argsText, 'argsText', { multiline: true }),
          text('工作目录 cwd（可空）', draft.cwd, 'cwd'),
          text('环境变量 env（每行 KEY=VALUE）', draft.envText, 'envText', { multiline: true, hint: TEMPLATE_HINT }))
        : h('div', null,
          text('地址 url', draft.url, 'url'),
          text('请求头 headers（每行 KEY=VALUE）', draft.headersText, 'headersText', { multiline: true, hint: TEMPLATE_HINT })),
      text('启动超时（毫秒）', draft.startupText, 'startupText'),
      text('工具调用超时（毫秒，可空）', draft.toolCallText, 'toolCallText'),
      text('关闭超时（毫秒，可空）', draft.closeText, 'closeText'),
      h('label', { className: 'mcp-field mcp-inline' },
        h('input', {
          type: 'checkbox',
          checked: draft.enabled,
          onChange: (event: { target: { checked: boolean } }) => set({ enabled: event.target.checked }),
        }),
        h('span', null, '保存后启用')),
      props.errors.length > 0
        ? h('ul', { className: 'mcp-errors', role: 'alert' }, ...props.errors.map(message => h('li', { key: message }, message)))
        : null,
      h('div', { className: 'mcp-actions' },
        h('button', { type: 'button', onClick: () => props.onSave(draft) }, '保存'),
        h('button', { type: 'button', onClick: props.onCancel }, '取消')),
    );
  };
}
