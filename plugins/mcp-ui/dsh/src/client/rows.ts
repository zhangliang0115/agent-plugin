/**
 * One server card. The header is one line: name, transport and live status on the left; on the right
 * the "all tools in parallel" box (when open), restart, edit, delete and the enable switch. Clicking the
 * name folds the tool list, which sits underneath and starts collapsed. @module
 */
import { serverPattern, statusTone, type ServerRow, type ServerToolsView } from '@zhangliang0115/mcp-ui-core';
import { toolCheckState, toolEnableState } from './tool-state.ts';
import type { ReactLike } from './types.ts';

/** Props of one row. */
export interface ServerRowProps {
  readonly row: ServerRow;
  readonly masked: readonly string[];
  readonly parallelTools: readonly string[];
  readonly disabledTools: readonly string[];
  /** Live server view with its tools; undefined until the first stream payload arrives. */
  readonly server: ServerToolsView | undefined;
  onToggleEnabled(enabled: boolean): void;
  onRestart(): void;
  onEdit(): void;
  onDelete(): void;
  onToggleTool(pattern: string, enabled: boolean): void;
  onToggleDisabled(fullName: string, disabled: boolean): void;
}

type CreateElement = ReactLike['createElement'];
type ChangeEvent = { target: { checked: boolean } };

export function createServerRow(react: ReactLike): (props: ServerRowProps) => unknown {
  const h = react.createElement;
  return function ServerRowView(props: ServerRowProps): unknown {
    const [confirming, setConfirming] = react.useState(false);
    // The tool list starts collapsed: a server with many tools would otherwise push the page far down.
    const [open, setOpen] = react.useState(false);
    const { row } = props;
    const state = row.status?.state;
    const connected = state === 'connected';
    const server = connected ? props.server : undefined;
    const serverWide = props.parallelTools.includes(serverPattern(row.name));
    return h('section', { className: 'mcp-card', 'data-enabled': row.enabled ? 'true' : 'false' },
      h('header', { className: 'mcp-card-head' },
        renderTitle(h, row, state, server !== undefined, open, () => setOpen(!open)),
        h('div', { className: 'mcp-controls' },
          server !== undefined && open
            ? h('label', { className: 'mcp-check' },
              h('input', {
                type: 'checkbox',
                checked: serverWide,
                onChange: (event: ChangeEvent) => props.onToggleTool(serverPattern(row.name), event.target.checked),
              }),
              h('span', null, '全部支持并行'))
            : null,
          row.configured ? h('button', { type: 'button', onClick: props.onRestart }, '重启') : null,
          row.configured ? h('button', { type: 'button', onClick: props.onEdit }, '编辑') : null,
          row.configured
            ? (confirming
              ? h('button', { type: 'button', className: 'mcp-danger', onClick: props.onDelete }, '确认删除')
              : h('button', { type: 'button', onClick: () => setConfirming(true) }, '删除'))
            : null,
          row.configured
            ? h('label', { className: 'mcp-switch' },
              h('input', {
                type: 'checkbox',
                checked: row.enabled,
                'aria-label': `启用 ${row.name}`,
                onChange: (event: ChangeEvent) => props.onToggleEnabled(event.target.checked),
              }),
              h('span', null, row.enabled ? '已启用' : '已停用'))
            : null)),
      props.masked.length > 0
        ? h('p', { className: 'mcp-hint' }, `敏感值已隐藏：${props.masked.join('、')}`)
        : null,
      renderBody(h, props, connected, server, open, serverWide));
  };
}

/**
 * Left side of the header. When the server's tools are known it is a button: clicking the name folds
 * or unfolds the tool list. Otherwise it is plain text, since there is nothing to fold.
 */
function renderTitle(
  h: CreateElement,
  row: ServerRow,
  state: string | undefined,
  foldable: boolean,
  open: boolean,
  onToggle: () => void,
): unknown {
  const parts = [
    foldable ? h('span', { key: 'chevron', className: 'mcp-chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸') : null,
    h('span', { key: 'dot', className: 'mcp-dot', 'data-tone': statusTone(state), 'aria-hidden': 'true' }),
    h('strong', { key: 'name', className: 'mcp-name' }, row.name),
    row.transport === undefined ? null : h('span', { key: 'tag', className: 'mcp-tag' }, row.transport),
    h('span', { key: 'status', className: 'mcp-status', 'data-tone': statusTone(state) }, row.label),
  ];
  if (!foldable) return h('div', { className: 'mcp-card-title' }, ...parts);
  return h('button', {
    type: 'button',
    className: 'mcp-card-title mcp-card-fold',
    'aria-expanded': open ? 'true' : 'false',
    'aria-label': `${open ? '收起' : '展开'} ${row.name} 的工具`,
    onClick: onToggle,
  }, ...parts);
}

/** Under the header: why there are no tools yet, or the tool list when it is open. */
function renderBody(
  h: CreateElement,
  props: ServerRowProps,
  connected: boolean,
  server: ServerToolsView | undefined,
  open: boolean,
  serverWide: boolean,
): unknown {
  if (!connected) return h('p', { className: 'mcp-empty' }, '启用并连接后显示这个服务器提供的工具。');
  if (server === undefined) return h('p', { className: 'mcp-empty' }, '正在读取工具…');
  if (!open) return null;
  const tools = server.tools;
  const anyDisabled = tools.some(tool => !toolEnableState(props.row.name, tool.rawName, props.disabledTools).enabled);
  return h('div', { className: 'mcp-tools' },
    server.truncated ? h('p', { className: 'mcp-hint' }, '工具过多，只显示前面一部分。') : null,
    anyDisabled ? h('p', { className: 'mcp-hint' }, DISABLED_HINT) : null,
    tools.length === 0 ? h('p', { className: 'mcp-empty' }, '这个服务器没有提供工具。') : null,
    h('ul', { className: 'mcp-tool-list' }, ...tools.map(tool => renderToolItem(h, props, serverWide, tool))));
}

/** One line in the tools area, shown when at least one tool is disabled. */
const DISABLED_HINT = '在 Code Mode 下被禁用的工具不会出现在模型的工具列表里；其他预设下模型仍能看到它，但调用会被拒绝。';

/** One tool row: the 启用 box on the left of the 支持并行 box. A disabled tool is muted and cannot be made parallel. */
function renderToolItem(
  h: CreateElement,
  props: ServerRowProps,
  serverWide: boolean,
  tool: ServerToolsView['tools'][number],
): unknown {
  const parallel = toolCheckState(props.row.name, tool.rawName, props.parallelTools);
  const enable = toolEnableState(props.row.name, tool.rawName, props.disabledTools);
  return h('li', { key: tool.name, className: enable.enabled ? 'mcp-tool' : 'mcp-tool mcp-tool-muted' },
    h('div', { className: 'mcp-tool-main' },
      h('code', { className: 'mcp-tool-name' }, tool.rawName),
      tool.description === '' ? null : h('p', { className: 'mcp-tool-desc' }, tool.description),
      parallel.cover === undefined || serverWide ? null : h('small', { className: 'mcp-hint' }, `由 ${parallel.cover} 覆盖`),
      enable.cover === undefined ? null : h('small', { className: 'mcp-hint' }, `由 ${enable.cover} 禁用，不能单独启用`)),
    h('div', { className: 'mcp-tool-actions' },
      h('label', { className: 'mcp-check' },
        h('input', {
          type: 'checkbox',
          checked: enable.enabled,
          disabled: enable.cover !== undefined,
          'aria-label': `${tool.rawName} 启用`,
          onChange: (event: ChangeEvent) => props.onToggleDisabled(enable.fullName, !event.target.checked),
        }),
        h('span', null, '启用')),
      h('label', { className: 'mcp-check' },
        h('input', {
          type: 'checkbox',
          checked: serverWide || parallel.checked,
          disabled: serverWide || parallel.disabled || !enable.enabled,
          'aria-label': `${tool.rawName} 支持并行`,
          onChange: (event: ChangeEvent) => props.onToggleTool(parallel.fullName, event.target.checked),
        }),
        h('span', null, '支持并行'))));
}
