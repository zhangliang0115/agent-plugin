/** Hash routing for the admin React app: `/overview`, `/audit`, `/reports`, `/manage?tab=…`. */
import { useEffect, useState } from 'react';

export type ManageTab =
  | 'servers'
  | 'tools'
  | 'clients'
  | 'secrets'
  | 'tags'
  | 'categories'
  | 'alerts'
  | 'ai'
  | 'config'
  | 'discover';

export interface RouteState {
  path: '/overview' | '/audit' | '/reports' | '/manage';
  tab: ManageTab;
}

export const MANAGE_TABS: ReadonlyArray<{ id: ManageTab; label: string; group: '连接' | '配置' | '迁移' }> = [
  { id: 'servers', label: '服务端', group: '连接' },
  { id: 'tools', label: '工具', group: '连接' },
  { id: 'clients', label: '客户端', group: '连接' },
  { id: 'secrets', label: '密钥', group: '配置' },
  { id: 'tags', label: '标签', group: '配置' },
  { id: 'categories', label: '分类', group: '配置' },
  { id: 'alerts', label: '告警', group: '配置' },
  { id: 'ai', label: 'AI 配置', group: '配置' },
  { id: 'config', label: '导入导出', group: '迁移' },
  { id: 'discover', label: '发现', group: '迁移' },
];

export function parseRoute(hash: string): RouteState {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const path = pathPart === '' ? '/overview' : pathPart.replace(/\/+$/u, '');
  const tab = new URLSearchParams(queryPart).get('tab');
  const valid = MANAGE_TABS.some((entry) => entry.id === tab);
  return {
    path: (path === '/audit' || path === '/reports' || path === '/manage' ? path : '/overview') as RouteState['path'],
    tab: (valid ? tab : 'servers') as ManageTab,
  };
}

export function routeHash(path: RouteState['path'], tab: ManageTab = 'servers'): string {
  if (path !== '/manage') return `#${path}`;
  return tab === 'servers' ? '#/manage' : `#/manage?tab=${tab}`;
}

export function navigate(path: RouteState['path'], tab: ManageTab = 'servers'): void {
  const next = routeHash(path, tab);
  if (window.location.hash === next) return;
  window.location.hash = next;
}

export function useRoute(): RouteState {
  const [route, setRoute] = useState<RouteState>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    if (window.location.hash === '') window.location.hash = '#/overview';
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
