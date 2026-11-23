/** Hash routing for the admin React app: `/overview`, `/logs`, `/reports`, `/manage?tab=…`. */
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
  path: '/overview' | '/logs' | '/reports' | '/requests' | '/manage';
  tab: ManageTab;
  /** Server filter for the tools tab, from `?server=…`. */
  server: string | null;
}

export const MANAGE_TABS: ReadonlyArray<{ id: ManageTab; label: string }> = [
  { id: 'servers', label: '服务端' },
  { id: 'tools', label: '工具' },
  { id: 'clients', label: '客户端' },
  { id: 'secrets', label: '密钥' },
  { id: 'tags', label: '标签' },
  { id: 'categories', label: '分类' },
  { id: 'alerts', label: '告警' },
  { id: 'ai', label: 'AI 配置' },
  { id: 'config', label: '导入导出' },
  { id: 'discover', label: '发现' },
];

export function parseRoute(hash: string): RouteState {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const path = pathPart === '' ? '/overview' : pathPart.replace(/\/+$/u, '');
  const params = new URLSearchParams(queryPart);
  const tab = params.get('tab');
  const valid = MANAGE_TABS.some((entry) => entry.id === tab);
  const resolved = (valid ? tab : 'servers') as ManageTab;
  const server = params.get('server');
  return {
    path: (path === '/logs' || path === '/reports' || path === '/requests' || path === '/manage'
      ? path
      : '/overview') as RouteState['path'],
    tab: resolved,
    server: resolved === 'tools' && server !== null && server !== '' ? server : null,
  };
}

export function routeHash(path: RouteState['path'], tab: ManageTab = 'servers', server?: string | null): string {
  if (path !== '/manage') return `#${path}`;
  const params = new URLSearchParams();
  if (tab !== 'servers') params.set('tab', tab);
  if (tab === 'tools' && server !== undefined && server !== null && server !== '') params.set('server', server);
  const query = params.toString();
  return query === '' ? '#/manage' : `#/manage?${query}`;
}

export function navigate(path: RouteState['path'], tab: ManageTab = 'servers', server?: string | null): void {
  const next = routeHash(path, tab, server);
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
