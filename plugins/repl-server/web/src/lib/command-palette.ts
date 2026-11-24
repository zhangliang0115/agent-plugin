/** Command-palette data: static page entries plus a pure filter over pages and servers. */
import type { ManageTab } from '../app/router.ts';

export interface PaletteServer {
  id: string;
  label: string;
}

export interface PaletteItem {
  kind: '页面' | 'Server';
  label: string;
  hint: string;
  path: '/overview' | '/logs' | '/reports' | '/requests' | '/manage';
  tab?: ManageTab;
}

export const PALETTE_PAGES: readonly PaletteItem[] = [
  { kind: '页面', label: '概览', hint: '监控', path: '/overview' },
  { kind: '页面', label: '事件', hint: '监控', path: '/logs' },
  { kind: '页面', label: '请求记录', hint: '监控', path: '/requests' },
  { kind: '页面', label: '报告', hint: '监控', path: '/reports' },
  { kind: '页面', label: '服务端', hint: '系统管理', path: '/manage', tab: 'servers' },
  { kind: '页面', label: '工具', hint: '系统管理', path: '/manage', tab: 'tools' },
  { kind: '页面', label: '脚本库', hint: '系统管理', path: '/manage', tab: 'scripts' },
  { kind: '页面', label: '客户端', hint: '系统管理', path: '/manage', tab: 'clients' },
  { kind: '页面', label: '密钥', hint: '系统管理', path: '/manage', tab: 'secrets' },
  { kind: '页面', label: '标签', hint: '系统管理', path: '/manage', tab: 'tags' },
  { kind: '页面', label: '分类', hint: '系统管理', path: '/manage', tab: 'categories' },
  { kind: '页面', label: '告警', hint: '系统管理', path: '/manage', tab: 'alerts' },
  { kind: '页面', label: 'AI 配置', hint: '系统管理', path: '/manage', tab: 'ai' },
  { kind: '页面', label: '导入导出', hint: '系统管理', path: '/manage', tab: 'config' },
  { kind: '页面', label: '发现', hint: '系统管理', path: '/manage', tab: 'discover' },
];

export function serverItem(server: PaletteServer): PaletteItem {
  return {
    kind: 'Server',
    label: server.label,
    hint: server.id,
    path: '/manage',
    tab: 'servers',
  };
}

/** Case-insensitive match over label, hint and kind. */
export function filterPaletteItems(
  items: readonly PaletteItem[],
  query: string,
): PaletteItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...items];
  return items.filter((item) =>
    `${item.label} ${item.hint} ${item.kind}`.toLowerCase().includes(needle),
  );
}
