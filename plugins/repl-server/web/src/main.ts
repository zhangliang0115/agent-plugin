/** Admin UI shell: sidebar, top bar, theme, routing and page mounting for RS-18/RS-20.
 *
 * The local admin has no password gate: the server mints its cookie session on the first
 * static request. A `?token=` bootstrap parameter is still accepted and stored as a
 * Bearer token for token-only deployments, then stripped from the address bar.
 *
 * Every API call goes through the same {@link ApiClient}. A rejected session shows a
 * non-blocking banner with a reconnect action instead of a login page. Each route builds
 * one page module; the previous page is destroyed before the next is mounted, so its
 * timers, polling loops and drawer listeners do not survive navigation.
 * @module
 */

import { createApiClient } from './lib/api.ts';
import { createHashRouter, type RouteLocation } from './lib/router.ts';
import { escapeHtml } from './lib/format.ts';
import { createAuditPage } from './pages/audit.ts';
import { createManagePage, MANAGE_NAV_GROUPS } from './pages/manage.ts';
import { createOverviewPage } from './pages/overview.ts';
import { iconMarkup, type PageHandle } from './pages/shared.ts';

const ROUTES = ['/overview', '/audit', '/manage'] as const;
const TOKEN_QUERY_PARAM = 'token';
const THEME_STORAGE_KEY = 'repl-server.admin.theme';
const THEME_COLOR_DARK = '#0a0b10';
const THEME_COLOR_LIGHT = '#f6f7fb';
const HEALTH_INTERVAL_MS = 30_000;

type Theme = 'dark' | 'light';
type ConnectionState = 'online' | 'offline' | 'checking' | 'lost';

interface PageMeta {
  title: string;
  summary: string;
}

const PAGES: Readonly<Record<string, PageMeta>> = {
  '/overview': {
    title: '概览',
    summary: '进程、容量、连接池与活跃会话。',
  },
  '/audit': {
    title: '审计',
    summary: '调用列表、eval 轨迹与协议帧；先选范围再下钻。',
  },
  '/manage': {
    title: '管理',
    summary: '服务端、工具、客户端、密钥、告警、AI 配置、导入导出与发现；八个分区按连接 / 配置 / 迁移分组。',
  },
};

interface NavItem {
  route: string;
  label: string;
  icon: string;
}

interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: '监控',
    items: [
      { route: '/overview', label: '概览', icon: 'overview' },
      { route: '/audit', label: '审计', icon: 'audit' },
    ],
  },
  {
    label: '系统',
    items: [{ route: '/manage', label: '管理', icon: 'manage' }],
  },
];

const root = document.querySelector<HTMLElement>('#app');
if (root === null) {
  throw new Error('repl-server admin: #app is missing');
}
const appRoot: HTMLElement = root;

/** Pages may expose a leave guard; the manage editor uses it for unsaved drafts. */
interface ShellPageHandle extends PageHandle {
  canLeave?: () => boolean;
}

let activePage: ShellPageHandle | null = null;
let unauthorizedShown = false;
let healthTimer: number | null = null;
let healthInFlight = false;

const api = createApiClient({
  onUnauthorized: () => showReconnectBanner(),
});

const router = createHashRouter({
  routes: ROUTES,
  fallback: '/overview',
  onChange: renderRoute,
});

/** Reads `?token=`, stores it, and removes it from the visible URL. */
function takeBootstrapToken(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get(TOKEN_QUERY_PARAM);
  if (token === null) return null;
  url.searchParams.delete(TOKEN_QUERY_PARAM);
  const search = url.searchParams.toString();
  window.history.replaceState(null, '', `${url.pathname}${search === '' ? '' : `?${search}`}${url.hash}`);
  return token;
}

function currentTheme(): Theme {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark';
}

function manageSubMarkup(): string {
  return `<div class="sidebar-sub" data-manage-sub hidden>
    ${MANAGE_NAV_GROUPS.map(
      (group) => `
      <p class="sidebar-sub-label">${escapeHtml(group.label)}</p>
      ${group.items
        .map(
          (item) => `
        <a class="sidebar-sublink" href="#/manage${item.tab === 'servers' ? '' : `?tab=${item.tab}`}" data-route="/manage" data-manage-tab="${item.tab}">${escapeHtml(item.label)}</a>`,
        )
        .join('')}`,
    ).join('')}
  </div>`;
}

function navMarkup(): string {
  return NAV_GROUPS.map(
    (group) => `
      <div class="sidebar-group">
        <p class="sidebar-group-label">${escapeHtml(group.label)}</p>
        ${group.items
          .map(
            (item) => `
          <a class="sidebar-link" href="#${item.route}" data-route="${item.route}">
            ${iconMarkup(item.icon, 16)}
            <span>${escapeHtml(item.label)}</span>
          </a>${item.route === '/manage' ? manageSubMarkup() : ''}`,
          )
          .join('')}
      </div>`,
  ).join('');
}

function shellMarkup(): string {
  const theme = currentTheme();
  const themeLabel = theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题';
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <span class="brand-mark" aria-hidden="true">${iconMarkup('terminal', 16)}</span>
          <span class="brand-name">repl-server</span>
          <span class="badge tone-info brand-badge">admin</span>
        </div>
        <nav class="sidebar-nav" aria-label="主导航">${navMarkup()}</nav>
        <div class="sidebar-footer">
          <div class="sidebar-meta">
            <span class="sidebar-version" data-version>v—</span>
            <span class="badge tone-neutral">本地</span>
          </div>
          <span class="connection" data-connection data-state="checking">
            <span class="connection-dot" aria-hidden="true"></span>
            <span data-connection-label>连接中</span>
          </span>
        </div>
      </aside>
      <div class="app-column">
        <header class="topbar">
          <div class="topbar-heading">
            <p class="topbar-breadcrumb">
              <span>repl-server</span>
              <span class="sep" aria-hidden="true">/</span>
              <span data-breadcrumb>概览</span>
            </p>
            <div class="topbar-title-row">
              <h1 class="topbar-title" data-page-title>概览</h1>
              <p class="topbar-summary" data-page-summary>进程、容量、连接池与活跃会话。</p>
            </div>
          </div>
          <div class="topbar-actions">
            <span class="connection-pill" data-connection-pill data-state="checking">
              <span class="connection-dot" aria-hidden="true"></span>
              <span data-connection-text>连接中</span>
            </span>
            <button
              class="icon-button"
              type="button"
              data-action="refresh"
              title="刷新当前页"
              aria-label="刷新当前页"
            >${iconMarkup('refresh', 16)}</button>
            <button
              class="icon-button theme-toggle"
              type="button"
              data-action="theme"
              title="${themeLabel}"
              aria-label="${themeLabel}"
            >${iconMarkup(theme === 'dark' ? 'sun' : 'moon', 16)}</button>
          </div>
        </header>
        <div class="alert-slot" data-alert-slot></div>
        <main class="app-main" data-view>
          <div class="empty-state card loading" role="status">
            <span class="spinner"></span>
            <p class="empty-hint">正在加载…</p>
          </div>
        </main>
      </div>
      <div class="drawer-backdrop" data-drawer-backdrop data-open="false"></div>
      <aside class="drawer" data-drawer data-open="false" aria-hidden="true" aria-label="详情"></aside>
    </div>
  `;
}

function showShell(): void {
  appRoot.innerHTML = shellMarkup();
  bindShellActions();
  applyTheme(currentTheme(), false);
  // Registered before `router.start()` so a cancelled browser back/forward can restore
  // the previous hash before the router sees the change.
  window.addEventListener('hashchange', guardHashNavigation);
  window.addEventListener('repl:manage-tab', (event) => {
    const tab = (event as CustomEvent<unknown>).detail;
    if (typeof tab === 'string') setManageTabActive(tab);
  });
  router.start();
  startHealthChecks();
  void hydrateCsrfToken();
}

/** Browser back/forward has no click to cancel; restore the old hash when the page objects. */
function guardHashNavigation(): void {
  if (canLeavePage()) return;
  try {
    window.history.replaceState(null, '', `#${router.current().hash}`);
  } catch {
    // A blocked history API leaves the address bar changed; the page stays mounted.
  }
}

function bindShellActions(): void {
  appRoot
    .querySelector<HTMLButtonElement>('[data-action="theme"]')
    ?.addEventListener('click', () => {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    });

  appRoot
    .querySelector<HTMLButtonElement>('[data-action="refresh"]')
    ?.addEventListener('click', (event) => {
      const control = event.currentTarget;
      if (control instanceof HTMLElement) {
        control.classList.add('is-spinning');
        window.setTimeout(() => control.classList.remove('is-spinning'), 600);
      }
      refreshCurrentPage();
    });

  appRoot
    .querySelector<HTMLElement>('.sidebar-nav')
    ?.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>('a[data-route]');
      if (link === null) return;
      if (link.getAttribute('href') === `#${router.current().hash}`) return;
      if (!canLeavePage()) event.preventDefault();
    });
}

/** Asks the mounted page before a shell action replaces it; pages without a guard leave. */
function canLeavePage(): boolean {
  return activePage?.canLeave === undefined ? true : activePage.canLeave();
}

function applyTheme(theme: Theme, persist: boolean): void {
  document.documentElement.dataset['theme'] = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta !== null) meta.content = theme === 'light' ? THEME_COLOR_LIGHT : THEME_COLOR_DARK;
  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Blocked storage must not break the toggle; the theme still applies in this tab.
    }
  }
  const toggle = appRoot.querySelector<HTMLButtonElement>('[data-action="theme"]');
  if (toggle === null) return;
  const label = theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题';
  toggle.title = label;
  toggle.setAttribute('aria-label', label);
  toggle.innerHTML = iconMarkup(theme === 'dark' ? 'sun' : 'moon', 16);
}

function refreshCurrentPage(): void {
  if (!canLeavePage()) return;
  renderRoute(router.current());
}

/** Fetches the cookie-session CSRF token; bearer writes do not need it, so failure is silent. */
async function hydrateCsrfToken(): Promise<void> {
  try {
    const response = await api.get<{ csrfToken?: unknown }>('/csrf');
    if (typeof response === 'object' && response !== null && typeof response.csrfToken === 'string') {
      api.setCsrfToken(response.csrfToken);
    }
  } catch {
    // A missing endpoint or an expired session is surfaced by the calling page.
  }
}

function showReconnectBanner(): void {
  setConnection('lost', '连接已失效');
  if (unauthorizedShown) return;
  const slot = appRoot.querySelector<HTMLElement>('[data-alert-slot]');
  if (slot === null) return;
  unauthorizedShown = true;
  slot.innerHTML = `
    <div class="alert-bar" role="alert">
      ${iconMarkup('alert', 16)}
      <span class="alert-text">与管理服务的连接已失效</span>
      <button class="button sm danger" type="button" data-action="reconnect">重新连接</button>
    </div>
  `;
  slot
    .querySelector<HTMLButtonElement>('[data-action="reconnect"]')
    ?.addEventListener('click', () => {
      window.location.reload();
    });
}

function setConnection(state: ConnectionState, label: string): void {
  for (const node of appRoot.querySelectorAll<HTMLElement>(
    '[data-connection], [data-connection-pill]',
  )) {
    node.dataset['state'] = state;
  }
  for (const node of appRoot.querySelectorAll<HTMLElement>(
    '[data-connection-label], [data-connection-text]',
  )) {
    node.textContent = label;
  }
}

function setVersion(value: string): void {
  const text = value.startsWith('v') ? value : `v${value}`;
  for (const node of appRoot.querySelectorAll<HTMLElement>('[data-version]')) {
    node.textContent = text;
  }
}

interface HealthBody {
  ok?: unknown;
  version?: unknown;
}

/** `/health` is unauthenticated; it doubles as the shell's connection indicator. */
async function probeHealth(): Promise<void> {
  if (healthInFlight) return;
  healthInFlight = true;
  try {
    const response = await fetch('/health', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const record = body as HealthBody;
      if (typeof record.version === 'string' && record.version !== '') setVersion(record.version);
    }
    if (!unauthorizedShown) setConnection('online', '已连接');
  } catch {
    if (!unauthorizedShown) setConnection('offline', '连接中断');
  } finally {
    healthInFlight = false;
  }
}

function startHealthChecks(): void {
  if (healthTimer !== null) return;
  void probeHealth();
  healthTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void probeHealth();
  }, HEALTH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void probeHealth();
  });
}

function resetDrawer(): void {
  const backdrop = appRoot.querySelector<HTMLElement>('[data-drawer-backdrop]');
  const drawer = appRoot.querySelector<HTMLElement>('[data-drawer]');
  if (backdrop !== null) backdrop.dataset['open'] = 'false';
  if (drawer !== null) {
    drawer.dataset['open'] = 'false';
    drawer.setAttribute('aria-hidden', 'true');
    drawer.replaceChildren();
  }
  document.body.classList.remove('drawer-open');
}

function setText(selector: string, text: string): void {
  const node = appRoot.querySelector<HTMLElement>(selector);
  if (node !== null) node.textContent = text;
}

function setManageTabActive(tab: string | null): void {
  for (const link of appRoot.querySelectorAll<HTMLAnchorElement>('a[data-manage-tab]')) {
    if (tab !== null && link.dataset['manageTab'] === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function renderRoute(location: RouteLocation): void {
  const meta = PAGES[location.route] ?? { title: location.route, summary: '' };
  document.title = `${meta.title} · repl-server`;
  setText('[data-page-title]', meta.title);
  setText('[data-breadcrumb]', meta.title);
  setText('[data-page-summary]', meta.summary);

  for (const link of appRoot.querySelectorAll<HTMLAnchorElement>('a[data-route]')) {
    if (link.dataset['manageTab'] !== undefined) continue;
    if (link.dataset['route'] === location.route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const manageSub = appRoot.querySelector<HTMLElement>('[data-manage-sub]');
  if (manageSub !== null) manageSub.hidden = location.route !== '/manage';
  setManageTabActive(
    location.route === '/manage' ? location.query.get('tab') ?? 'servers' : null,
  );

  resetDrawer();
  activePage?.destroy();
  activePage = null;

  const view = appRoot.querySelector<HTMLElement>('[data-view]');
  if (view === null) return;
  try {
    const page = createRoutePage(location);
    activePage = page;
    view.replaceChildren(page.element);
  } catch (error) {
    view.replaceChildren(pageError(location, error));
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function createRoutePage(location: RouteLocation): PageHandle {
  const context = {
    api,
    location,
    query: location.query,
    navigate: router.navigate,
  };
  if (location.route === '/audit') return createAuditPage(context);
  if (location.route === '/manage') return createManagePage(context);
  return createOverviewPage(context);
}

function pageError(location: RouteLocation, error: unknown): HTMLElement {
  const section = document.createElement('section');
  section.className = 'page';
  section.dataset['route'] = location.route;

  const body = document.createElement('div');
  body.className = 'card empty-state';
  const icon = document.createElement('span');
  icon.className = 'empty-icon';
  icon.innerHTML = iconMarkup('alert', 26);
  const message = document.createElement('p');
  message.className = 'empty-title';
  message.textContent = '页面加载失败。';
  const detail = document.createElement('p');
  detail.className = 'empty-hint';
  detail.textContent = error instanceof Error ? error.message : String(error);
  body.append(icon, message, detail);
  section.appendChild(body);
  return section;
}

function boot(): void {
  const bootstrapToken = takeBootstrapToken();
  if (bootstrapToken !== null) api.setToken(bootstrapToken);
  showShell();
}

boot();
