/** Management page: servers, tools, clients, secrets, config transfer and discovery (RS-20).
 *
 * Every mutation goes through `/admin/api` with the typed client. Catalog writes send
 * `If-Match: <meta.revision>` and surface `REVISION_CONFLICT` as an actionable message;
 * connection actions return 202 and are followed through `GET /operations/:id`.
 *
 * The page uses the shell's top-level tabs and rebuilds only the active tab. Editor drafts
 * live in `state`, so a re-render triggered by a refresh does not discard typed input.
 * Lists are data tables with sticky headers and row-level actions; long-lived notices stay
 * in the inline banner while successful mutations also raise a transient toast. Server,
 * tool and client detail views open in the shared drawer.
 * @module
 */

import { ApiError } from '../lib/api.ts';
import {
  formatDuration,
  formatId,
  formatJson,
  formatNumber,
  formatRelativeTime,
} from '../lib/format.ts';
import {
  add,
  badge,
  button,
  cardSection,
  confirmAction,
  copyButton,
  createDrawer,
  definitionList,
  describeError,
  el,
  emptyState,
  field,
  formError,
  icon,
  input,
  loading,
  notice,
  pageFrame,
  selectControl,
  setFormError,
  setStyle,
  statusBadge,
  switchControl,
  tabs,
  textarea,
  textInput,
  toast,
  type NoticeTone,
  type PageContext,
  type PageHandle,
  type TabOption,
} from './shared.ts';

// ---------------------------------------------------------------------------
// API shapes (03 §4.2–4.3)
// ---------------------------------------------------------------------------

type ServerTransport = 'stdio' | 'http' | 'builtin';
type ConnectMode = 'lazy' | 'eager';
type ToolConcurrency = 'parallel' | 'serial' | 'exclusive';

interface ServerView {
  id: string;
  label: string;
  transport: ServerTransport;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  connectMode: ConnectMode;
  summary: string | null;
  category: string | null;
  tags: string[];
  timeoutMs: number;
  maxConcurrency: number;
  revision: number;
  state: string;
  lastError?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface ServersResponse {
  servers: ServerView[];
  revision: number;
}

interface ToolRecord {
  serverId: string;
  name: string;
  displayName: string | null;
  description: string | null;
  descriptionOverride: string | null;
  enabled: boolean;
  concurrency: ToolConcurrency;
  type: string | null;
  tags: string[];
  category: string | null;
  schema?: unknown;
  stale: boolean;
  staleOverride: boolean;
  effective?: {
    description: string | null;
    enabled: boolean;
    concurrency: ToolConcurrency;
    tags: string[];
    category: string | null;
    stale: boolean;
    exposed: boolean;
  };
}

interface ToolsResponse {
  server: { id: string; label: string; enabled: boolean; tags: string[]; category: string | null };
  tools: ToolRecord[];
  revision: number;
}

interface ClientQuota {
  maxExecSessionsPerBinding?: number;
  maxInFlightEvalsPerBinding?: number;
  maxInFlightCallsPerBindingPerServer?: number;
  maxQueuedCallsPerBindingPerServer?: number;
}

interface ClientBinding {
  id: string;
  label: string;
  defaultWorkspace: string | null;
  allowedServers: string[] | null;
  allowedTags: string[] | null;
  quota: ClientQuota | null;
  createdAt: string;
  lastSeenAt: string | null;
  activeSessions?: number;
}

interface McpSessionRecord {
  mcpSessionId: string;
  bindingId: string | null;
  client: string;
  connectedAt?: string;
  lastRequestAt?: string;
  execSessionIds?: string[];
}

interface ClientsResponse {
  clients: ClientBinding[];
  sessions: McpSessionRecord[];
}

interface SecretStatus {
  name: string;
  configured: boolean;
}

interface SecretsResponse {
  secrets?: SecretStatus[];
}

interface ConfigDocument {
  version: number;
  servers: unknown[];
}

interface DiscoverSuggestion {
  id: string;
  label: string;
  command: string | null;
  args: string[];
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  alreadyExists: boolean;
  requiredSecrets: string[];
}

interface Operation {
  operationId: string;
  kind: string;
  target: string;
  state: 'running' | 'ok' | 'error';
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
}

type Tab = 'servers' | 'tools' | 'clients' | 'secrets' | 'config' | 'discover';

interface ServerDraft {
  mode: 'create' | 'edit';
  id: string;
  label: string;
  transport: ServerTransport;
  command: string;
  args: string;
  cwd: string;
  url: string;
  envKeys: string;
  headerKeys: string;
  enabled: boolean;
  connectMode: ConnectMode;
  summary: string;
  category: string;
  tags: string;
  timeoutMs: string;
  maxConcurrency: string;
  revision: number;
}

interface ClientDraft {
  mode: 'create' | 'edit';
  id: string;
  label: string;
  defaultWorkspace: string;
  allowedServers: string;
  allowedTags: string;
  quota: Record<string, string>;
}

interface ImportReport {
  tone: NoticeTone;
  text: string;
}

const TABS: ReadonlyArray<TabOption> = [
  { id: 'servers', label: 'Servers', icon: 'server' },
  { id: 'tools', label: 'Tools', icon: 'tool' },
  { id: 'clients', label: 'Clients', icon: 'users' },
  { id: 'secrets', label: '密钥', icon: 'key' },
  { id: 'config', label: '导入导出', icon: 'download' },
  { id: 'discover', label: 'Discover', icon: 'search' },
];

const CONCURRENCY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'parallel', label: 'parallel（读锁）' },
  { value: 'serial', label: 'serial（写锁）' },
  { value: 'exclusive', label: 'exclusive（全局）' },
];

const TRANSPORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'http' },
];

const CONNECT_MODE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'lazy', label: 'lazy（默认）' },
  { value: 'eager', label: 'eager' },
];

const QUOTA_KEYS = [
  'maxExecSessionsPerBinding',
  'maxInFlightEvalsPerBinding',
  'maxInFlightCallsPerBindingPerServer',
  'maxQueuedCallsPerBindingPerServer',
] as const;

export function createManagePage(context: PageContext): PageHandle {
  const { section, body } = pageFrame(
    '管理',
    'servers、tools、clients、密钥、配置导入导出与本地 discover；写操作同步落库后才会刷新列表。',
  );

  const state = {
    tab: 'servers' as Tab,
    servers: [] as ServerView[],
    serversRevision: 0,
    serversLoaded: false,
    serverQuery: '',
    serverDraft: null as ServerDraft | null,
    selectedServerId: null as string | null,
    tools: [] as ToolRecord[],
    toolsRevision: 0,
    toolsServerId: null as string | null,
    toolDraft: null as ToolRecord | null,
    clients: [] as ClientBinding[],
    sessions: [] as McpSessionRecord[],
    clientsLoaded: false,
    clientDraft: null as ClientDraft | null,
    tokenReveal: null as { label: string; token: string } | null,
    secrets: [] as SecretStatus[],
    secretsLoaded: false,
    configText: '',
    configLoaded: false,
    importText: '',
    importReport: null as ImportReport | null,
    suggestions: [] as DiscoverSuggestion[],
    discoverLoaded: false,
  };

  const drawer = createDrawer();

  const banner = el('div');
  banner.hidden = true;
  const tabHost = el('div');
  const content = el('div');
  setStyle(content, { display: 'flex', flexDirection: 'column', gap: '20px' });
  add(body, tabHost, banner, content);

  let destroyed = false;
  const controller = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  /** Rebuilds the underline tabs so programmatic switches and clicks share one truth. */
  function renderTabs(): void {
    tabHost.replaceChildren(
      tabs(TABS, state.tab, (id) => setTab(id as Tab), { ariaLabel: '管理分区' }),
    );
  }

  function later(callback: () => void, ms: number): void {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (!destroyed) callback();
    }, ms);
    timers.add(timer);
  }

  /** Persistent inline notice; errors and queued operations stay until replaced. */
  function setStatus(message: string | null, tone: NoticeTone = 'info'): void {
    banner.replaceChildren();
    banner.hidden = message === null;
    if (message !== null) add(banner, notice(message, tone));
  }

  /** Transient confirmation for a completed mutation; keeps the banner area clear. */
  function succeeded(message: string): void {
    banner.replaceChildren();
    banner.hidden = true;
    toast(message, 'ok');
  }

  function setTab(tab: Tab): void {
    if (state.tab === tab) return;
    if (state.tab === 'clients' && tab !== 'clients') state.tokenReveal = null;
    state.tab = tab;
    renderTabs();
    setStatus(null);
    void openTab();
  }

  async function openTab(): Promise<void> {
    content.replaceChildren(loading(`正在加载 ${tabLabel(state.tab)}…`));
    try {
      switch (state.tab) {
        case 'servers':
          await ensureServers();
          break;
        case 'tools':
          await ensureServers();
          ensureSelectedServer();
          await ensureTools();
          break;
        case 'clients':
          await loadClients();
          break;
        case 'secrets':
          await loadSecrets();
          break;
        case 'config':
          await loadConfig();
          break;
        case 'discover':
          break;
        default:
          break;
      }
      if (destroyed) return;
      renderTab();
    } catch (error) {
      if (destroyed) return;
      content.replaceChildren(
        emptyState(`${tabLabel(state.tab)}加载失败`, describeError(error)),
        retryButton(),
      );
    }
  }

  function retryButton(): HTMLElement {
    return button('重试', () => {
      void openTab();
    }, { variant: 'primary', icon: 'refresh' });
  }

  function renderTab(): void {
    if (destroyed) return;
    switch (state.tab) {
      case 'servers':
        content.replaceChildren(buildServersTab());
        break;
      case 'tools':
        content.replaceChildren(buildToolsTab());
        break;
      case 'clients':
        content.replaceChildren(buildClientsTab());
        break;
      case 'secrets':
        content.replaceChildren(buildSecretsTab());
        break;
      case 'config':
        content.replaceChildren(buildConfigTab());
        break;
      case 'discover':
        content.replaceChildren(buildDiscoverTab());
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------

  async function ensureServers(force = false): Promise<void> {
    if (state.serversLoaded && !force) return;
    const response = await context.api.get<ServersResponse>('/servers', {
      signal: controller.signal,
    });
    if (destroyed) return;
    state.servers = Array.isArray(response.servers) ? response.servers : [];
    state.serversRevision = numberOr(response.revision, state.serversRevision);
    state.serversLoaded = true;
    if (state.selectedServerId === null) state.selectedServerId = state.servers[0]?.id ?? null;
  }

  async function refreshServers(): Promise<void> {
    state.serversLoaded = false;
    await ensureServers(true);
    if (!destroyed && state.tab === 'servers') renderTab();
  }

  function ensureSelectedServer(): void {
    if (state.selectedServerId !== null && state.servers.some((s) => s.id === state.selectedServerId)) {
      return;
    }
    state.selectedServerId = state.servers[0]?.id ?? null;
    state.tools = [];
    state.toolsServerId = null;
  }

  function buildServersTab(): HTMLElement {
    const fragment = el('div');
    setStyle(fragment, { display: 'flex', flexDirection: 'column', gap: '20px' });

    const search = textInput({
      type: 'search',
      value: state.serverQuery,
      placeholder: '过滤 id / label / tag',
      ariaLabel: '过滤 server',
    });
    setStyle(search, { width: '230px' });

    const refresh = button('刷新', () => {
      void refreshServers().catch((error: unknown) => setStatus(describeError(error), 'error'));
    }, { variant: 'secondary', icon: 'refresh' });
    const create = button('新增 server', () => openServerEditor(null), {
      variant: 'primary',
      icon: 'plus',
    });

    const listCard = cardSection({
      title: 'Servers',
      subtitle: `共 ${formatNumber(state.servers.length)} 个 server · 写操作按 revision 校验`,
      icon: 'server',
      flush: true,
      actions: [search, refresh, create],
    });

    const tableBody = el('tbody');
    if (state.servers.length === 0) {
      listCard.body.appendChild(
        emptyBlock(
          '还没有注册的 server。',
          '新增一个 stdio 或 http server，或先在 Discover 分区探测本地配置。',
        ),
      );
    } else {
      listCard.body.appendChild(tablePanel(buildServersTable(tableBody)));
      fillServerRows(tableBody);
    }

    search.addEventListener('input', () => {
      state.serverQuery = search.value;
      if (tableBody.isConnected) fillServerRows(tableBody);
    });

    if (state.serverDraft !== null) fragment.append(buildServerEditor(state.serverDraft));
    fragment.append(listCard.element);
    return fragment;
  }

  function buildServersTable(tbody: HTMLTableSectionElement): HTMLTableElement {
    const table = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const label of ['server', 'transport', 'state', '启用', 'tags', '更新', '操作']) {
      add(head, el('th', '', label));
    }
    thead.appendChild(head);
    add(table, thead, tbody);
    return table;
  }

  function fillServerRows(tbody: HTMLTableSectionElement): void {
    tbody.replaceChildren();
    const needle = state.serverQuery.trim().toLowerCase();
    const rows = state.servers.filter((server) => {
      if (needle === '') return true;
      return (
        server.id.toLowerCase().includes(needle) ||
        server.label.toLowerCase().includes(needle) ||
        server.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    });

    if (rows.length === 0) {
      const row = el('tr');
      const cell = el('td');
      cell.colSpan = 7;
      const empty = emptyBlock('没有匹配的 server。', '调整过滤词，或新增一个 server。');
      setStyle(empty, { padding: '32px 16px' });
      add(cell, empty);
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }

    for (const server of rows) {
      const row = el('tr');
      if (server.lastError !== undefined && server.lastError !== '') row.title = server.lastError;
      add(
        row,
        serverIdentity(server),
        el('td', 'mono', server.transport),
        td(statusBadge(server.state)),
        td(badge(server.enabled ? '启用' : '停用', server.enabled ? 'ok' : 'neutral')),
        tagCell(server.tags),
        updatedCell(server.updatedAt),
        td(rowActions(...buildServerActions(server))),
      );
      tbody.appendChild(row);
    }
  }

  function buildServerActions(server: ServerView): Node[] {
    const actions: Node[] = [
      button('详情', () => openServerDetail(server), { variant: 'ghost', size: 'sm' }),
      button('编辑', () => openServerEditor(server), { variant: 'ghost', size: 'sm' }),
      button('工具', () => {
        state.selectedServerId = server.id;
        state.tools = [];
        state.toolsServerId = null;
        state.toolDraft = null;
        setTab('tools');
      }, { variant: 'ghost', size: 'sm' }),
    ];
    if (server.transport !== 'builtin') {
      actions.push(
        button('连接', () => void runServerAction(server.id, 'connect'), {
          variant: 'ghost',
          size: 'sm',
        }),
        button('断开', () => void runServerAction(server.id, 'disconnect'), {
          variant: 'ghost',
          size: 'sm',
        }),
        button('重启', () => void runServerAction(server.id, 'restart'), {
          variant: 'ghost',
          size: 'sm',
        }),
        button('测试', () => void testServer(server.id), { variant: 'ghost', size: 'sm' }),
        button('刷新工具', () => void runServerAction(server.id, 'tools/refresh', 'tools_refresh'), {
          variant: 'ghost',
          size: 'sm',
        }),
        button('删除', () => void deleteServer(server), { variant: 'danger', size: 'sm' }),
      );
    }
    return actions;
  }

  function openServerDetail(server: ServerView): void {
    const wrapper = el('div');
    setStyle(wrapper, { display: 'flex', flexDirection: 'column', gap: '16px' });

    const head = el('div', 'toolbar');
    add(
      head,
      statusBadge(server.state),
      badge(server.enabled ? '启用' : '停用', server.enabled ? 'ok' : 'neutral'),
      badge(server.transport, 'info'),
      badge(`revision ${server.revision}`, 'neutral'),
    );
    add(wrapper, head);

    if (server.lastError !== undefined && server.lastError !== '') {
      add(wrapper, notice(server.lastError, 'error'));
    }

    add(
      wrapper,
      definitionList([
        { label: 'id', value: server.id, mono: true },
        { label: 'label', value: server.label },
        { label: 'command', value: commandLine(server), mono: true },
        { label: 'cwd', value: server.cwd ?? '—', mono: true },
        { label: 'url', value: server.url ?? '—', mono: true },
        { label: 'env 键名', value: server.envKeys.join(', ') || '—' },
        { label: 'header 键名', value: server.headerKeys.join(', ') || '—' },
        { label: 'summary', value: server.summary ?? '—' },
        { label: 'category', value: server.category ?? '—' },
        { label: 'tags', value: server.tags.join(', ') || '—' },
        { label: 'connectMode', value: server.connectMode },
        { label: 'timeoutMs', value: formatNumber(server.timeoutMs) },
        { label: 'maxConcurrency', value: formatNumber(server.maxConcurrency) },
        { label: '创建', value: timeValue(server.createdAt) },
        { label: '更新', value: timeValue(server.updatedAt) },
      ]),
    );

    const actions = el('div', 'toolbar');
    add(
      actions,
      button('编辑', () => {
        drawer.close();
        openServerEditor(server);
      }, { variant: 'primary', size: 'sm' }),
      button('关闭', () => drawer.close(), { variant: 'ghost', size: 'sm' }),
    );
    add(wrapper, actions);
    drawer.open(server.label, wrapper);
  }

  function openServerEditor(server: ServerView | null): void {
    state.serverDraft =
      server === null
        ? {
            mode: 'create',
            id: '',
            label: '',
            transport: 'stdio',
            command: '',
            args: '',
            cwd: '',
            url: '',
            envKeys: '',
            headerKeys: '',
            enabled: true,
            connectMode: 'lazy',
            summary: '',
            category: '',
            tags: '',
            timeoutMs: '60000',
            maxConcurrency: '8',
            revision: 0,
          }
        : {
            mode: 'edit',
            id: server.id,
            label: server.label,
            transport: server.transport,
            command: server.command ?? '',
            args: server.args.join('\n'),
            cwd: server.cwd ?? '',
            url: server.url ?? '',
            envKeys: server.envKeys.join('\n'),
            headerKeys: server.headerKeys.join('\n'),
            enabled: server.enabled,
            connectMode: server.connectMode,
            summary: server.summary ?? '',
            category: server.category ?? '',
            tags: server.tags.join(', '),
            timeoutMs: String(server.timeoutMs),
            maxConcurrency: String(server.maxConcurrency),
            revision: server.revision,
          };
    renderTab();
  }

  function buildServerEditor(draft: ServerDraft): HTMLElement {
    const builtin = draft.transport === 'builtin';
    const handle = cardSection({
      title: draft.mode === 'create' ? '注册 server' : `编辑 ${draft.id}`,
      subtitle: 'env/header 只声明键名，值在“密钥”分区写入；args 里的 <secret:NAME> 按引用保存。',
      icon: 'server',
    });

    const idInput = input({
      value: draft.id,
      placeholder: 'pg',
      disabled: draft.mode === 'edit',
    });
    const labelInput = input({ value: draft.label, placeholder: 'PostgreSQL' });
    const transportSelect = selectControl(TRANSPORT_OPTIONS, {
      value: draft.transport === 'http' ? 'http' : 'stdio',
      ariaLabel: 'transport',
    });
    if (draft.mode === 'edit' || builtin) transportSelect.disabled = true;
    const connectSelect = selectControl(CONNECT_MODE_OPTIONS, {
      value: draft.connectMode,
      ariaLabel: 'connectMode',
    });
    const commandInput = input({ value: draft.command, placeholder: 'npx' });
    const argsArea = textarea({ value: draft.args, rows: 3, placeholder: '每行一个参数' });
    const cwdInput = input({ value: draft.cwd, placeholder: '/absolute/workspace' });
    const urlInput = input({ type: 'url', value: draft.url, placeholder: 'https://…/mcp' });
    const envKeysArea = textarea({ value: draft.envKeys, rows: 2, placeholder: '每行一个变量名，值写入密钥' });
    const headerKeysArea = textarea({ value: draft.headerKeys, rows: 2, placeholder: '每行一个 header 名' });
    const summaryInput = input({ value: draft.summary, placeholder: '用于检索的 server 摘要' });
    const categoryInput = input({ value: draft.category, placeholder: 'database' });
    const tagsInput = input({ value: draft.tags, placeholder: 'db, sql' });
    const timeoutInput = input({ type: 'number', value: draft.timeoutMs, min: '1000', max: '7200000' });
    const concurrencyInput = input({ type: 'number', value: draft.maxConcurrency, min: '1', max: '64' });
    const enabledSwitch = switchControl({ checked: draft.enabled, label: '启用该 server' });

    const stdioFields = el('div');
    setStyle(stdioFields, { display: 'flex', flexDirection: 'column', gap: '12px' });
    add(stdioFields, field('command', commandInput), field('args', argsArea), field('cwd', cwdInput));
    const httpFields = el('div');
    setStyle(httpFields, { display: 'flex', flexDirection: 'column', gap: '12px' });
    add(httpFields, field('url', urlInput));

    const showTransport = (): void => {
      stdioFields.hidden = transportSelect.value !== 'stdio';
      httpFields.hidden = transportSelect.value !== 'http';
    };
    transportSelect.addEventListener('change', showTransport);
    showTransport();

    if (builtin) {
      for (const control of [
        commandInput,
        argsArea,
        cwdInput,
        urlInput,
        envKeysArea,
        headerKeysArea,
        timeoutInput,
        concurrencyInput,
        connectSelect,
      ]) {
        control.disabled = true;
      }
    }

    const groups = formGrid();
    add(
      groups,
      groupCard('基本信息', null, [
        field('id', idInput),
        field('label', labelInput),
        field('transport', transportSelect),
        field('connectMode', connectSelect),
      ]),
      groupCard('传输配置', 'stdio 使用 command/args/cwd；http 使用 url。', [
        stdioFields,
        httpFields,
      ]),
      groupCard('元数据', 'summary 用于检索；tags 支持逗号或换行分隔。', [
        field('summary', summaryInput),
        field('category', categoryInput),
        field('tags', tagsInput),
        field('env 键名', envKeysArea),
        field('header 键名', headerKeysArea),
      ]),
      groupCard('运行策略', 'timeoutMs 控制单次调用上限，maxConcurrency 控制并发。', [
        field('timeoutMs', timeoutInput),
        field('maxConcurrency', concurrencyInput),
        enabledSwitch,
      ]),
    );

    const form = el('form');
    form.noValidate = true;
    setStyle(form, { display: 'flex', flexDirection: 'column', gap: '16px' });
    add(
      form,
      notice(
        builtin
          ? 'builtin server 的传输、超时与并发字段只读；label 与元数据仍可修改。'
          : draft.mode === 'create'
            ? 'stdio server 等于允许执行任意命令；保存前请确认 command 与 args。'
            : 'transport 不可修改；删除后重新注册才能更换传输方式。',
        'queue',
      ),
      groups,
    );

    const errorLine = formError();
    const save = button('保存', () => undefined, { type: 'submit', variant: 'primary' });
    const cancel = button('取消', () => {
      state.serverDraft = null;
      renderTab();
    }, { variant: 'ghost' });
    const footer = el('div', 'toolbar');
    add(footer, save, cancel);
    add(form, errorLine, footer);
    handle.body.appendChild(form);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      setFormError(errorLine, null);
      if (
        draft.mode === 'create' &&
        transportSelect.value === 'stdio' &&
        !confirmAction(
          `即将注册 stdio server，启动命令为：\n\n${commandInput.value} ${argsArea.value}\n\n这等于允许在该 cwd 下执行任意命令。继续？`,
        )
      ) {
        return;
      }
      save.disabled = true;
      save.textContent = '保存中…';
      void saveServer({
        draft,
        builtin,
        transport: transportSelect.value === 'http' ? 'http' : 'stdio',
        id: idInput.value,
        label: labelInput.value,
        command: commandInput.value,
        args: argsArea.value,
        cwd: cwdInput.value,
        url: urlInput.value,
        envKeys: envKeysArea.value,
        headerKeys: headerKeysArea.value,
        enabled: enabledSwitch.input.checked,
        connectMode: connectSelect.value === 'eager' ? 'eager' : 'lazy',
        summary: summaryInput.value,
        category: categoryInput.value,
        tags: tagsInput.value,
        timeoutMs: timeoutInput.value,
        maxConcurrency: concurrencyInput.value,
      }).catch((error: unknown) => {
        setFormError(errorLine, saveErrorText(error));
        save.disabled = false;
        save.textContent = '保存';
      });
    });

    return handle.element;
  }

  interface ServerFormInput {
    draft: ServerDraft;
    builtin: boolean;
    transport: 'stdio' | 'http';
    id: string;
    label: string;
    command: string;
    args: string;
    cwd: string;
    url: string;
    envKeys: string;
    headerKeys: string;
    enabled: boolean;
    connectMode: ConnectMode;
    summary: string;
    category: string;
    tags: string;
    timeoutMs: string;
    maxConcurrency: string;
  }

  async function saveServer(values: ServerFormInput): Promise<void> {
    const label = values.label.trim() === '' ? values.id.trim() : values.label.trim();
    if (values.id.trim() === '') throw new Error('id 不能为空。');
    if (label === '') throw new Error('label 不能为空。');
    const timeoutMs = readInteger(values.timeoutMs, 'timeoutMs');
    const maxConcurrency = readInteger(values.maxConcurrency, 'maxConcurrency');
    const common = {
      label,
      enabled: values.enabled,
      connectMode: values.connectMode,
      summary: nullIfEmpty(values.summary),
      category: nullIfEmpty(values.category),
      tags: splitList(values.tags),
      timeoutMs,
      maxConcurrency,
    };

    if (values.draft.mode === 'create') {
      const body: Record<string, unknown> = {
        id: values.id.trim(),
        transport: values.transport,
        ...common,
      };
      if (values.transport === 'stdio') {
        body['command'] = nullIfEmpty(values.command);
        body['args'] = parseArgs(values.args);
        body['cwd'] = nullIfEmpty(values.cwd);
        body['url'] = null;
      } else {
        body['command'] = null;
        body['args'] = [];
        body['cwd'] = null;
        body['url'] = nullIfEmpty(values.url);
      }
      if (values.builtin) throw new Error('builtin server 不能通过 API 注册。');
      body['envKeys'] = splitList(values.envKeys);
      body['headerKeys'] = splitList(values.headerKeys);
      const response = await context.api.post<{ server: ServerView; revision: number }>(
        '/servers',
        body,
        { signal: controller.signal },
      );
      if (destroyed) return;
      state.serversRevision = numberOr(response.revision, state.serversRevision);
      state.serverDraft = null;
      succeeded(`已注册 server ${response.server.id}。`);
      await refreshServers();
      return;
    }

    const patch: Record<string, unknown> = { ...common };
    if (values.builtin) {
      for (const key of ['timeoutMs', 'maxConcurrency', 'connectMode']) delete patch[key];
    } else {
      patch['envKeys'] = splitList(values.envKeys);
      patch['headerKeys'] = splitList(values.headerKeys);
      if (values.transport === 'stdio') {
        patch['command'] = nullIfEmpty(values.command);
        patch['args'] = parseArgs(values.args);
        patch['cwd'] = nullIfEmpty(values.cwd);
      } else {
        patch['url'] = nullIfEmpty(values.url);
      }
    }
    if (Object.keys(patch).length === 0) throw new Error('没有可保存的字段。');

    const response = await context.api.patch<{ server: ServerView; revision: number }>(
      `/servers/${encodeURIComponent(values.id)}`,
      patch,
      { signal: controller.signal, headers: { 'If-Match': String(state.serversRevision) } },
    );
    if (destroyed) return;
    state.serversRevision = numberOr(response.revision, state.serversRevision);
    state.serverDraft = null;
    succeeded(`已保存 server ${response.server.id}；下一次 eval 生效。`);
    await refreshServers();
  }

  async function runServerAction(
    serverId: string,
    action: 'connect' | 'disconnect' | 'restart' | 'tools/refresh',
    kind: string = action,
  ): Promise<void> {
    try {
      const operation = await context.api.post<Operation>(
        `/servers/${encodeURIComponent(serverId)}/${action}`,
        undefined,
        { signal: controller.signal },
      );
      if (destroyed) return;
      setStatus(`${serverId} 的 ${kind} 已排队（${operation.operationId}）。`, 'info');
      await followOperation(operation.operationId, serverId);
    } catch (error) {
      if (!destroyed) setStatus(saveErrorText(error), 'error');
    }
  }

  async function followOperation(operationId: string, serverId: string): Promise<void> {
    const started = Date.now();
    const poll = async (): Promise<void> => {
      if (destroyed) return;
      try {
        const operation = await context.api.get<Operation>(
          `/operations/${encodeURIComponent(operationId)}`,
          { signal: controller.signal },
        );
        if (destroyed) return;
        if (operation.state === 'ok') {
          succeeded(`${serverId} 操作完成，已刷新列表。`);
          await refreshServers();
          return;
        }
        if (operation.state === 'error') {
          setStatus(
            `${serverId} 操作失败：${operation.error?.message ?? operation.error?.code ?? '未知错误'}`,
            'error',
          );
          await refreshServers();
          return;
        }
      } catch (error) {
        // `/operations/:id` is optional in the admin base; fall back to a timed refresh.
        if (error instanceof ApiError && error.status === 404) {
          await refreshServers();
          return;
        }
      }
      if (Date.now() - started > 15_000) {
        setStatus(`${serverId} 操作仍在运行，稍后刷新查看状态。`, 'queue');
        await refreshServers();
        return;
      }
      later(() => {
        void poll();
      }, 800);
    };
    await poll();
  }

  async function testServer(serverId: string): Promise<void> {
    setStatus(`正在测试 ${serverId}（10 秒上限）…`, 'info');
    try {
      const result = await context.api.post<{
        ok: boolean;
        tools: unknown[];
        count: number;
        elapsedMs: number;
      }>(`/servers/${encodeURIComponent(serverId)}/test`, undefined, {
        signal: controller.signal,
      });
      if (destroyed) return;
      const names = result.tools
        .map((tool) =>
          typeof tool === 'object' && tool !== null && 'name' in tool
            ? String((tool as { name: unknown }).name)
            : '',
        )
        .filter((name) => name !== '')
        .slice(0, 8);
      const more = result.count > names.length ? ` 等 ${result.count} 个` : '';
      succeeded(
        `${serverId} 测试通过：${result.count} 个工具，耗时 ${formatDuration(result.elapsedMs)}。${names.length === 0 ? '' : ` ${names.join(', ')}${more}`}`,
      );
    } catch (error) {
      if (!destroyed) setStatus(`${serverId} 测试失败：${describeError(error)}`, 'error');
    }
  }

  async function deleteServer(server: ServerView): Promise<void> {
    if (!confirmAction(`删除 server ${server.id}？默认 drain；在飞调用未结束时会要求强制删除。`)) {
      return;
    }
    try {
      const response = await context.api.delete<{ deleted: boolean; revision: number }>(
        `/servers/${encodeURIComponent(server.id)}`,
        { signal: controller.signal, headers: { 'If-Match': String(state.serversRevision) } },
      );
      if (destroyed) return;
      state.serversRevision = numberOr(response.revision, state.serversRevision);
      succeeded(`已删除 server ${server.id}。`);
      await refreshServers();
    } catch (error) {
      if (destroyed) return;
      if (error instanceof ApiError && error.code === 'SERVER_BUSY') {
        if (!confirmAction(`${server.id} 仍有在飞调用。强制删除会中止它们，继续？`)) return;
        try {
          const response = await context.api.delete<{ revision: number }>(
            `/servers/${encodeURIComponent(server.id)}?force=true`,
            { signal: controller.signal, headers: { 'If-Match': String(state.serversRevision) } },
          );
          if (destroyed) return;
          state.serversRevision = numberOr(response.revision, state.serversRevision);
          succeeded(`已强制删除 server ${server.id}。`);
          await refreshServers();
        } catch (forcedError) {
          if (!destroyed) setStatus(saveErrorText(forcedError), 'error');
        }
        return;
      }
      setStatus(saveErrorText(error), 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  async function ensureTools(force = false): Promise<void> {
    const serverId = state.selectedServerId;
    if (serverId === null) return;
    if (state.toolsServerId === serverId && !force) return;
    const response = await context.api.get<ToolsResponse>(
      `/servers/${encodeURIComponent(serverId)}/tools`,
      { signal: controller.signal },
    );
    if (destroyed) return;
    state.tools = Array.isArray(response.tools) ? response.tools : [];
    state.toolsRevision = numberOr(response.revision, 0);
    state.toolsServerId = serverId;
    state.toolDraft = null;
  }

  function buildToolsTab(): HTMLElement {
    const fragment = el('div');
    setStyle(fragment, { display: 'flex', flexDirection: 'column', gap: '20px' });

    const serverSelect = selectControl(
      state.servers.map((server) => ({ value: server.id, label: `${server.id} · ${server.label}` })),
      {
        value: state.selectedServerId ?? '',
        disabled: state.servers.length === 0,
        ariaLabel: '选择 server',
        onChange: (value) => {
          state.selectedServerId = value;
          state.tools = [];
          state.toolsServerId = null;
          state.toolDraft = null;
          void ensureTools(true)
            .then(() => renderTab())
            .catch((error: unknown) => setStatus(describeError(error), 'error'));
        },
      },
    );
    setStyle(serverSelect, { width: '240px' });

    const refresh = button('刷新工具', () => {
      void ensureTools(true)
        .then(() => renderTab())
        .catch((error: unknown) => setStatus(describeError(error), 'error'));
    }, { variant: 'secondary', icon: 'refresh' });
    const pull = button('从上游重拉', () => {
      if (state.selectedServerId === null) return;
      void runServerAction(state.selectedServerId, 'tools/refresh', 'tools_refresh');
    }, { variant: 'secondary' });

    const listCard = cardSection({
      title: 'Tools',
      subtitle:
        state.selectedServerId === null
          ? '选择 server 后查看工具行'
          : `${state.selectedServerId} · 共 ${formatNumber(state.tools.length)} 个工具 · 覆盖字段下一次 eval 生效`,
      icon: 'tool',
      flush: true,
      actions: [serverSelect, refresh, pull],
    });

    if (state.selectedServerId === null) {
      listCard.body.appendChild(emptyBlock('还没有可管理的 server。', '先在 Servers 分区注册。'));
    } else if (state.tools.length === 0) {
      listCard.body.appendChild(
        emptyBlock(
          '该 server 还没有工具行。',
          '先连接并刷新工具列表；enabled 的 server 会在后台拉取。',
        ),
      );
    } else {
      listCard.body.appendChild(tablePanel(buildToolsTable()));
    }

    if (state.toolDraft !== null) fragment.append(buildToolEditor(state.toolDraft));
    fragment.append(listCard.element);
    return fragment;
  }

  function buildToolsTable(): HTMLTableElement {
    const table = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const label of ['tool', '启用', '并发', '生效 tags', '暴露', '描述', '操作']) {
      add(head, el('th', '', label));
    }
    thead.appendChild(head);
    const tbody = el('tbody');
    for (const tool of state.tools) {
      const effective = tool.effective;
      const row = el('tr');
      add(
        row,
        toolIdentity(tool),
        td(badge(tool.enabled ? '启用' : '停用', tool.enabled ? 'ok' : 'neutral')),
        td(badge(tool.concurrency, concurrencyTone(tool.concurrency))),
        tagCell(effective?.tags ?? tool.tags),
        td(
          effective === undefined
            ? badge(tool.stale ? 'stale' : '—', tool.stale ? 'queue' : 'neutral')
            : badge(effective.exposed ? '可见' : '隐藏', effective.exposed ? 'ok' : 'neutral'),
        ),
        descriptionCell(effective?.description ?? tool.description ?? ''),
        td(
          rowActions(
            button('详情', () => openToolDetail(tool), { variant: 'ghost', size: 'sm' }),
            button('编辑', () => {
              state.toolDraft = tool;
              renderTab();
            }, { variant: 'ghost', size: 'sm' }),
          ),
        ),
      );
      tbody.appendChild(row);
    }
    add(table, thead, tbody);
    return table;
  }

  function buildToolEditor(tool: ToolRecord): HTMLElement {
    const handle = cardSection({
      title: `编辑 ${tool.serverId}/${tool.name}`,
      subtitle: '覆盖字段只影响 catalog 视图；保存后下一次 eval 生效。',
      icon: 'tool',
    });

    const description = textarea({
      value: tool.descriptionOverride ?? '',
      rows: 4,
      placeholder: '留空则使用上游 description',
    });
    const enabledSwitch = switchControl({ checked: tool.enabled, label: '启用该工具' });
    const concurrency = selectControl(CONCURRENCY_OPTIONS, {
      value: tool.concurrency,
      ariaLabel: 'concurrency',
    });
    const tags = input({ value: tool.tags.join(', '), placeholder: 'db, read' });
    const type = input({ value: tool.type ?? '', placeholder: 'query' });
    const category = input({ value: tool.category ?? '', placeholder: '继承 server' });
    const staleSwitch = switchControl({
      checked: tool.staleOverride,
      label: '允许 stale 工具暴露',
    });

    const groups = formGrid();
    add(
      groups,
      groupCard('覆盖字段', 'description 留空表示继续使用上游值。', [field('description', description)]),
      groupCard('生效策略', '并发级别决定调用时持有的锁类型。', [
        enabledSwitch,
        field('concurrency', concurrency),
        staleSwitch,
      ]),
      groupCard('元数据', 'tags 支持逗号或换行分隔；category 留空继承 server。', [
        field('tags', tags),
        field('type', type),
        field('category', category),
      ]),
    );

    const form = el('form');
    form.noValidate = true;
    setStyle(form, { display: 'flex', flexDirection: 'column', gap: '16px' });
    add(form, groups);

    const errorLine = formError();
    const save = button('保存', () => undefined, { type: 'submit', variant: 'primary' });
    const cancel = button('取消', () => {
      state.toolDraft = null;
      renderTab();
    }, { variant: 'ghost' });
    const footer = el('div', 'toolbar');
    add(footer, save, cancel);
    add(form, errorLine, footer);
    handle.body.appendChild(form);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      setFormError(errorLine, null);
      save.disabled = true;
      save.textContent = '保存中…';
      const patch: Record<string, unknown> = {
        description: description.value.trim() === '' ? null : description.value,
        enabled: enabledSwitch.input.checked,
        concurrency: concurrency.value,
        tags: splitList(tags.value),
        type: nullIfEmpty(type.value),
        category: nullIfEmpty(category.value),
        staleOverride: staleSwitch.input.checked,
      };
      void context.api
        .patch<{ tool: ToolRecord; revision: number }>(
          `/tools/${encodeURIComponent(tool.serverId)}/${encodeURIComponent(tool.name)}`,
          patch,
          {
            signal: controller.signal,
            headers: { 'If-Match': String(state.toolsRevision) },
          },
        )
        .then(async (response) => {
          if (destroyed) return;
          state.toolsRevision = numberOr(response.revision, state.toolsRevision);
          state.toolDraft = null;
          succeeded(`已保存工具 ${tool.serverId}/${tool.name}；下一次 eval 生效。`);
          await ensureTools(true);
          renderTab();
        })
        .catch((error: unknown) => {
          setFormError(errorLine, saveErrorText(error));
          save.disabled = false;
          save.textContent = '保存';
        });
    });

    return handle.element;
  }

  function openToolDetail(tool: ToolRecord): void {
    const wrapper = el('div');
    setStyle(wrapper, { display: 'flex', flexDirection: 'column', gap: '16px' });
    const effective = tool.effective;

    const head = el('div', 'toolbar');
    add(
      head,
      badge(tool.enabled ? '启用' : '停用', tool.enabled ? 'ok' : 'neutral'),
      badge(tool.concurrency, concurrencyTone(tool.concurrency)),
      effective === undefined
        ? badge(tool.stale ? 'stale' : '未暴露', tool.stale ? 'queue' : 'neutral')
        : badge(effective.exposed ? '可见' : '隐藏', effective.exposed ? 'ok' : 'neutral'),
      tool.staleOverride ? badge('staleOverride', 'queue') : null,
    );
    add(wrapper, head);

    add(
      wrapper,
      definitionList([
        { label: 'server', value: tool.serverId, mono: true },
        { label: 'name', value: tool.name, mono: true },
        { label: 'displayName', value: tool.displayName ?? '—' },
        { label: 'type', value: tool.type ?? '—' },
        { label: 'category', value: tool.category ?? effective?.category ?? '—' },
        { label: 'tags', value: (effective?.tags ?? tool.tags).join(', ') || '—' },
        { label: 'description', value: tool.description ?? '—' },
        { label: 'descriptionOverride', value: tool.descriptionOverride ?? '—' },
        { label: '生效 description', value: effective?.description ?? '—' },
        { label: 'stale', value: tool.stale ? '是' : '否' },
      ]),
    );

    if (tool.schema !== undefined) {
      const block = el('div');
      setStyle(block, { display: 'flex', flexDirection: 'column', gap: '8px' });
      add(block, el('h3', '', 'inputSchema'), el('pre', '', formatJson(tool.schema, 2)));
      add(wrapper, block);
    }

    const actions = el('div', 'toolbar');
    add(
      actions,
      button('编辑', () => {
        drawer.close();
        state.toolDraft = tool;
        renderTab();
      }, { variant: 'primary', size: 'sm' }),
      button('关闭', () => drawer.close(), { variant: 'ghost', size: 'sm' }),
    );
    add(wrapper, actions);
    drawer.open(`${tool.serverId}/${tool.name}`, wrapper);
  }

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------

  async function loadClients(): Promise<void> {
    const response = await context.api.get<ClientsResponse>('/clients', {
      signal: controller.signal,
    });
    if (destroyed) return;
    state.clients = Array.isArray(response.clients) ? response.clients : [];
    state.sessions = Array.isArray(response.sessions) ? response.sessions : [];
    state.clientsLoaded = true;
  }

  function buildClientsTab(): HTMLElement {
    const fragment = el('div');
    setStyle(fragment, { display: 'flex', flexDirection: 'column', gap: '20px' });

    const refresh = button('刷新', () => {
      void loadClients()
        .then(() => renderTab())
        .catch((error: unknown) => setStatus(describeError(error), 'error'));
    }, { variant: 'secondary', icon: 'refresh' });
    const create = button('新建绑定', () => {
      state.tokenReveal = null;
      state.clientDraft = emptyClientDraft();
      renderTab();
    }, { variant: 'primary', icon: 'plus' });

    if (state.tokenReveal !== null) fragment.append(buildTokenReveal());
    if (state.clientDraft !== null) fragment.append(buildClientEditor(state.clientDraft));

    const listCard = cardSection({
      title: 'Clients',
      subtitle: `${formatNumber(state.clients.length)} 个绑定 · ${formatNumber(state.sessions.length)} 个活跃 MCP 会话`,
      icon: 'users',
      flush: true,
      actions: [refresh, create],
    });
    if (state.clients.length === 0) {
      listCard.body.appendChild(
        emptyBlock('还没有客户端绑定。', '创建后明文 token 只返回一次，请立即保存。'),
      );
    } else {
      listCard.body.appendChild(tablePanel(buildClientsTable()));
    }
    fragment.append(listCard.element);

    if (state.sessions.length > 0) fragment.append(buildSessionsTable());
    return fragment;
  }

  function buildTokenReveal(): HTMLElement {
    const reveal = state.tokenReveal;
    if (reveal === null) return el('div');
    const card = cardSection({
      title: `一次性 token · ${reveal.label}`,
      subtitle: '关闭后无法再次查看；现在复制并填进客户端的 Authorization header。',
      icon: 'key',
    });
    const line = el('div', 'toolbar');
    const token = el('code', 'mono', reveal.token);
    setStyle(token, { flex: '1', padding: '10px 12px', wordBreak: 'break-all' });
    add(line, token, copyButton('复制 token', () => reveal.token));
    const actions = el('div', 'toolbar');
    add(actions, button('我已保存', () => {
      state.tokenReveal = null;
      renderTab();
    }, { variant: 'primary' }));
    add(
      card.body,
      notice('明文 token 只显示这一次；离开 Clients 分区后不再保留。', 'queue'),
      line,
      actions,
    );
    return card.element;
  }

  function emptyClientDraft(): ClientDraft {
    return {
      mode: 'create',
      id: '',
      label: '',
      defaultWorkspace: '',
      allowedServers: '',
      allowedTags: '',
      quota: Object.fromEntries(QUOTA_KEYS.map((key) => [key, ''])),
    };
  }

  function buildClientEditor(draft: ClientDraft): HTMLElement {
    const handle = cardSection({
      title: draft.mode === 'create' ? '新建客户端绑定' : `编辑 ${draft.id}`,
      subtitle:
        draft.mode === 'create'
          ? '明文 token 只在创建成功后返回一次。'
          : '保存会按 binding 销毁其活跃执行会话；旧 token 仍按每请求复核保持有效。',
      icon: 'users',
    });

    const label = input({ value: draft.label, placeholder: 'work-laptop' });
    const workspace = input({ value: draft.defaultWorkspace, placeholder: '/absolute/workspace' });
    const servers = textarea({
      value: draft.allowedServers,
      rows: 3,
      placeholder: '每行一个 server id；留空表示全部',
    });
    const tags = textarea({
      value: draft.allowedTags,
      rows: 3,
      placeholder: '每行一个 tag；留空表示全部',
    });
    const quotaInputs = new Map<string, HTMLInputElement>();
    const quotaGrid = el('div', 'grid grid-2');
    for (const key of QUOTA_KEYS) {
      const control = input({
        type: 'number',
        value: draft.quota[key] ?? '',
        min: '1',
        placeholder: '留空取全局默认',
      });
      quotaInputs.set(key, control);
      quotaGrid.appendChild(field(key, control));
    }

    const quotaCard = groupCard('配额', '留空取全局默认；按 binding 立即生效。', [quotaGrid]);
    setStyle(quotaCard, { gridColumn: '1 / -1' });

    const groups = formGrid();
    add(
      groups,
      groupCard('基本信息', null, [field('label', label), field('defaultWorkspace', workspace)]),
      groupCard('可见范围', '列表留空表示不限制。', [
        field('allowedServers', servers),
        field('allowedTags', tags),
      ]),
      quotaCard,
    );

    const form = el('form');
    form.noValidate = true;
    setStyle(form, { display: 'flex', flexDirection: 'column', gap: '16px' });
    add(form, groups);

    const errorLine = formError();
    const save = button('保存', () => undefined, { type: 'submit', variant: 'primary' });
    const cancel = button('取消', () => {
      state.clientDraft = null;
      renderTab();
    }, { variant: 'ghost' });
    const footer = el('div', 'toolbar');
    add(footer, save, cancel);
    add(form, errorLine, footer);
    handle.body.appendChild(form);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      setFormError(errorLine, null);
      save.disabled = true;
      save.textContent = '保存中…';
      const quota: Record<string, number> = {};
      for (const [key, control] of quotaInputs) {
        const text = control.value.trim();
        if (text === '') continue;
        const parsed = Number(text);
        if (!Number.isInteger(parsed) || parsed < 1) {
          setFormError(errorLine, `${key} 必须是正整数。`);
          save.disabled = false;
          save.textContent = '保存';
          return;
        }
        quota[key] = parsed;
      }
      const body: Record<string, unknown> = {
        label: label.value.trim(),
        defaultWorkspace: nullIfEmpty(workspace.value),
        allowedServers: nullableList(servers.value),
        allowedTags: nullableList(tags.value),
        quota: Object.keys(quota).length === 0 ? null : quota,
      };
      if (body['label'] === '') {
        setFormError(errorLine, 'label 不能为空。');
        save.disabled = false;
        save.textContent = '保存';
        return;
      }
      const request =
        draft.mode === 'create'
          ? context.api.post<{ client: ClientBinding; token: string }>('/clients', body, {
              signal: controller.signal,
            })
          : context.api.put<{ client: ClientBinding; affectedSessions?: number }>(
              `/clients/${encodeURIComponent(draft.id)}`,
              body,
              { signal: controller.signal },
            );
      void request
        .then(async (response) => {
          if (destroyed) return;
          state.clientDraft = null;
          if ('token' in response && typeof response.token === 'string') {
            state.tokenReveal = { label: response.client.label, token: response.token };
            succeeded('已创建绑定；明文 token 仅显示这一次。');
          } else {
            const affected = 'affectedSessions' in response ? response.affectedSessions ?? 0 : 0;
            succeeded(`已保存绑定；销毁活跃执行会话 ${formatNumber(affected)} 个。`);
          }
          await loadClients();
          renderTab();
        })
        .catch((error: unknown) => {
          setFormError(errorLine, describeError(error));
          save.disabled = false;
          save.textContent = '保存';
        });
    });

    return handle.element;
  }

  function buildClientsTable(): HTMLTableElement {
    const table = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const label of ['client', 'workspace', '可见范围', '配额', '会话', '最近', '操作']) {
      add(head, el('th', label === '会话' ? 'num' : '', label));
    }
    thead.appendChild(head);
    const tbody = el('tbody');
    for (const client of state.clients) {
      const row = el('tr');
      const scope = [
        client.allowedServers === null ? 'servers: 全部' : `servers: ${client.allowedServers.join(', ')}`,
        client.allowedTags === null ? 'tags: 全部' : `tags: ${client.allowedTags.join(', ')}`,
      ].join(' · ');
      const quotaText =
        client.quota === null || client.quota === undefined
          ? '默认'
          : QUOTA_KEYS.filter((key) => client.quota?.[key] !== undefined)
              .map((key) => `${key.replace(/^max/, '')}=${client.quota?.[key]}`)
              .join(', ') || '默认';
      add(
        row,
        clientIdentity(client),
        el('td', 'mono', client.defaultWorkspace ?? '—'),
        clippedCell(scope, 320),
        clippedCell(quotaText, 260),
        el('td', 'num', formatNumber(client.activeSessions ?? 0)),
        updatedCell(client.lastSeenAt ?? undefined),
        td(
          rowActions(
            button('详情', () => openClientDetail(client), { variant: 'ghost', size: 'sm' }),
            button('编辑', () => {
              state.clientDraft = {
                mode: 'edit',
                id: client.id,
                label: client.label,
                defaultWorkspace: client.defaultWorkspace ?? '',
                allowedServers: (client.allowedServers ?? []).join('\n'),
                allowedTags: (client.allowedTags ?? []).join('\n'),
                quota: Object.fromEntries(
                  QUOTA_KEYS.map((key) => [
                    key,
                    client.quota?.[key] === undefined ? '' : String(client.quota[key]),
                  ]),
                ),
              };
              state.tokenReveal = null;
              renderTab();
            }, { variant: 'ghost', size: 'sm' }),
            button('删除', () => void deleteClient(client), { variant: 'danger', size: 'sm' }),
          ),
        ),
      );
      tbody.appendChild(row);
    }
    add(table, thead, tbody);
    return table;
  }

  function openClientDetail(client: ClientBinding): void {
    const wrapper = el('div');
    setStyle(wrapper, { display: 'flex', flexDirection: 'column', gap: '16px' });
    const head = el('div', 'toolbar');
    add(
      head,
      badge(client.allowedServers === null && client.allowedTags === null ? '全部可见' : '受限', 'info'),
      badge(`${formatNumber(client.activeSessions ?? 0)} 个执行会话`, 'neutral'),
    );
    add(wrapper, head);

    add(
      wrapper,
      definitionList([
        { label: 'id', value: client.id, mono: true },
        { label: 'label', value: client.label },
        { label: 'defaultWorkspace', value: client.defaultWorkspace ?? '—', mono: true },
        {
          label: 'allowedServers',
          value: client.allowedServers === null ? '全部' : client.allowedServers.join(', ') || '—',
        },
        {
          label: 'allowedTags',
          value: client.allowedTags === null ? '全部' : client.allowedTags.join(', ') || '—',
        },
        {
          label: 'quota',
          value:
            client.quota === null
              ? '默认'
              : QUOTA_KEYS.filter((key) => client.quota?.[key] !== undefined)
                  .map((key) => `${key}=${client.quota?.[key]}`)
                  .join(', ') || '默认',
        },
        { label: '创建', value: timeValue(client.createdAt) },
        { label: '最近', value: timeValue(client.lastSeenAt ?? undefined) },
      ]),
    );

    const actions = el('div', 'toolbar');
    add(
      actions,
      button('编辑', () => {
        drawer.close();
        state.clientDraft = {
          mode: 'edit',
          id: client.id,
          label: client.label,
          defaultWorkspace: client.defaultWorkspace ?? '',
          allowedServers: (client.allowedServers ?? []).join('\n'),
          allowedTags: (client.allowedTags ?? []).join('\n'),
          quota: Object.fromEntries(
            QUOTA_KEYS.map((key) => [
              key,
              client.quota?.[key] === undefined ? '' : String(client.quota[key]),
            ]),
          ),
        };
        state.tokenReveal = null;
        renderTab();
      }, { variant: 'primary', size: 'sm' }),
      button('关闭', () => drawer.close(), { variant: 'ghost', size: 'sm' }),
    );
    add(wrapper, actions);
    drawer.open(client.label, wrapper);
  }

  function buildSessionsTable(): HTMLElement {
    const card = cardSection({
      title: '活跃 MCP 会话',
      subtitle: `${formatNumber(state.sessions.length)} 个传输会话`,
      icon: 'activity',
      flush: true,
    });
    const table = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const label of ['Mcp-Session-Id', 'client', 'binding', '执行会话', '最近请求']) {
      add(head, el('th', '', label));
    }
    thead.appendChild(head);
    const tbody = el('tbody');
    for (const session of state.sessions) {
      const row = el('tr');
      add(
        row,
        el('td', 'mono', formatId(session.mcpSessionId, 22)),
        el('td', '', session.client || '—'),
        el('td', 'mono', session.bindingId ?? 'unbound'),
        el('td', 'muted', (session.execSessionIds ?? []).join(', ') || '—'),
        el('td', 'muted', formatRelativeTime(session.lastRequestAt ?? session.connectedAt ?? null)),
      );
      tbody.appendChild(row);
    }
    add(table, thead, tbody);
    card.body.appendChild(tablePanel(table));
    return card.element;
  }

  async function deleteClient(client: ClientBinding): Promise<void> {
    if (!confirmAction(`删除绑定 ${client.label}（${client.id}）？token 立即失效，并销毁其执行会话。`)) {
      return;
    }
    try {
      const response = await context.api.delete<{ affectedSessions?: number; warning?: string }>(
        `/clients/${encodeURIComponent(client.id)}`,
        { signal: controller.signal },
      );
      if (destroyed) return;
      const message = `已删除绑定 ${client.id}；销毁执行会话 ${formatNumber(response.affectedSessions ?? 0)} 个${response.warning === undefined ? '' : `；${response.warning}`}`;
      if (response.warning === undefined) succeeded(message);
      else setStatus(message, 'queue');
      await loadClients();
      renderTab();
    } catch (error) {
      if (!destroyed) setStatus(describeError(error), 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  async function loadSecrets(): Promise<void> {
    const response = await context.api.get<SecretsResponse | SecretStatus[]>('/secrets', {
      signal: controller.signal,
    });
    if (destroyed) return;
    state.secrets = Array.isArray(response) ? response : Array.isArray(response.secrets) ? response.secrets : [];
    state.secretsLoaded = true;
  }

  function buildSecretsTab(): HTMLElement {
    const fragment = el('div');
    setStyle(fragment, { display: 'flex', flexDirection: 'column', gap: '20px' });

    const nameInput = input({ placeholder: 'DATABASE_URL', value: '' });
    nameInput.setAttribute('list', 'secret-names');
    const list = el('datalist');
    list.id = 'secret-names';
    for (const secret of state.secrets) {
      const option = el('option');
      option.value = secret.name;
      list.appendChild(option);
    }
    const valueInput = input({ type: 'password', placeholder: '值只在写入时发送，永不回读' });
    const errorLine = formError();

    const formCard = cardSection({
      title: '写入密钥',
      subtitle: '密钥值只写不读；GET /secrets 只返回键名与是否已设置。',
      icon: 'key',
    });
    const form = el('form');
    form.noValidate = true;
    setStyle(form, { display: 'flex', flexDirection: 'column', gap: '14px' });
    const row = el('div', 'grid grid-2');
    add(row, field('键名', nameInput), field('值', valueInput));
    const save = button('写入密钥', () => undefined, { type: 'submit', variant: 'primary' });
    const footer = el('div', 'toolbar');
    add(footer, save);
    add(form, row, errorLine, footer, list);
    formCard.body.appendChild(form);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      setFormError(errorLine, null);
      const name = nameInput.value.trim();
      const value = valueInput.value;
      if (name === '') {
        setFormError(errorLine, '键名不能为空。');
        return;
      }
      if (value === '') {
        setFormError(errorLine, '值不能为空。');
        return;
      }
      save.disabled = true;
      save.textContent = '写入中…';
      void context.api
        .put<SecretStatus>(`/secrets/${encodeURIComponent(name)}`, { value }, {
          signal: controller.signal,
        })
        .then(async () => {
          if (destroyed) return;
          valueInput.value = '';
          succeeded(`已写入密钥 ${name}（值不回读）。`);
          await loadSecrets();
          renderTab();
        })
        .catch((error: unknown) => {
          setFormError(errorLine, describeError(error));
          save.disabled = false;
          save.textContent = '写入密钥';
        });
    });

    const configured = state.secrets.filter((secret) => secret.configured).length;
    const listCard = cardSection({
      title: '已声明的密钥',
      subtitle: `${formatNumber(state.secrets.length)} 个键名 · ${formatNumber(configured)} 个已设置`,
      icon: 'shield',
      flush: true,
    });

    if (state.secrets.length === 0) {
      listCard.body.appendChild(
        emptyBlock('还没有被引用的密钥。', '先注册 server 并在 env/header 中声明键名。'),
      );
    } else {
      const table = el('table');
      const thead = el('thead');
      const head = el('tr');
      add(head, el('th', '', '键名'), el('th', '', '状态'), el('th', '', '操作'));
      thead.appendChild(head);
      const tbody = el('tbody');
      for (const secret of state.secrets) {
        const row = el('tr');
        add(
          row,
          el('td', 'mono', secret.name),
          td(badge(secret.configured ? '已设置' : '缺失', secret.configured ? 'ok' : 'error')),
          td(
            rowActions(
              button('写入/轮换', () => {
                nameInput.value = secret.name;
                valueInput.focus();
              }, { variant: 'ghost', size: 'sm' }),
            ),
          ),
        );
        tbody.appendChild(row);
      }
      add(table, thead, tbody);
      listCard.body.appendChild(tablePanel(table));
    }

    fragment.append(formCard.element, listCard.element);
    return fragment;
  }

  // -------------------------------------------------------------------------
  // Config export / import
  // -------------------------------------------------------------------------

  async function loadConfig(force = false): Promise<void> {
    if (state.configLoaded && !force) return;
    const document = await context.api.get<ConfigDocument>('/config/export', {
      signal: controller.signal,
    });
    if (destroyed) return;
    state.configText = formatJson(document, 2);
    state.configLoaded = true;
  }

  function buildConfigTab(): HTMLElement {
    const fragment = el('div');
    setStyle(fragment, { display: 'flex', flexDirection: 'column', gap: '20px' });

    const exported = textarea({ value: state.configText, rows: 14 });
    exported.readOnly = true;
    const exportCard = cardSection({
      title: '导出声明式配置',
      subtitle: '导出不包含 $secret 引用或明文值。',
      icon: 'download',
      actions: [
        button('重新导出', () => {
          state.configLoaded = false;
          void loadConfig(true)
            .then(() => renderTab())
            .catch((error: unknown) => setStatus(describeError(error), 'error'));
        }, { variant: 'secondary', icon: 'refresh' }),
        copyButton('复制 JSON', () => exported.value),
        button('下载 JSON', () => downloadJson('repl-server-config.json', state.configText), {
          variant: 'secondary',
          icon: 'download',
        }),
      ],
    });
    exportCard.body.appendChild(exported);

    const importArea = textarea({
      value: state.importText,
      rows: 14,
      placeholder: '粘贴导出的 JSON；先 dry-run 查看 added / changed / removed。',
    });
    importArea.addEventListener('input', () => {
      state.importText = importArea.value;
    });
    const importCard = cardSection({
      title: '导入配置',
      subtitle: '实际导入返回 202 operationId；导入会 upsert 并删除 diff.removed。',
      icon: 'upload',
      actions: [
        button('Dry-run', () => void runImport(true), { variant: 'secondary' }),
        button('导入', () => void runImport(false), { variant: 'primary', icon: 'upload' }),
      ],
    });
    importCard.body.appendChild(importArea);
    if (state.importReport !== null) {
      importCard.body.appendChild(notice(state.importReport.text, state.importReport.tone));
    }

    fragment.append(exportCard.element, importCard.element);
    return fragment;
  }

  async function runImport(dryRun: boolean): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(state.importText);
    } catch (error) {
      state.importReport = { tone: 'error', text: `JSON 解析失败：${describeError(error)}` };
      renderTab();
      return;
    }
    if (!dryRun && !confirmAction('导入会修改并删除 server 配置；已有连接可能被重建。继续？')) {
      return;
    }
    setStatus(dryRun ? '正在 dry-run…' : '正在导入…', 'info');
    try {
      if (dryRun) {
        const result = await context.api.post<{
          valid?: boolean;
          diff?: { added?: string[]; changed?: string[]; removed?: string[] };
          errors?: string[];
          missingSecrets?: string[];
        }>('/config/import', parsed, {
          query: { 'dry-run': 'true' },
          signal: controller.signal,
        });
        if (destroyed) return;
        const added = result.diff?.added ?? [];
        const changed = result.diff?.changed ?? [];
        const removed = result.diff?.removed ?? [];
        const lines = [
          result.valid === false ? '校验失败' : '校验通过',
          `新增 ${added.length}${added.length === 0 ? '' : `：${added.join(', ')}`}`,
          `修改 ${changed.length}${changed.length === 0 ? '' : `：${changed.join(', ')}`}`,
          `删除 ${removed.length}${removed.length === 0 ? '' : `：${removed.join(', ')}`}`,
        ];
        if (result.errors !== undefined && result.errors.length > 0) {
          lines.push(`错误：${result.errors.join('；')}`);
        }
        if (result.missingSecrets !== undefined && result.missingSecrets.length > 0) {
          lines.push(`缺失密钥（警告）：${result.missingSecrets.join(', ')}`);
        }
        state.importReport = {
          tone: result.valid === false ? 'error' : 'ok',
          text: lines.join('；'),
        };
        setStatus(null);
        renderTab();
        toast(
          result.valid === false ? 'dry-run 校验失败，请查看报告。' : 'dry-run 校验通过。',
          result.valid === false ? 'error' : 'ok',
        );
        return;
      }

      const result = await context.api.post<{ operationId?: string }>('/config/import', parsed, {
        signal: controller.signal,
      });
      if (destroyed) return;
      state.importReport = {
        tone: 'ok',
        text: `导入已排队：${result.operationId ?? '（无 operationId）'}；进度看 /events 或刷新 servers。`,
      };
      state.serversLoaded = false;
      state.clientsLoaded = false;
      state.secretsLoaded = false;
      state.configLoaded = false;
      succeeded('导入已提交；配置写入完成后下一次 eval 生效。');
      renderTab();
    } catch (error) {
      if (destroyed) return;
      state.importReport = { tone: 'error', text: describeError(error) };
      setStatus(null);
      renderTab();
      toast('导入失败，请查看报告。', 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Discover
  // -------------------------------------------------------------------------

  function buildDiscoverTab(): HTMLElement {
    const card = cardSection({
      title: '本地发现',
      subtitle: '只读探测：配置文件只读 server 名，凭据文件只看是否存在，不读值（5 秒上限）。',
      icon: 'search',
      flush: true,
      actions: [
        button('开始探测', () => void runDiscover(), { variant: 'primary', icon: 'search' }),
      ],
    });

    if (!state.discoverLoaded) {
      card.body.appendChild(
        emptyBlock('尚未探测。', '扫描常见 MCP 配置、npx/gh/psql 与凭据文件位置。'),
      );
      return card.element;
    }
    if (state.suggestions.length === 0) {
      card.body.appendChild(emptyBlock('没有探测到建议。', '可以手动注册 server。'));
      return card.element;
    }

    const table = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const label of ['建议', 'command', '置信度', '原因', '已存在', '操作']) {
      add(head, el('th', '', label));
    }
    thead.appendChild(head);
    const tbody = el('tbody');
    for (const suggestion of state.suggestions) {
      const row = el('tr');
      add(
        row,
        suggestionIdentity(suggestion),
        el('td', 'mono', [suggestion.command ?? '', ...suggestion.args].join(' ')),
        td(badge(suggestion.confidence, confidenceTone(suggestion.confidence))),
        clippedCell(suggestion.reason, 380),
        td(badge(suggestion.alreadyExists ? '是' : '否', suggestion.alreadyExists ? 'queue' : 'neutral')),
        td(
          rowActions(
            button('注册', () => {
              state.serverDraft = {
                mode: 'create',
                id: suggestion.id,
                label: suggestion.label,
                transport: 'stdio',
                command: suggestion.command ?? '',
                args: suggestion.args.join('\n'),
                cwd: '',
                url: '',
                envKeys: suggestion.requiredSecrets.join('\n'),
                headerKeys: '',
                enabled: true,
                connectMode: 'lazy',
                summary: suggestion.reason,
                category: '',
                tags: '',
                timeoutMs: '60000',
                maxConcurrency: '8',
                revision: 0,
              };
              setTab('servers');
            }, { variant: 'ghost', size: 'sm', disabled: suggestion.alreadyExists }),
          ),
        ),
      );
      tbody.appendChild(row);
    }
    add(table, thead, tbody);
    card.body.appendChild(tablePanel(table));
    return card.element;
  }

  async function runDiscover(): Promise<void> {
    setStatus('正在探测本地环境…', 'info');
    try {
      const response = await context.api.post<{ suggestions?: DiscoverSuggestion[] }>(
        '/discover',
        undefined,
        { signal: controller.signal },
      );
      if (destroyed) return;
      state.suggestions = Array.isArray(response.suggestions) ? response.suggestions : [];
      state.discoverLoaded = true;
      succeeded(`探测完成：${formatNumber(state.suggestions.length)} 条建议。`);
      renderTab();
    } catch (error) {
      if (!destroyed) setStatus(describeError(error), 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  renderTabs();
  void openTab();

  return {
    element: section,
    destroy(): void {
      destroyed = true;
      controller.abort();
      drawer.destroy();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      section.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared presentation helpers
// ---------------------------------------------------------------------------

/** Bordered list surface; flush cards do not need a second border inside their body. */
function tablePanel(table: HTMLTableElement): HTMLElement {
  const wrap = el('div', 'table-wrap');
  setStyle(wrap, {
    border: '0',
    borderRadius: '0',
    maxHeight: 'min(720px, calc(100vh - 280px))',
  });
  add(wrap, table);
  return wrap;
}

/** Empty state for a card body; `emptyState` owns the page-level card styling. */
function emptyBlock(title: string, hint?: string): HTMLElement {
  const box = el('div', 'empty-state');
  add(box, icon('inbox', 26));
  const body = el('div', 'empty-body');
  add(body, el('p', 'empty-title', title));
  if (hint !== undefined) add(body, el('p', 'empty-hint', hint));
  add(box, body);
  return box;
}

/** Two-column form layout on desktop; the 420px track collapses to one column on narrow screens. */
function formGrid(): HTMLElement {
  const grid = el('div', 'grid grid-2');
  setStyle(grid, { gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' });
  return grid;
}

/** Grouped form panel; forms use these inside a two-column grid. */
function groupCard(title: string, hint: string | null, children: Node[]): HTMLElement {
  const card = el('section', 'card');
  setStyle(card, {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '16px',
  });
  const head = el('div');
  setStyle(head, { display: 'flex', flexDirection: 'column', gap: '2px' });
  add(head, el('h3', '', title));
  if (hint !== null) add(head, el('p', 'field-hint', hint));
  add(card, head, ...children);
  return card;
}

function rowActions(...children: Node[]): HTMLElement {
  const actions = el('div', 'toolbar');
  setStyle(actions, { gap: '4px', flexWrap: 'nowrap' });
  add(actions, ...children);
  return actions;
}

function td(content: Node | string): HTMLTableCellElement {
  const cell = el('td');
  add(cell, content);
  return cell;
}

function serverIdentity(server: ServerView): HTMLTableCellElement {
  const cell = el('td');
  const label = el('span', '', server.label);
  const id = el('span', 'mono muted', server.id);
  setStyle(id, { display: 'block', fontSize: '11px' });
  add(cell, label, id);
  return cell;
}

function toolIdentity(tool: ToolRecord): HTMLTableCellElement {
  const cell = el('td');
  if (tool.displayName !== null && tool.displayName !== tool.name) {
    const display = el('span', '', tool.displayName);
    const name = el('span', 'mono muted', tool.name);
    setStyle(name, { display: 'block', fontSize: '11px' });
    add(cell, display, name);
  } else {
    add(cell, el('span', 'mono', tool.name));
  }
  return cell;
}

function clientIdentity(client: ClientBinding): HTMLTableCellElement {
  const cell = el('td');
  const label = el('span', '', client.label);
  const id = el('span', 'mono muted', client.id);
  setStyle(id, { display: 'block', fontSize: '11px' });
  add(cell, label, id);
  return cell;
}

function suggestionIdentity(suggestion: DiscoverSuggestion): HTMLTableCellElement {
  const cell = el('td');
  const label = el('span', '', suggestion.label);
  const id = el('span', 'mono muted', suggestion.id);
  setStyle(id, { display: 'block', fontSize: '11px' });
  add(cell, label, id);
  return cell;
}

function tagCell(tags: string[]): HTMLTableCellElement {
  const cell = el('td');
  if (tags.length === 0) {
    cell.className = 'muted';
    cell.textContent = '—';
    return cell;
  }
  const line = el('div', 'toolbar');
  setStyle(line, { gap: '4px' });
  for (const tag of tags.slice(0, 3)) add(line, badge(tag, 'neutral'));
  if (tags.length > 3) add(line, el('span', 'muted', `+${tags.length - 3}`));
  add(cell, line);
  return cell;
}

function updatedCell(value: string | undefined): HTMLTableCellElement {
  const cell = el('td', 'muted');
  cell.textContent = formatRelativeTime(value ?? null);
  if (value !== undefined) cell.title = value;
  return cell;
}

function clippedCell(text: string, maxWidth: number): HTMLTableCellElement {
  const cell = el('td', 'muted');
  if (text === '') {
    cell.textContent = '—';
    return cell;
  }
  const span = el('span', 'truncate', text);
  setStyle(span, { display: 'inline-block', maxWidth: `${maxWidth}px` });
  span.title = text;
  add(cell, span);
  return cell;
}

function descriptionCell(text: string): HTMLTableCellElement {
  return clippedCell(text, 360);
}

function timeValue(value: string | undefined): Node | string {
  if (value === undefined || value === '') return '—';
  const span = el('span', '', formatRelativeTime(value));
  span.title = value;
  return span;
}

function commandLine(server: ServerView): string {
  const line = [server.command ?? '', ...server.args].join(' ').trim();
  return line === '' ? '—' : line;
}

function concurrencyTone(concurrency: ToolConcurrency): 'info' | 'queue' | 'slow' {
  if (concurrency === 'serial') return 'queue';
  if (concurrency === 'exclusive') return 'slow';
  return 'info';
}

/** Adds an actionable hint when a write lost the `If-Match` race. */
function saveErrorText(error: unknown): string {
  const text = describeError(error);
  if (error instanceof ApiError && error.code === 'REVISION_CONFLICT') {
    return `${text}；配置已被其他操作修改，请取消后重新打开编辑器再保存。`;
  }
  return text;
}

function tabLabel(tab: Tab): string {
  return TABS.find((entry) => entry.id === tab)?.label ?? tab;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readInteger(value: string, label: string): number {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed)) throw new Error(`${label} 必须是整数。`);
  return parsed;
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** `<secret:NAME>` is the view-only rendering from `servers.ts`; send it back as a ref. */
function parseArgs(value: string): Array<string | { $secret: string }> {
  return splitLines(value).map((line) => {
    const match = /^<secret:(.+)>$/.exec(line);
    return match !== null && match[1] !== undefined && match[1] !== ''
      ? { $secret: match[1] }
      : line;
  });
}

function splitList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function nullIfEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function nullableList(value: string): string[] | null {
  const entries = splitList(value);
  return entries.length === 0 ? null : entries;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function confidenceTone(confidence: DiscoverSuggestion['confidence']): 'ok' | 'queue' | 'neutral' {
  if (confidence === 'high') return 'ok';
  if (confidence === 'medium') return 'queue';
  return 'neutral';
}

function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = el('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
