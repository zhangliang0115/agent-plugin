/** Admin shell: sidebar, breadcrumb header, command palette, theme. */
import { App as AntApp, ConfigProvider, Layout, Menu, Button, Alert, Tooltip } from 'antd';
import {
  AlertOutlined,
  ApartmentOutlined,
  ApiOutlined,
  AppstoreOutlined,
  CompassOutlined,
  DashboardOutlined,
  ImportOutlined,
  KeyOutlined,
  MoonOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  ClusterOutlined,
  SunOutlined,
  TagsOutlined,
  ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';

import { hydrateCsrf } from './api.tsx';
import { adminTheme, type AdminTheme } from './theme.ts';
import { MANAGE_TABS, navigate, useRoute, type ManageTab, type RouteState } from './router.ts';
import { CommandPalette } from './components/CommandPalette.tsx';
import type { PaletteItem } from '../lib/command-palette.ts';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { AuditPage } from './pages/AuditPage.tsx';
import { ReportsPage } from './pages/ReportsPage.tsx';
import { ServersPage } from './pages/ServersPage.tsx';
import { ToolsPage } from './pages/ToolsPage.tsx';
import { ClientsPage } from './pages/ClientsPage.tsx';
import { SecretsPage } from './pages/SecretsPage.tsx';
import { TagsPage } from './pages/TagsPage.tsx';
import { CategoriesPage } from './pages/CategoriesPage.tsx';
import { AlertsPage } from './pages/AlertsPage.tsx';
import { AiPage } from './pages/AiPage.tsx';
import { ConfigPage } from './pages/ConfigPage.tsx';
import { DiscoverPage } from './pages/DiscoverPage.tsx';

const { Sider, Header, Content } = Layout;
const THEME_KEY = 'repl-server.admin.theme';

const TAB_ICONS: Record<ManageTab, React.ReactNode> = {
  servers: <ClusterOutlined />,
  tools: <ToolOutlined />,
  clients: <ApiOutlined />,
  secrets: <KeyOutlined />,
  tags: <TagsOutlined />,
  categories: <ApartmentOutlined />,
  alerts: <WarningOutlined />,
  ai: <RobotOutlined />,
  config: <ImportOutlined />,
  discover: <CompassOutlined />,
};

function initialTheme(): AdminTheme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function App(): React.ReactElement {
  const [mode, setMode] = useState<AdminTheme>(initialTheme);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [lost, setLost] = useState(false);
  const route = useRoute();

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta !== null) meta.content = mode === 'light' ? '#f5f6fa' : '#0a0b10';
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      // Blocked storage still allows the in-memory theme.
    }
  }, [mode]);

  useEffect(() => {
    void hydrateCsrf();
    const onUnauthorized = (): void => setLost(true);
    window.addEventListener('repl:unauthorized', onUnauthorized);
    return () => window.removeEventListener('repl:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A clicked menu item keeps focus after SPA navigation, which reads as a second
  // selected row; drop it once the route settles.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.ant-menu') !== null) active.blur();
  }, [route.path, route.tab]);

  const selectedKey = route.path === '/manage' ? `manage:${route.tab}` : route.path;

  const menuItems = useMemo(
    () => [
      {
        type: 'group' as const,
        label: '监控',
        children: [
          { key: '/overview', icon: <DashboardOutlined />, label: '概览' },
          { key: '/audit', icon: <AlertOutlined />, label: '审计' },
          { key: '/reports', icon: <AppstoreOutlined />, label: '报告' },
        ],
      },
      {
        type: 'group' as const,
        label: '系统管理',
        children: MANAGE_TABS.map((tab) => ({
          key: `manage:${tab.id}`,
          icon: TAB_ICONS[tab.id],
          label: tab.label,
        })),
      },
    ],
    [],
  );

  function openPaletteItem(item: PaletteItem): void {
    setPaletteOpen(false);
    navigate(item.path, item.tab ?? 'servers');
  }

  const tabLabel = route.path === '/manage' ? MANAGE_TABS.find((tab) => tab.id === route.tab)?.label : undefined;

  return (
    <ConfigProvider theme={adminTheme(mode)}>
      <AntApp>
        <Layout className="shell">
          <Sider width={224} className="sidebar" theme={mode}>
            <div className="brand">
              <span className="brand-mark">R</span>
              <span className="brand-name">repl-server</span>
              <span className="badge-soft">admin</span>
            </div>
            <Menu
              mode="inline"
              theme={mode}
              selectedKeys={[selectedKey]}
              items={menuItems}
              onClick={({ key }) => {
                if (key.startsWith('/')) {
                  navigate(key as RouteState['path']);
                  return;
                }
                navigate('/manage', key.slice('manage:'.length) as ManageTab);
              }}
            />
            <div className="sidebar-foot">
              <span>v0.1.0</span>
              <span className="conn-dot" /> 已连接
            </div>
          </Sider>
          <Layout className="column">
            <Header className="topbar">
              <div className="crumbs">
                <span>repl-server</span>
                <span className="sep">/</span>
                <b>
                  {route.path === '/manage'
                    ? `系统管理 / ${tabLabel ?? ''}`
                    : route.path === '/overview'
                      ? '监控 / 概览'
                      : route.path === '/audit'
                        ? '监控 / 审计'
                        : '监控 / 报告'}
                </b>
              </div>
              <button
                type="button"
                className="topbar-search"
                aria-label="搜索页面与服务端"
                onClick={() => setPaletteOpen(true)}
              >
                <SearchOutlined />
                <span className="topbar-search-text">搜索页面、服务端</span>
                <kbd className="topbar-search-kbd">⌘K</kbd>
              </button>
              <div className="topbar-actions">
                <Tooltip title="刷新当前页">
                  <Button
                    type="text"
                    icon={<ReloadOutlined />}
                    onClick={() => window.dispatchEvent(new CustomEvent('repl:refresh'))}
                  />
                </Tooltip>
                <Tooltip title={mode === 'dark' ? '切换到亮色' : '切换到暗色'}>
                  <Button
                    type="text"
                    icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
                    onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
                  />
                </Tooltip>
              </div>
            </Header>
            <Content className="content">
              {lost ? (
                <Alert
                  type="error"
                  showIcon
                  closable
                  message="与管理服务的连接已失效"
                  description="会话过期或服务已重启。重新加载页面可建立新的本地会话。"
                  action={
                    <Button size="small" onClick={() => window.location.reload()}>
                      重新连接
                    </Button>
                  }
                  style={{ marginBottom: 16 }}
                />
              ) : null}
              <Page route={route} />
            </Content>
          </Layout>
        </Layout>
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onNavigate={openPaletteItem}
        />
      </AntApp>
    </ConfigProvider>
  );
}

function Page({ route }: { route: RouteState }): React.ReactElement {
  if (route.path === '/reports') return <ReportsPage />;
  if (route.path === '/audit') return <AuditPage />;
  if (route.path === '/overview') return <OverviewPage />;
  switch (route.tab) {
    case 'servers':
      return <ServersPage />;
    case 'tools':
      return <ToolsPage serverId={route.server} />;
    case 'clients':
      return <ClientsPage />;
    case 'secrets':
      return <SecretsPage />;
    case 'tags':
      return <TagsPage />;
    case 'categories':
      return <CategoriesPage />;
    case 'alerts':
      return <AlertsPage />;
    case 'ai':
      return <AiPage />;
    case 'config':
      return <ConfigPage />;
    case 'discover':
      return <DiscoverPage />;
    default:
      return <OverviewPage />;
  }
}

export default App;
