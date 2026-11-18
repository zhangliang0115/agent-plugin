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
  formatBytes,
  formatDuration,
  formatId,
  formatJson,
  formatNumber,
  formatRelativeTime,
  formatTimestamp,
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
  startPolling,
  statusBadge,
  switchControl,
  tabs,
  textarea,
  textInput,
  toast,
  type NoticeTone,
  type PageContext,
  type PageHandle,
  type Polling,
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
  summarySource?: string | null;
  category: string | null;
  tags: string[];
  timeoutMs: number;
  maxConcurrency: number;
  toolDiscovery?: ToolDiscoveryConfig | null;
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
  discoveredVia?: 'static' | 'search';
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

type Severity = 'low' | 'medium' | 'high' | 'critical';
type ReportStatus = 'open' | 'ack' | 'closed';
type ReportSource = 'mcp' | 'admin';
type AlertState = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped' | 'no_webhook';

interface ReportView {
  id: string;
  createdAt: string;
  updatedAt: string;
  source: ReportSource;
  binding: string | null;
  client: string | null;
  mcp: string | null;
  exec: string | null;
  evalId: string | null;
  severity: Severity;
  title: string;
  status: ReportStatus;
  alertState: AlertState;
  alertError: string | null;
  alertAttempts: number;
  alertUpdatedAt: string | null;
  alertedAt: string | null;
  detail?: string;
  context?: unknown;
}

interface ReportsResponse {
  items: ReportView[];
  nextCursor: string | null;
}

interface AlertConfigView {
  enabled: boolean;
  minSeverity: Severity;
  events: string[];
  webhook: { configured: boolean; secretName: string };
  revision: number;
}

interface AlertTestResponse {
  ok: boolean;
  attempts: number;
  elapsedMs: number;
  error?: { code: string; message: string };
  details?: Record<string, unknown>;
}

interface AlertPreviewResponse {
  content: string;
  bytes: number;
}

interface ToolDiscoveryConfig {
  mode: 'static' | 'search';
  searchTool?: string;
  query?: string;
  args?: Record<string, unknown>;
  maxTools?: number;
  prepareOnCall?: boolean;
}

interface DiscoveryToolView {
  name: string;
  description: string | null;
  inputSchema: unknown;
  schemaMissing: boolean;
  descriptionTruncated: boolean;
  conflict: 'none' | 'static' | 'search';
  action: 'create' | 'update' | 'skip_static';
}

interface DiscoveryPreview {
  discoveryId: string;
  serverId: string;
  searchTool: string;
  query: string;
  effectiveConfig: ToolDiscoveryConfig;
  parsed: boolean;
  shape: string;
  tools: DiscoveryToolView[];
  skipped: Array<{ name?: string; reason: string }>;
  omitted: number;
  partial: boolean;
  willStale: string[];
  willStaleCount: number;
  nextCursor: string | null;
  raw: string | null;
  rawTruncated: boolean;
  elapsedMs: number;
  previewExpiresAt: string;
}

interface DiscoveryApplyResult {
  serverId: string;
  applied: number;
  created: number;
  updated: number;
  skippedStatic: number;
  skippedOther: number;
  stale: number;
  revision: number;
}

interface DiscoveryDraft {
  serverId: string;
  searchTool: string;
  query: string;
  args: string;
  maxTools: string;
  prepareOnCall: boolean;
  staleOthers: boolean;
  cursor: string | null;
}

interface AiSettings {
  enabled: boolean;
  autoAnnotate: boolean;
  claudeBin: string | null;
  model: string | null;
  timeoutMs: number;
}

type ClaudeBinSource = 'settings' | 'env' | 'default';

interface AiConfigView {
  ai: AiSettings & { effectiveClaudeBin: string; claudeBinSource: ClaudeBinSource };
  prompts: { propose: number; annotate: number };
  revision: number;
}

interface ProposalServerDraft {
  id: string;
  label: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: Array<string | { $secret: string }>;
  cwd: string | null;
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  connectMode: ConnectMode;
  tags: string[];
  category: string | null;
  summary: string | null;
}

interface AiProposal {
  proposalId: string | null;
  server: ProposalServerDraft | null;
  explanation: string;
  warnings: string[];
  idConflict: boolean;
  inputWarning?: boolean;
  meta: {
    model: string | null;
    durationMs: number;
    promptVersion: number;
    costUsd: number | null;
    expiresAt: string | null;
  };
}

interface ToolOverrideDraft {
  name: string;
  description: string | null;
  tags: string[];
}

interface AnnotationCurrentView {
  summary: string | null;
  summarySource: string | null;
  category: string | null;
  tags: string[];
}

interface AnnotationProposedView {
  summary: string | null;
  category: string | null;
  tags: string[];
  toolOverrides: ToolOverrideDraft[];
}

interface AnnotationPreviewView {
  serverId: string;
  current: AnnotationCurrentView;
  proposed: AnnotationProposedView;
  warnings: string[];
  omittedTools: number;
  meta: {
    model: string | null;
    durationMs: number;
    promptVersion: number;
    costUsd: number | null;
  };
}

interface PendingAnnotationView {
  serverId: string;
  proposed: AnnotationProposedView;
  warnings: string[];
  omittedTools: number;
  createdAt: string;
}

interface AnnotationToolDraft {
  name: string;
  currentDescription: string | null;
  currentDescriptionSource: string | null;
  proposedDescription: string | null;
  currentTags: string[];
  proposedTags: string[];
}

interface AnnotationDraft {
  serverId: string;
  current: AnnotationCurrentView;
  proposed: AnnotationProposedView;
  warnings: string[];
  omittedTools: number;
  tools: AnnotationToolDraft[];
}

type Tab = 'servers' | 'tools' | 'clients' | 'secrets' | 'alerts' | 'ai' | 'config' | 'discover';

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
  { id: 'alerts', label: '告警', icon: 'alert' },
  { id: 'ai', label: 'AI', icon: 'activity' },
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

const SEVERITY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'critical', label: 'critical' },
];

const REPORT_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'open', label: 'open' },
  { value: 'ack', label: 'ack' },
  { value: 'closed', label: 'closed' },
];

const REPORT_SEVERITY_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部严重级' },
  ...SEVERITY_OPTIONS,
];

const AI_INPUT_MAX_BYTES = 16_384;

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
    alertsConfig: null as AlertConfigView | null,
    alertsConfigLoaded: false,
    reports: [] as ReportView[],
    reportsCursor: null as string | null,
    reportsLoaded: false,
    reportStatus: '' as '' | ReportStatus,
    reportSeverity: '' as '' | Severity,
    discoveryDraft: null as DiscoveryDraft | null,
    discoveryPreview: null as DiscoveryPreview | null,
    discoverySelected: new Set<string>(),
    aiConfig: null as AiConfigView | null,
    aiConfigLoaded: false,
    aiInput: '',
    aiProposal: null as AiProposal | null,
    aiPending: [] as PendingAnnotationView[],
    aiPendingLoaded: false,
    aiConfigBusy: false,
    aiProposeBusy: false,
    aiProposalApplyBusy: false,
    aiAnnotationBusy: false,
  };

  const drawer = createDrawer();
  let reportHost: HTMLElement | null = null;
  let reportsPolling: Polling | null = null;

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

  function stopReportsPolling(): void {
    reportsPolling?.stop();
    reportsPolling = null;
  }

  function setTab(tab: Tab): void {
    if (state.tab === tab) return;
    if (state.tab === 'clients' && tab !== 'clients') state.tokenReveal = null;
    if (state.tab === 'alerts' && tab !== 'alerts') {
      stopReportsPolling();
      reportHost = null;
    }
    if (state.tab === 'tools' && tab !== 'tools') {
      state.discoveryDraft = null;
      state.discoveryPreview = null;
      state.discoverySelected = new Set<string>();
    }
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
        case 'alerts':
          await Promise.all([ensureAlertsConfig(), loadReports(true)]);
          break;
        case 'ai':
          await Promise.all([ensureServers(), ensureAiConfig(), loadAiPending()]);
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
      case 'alerts':
        content.replaceChildren(buildAlertsTab());
        break;
      case 'ai':
        content.replaceChildren(buildAiTab());
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
        state.discoveryDraft = null;
        state.discoveryPreview = null;
        setTab('tools');
      }, { variant: 'ghost', size: 'sm' }),
    ];
    if (server.transport !== 'builtin' && !isSeedServerId(server.id)) {
      actions.push(
        button('AI 标注', () => void startServerAnnotation(server), {
          variant: 'ghost',
          size: 'sm',
        }),
      );
    }
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
          state.discoveryDraft = null;
          state.discoveryPreview = null;
          state.discoverySelected = new Set<string>();
          void ensureTools(true)
            .then(() => renderTab())
            .catch((error: unknown) => setStatus(describeError(error), 'error'));
        },
      },
    );
    setStyle(serverSelect, { width: '240px' });

    const selectedServer = state.servers.find((server) => server.id === state.selectedServerId);
    const refresh = button('刷新工具', () => {
      void ensureTools(true)
        .then(() => renderTab())
        .catch((error: unknown) => setStatus(describeError(error), 'error'));
    }, { variant: 'secondary', icon: 'refresh' });
    const pull = button('从上游重拉', () => {
      if (state.selectedServerId === null) return;
      void runServerAction(state.selectedServerId, 'tools/refresh', 'tools_refresh');
    }, { variant: 'secondary' });
    const scan = button('扫描懒加载工具', () => {
      openDiscoveryForm();
    }, {
      variant: 'secondary',
      icon: 'search',
      disabled: selectedServer === undefined || selectedServer.transport === 'builtin',
    });
    const saveDiscovery = button('保存配置', () => {
      void saveDiscoveryConfig();
    }, {
      variant: 'secondary',
      disabled: selectedServer === undefined || selectedServer.transport === 'builtin',
    });

    const listCard = cardSection({
      title: 'Tools',
      subtitle:
        state.selectedServerId === null
          ? '选择 server 后查看工具行'
          : `${state.selectedServerId} · 共 ${formatNumber(state.tools.length)} 个工具 · 覆盖字段下一次 eval 生效`,
      icon: 'tool',
      flush: true,
      actions: [serverSelect, refresh, pull, scan, saveDiscovery],
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

    if (state.discoveryDraft !== null) fragment.append(buildDiscoveryCard(state.discoveryDraft));
    if (state.toolDraft !== null) fragment.append(buildToolEditor(state.toolDraft));
    fragment.append(listCard.element);
    return fragment;
  }

  function buildToolsTable(): HTMLTableElement {
    const table = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const label of ['tool', '来源', '启用', '并发', '生效 tags', '暴露', '描述', '操作']) {
      add(head, el('th', '', label));
    }
    thead.appendChild(head);
    const tbody = el('tbody');
    for (const tool of state.tools) {
      const effective = tool.effective;
      const row = el('tr');
      const actions: Node[] = [
        button('详情', () => openToolDetail(tool), { variant: 'ghost', size: 'sm' }),
        button('编辑', () => {
          state.toolDraft = tool;
          renderTab();
        }, { variant: 'ghost', size: 'sm' }),
      ];
      if (tool.discoveredVia === 'search') {
        actions.push(
          button('再扫描', () => {
            openDiscoveryForm(tool.serverId);
          }, { variant: 'ghost', size: 'sm' }),
        );
      }
      add(
        row,
        toolIdentity(tool),
        td(sourceBadge(tool.discoveredVia)),
        td(badge(tool.enabled ? '启用' : '停用', tool.enabled ? 'ok' : 'neutral')),
        td(badge(tool.concurrency, concurrencyTone(tool.concurrency))),
        tagCell(effective?.tags ?? tool.tags),
        td(
          effective === undefined
            ? badge(tool.stale ? 'stale' : '—', tool.stale ? 'queue' : 'neutral')
            : badge(effective.exposed ? '可见' : '隐藏', effective.exposed ? 'ok' : 'neutral'),
        ),
        descriptionCell(effective?.description ?? tool.description ?? ''),
        td(rowActions(...actions)),
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
      label: '保留检索可见性（仍不可直接调用）',
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
  // Lazy tool discovery (design 07 §6)
  // -------------------------------------------------------------------------

  function serverById(serverId: string | null): ServerView | undefined {
    if (serverId === null) return undefined;
    return state.servers.find((server) => server.id === serverId);
  }

  function isSeedServerId(serverId: string): boolean {
    return serverId === '__official__' || serverId === '__builtin__';
  }

  function sourceBadge(source: 'static' | 'search' | undefined): HTMLSpanElement {
    return source === 'search' ? badge('search', 'info') : badge('static', 'neutral');
  }

  function makeDiscoveryDraft(serverId: string): DiscoveryDraft {
    const server = serverById(serverId);
    const config = server?.toolDiscovery?.mode === 'search' ? server.toolDiscovery : null;
    const staticTools = state.tools.filter(
      (tool) => tool.serverId === serverId && tool.discoveredVia !== 'search',
    );
    return {
      serverId,
      searchTool: config?.searchTool ?? staticTools[0]?.name ?? '',
      query: config?.query ?? '',
      args: config?.args === undefined ? '' : formatJson(config.args, 2),
      maxTools: String(config?.maxTools ?? 50),
      prepareOnCall: config?.prepareOnCall ?? true,
      staleOthers: true,
      cursor: null,
    };
  }

  function openDiscoveryForm(serverId: string | null = state.selectedServerId): void {
    if (serverId === null) return;
    const server = serverById(serverId);
    if (server === undefined) {
      setStatus('server 不存在，刷新后重试。', 'error');
      return;
    }
    if (server.transport === 'builtin') {
      setStatus('builtin server 不支持懒加载工具扫描。', 'error');
      return;
    }
    if (serverId !== state.selectedServerId) {
      state.selectedServerId = serverId;
      state.tools = [];
      state.toolsServerId = null;
    }
    state.discoveryDraft = makeDiscoveryDraft(serverId);
    state.discoveryPreview = null;
    state.discoverySelected = new Set<string>();
    state.toolDraft = null;
    renderTab();
  }

  function readDiscoveryArgs(text: string): Record<string, unknown> | undefined {
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('固定参数必须是 JSON 对象。');
    }
    return parsed as Record<string, unknown>;
  }

  function discoveryConfigFromDraft(draft: DiscoveryDraft): ToolDiscoveryConfig {
    if (draft.searchTool.trim() === '') throw new Error('搜索工具不能为空。');
    const maxTools = readInteger(draft.maxTools, 'maxTools');
    if (maxTools < 1 || maxTools > 200) throw new Error('maxTools 必须在 1 到 200 之间。');
    const args = readDiscoveryArgs(draft.args);
    return {
      mode: 'search',
      searchTool: draft.searchTool.trim(),
      query: draft.query,
      ...(args === undefined ? {} : { args }),
      maxTools,
      prepareOnCall: draft.prepareOnCall,
    };
  }

  async function saveDiscoveryConfig(): Promise<void> {
    let draft = state.discoveryDraft;
    if (draft === null) {
      openDiscoveryForm();
      setStatus('已打开扫描表单；调整配置后再次点击“保存配置”。', 'info');
      return;
    }
    const server = serverById(draft.serverId);
    if (server === undefined) {
      setStatus('server 不存在，刷新后重试。', 'error');
      return;
    }
    try {
      const toolDiscovery = discoveryConfigFromDraft(draft);
      const response = await context.api.patch<{ server: ServerView; revision: number }>(
        `/servers/${encodeURIComponent(draft.serverId)}`,
        { toolDiscovery },
        {
          signal: controller.signal,
          headers: { 'If-Match': String(state.serversRevision) },
        },
      );
      if (destroyed) return;
      state.serversRevision = numberOr(response.revision, state.serversRevision);
      state.servers = state.servers.map((entry) =>
        entry.id === response.server.id ? response.server : entry,
      );
      succeeded(`已保存 ${draft.serverId} 的懒加载配置；下一次扫描或 eval 生效。`);
      renderTab();
    } catch (error) {
      setStatus(saveErrorText(error), 'error');
    }
  }

  async function previewDiscovery(): Promise<void> {
    const draft = state.discoveryDraft;
    if (draft === null) return;
    try {
      const maxTools = readInteger(draft.maxTools, 'maxTools');
      if (maxTools < 1 || maxTools > 200) throw new Error('maxTools 必须在 1 到 200 之间。');
      if (draft.searchTool.trim() === '') throw new Error('搜索工具不能为空。');
      const args = readDiscoveryArgs(draft.args);
      const body: Record<string, unknown> = {
        preview: true,
        searchTool: draft.searchTool.trim(),
        query: draft.query,
        maxTools,
        prepareOnCall: draft.prepareOnCall,
      };
      if (args !== undefined) body['args'] = args;
      if (draft.cursor !== null) body['cursor'] = draft.cursor;
      const preview = await context.api.post<DiscoveryPreview>(
        `/servers/${encodeURIComponent(draft.serverId)}/tools/discover`,
        body,
        { signal: controller.signal },
      );
      if (destroyed) return;
      state.discoveryPreview = preview;
      state.discoverySelected = new Set(
        preview.tools
          .filter((tool) => tool.action !== 'skip_static')
          .map((tool) => tool.name),
      );
      draft.staleOthers = !preview.partial;
      renderTab();
    } catch (error) {
      if (destroyed) return;
      handleDiscoveryError(error);
    }
  }

  function handleDiscoveryError(error: unknown): void {
    let message = describeError(error);
    let cleared = false;
    if (error instanceof ApiError) {
      const details = errorDetails(error);
      switch (error.code) {
        case 'DISCOVERY_PREVIEW_EXPIRED':
          message =
            details?.['reason'] === 'applied'
              ? '这次预览已经应用过；请重新扫描。'
              : '预览已过期；请重新扫描。';
          clearDiscoveryPreview();
          cleared = true;
          break;
        case 'DISCOVERY_PREVIEW_NOT_FOUND':
          message = '预览不存在（进程可能重启过）；请重新扫描。';
          clearDiscoveryPreview();
          cleared = true;
          break;
        case 'DISCOVERY_EMPTY_PREVIEW':
          message = '预览为空，不能应用；请调整搜索工具或查询词后重新预览。';
          clearDiscoveryPreview();
          cleared = true;
          break;
        case 'DISCOVERY_PARTIAL_STALE_UNCONFIRMED':
          message = '本次预览不完整，不能把未返回的工具标记为 stale；请重新预览并确认。';
          break;
        case 'DISCOVERY_BUSY':
          message = `另一个扫描正在进行，请稍后重试${retryAfterText(details)}。`;
          break;
        case 'REVISION_CONFLICT':
          message = saveErrorText(error);
          break;
        default:
          break;
      }
    }
    setStatus(message, 'error');
    if (cleared && !destroyed) renderTab();
  }

  function clearDiscoveryPreview(): void {
    state.discoveryPreview = null;
    state.discoverySelected = new Set<string>();
    if (state.discoveryDraft !== null) state.discoveryDraft.cursor = null;
  }

  async function applyDiscovery(): Promise<void> {
    const preview = state.discoveryPreview;
    const draft = state.discoveryDraft;
    if (preview === null || draft === null) return;
    const selected = preview.tools.filter((tool) => state.discoverySelected.has(tool.name));
    if (selected.length === 0) {
      setStatus('至少勾选一个要应用的工具。', 'error');
      return;
    }
    const overwriteStatic = selected.some((tool) => tool.action === 'skip_static');
    if (
      overwriteStatic &&
      !confirmAction('勾选的行与上游声明的同名 static 工具冲突，应用会覆盖它们并改成 search 来源。继续？')
    ) {
      return;
    }
    let confirmPartialStale = false;
    if (preview.partial && draft.staleOthers) {
      const proceed = confirmAction(
        '本次预览不完整（有未展示或未解析的结果）。继续把未返回的旧 search 工具标记为 stale 吗？',
      );
      if (!proceed) return;
      confirmPartialStale = true;
    }
    if (draft.staleOthers && preview.willStaleCount > 0) {
      const names = preview.willStale.slice(0, 10).join(', ');
      const suffix =
        preview.willStaleCount > 10 ? ` 等 ${preview.willStaleCount} 个` : '';
      const proceed = confirmAction(
        `本次会把 ${preview.willStaleCount} 个已有工具标记为 stale${names === '' ? '' : `：${names}${suffix}`}。\n它们会从检索与直接调用中消失，直到下次扫描返回。继续？`,
      );
      if (!proceed) return;
    }
    const accept = selected.map((tool) => tool.name);
    const body: Record<string, unknown> = {
      preview: false,
      discoveryId: preview.discoveryId,
      accept,
      staleOthers: draft.staleOthers,
    };
    if (overwriteStatic) body['overwriteStatic'] = true;
    if (confirmPartialStale) body['confirmPartialStale'] = true;
    try {
      const result = await context.api.post<DiscoveryApplyResult>(
        `/servers/${encodeURIComponent(draft.serverId)}/tools/discover`,
        body,
        {
          signal: controller.signal,
          headers: { 'If-Match': String(state.serversRevision) },
        },
      );
      if (destroyed) return;
      state.serversRevision = numberOr(result.revision, state.serversRevision);
      clearDiscoveryPreview();
      succeeded(
        `已应用 ${formatNumber(result.applied)} 个工具：新增 ${formatNumber(result.created)}、更新 ${formatNumber(result.updated)}、标记 stale ${formatNumber(result.stale)}；revision ${formatNumber(result.revision)}。`,
      );
      state.serversLoaded = false;
      try {
        await ensureServers(true);
        if (!destroyed) await ensureTools(true);
      } catch (refreshError) {
        if (!destroyed) {
          setStatus(`工具已应用，但刷新列表失败：${describeError(refreshError)}`, 'queue');
        }
      }
      if (!destroyed) renderTab();
    } catch (error) {
      if (!destroyed) handleDiscoveryError(error);
    }
  }

  function buildDiscoveryCard(draft: DiscoveryDraft): HTMLElement {
    const handle = cardSection({
      title: `扫描懒加载工具 · ${draft.serverId}`,
      subtitle: '预览会调用上游搜索工具；应用只写本地 catalog，不再次访问上游。',
      icon: 'search',
    });
    const staticTools = state.tools.filter(
      (tool) => tool.serverId === draft.serverId && tool.discoveredVia !== 'search',
    );
    const staticOptions = staticTools.map((tool) => ({ value: tool.name, label: tool.name }));
    if (
      draft.searchTool !== '' &&
      !staticOptions.some((entry) => entry.value === draft.searchTool)
    ) {
      staticOptions.unshift({ value: draft.searchTool, label: `${draft.searchTool}（已保存）` });
    }
    const searchToolSelect = selectControl(staticOptions, {
      value: draft.searchTool,
      ariaLabel: '搜索工具',
      disabled: staticOptions.length === 0,
    });
    searchToolSelect.addEventListener('change', () => {
      draft.searchTool = searchToolSelect.value;
      draft.cursor = null;
    });

    const queryInput = input({ value: draft.query, placeholder: 'database' });
    queryInput.addEventListener('input', () => {
      draft.query = queryInput.value;
    });
    const argsArea = textarea({
      value: draft.args,
      rows: 4,
      placeholder: '{"q": "$query"}；留空表示不带固定参数',
    });
    argsArea.addEventListener('input', () => {
      draft.args = argsArea.value;
    });
    const maxToolsInput = input({
      type: 'number',
      value: draft.maxTools,
      min: '1',
      max: '200',
    });
    maxToolsInput.addEventListener('input', () => {
      draft.maxTools = maxToolsInput.value;
    });
    const prepareSwitch = switchControl({
      checked: draft.prepareOnCall,
      label: '调用前预热（每次新连接首次调用会先执行搜索）',
    });
    prepareSwitch.input.addEventListener('change', () => {
      draft.prepareOnCall = prepareSwitch.input.checked;
    });
    const staleSwitch = switchControl({
      checked: draft.staleOthers,
      label: '把本次未返回的旧 search 工具标记为 stale',
    });
    staleSwitch.input.addEventListener('change', () => {
      draft.staleOthers = staleSwitch.input.checked;
    });

    const groups = formGrid();
    add(
      groups,
      groupCard('搜索配置', '搜索参数会以明文保存在配置里，不要填密钥；需要鉴权请配置 server 的 env/headers。', [
        field('搜索工具', searchToolSelect),
        field('查询词', queryInput),
        field('固定参数（JSON）', argsArea),
        field('最大条数', maxToolsInput),
      ]),
      groupCard('应用策略', '应用会改写工具 catalog，下一次 eval 生效；同名 static 工具默认跳过。', [
        prepareSwitch,
        staleSwitch,
      ]),
    );
    const errorLine = formError();
    const previewButton = button('预览', () => {
      previewButton.disabled = true;
      previewButton.textContent = '扫描中…';
      setFormError(errorLine, null);
      void previewDiscovery().finally(() => {
        if (previewButton.isConnected) {
          previewButton.disabled = false;
          previewButton.textContent = '预览';
        }
      });
    }, { variant: 'primary', icon: 'search' });
    const saveButton = button('保存配置', () => void saveDiscoveryConfig(), {
      variant: 'secondary',
    });
    const closeButton = button('关闭', () => {
      state.discoveryDraft = null;
      clearDiscoveryPreview();
      renderTab();
    }, { variant: 'ghost' });
    const footer = el('div', 'toolbar');
    add(footer, previewButton, saveButton, closeButton);
    add(handle.body, notice('预览会调用一次上游搜索工具；原始输出仅供人工排查，不会写入 catalog。', 'queue'), groups, errorLine, footer);

    if (state.discoveryPreview !== null) {
      handle.body.appendChild(buildDiscoveryPreview(state.discoveryPreview));
    }
    return handle.element;
  }

  function buildDiscoveryPreview(preview: DiscoveryPreview): HTMLElement {
    const wrap = el('div');
    setStyle(wrap, { display: 'flex', flexDirection: 'column', gap: '12px' });
    const head = el('div', 'toolbar');
    add(
      head,
      badge(preview.parsed ? '已解析' : '未解析', preview.parsed ? 'ok' : 'error'),
      badge(preview.shape, 'neutral'),
      badge(`${formatNumber(preview.tools.length)} 个工具`, 'info'),
      badge(`${formatDuration(preview.elapsedMs)}`, 'neutral'),
      badge(`过期 ${formatTimestamp(preview.previewExpiresAt)}`, 'neutral'),
    );
    add(wrap, head);

    if (preview.skipped.length > 0) {
      add(
        wrap,
        notice(
          `有 ${formatNumber(preview.skipped.length)} 个结果被跳过：${preview.skipped
            .slice(0, 5)
            .map((entry) => `${entry.name ?? '?'}（${entry.reason}）`)
            .join('、')}${preview.skipped.length > 5 ? ' …' : ''}`,
          'queue',
        ),
      );
    }
    if (preview.omitted > 0) {
      add(
        wrap,
        notice(
          `还有 ${formatNumber(preview.omitted)} 个结果未显示；可提高最大条数或使用游标。此时预览不完整。`,
          'queue',
        ),
      );
    }
    if (preview.willStaleCount > 0) {
      const names =
        preview.willStale.length === 0
          ? ''
          : `：${preview.willStale.slice(0, 100).join(', ')}${preview.willStaleCount > preview.willStale.length ? ' …' : ''}`;
      const marking = state.discoveryDraft?.staleOthers === true;
      add(
        wrap,
        notice(
          marking
            ? `本次会把 ${formatNumber(preview.willStaleCount)} 个已有工具标记为 stale${names}。它们会从检索与直接调用中消失，直到下次扫描返回。`
            : `预览计算有 ${formatNumber(preview.willStaleCount)} 个已有工具不在本次结果中${names}；当前未勾选“标记 stale”，应用不会改动它们。`,
          'queue',
        ),
      );
    }
    if (preview.partial) {
      add(
        wrap,
        notice(
          '本次预览不完整；默认不标记其它工具为 stale。显式勾选时应用前会再次确认。',
          'queue',
        ),
      );
    }

    if (!preview.parsed) {
      add(
        wrap,
        notice(
          '未能自动识别上游输出；请调整搜索工具或查询词。原始输出仅供人工排查，不会写入 catalog。',
          'error',
        ),
      );
      if (preview.raw !== null) {
        const raw = el('pre', '', preview.raw);
        setStyle(raw, {
          maxHeight: '320px',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          margin: '0',
          padding: '12px',
          border: '1px solid var(--border)',
          borderRadius: '8px',
        });
        if (preview.rawTruncated) add(wrap, notice('原始输出已截断。', 'queue'));
        add(wrap, raw);
      }
      return wrap;
    }

    if (preview.tools.length === 0) {
      add(
        wrap,
        notice('解析成功但没有可应用的工具；不能应用空预览。请调整后重新扫描。', 'queue'),
      );
      return wrap;
    }

    const table = el('table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const label of ['勾选', '工具名', '描述', 'schema', '冲突', '动作']) {
      add(headRow, el('th', '', label));
    }
    thead.appendChild(headRow);
    const tbody = el('tbody');
    for (const tool of preview.tools) {
      const row = el('tr');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.discoverySelected.has(tool.name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.discoverySelected.add(tool.name);
        else state.discoverySelected.delete(tool.name);
      });
      const conflict =
        tool.conflict === 'static'
          ? badge('static', 'error')
          : tool.conflict === 'search'
            ? badge('search', 'info')
            : el('span', 'muted', '—');
      const action =
        tool.action === 'create'
          ? badge('新建', 'ok')
          : tool.action === 'update'
            ? badge('更新', 'info')
            : badge('跳过', 'queue');
      add(
        row,
        td(checkbox),
        el('td', 'mono', tool.name),
        clippedCell(tool.description ?? '', 320),
        td(tool.schemaMissing ? badge('缺失', 'error') : badge('有', 'ok')),
        td(conflict),
        td(action),
      );
      tbody.appendChild(row);
    }
    add(table, thead, tbody);

    const selection = el('div', 'toolbar');
    add(
      selection,
      button('全选', () => {
        state.discoverySelected = new Set(
          preview.tools
            .filter((tool) => tool.action !== 'skip_static')
            .map((tool) => tool.name),
        );
        renderTab();
      }, { variant: 'ghost', size: 'sm' }),
      button('全不选', () => {
        state.discoverySelected = new Set<string>();
        renderTab();
      }, { variant: 'ghost', size: 'sm' }),
    );
    add(wrap, selection, tablePanel(table));

    const actions = el('div', 'toolbar');
    const applyButton = button('应用所选', () => {
      applyButton.disabled = true;
      applyButton.textContent = '应用中…';
      void applyDiscovery().finally(() => {
        if (applyButton.isConnected) {
          applyButton.disabled = false;
          applyButton.textContent = '应用所选';
        }
      });
    }, { variant: 'primary', icon: 'check' });
    add(actions, applyButton);
    if (preview.nextCursor !== null) {
      actions.appendChild(
        button('加载下一页', () => {
          if (state.discoveryDraft !== null) state.discoveryDraft.cursor = preview.nextCursor;
          state.discoveryPreview = null;
          renderTab();
          void previewDiscovery();
        }, { variant: 'secondary', icon: 'chevron-right' }),
      );
    }
    add(wrap, actions);
    return wrap;
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
  // Alerts and problem reports (design 06 §6)
  // -------------------------------------------------------------------------

  async function ensureAlertsConfig(force = false): Promise<void> {
    if (state.alertsConfigLoaded && !force) return;
    const config = await context.api.get<AlertConfigView>('/alerts/config', {
      signal: controller.signal,
    });
    if (destroyed) return;
    state.alertsConfig = config;
    state.alertsConfigLoaded = true;
  }

  async function loadReports(reset: boolean): Promise<void> {
    if (!reset && state.reportsCursor === null) return;
    const query: Record<string, string | number> = { limit: 50 };
    if (state.reportStatus !== '') query['status'] = state.reportStatus;
    if (state.reportSeverity !== '') query['severity'] = state.reportSeverity;
    if (!reset && state.reportsCursor !== null) query['cursor'] = state.reportsCursor;
    const response = await context.api.get<ReportsResponse>('/reports', {
      query,
      signal: controller.signal,
    });
    if (destroyed) return;
    const items = Array.isArray(response.items) ? response.items : [];
    state.reports = reset ? items : [...state.reports, ...items];
    state.reportsCursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
    state.reportsLoaded = true;
  }

  function startReportsPolling(): void {
    if (reportsPolling !== null) return;
    reportsPolling = startPolling(async () => {
      if (state.tab !== 'alerts' || destroyed) return;
      await loadReports(true);
      if (!destroyed && state.tab === 'alerts' && reportHost !== null && reportHost.isConnected) {
        renderReportsInto(reportHost);
      }
    }, 30_000);
  }

  function buildAlertsTab(): HTMLElement {
    const fragment = el('div');
    setStyle(fragment, { display: 'flex', flexDirection: 'column', gap: '20px' });

    fragment.append(buildAlertConfigCard(), buildReportCreateCard());

    const statusFilter = selectControl(REPORT_STATUS_OPTIONS, {
      value: state.reportStatus,
      ariaLabel: '报告状态过滤',
      onChange: (value) => {
        state.reportStatus = value as '' | ReportStatus;
        void reloadReports();
      },
    });
    const severityFilter = selectControl(REPORT_SEVERITY_FILTER_OPTIONS, {
      value: state.reportSeverity,
      ariaLabel: '报告严重级过滤',
      onChange: (value) => {
        state.reportSeverity = value as '' | Severity;
        void reloadReports();
      },
    });
    const refresh = button('刷新', () => {
      void reloadReports();
    }, { variant: 'secondary', icon: 'refresh' });
    const listCard = cardSection({
      title: '问题报告',
      subtitle: `${formatNumber(state.reports.length)} 条 · 每 30 秒刷新（页面隐藏时暂停）`,
      icon: 'alert',
      flush: true,
      actions: [statusFilter, severityFilter, refresh],
    });
    reportHost = el('div');
    listCard.body.appendChild(reportHost);
    renderReportsInto(reportHost);
    fragment.append(listCard.element);
    startReportsPolling();
    return fragment;
  }

  async function reloadReports(): Promise<void> {
    try {
      await loadReports(true);
      if (!destroyed && reportHost !== null) renderReportsInto(reportHost);
    } catch (error) {
      if (!destroyed) setStatus(describeError(error), 'error');
    }
  }

  function buildAlertConfigCard(): HTMLElement {
    const config = state.alertsConfig;
    const handle = cardSection({
      title: '告警配置',
      subtitle: '企业微信 webhook 只写不读；保存需要 If-Match revision。',
      icon: 'alert',
    });
    if (config === null) {
      add(
        handle.body,
        emptyBlock('没有读取到告警配置。', '检查服务端 /alerts/config 端点。'),
        button('重试', () => {
          state.alertsConfigLoaded = false;
          void ensureAlertsConfig(true)
            .then(() => renderTab())
            .catch((error: unknown) => setStatus(describeError(error), 'error'));
        }, { variant: 'secondary', icon: 'refresh' }),
      );
      return handle.element;
    }

    const enabledSwitch = switchControl({ checked: config.enabled, label: '启用告警' });
    const severitySelect = selectControl(SEVERITY_OPTIONS, {
      value: config.minSeverity,
      ariaLabel: '最低严重级',
    });
    const statusLine = el('div', 'toolbar');
    add(
      statusLine,
      badge(config.enabled ? '已启用' : '已关闭', config.enabled ? 'ok' : 'neutral'),
      badge(
        config.webhook.configured ? 'Webhook 已配置' : 'Webhook 未配置',
        config.webhook.configured ? 'ok' : 'error',
      ),
      badge(`revision ${formatNumber(config.revision)}`, 'neutral'),
    );

    const webhookHost = el('div');
    let webhookInput: HTMLInputElement | null = null;
    let revealWebhook = !config.webhook.configured;
    const drawWebhook = (): void => {
      webhookHost.replaceChildren();
      if (config.webhook.configured && !revealWebhook) {
        const line = el('div', 'toolbar');
        add(
          line,
          el('span', 'mono muted', `${config.webhook.secretName}（已配置）`),
          button('更换', () => {
            revealWebhook = true;
            drawWebhook();
          }, { variant: 'secondary', size: 'sm' }),
        );
        add(webhookHost, line);
        return;
      }
      webhookInput = input({
        type: 'password',
        value: '',
        placeholder: config.webhook.configured
          ? '输入新值可替换（留空保持不变）'
          : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
      });
      webhookInput.setAttribute('autocomplete', 'off');
      add(webhookHost, field('企业微信 webhook', webhookInput));
    };
    drawWebhook();

    const resultHost = el('div');
    const errorLine = formError();

    const save = button('保存', () => {
      const wantEnabled = enabledSwitch.input.checked;
      if (
        !config.enabled &&
        wantEnabled &&
        !confirmAction(
          `启用告警后，severity ≥ ${severitySelect.value} 的报告会发送到 ${
            config.webhook.configured ? `${config.webhook.secretName}（已配置）` : '尚未配置的 webhook'
          }。继续？`,
        )
      ) {
        return;
      }
      const body: Record<string, unknown> = {
        enabled: wantEnabled,
        minSeverity: severitySelect.value,
      };
      const webhook = webhookInput?.value.trim() ?? '';
      if (webhook !== '') body['webhook'] = webhook;
      setFormError(errorLine, null);
      save.disabled = true;
      save.textContent = '保存中…';
      void context.api
        .put<AlertConfigView>('/alerts/config', body, {
          signal: controller.signal,
          headers: { 'If-Match': String(config.revision) },
        })
        .then((response) => {
          if (destroyed) return;
          state.alertsConfig = response;
          state.alertsConfigLoaded = true;
          succeeded('已保存告警配置。');
          renderTab();
        })
        .catch((error: unknown) => {
          const details = error instanceof ApiError ? errorDetails(error) : null;
          const message =
            details?.['webhookUpdated'] === true
              ? 'webhook 已更新，配置未保存；请刷新后重试。'
              : saveErrorText(error);
          setFormError(errorLine, message);
          save.disabled = false;
          save.textContent = '保存';
        });
    }, { variant: 'primary' });

    const clear = button('清除 webhook', () => {
      if (!confirmAction('清除已保存的企业微信 webhook？告警将停止发送，开关不会被关闭。')) return;
      clear.disabled = true;
      void context.api
        .put<AlertConfigView>('/alerts/config', { webhook: null }, {
          signal: controller.signal,
          headers: { 'If-Match': String(config.revision) },
        })
        .then((response) => {
          if (destroyed) return;
          state.alertsConfig = response;
          state.alertsConfigLoaded = true;
          succeeded('已清除 webhook。');
          renderTab();
        })
        .catch((error: unknown) => {
          if (!destroyed) setStatus(saveErrorText(error), 'error');
          clear.disabled = false;
        });
    }, { variant: 'danger', disabled: !config.webhook.configured });

    const preview = button('预览', () => {
      preview.disabled = true;
      preview.textContent = '渲染中…';
      resultHost.replaceChildren();
      void context.api
        .post<AlertPreviewResponse>('/alerts/preview', { severity: severitySelect.value }, {
          signal: controller.signal,
        })
        .then((response) => {
          if (destroyed) return;
          const pre = el('pre', '', response.content);
          setStyle(pre, {
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            margin: '0',
            padding: '12px',
            border: '1px solid var(--border)',
            borderRadius: '8px',
          });
          resultHost.replaceChildren(
            notice(`预览内容 ${formatBytes(response.bytes)}（上限 4096 字节）。`, 'info'),
            pre,
          );
        })
        .catch((error: unknown) => {
          if (!destroyed) resultHost.replaceChildren(notice(describeError(error), 'error'));
        })
        .finally(() => {
          if (preview.isConnected) {
            preview.disabled = false;
            preview.textContent = '预览';
          }
        });
    }, { variant: 'secondary' });

    const test = button('发送测试', () => {
      test.disabled = true;
      test.textContent = '发送中…';
      resultHost.replaceChildren(notice('测试消息正在通过发送队列投递，最长约 10.5 秒。', 'info'));
      void context.api
        .post<AlertTestResponse>('/alerts/test', undefined, { signal: controller.signal })
        .then((response) => {
          if (destroyed) return;
          if (response.ok) {
            resultHost.replaceChildren(
              notice(
                `测试消息已送达：attempts ${formatNumber(response.attempts)}，耗时 ${formatDuration(response.elapsedMs)}。`,
                'ok',
              ),
            );
          } else {
            const code = response.error?.code ?? 'ALERT_FAILED';
            const message = response.error?.message ?? '测试消息未送达。';
            resultHost.replaceChildren(notice(`测试消息未送达：${code} · ${message}`, 'error'));
          }
        })
        .catch((error: unknown) => {
          if (!destroyed) resultHost.replaceChildren(notice(alertErrorText(error), 'error'));
        })
        .finally(() => {
          if (test.isConnected) {
            test.disabled = false;
            test.textContent = '发送测试';
          }
        });
    }, { variant: 'secondary' });

    const controls = el('div', 'toolbar');
    add(controls, save, clear, preview, test);
    add(handle.body, statusLine, enabledSwitch, field('最低严重级', severitySelect), webhookHost, controls, errorLine, resultHost);
    return handle.element;
  }

  function buildReportCreateCard(): HTMLElement {
    const handle = cardSection({
      title: '新建问题报告',
      subtitle: '提交后写入数据库并进入告警队列；列表不会自动展开详情。',
      icon: 'plus',
    });
    const formBody = el('div');
    setStyle(formBody, { display: 'flex', flexDirection: 'column', gap: '12px' });
    formBody.hidden = true;
    const toggle = button('展开表单', () => {
      formBody.hidden = !formBody.hidden;
      toggle.textContent = formBody.hidden ? '展开表单' : '收起表单';
    }, { variant: 'secondary', icon: 'chevron-down' });
    handle.actions.appendChild(toggle);

    const title = input({ placeholder: 'Bash 执行 npm test 时挂起' });
    title.maxLength = 200;
    const detail = textarea({ rows: 6, placeholder: '现象、期望与实际、复现步骤；不要粘贴密钥。' });
    detail.maxLength = 20_000;
    const severity = selectControl(SEVERITY_OPTIONS, { value: 'high', ariaLabel: 'severity' });
    const contextArea = textarea({
      rows: 4,
      placeholder: '可选 JSON 对象，≤ 8192 字节；例如 {"tool":"Bash"}',
    });
    const errorLine = formError();
    const submit = button('提交报告', () => undefined, { type: 'submit', variant: 'primary' });
    const form = el('form');
    form.noValidate = true;
    setStyle(form, { display: 'flex', flexDirection: 'column', gap: '12px' });
    add(
      form,
      notice('报告中不要粘贴密钥；详情与 context 不会进入告警消息和审计日志。', 'queue'),
      field('标题', title),
      field('详情', detail),
      field('严重级', severity),
      field('context（JSON）', contextArea),
      errorLine,
      submit,
    );
    formBody.appendChild(form);
    handle.body.appendChild(formBody);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      setFormError(errorLine, null);
      const titleText = title.value.trim();
      const detailText = detail.value.trim();
      if (titleText === '') {
        setFormError(errorLine, '标题不能为空。');
        return;
      }
      if (detailText === '') {
        setFormError(errorLine, '详情不能为空。');
        return;
      }
      let parsedContext: unknown;
      if (contextArea.value.trim() !== '') {
        try {
          parsedContext = JSON.parse(contextArea.value);
        } catch (error) {
          setFormError(errorLine, `context JSON 解析失败：${describeError(error)}`);
          return;
        }
        if (
          typeof parsedContext !== 'object' ||
          parsedContext === null ||
          Array.isArray(parsedContext)
        ) {
          setFormError(errorLine, 'context 必须是 JSON 对象。');
          return;
        }
      }
      const body: Record<string, unknown> = {
        title: titleText,
        detail: detailText,
        severity: severity.value,
      };
      if (parsedContext !== undefined) body['context'] = parsedContext;
      submit.disabled = true;
      submit.textContent = '提交中…';
      void context.api
        .post<{ report: ReportView }>('/reports', body, { signal: controller.signal })
        .then(async (response) => {
          if (destroyed) return;
          succeeded(`已创建报告 ${response.report.id}；状态 ${response.report.status}。`);
          title.value = '';
          detail.value = '';
          contextArea.value = '';
          try {
            await loadReports(true);
            if (!destroyed && reportHost !== null) renderReportsInto(reportHost);
          } catch (refreshError) {
            if (!destroyed) {
              setStatus(`报告已创建，但刷新列表失败：${describeError(refreshError)}`, 'queue');
            }
          }
        })
        .catch((error: unknown) => {
          if (!destroyed) setFormError(errorLine, saveErrorText(error));
        })
        .finally(() => {
          if (submit.isConnected) {
            submit.disabled = false;
            submit.textContent = '提交报告';
          }
        });
    });
    return handle.element;
  }

  function renderReportsInto(host: HTMLElement): void {
    host.replaceChildren();
    if (state.reports.length === 0) {
      host.appendChild(
        emptyBlock('还没有问题报告。', '可以在上方新建报告，或让 MCP 客户端调用 report_problem。'),
      );
      return;
    }
    const table = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const label of ['时间', '严重级', '标题', '来源', '状态', '告警状态']) {
      add(head, el('th', '', label));
    }
    thead.appendChild(head);
    const tbody = el('tbody');
    for (const report of state.reports) {
      const row = el('tr');
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => openReportDetail(report.id));
      const time = el('span', '', formatTimestamp(report.createdAt));
      time.title = report.createdAt;
      add(
        row,
        td(time),
        td(badge(report.severity, severityTone(report.severity))),
        clippedCell(report.title, 380),
        td(badge(report.source, report.source === 'mcp' ? 'info' : 'neutral')),
        td(badge(report.status, reportStatusTone(report.status))),
        td(alertStateBadge(report.alertState)),
      );
      tbody.appendChild(row);
    }
    add(table, thead, tbody);
    host.appendChild(tablePanel(table));
    if (state.reportsCursor !== null) {
      const footer = el('div', 'toolbar');
      add(
        footer,
        button('加载更多', () => {
          void loadReports(false)
            .then(() => {
              if (!destroyed && reportHost !== null) renderReportsInto(reportHost);
            })
            .catch((error: unknown) => {
              if (error instanceof ApiError && error.code === 'INVALID_CURSOR') {
                state.reportsCursor = null;
                void reloadReports();
                setStatus('分页游标失效，已从头加载。', 'queue');
                return;
              }
              if (!destroyed) setStatus(describeError(error), 'error');
            });
        }, { variant: 'secondary' }),
      );
      setStyle(footer, { padding: '12px 16px' });
      host.appendChild(footer);
    }
  }

  function openReportDetail(reportId: string): void {
    drawer.open(`报告 ${formatId(reportId, 20)}`, loading('正在加载报告详情…'));
    void context.api
      .get<{ report: ReportView }>(`/reports/${encodeURIComponent(reportId)}`, {
        signal: controller.signal,
      })
      .then((response) => {
        if (destroyed) return;
        drawer.open(`报告 ${formatId(reportId, 20)}`, buildReportDetail(response.report));
      })
      .catch((error: unknown) => {
        if (destroyed) return;
        const box = el('div');
        add(box, notice(describeError(error), 'error'));
        drawer.open(`报告 ${formatId(reportId, 20)}`, box);
      });
  }

  function buildReportDetail(report: ReportView): HTMLElement {
    const wrapper = el('div');
    setStyle(wrapper, { display: 'flex', flexDirection: 'column', gap: '16px' });
    const head = el('div', 'toolbar');
    add(
      head,
      badge(report.severity, severityTone(report.severity)),
      badge(report.status, reportStatusTone(report.status)),
      alertStateBadge(report.alertState),
      badge(report.source, report.source === 'mcp' ? 'info' : 'neutral'),
    );
    add(wrapper, head);
    add(
      wrapper,
      definitionList([
        { label: 'id', value: report.id, mono: true },
        { label: '创建', value: formatTimestamp(report.createdAt) },
        { label: '更新', value: formatTimestamp(report.updatedAt) },
        { label: '来源', value: report.source },
        { label: 'binding', value: report.binding ?? '—', mono: true },
        { label: 'client', value: report.client ?? '—', mono: true },
        { label: 'mcp', value: report.mcp ?? '—', mono: true },
        { label: 'exec', value: report.exec ?? '—', mono: true },
        { label: 'evalId', value: report.evalId ?? '—', mono: true },
        { label: '告警尝试', value: formatNumber(report.alertAttempts) },
        { label: '告警错误', value: report.alertError ?? '—', mono: true },
        { label: '告警更新', value: formatTimestamp(report.alertUpdatedAt) },
        { label: '送达时间', value: formatTimestamp(report.alertedAt) },
      ]),
    );

    add(wrapper, el('h3', '', report.title));
    const detail = el('pre', '', report.detail ?? '');
    setStyle(detail, {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      margin: '0',
      fontFamily: 'inherit',
      fontSize: '13px',
    });
    add(wrapper, detail);

    if (report.context !== undefined && report.context !== null) {
      add(wrapper, el('h3', '', 'context'));
      const context = el('pre', '', formatJson(report.context, 2));
      setStyle(context, {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: '0',
        padding: '12px',
        border: '1px solid var(--border)',
        borderRadius: '8px',
      });
      add(wrapper, context);
    }

    if (report.alertError !== null) add(wrapper, notice(report.alertError, 'error'));

    const actions = el('div', 'toolbar');
    if (report.status === 'open') {
      actions.appendChild(
        button('确认', () => void changeReportStatus(report.id, 'ack'), {
          variant: 'secondary',
          size: 'sm',
        }),
      );
    }
    if (report.status !== 'open') {
      actions.appendChild(
        button('重新打开', () => void changeReportStatus(report.id, 'open'), {
          variant: 'secondary',
          size: 'sm',
        }),
      );
    }
    if (report.status !== 'closed') {
      actions.appendChild(
        button('关闭', () => void changeReportStatus(report.id, 'closed'), {
          variant: 'primary',
          size: 'sm',
        }),
      );
    }
    if (
      report.alertState === 'failed' ||
      report.alertState === 'skipped' ||
      report.alertState === 'no_webhook'
    ) {
      actions.appendChild(
        button('重发告警', () => void retryReportAlert(report.id), {
          variant: 'secondary',
          size: 'sm',
        }),
      );
    }
    actions.appendChild(button('关闭详情', () => drawer.close(), { variant: 'ghost', size: 'sm' }));
    add(wrapper, actions);
    return wrapper;
  }

  async function changeReportStatus(reportId: string, status: ReportStatus): Promise<void> {
    try {
      await context.api.patch<{ report: ReportView }>(
        `/reports/${encodeURIComponent(reportId)}`,
        { status },
        { signal: controller.signal },
      );
      if (destroyed) return;
      succeeded(`报告状态已更新为 ${status}。`);
      await reloadReports();
      openReportDetail(reportId);
    } catch (error) {
      if (!destroyed) setStatus(describeError(error), 'error');
    }
  }

  async function retryReportAlert(reportId: string): Promise<void> {
    try {
      await context.api.post<{ report: ReportView }>(
        `/reports/${encodeURIComponent(reportId)}/retry-alert`,
        undefined,
        { signal: controller.signal },
      );
      if (destroyed) return;
      succeeded('告警已重新排队。');
      await reloadReports();
      openReportDetail(reportId);
    } catch (error) {
      if (!destroyed) setStatus(describeError(error), 'error');
    }
  }

  // -------------------------------------------------------------------------
  // AI configuration and annotation (design 08 §8)
  // -------------------------------------------------------------------------

  async function ensureAiConfig(force = false): Promise<void> {
    if (state.aiConfigLoaded && !force) return;
    const config = await context.api.get<AiConfigView>('/ai/config', {
      signal: controller.signal,
    });
    if (destroyed) return;
    state.aiConfig = config;
    state.aiConfigLoaded = true;
  }

  async function loadAiPending(): Promise<void> {
    const response = await context.api.get<{ items: PendingAnnotationView[] }>(
      '/ai/annotations/pending',
      { signal: controller.signal },
    );
    if (destroyed) return;
    state.aiPending = Array.isArray(response.items) ? response.items : [];
    state.aiPendingLoaded = true;
  }

  function buildAiTab(): HTMLElement {
    const fragment = el('div');
    setStyle(fragment, { display: 'flex', flexDirection: 'column', gap: '20px' });
    fragment.append(buildAiConfigCard(), buildAiProposeCard(), buildAiPendingCard());
    return fragment;
  }

  function buildAiConfigCard(): HTMLElement {
    const config = state.aiConfig;
    const handle = cardSection({
      title: 'AI 配置',
      subtitle: '启用后生成与标注会把工具名和描述发送给模型；密钥只以 $secret 引用。',
      icon: 'activity',
    });
    if (config === null) {
      add(handle.body, emptyBlock('没有读取到 AI 配置。', '检查服务端 /ai/config 端点。'));
      return handle.element;
    }
    const ai = config.ai;
    const enabledSwitch = switchControl({ checked: ai.enabled, label: '启用 AI' });
    const autoSwitch = switchControl({
      checked: ai.autoAnnotate,
      label: '新接入 server 自动生成标注预览',
    });
    const claudeBin = input({
      value: ai.claudeBin ?? '',
      placeholder: '留空使用环境变量或默认 claude',
    });
    const model = input({ value: ai.model ?? '', placeholder: '留空使用 CLI 默认模型' });
    const timeoutMs = input({
      type: 'number',
      value: String(ai.timeoutMs),
      min: '5000',
      max: '180000',
    });
    const sourceLine = el('div', 'toolbar');
    add(
      sourceLine,
      badge(`生效命令 ${ai.effectiveClaudeBin}`, 'info'),
      badge(`来源 ${ai.claudeBinSource}`, 'neutral'),
      badge(`prompt v${config.prompts.propose}/${config.prompts.annotate}`, 'neutral'),
      badge(`revision ${formatNumber(config.revision)}`, 'neutral'),
    );
    const errorLine = formError();
    const save = button('保存', () => {
      setFormError(errorLine, null);
      const timeout = readInteger(timeoutMs.value, 'timeoutMs');
      if (timeout < 5_000 || timeout > 180_000) {
        setFormError(errorLine, 'timeoutMs 必须在 5000 到 180000 之间。');
        return;
      }
      const body = {
        ai: {
          enabled: enabledSwitch.input.checked,
          autoAnnotate: autoSwitch.input.checked,
          claudeBin: nullIfEmpty(claudeBin.value),
          model: nullIfEmpty(model.value),
          timeoutMs: timeout,
        },
      };
      state.aiConfigBusy = true;
      save.disabled = true;
      save.textContent = '保存中…';
      void context.api
        .put<{ ai: AiConfigView['ai']; revision: number }>('/ai/config', body, {
          signal: controller.signal,
          headers: { 'If-Match': String(config.revision) },
        })
        .then((response) => {
          if (destroyed) return;
          state.aiConfig = {
            ai: response.ai,
            prompts: config.prompts,
            revision: response.revision,
          };
          state.aiConfigLoaded = true;
          succeeded('已保存 AI 配置。');
          renderTab();
        })
        .catch((error: unknown) => {
          if (!destroyed) setFormError(errorLine, saveErrorText(error));
          save.disabled = false;
          save.textContent = '保存';
        })
        .finally(() => {
          state.aiConfigBusy = false;
        });
    }, { variant: 'primary' });
    add(
      handle.body,
      sourceLine,
      enabledSwitch,
      autoSwitch,
      field('claudeBin', claudeBin),
      field('model', model),
      field('timeoutMs', timeoutMs),
      errorLine,
      save,
    );
    return handle.element;
  }

  function buildAiProposeCard(): HTMLElement {
    const handle = cardSection({
      title: '一句话生成 MCP 配置',
      subtitle: '输入会发送给模型；密钥用 $secret 引用，预览确认后才会创建 server。',
      icon: 'terminal',
    });
    const inputArea = textarea({
      value: state.aiInput,
      rows: 5,
      placeholder: '例如：帮我配一个 github MCP，需要 GITHUB_TOKEN',
    });
    const counter = el('p', 'field-hint', '');
    const updateCounter = (): void => {
      const bytes = new TextEncoder().encode(inputArea.value).length;
      counter.textContent = `${formatNumber(bytes)} / ${formatNumber(AI_INPUT_MAX_BYTES)} 字节`;
    };
    inputArea.addEventListener('input', () => {
      state.aiInput = inputArea.value;
      updateCounter();
    });
    updateCounter();
    const errorLine = formError();
    const generate = button('生成配置', () => {
      setFormError(errorLine, null);
      const bytes = new TextEncoder().encode(inputArea.value).length;
      if (inputArea.value.trim() === '') {
        setFormError(errorLine, '输入不能为空。');
        return;
      }
      if (bytes > AI_INPUT_MAX_BYTES) {
        setFormError(
          errorLine,
          `输入为 ${formatNumber(bytes)} 字节，超过上限 ${formatNumber(AI_INPUT_MAX_BYTES)} 字节。`,
        );
        return;
      }
      generate.disabled = true;
      generate.textContent = `Claude 正在生成，最长 ${Math.round((state.aiConfig?.ai.timeoutMs ?? 60_000) / 1000)} 秒…`;
      state.aiProposeBusy = true;
      void context.api
        .post<AiProposal>('/ai/propose', { input: inputArea.value }, { signal: controller.signal })
        .then((proposal) => {
          if (destroyed) return;
          state.aiProposal = proposal;
          renderTab();
        })
        .catch((error: unknown) => {
          if (!destroyed) setFormError(errorLine, aiErrorText(error));
        })
        .finally(() => {
          state.aiProposeBusy = false;
          if (generate.isConnected) {
            generate.disabled = false;
            generate.textContent = '生成配置';
          }
        });
    }, { variant: 'primary', icon: 'play' });
    const toolbar = el('div', 'toolbar');
    add(toolbar, generate);
    add(handle.body, inputArea, counter, toolbar, errorLine);
    if (state.aiProposal !== null) handle.body.appendChild(buildAiProposalCard(state.aiProposal));
    return handle.element;
  }

  function buildAiProposalCard(proposal: AiProposal): HTMLElement {
    const wrapper = el('div');
    setStyle(wrapper, { display: 'flex', flexDirection: 'column', gap: '12px' });
    add(
      wrapper,
      notice('AI 生成，未经审核；stdio 等于允许执行命令，确认前请核对 command 与 args。', 'queue'),
    );
    if (proposal.server === null) {
      add(
        wrapper,
        notice('模型没有给出可用的 server 草稿；请调整输入后重新生成。', 'error'),
      );
      add(wrapper, buildAiProposalFooter());
      return wrapper;
    }
    const server = proposal.server;
    add(wrapper, el('p', '', proposal.explanation));
    if (proposal.warnings.length > 0) {
      const list = el('ul');
      setStyle(list, { margin: '0', paddingLeft: '20px' });
      for (const warning of proposal.warnings) list.appendChild(el('li', '', warning));
      add(wrapper, list);
    }
    if (proposal.idConflict) {
      add(wrapper, notice('生成的 id 已存在；请修改 id 或取消后重新生成。', 'error'));
    }
    if (proposal.inputWarning === true) {
      add(wrapper, notice('输入中可能包含字面密钥，已发送给模型；建议改用 $secret。', 'queue'));
    }

    const idInput = input({ value: server.id, placeholder: 'github' });
    if (proposal.idConflict) {
      setStyle(idInput, { borderColor: 'var(--error)' });
      idInput.focus();
    }
    const labelInput = input({ value: server.label, placeholder: 'GitHub' });
    const transportSelect = selectControl(TRANSPORT_OPTIONS, {
      value: server.transport,
      ariaLabel: 'transport',
    });
    const commandInput = input({ value: server.command ?? '', placeholder: 'npx' });
    const argsArea = textarea({
      value: argsForEditing(server.args),
      rows: 3,
      placeholder: '每行一个参数；<secret:NAME> 按引用保存',
    });
    const cwdInput = input({ value: server.cwd ?? '', placeholder: '/absolute/workspace' });
    const urlInput = input({ value: server.url ?? '', placeholder: 'https://…/mcp' });
    const envKeysArea = textarea({
      value: server.envKeys.join('\n'),
      rows: 2,
      placeholder: '每行一个变量名；值到密钥页写入',
    });
    const headerKeysArea = textarea({
      value: server.headerKeys.join('\n'),
      rows: 2,
      placeholder: '每行一个 header 名',
    });
    const enabledSwitch = switchControl({ checked: server.enabled, label: '启用该 server' });
    const connectSelect = selectControl(CONNECT_MODE_OPTIONS, {
      value: server.connectMode,
      ariaLabel: 'connectMode',
    });
    const categoryInput = input({ value: server.category ?? '', placeholder: 'devtools' });
    const tagsInput = input({ value: server.tags.join(', '), placeholder: 'git, github' });
    const summaryInput = input({ value: server.summary ?? '', placeholder: '用于检索的摘要与英文关键词' });

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

    const groups = formGrid();
    add(
      groups,
      groupCard('基本信息', null, [
        field('id', idInput),
        field('label', labelInput),
        field('transport', transportSelect),
        field('connectMode', connectSelect),
      ]),
      groupCard('传输配置', 'envKeys/headerKeys 只允许键名；值到密钥页写入。', [
        stdioFields,
        httpFields,
        field('env 键名', envKeysArea),
        field('header 键名', headerKeysArea),
      ]),
      groupCard('元数据', 'summary 与 tags 用于检索。', [
        field('summary', summaryInput),
        field('category', categoryInput),
        field('tags', tagsInput),
        enabledSwitch,
      ]),
    );
    const form = el('form');
    form.noValidate = true;
    setStyle(form, { display: 'flex', flexDirection: 'column', gap: '16px' });
    const errorLine = formError();
    const apply = button('确认创建', () => undefined, { type: 'submit', variant: 'primary' });
    const cancel = button('取消', () => {
      state.aiProposal = null;
      renderTab();
    }, { variant: 'ghost' });
    const regenerate = button('重新生成', () => {
      state.aiProposal = null;
      renderTab();
    }, { variant: 'secondary' });
    const actions = el('div', 'toolbar');
    add(actions, apply, regenerate, cancel);
    add(form, groups, errorLine, actions);
    wrapper.appendChild(form);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      setFormError(errorLine, null);
      const id = idInput.value.trim();
      if (id === '') {
        setFormError(errorLine, 'id 不能为空。');
        return;
      }
      if (proposal.proposalId === null) {
        setFormError(errorLine, '草稿已失效，请重新生成。');
        return;
      }
      const transport = transportSelect.value === 'http' ? 'http' : 'stdio';
      const command = transport === 'stdio' ? nullIfEmpty(commandInput.value) : null;
      const args = transport === 'stdio' ? parseArgs(argsArea.value) : [];
      if (
        transport === 'stdio' &&
        !confirmAction(
          `即将创建 stdio server，启动命令为：\n\n${command ?? ''} ${args
            .map((arg) => (typeof arg === 'string' ? arg : `<secret:${arg.$secret}>`))
            .join(' ')}\n\n这等于允许执行任意命令。继续？`,
        )
      ) {
        return;
      }
      const body: Record<string, unknown> = {
        proposalId: proposal.proposalId,
        server: {
          id,
          label: labelInput.value.trim() === '' ? id : labelInput.value.trim(),
          transport,
          command,
          args,
          cwd: transport === 'stdio' ? nullIfEmpty(cwdInput.value) : null,
          url: transport === 'http' ? nullIfEmpty(urlInput.value) : null,
          envKeys: splitList(envKeysArea.value),
          headerKeys: splitList(headerKeysArea.value),
          enabled: enabledSwitch.input.checked,
          connectMode: connectSelect.value === 'eager' ? 'eager' : 'lazy',
          category: nullIfEmpty(categoryInput.value),
          tags: splitList(tagsInput.value),
          summary: nullIfEmpty(summaryInput.value),
        },
      };
      if (transport === 'stdio') body['confirmStdio'] = true;
      state.aiProposalApplyBusy = true;
      apply.disabled = true;
      apply.textContent = '创建中…';
      void context.api
        .post<{ server: ServerView; revision: number }>('/ai/propose/apply', body, {
          signal: controller.signal,
        })
        .then(async (response) => {
          if (destroyed) return;
          state.serversRevision = numberOr(response.revision, state.serversRevision);
          state.aiProposal = null;
          state.aiInput = '';
          succeeded(`已创建 server ${response.server.id}。`);
          state.serversLoaded = false;
          try {
            await ensureServers(true);
          } catch (refreshError) {
            if (!destroyed) {
              setStatus(`server 已创建，但刷新列表失败：${describeError(refreshError)}`, 'queue');
            }
          }
          if (!destroyed) setTab('servers');
        })
        .catch((error: unknown) => {
          if (!destroyed) setFormError(errorLine, aiErrorText(error));
          apply.disabled = false;
          apply.textContent = '确认创建';
        })
        .finally(() => {
          state.aiProposalApplyBusy = false;
        });
    });
    return wrapper;
  }

  function buildAiProposalFooter(): HTMLElement {
    const toolbar = el('div', 'toolbar');
    add(
      toolbar,
      button('重新生成', () => {
        state.aiProposal = null;
        renderTab();
      }, { variant: 'secondary' }),
      button('取消', () => {
        state.aiProposal = null;
        renderTab();
      }, { variant: 'ghost' }),
    );
    return toolbar;
  }

  function buildAiPendingCard(): HTMLElement {
    const handle = cardSection({
      title: '待处理标注',
      subtitle: `${formatNumber(state.aiPending.length)} 条自动生成的标注建议`,
      icon: 'layers',
      flush: true,
      actions: [
        button('刷新', () => {
          void loadAiPending()
            .then(() => renderTab())
            .catch((error: unknown) => setStatus(describeError(error), 'error'));
        }, { variant: 'secondary', icon: 'refresh' }),
      ],
    });
    if (state.aiPending.length === 0) {
      handle.body.appendChild(
        emptyBlock('没有待处理标注。', '新接入 server 自动生成建议后会出现在这里。'),
      );
      return handle.element;
    }
    const table = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const label of ['server', '生成时间', 'summary', 'tags', 'warnings', '操作']) {
      add(head, el('th', '', label));
    }
    thead.appendChild(head);
    const tbody = el('tbody');
    for (const pending of state.aiPending) {
      const row = el('tr');
      add(
        row,
        el('td', 'mono', pending.serverId),
        el('td', 'muted', formatTimestamp(pending.createdAt)),
        clippedCell(pending.proposed.summary ?? '—', 320),
        tagCell(pending.proposed.tags),
        el('td', 'muted', formatNumber(pending.warnings.length)),
        td(
          rowActions(
            button('预览', () => void openPendingAnnotation(pending), {
              variant: 'ghost',
              size: 'sm',
            }),
            button('应用', () => void applyPendingAnnotation(pending), {
              variant: 'ghost',
              size: 'sm',
            }),
          ),
        ),
      );
      tbody.appendChild(row);
    }
    add(table, thead, tbody);
    handle.body.appendChild(tablePanel(table));
    return handle.element;
  }

  function annotationDraftFromPreview(
    preview: AnnotationPreviewView,
    tools: ToolRecord[],
  ): AnnotationDraft {
    return {
      serverId: preview.serverId,
      current: preview.current,
      proposed: preview.proposed,
      warnings: preview.warnings,
      omittedTools: preview.omittedTools,
      tools: buildAnnotationTools(preview.proposed.toolOverrides, tools),
    };
  }

  function buildAnnotationTools(
    overrides: ToolOverrideDraft[],
    tools: ToolRecord[],
  ): AnnotationToolDraft[] {
    return overrides.map((override) => {
      const tool = tools.find((entry) => entry.name === override.name);
      const effectiveDescription =
        tool === undefined
          ? null
          : tool.effective?.description ?? tool.descriptionOverride ?? tool.description;
      return {
        name: override.name,
        currentDescription: effectiveDescription,
        currentDescriptionSource:
          tool === undefined
            ? null
            : tool.descriptionOverride !== null && tool.descriptionOverride !== undefined
              ? 'override'
              : 'upstream',
        proposedDescription: override.description,
        currentTags: tool?.effective?.tags ?? tool?.tags ?? [],
        proposedTags: override.tags,
      };
    });
  }

  async function startServerAnnotation(server: ServerView): Promise<void> {
    if (state.aiAnnotationBusy) return;
    if (
      !confirmAction(
        `将把 ${server.id} 的工具名与描述（最多 80 个，每个 400 字符）发送给模型。敏感 server 请取消。继续？`,
      )
    ) {
      return;
    }
    state.aiAnnotationBusy = true;
    drawer.open(`AI 标注 · ${server.id}`, loading('Claude 正在生成标注预览…'));
    try {
      const preview = await context.api.post<AnnotationPreviewView>(
        `/ai/annotate/${encodeURIComponent(server.id)}`,
        { mode: 'preview' },
        { signal: controller.signal },
      );
      const toolsResponse = await context.api.get<ToolsResponse>(
        `/servers/${encodeURIComponent(server.id)}/tools`,
        { signal: controller.signal },
      );
      if (destroyed) return;
      openAnnotationPreview(
        annotationDraftFromPreview(
          preview,
          Array.isArray(toolsResponse.tools) ? toolsResponse.tools : [],
        ),
      );
    } catch (error) {
      if (!destroyed) {
        const box = el('div');
        add(box, notice(aiErrorText(error), 'error'));
        drawer.open(`AI 标注 · ${server.id}`, box);
      }
    } finally {
      state.aiAnnotationBusy = false;
    }
  }

  async function openPendingAnnotation(pending: PendingAnnotationView): Promise<void> {
    const server = serverById(pending.serverId);
    if (server === undefined) {
      setStatus(`server ${pending.serverId} 不在当前列表，刷新后重试。`, 'error');
      return;
    }
    state.aiAnnotationBusy = true;
    drawer.open(`AI 标注 · ${pending.serverId}`, loading('正在读取工具与当前标注…'));
    try {
      const toolsResponse = await context.api.get<ToolsResponse>(
        `/servers/${encodeURIComponent(pending.serverId)}/tools`,
        { signal: controller.signal },
      );
      if (destroyed) return;
      const preview: AnnotationPreviewView = {
        serverId: pending.serverId,
        current: {
          summary: server.summary,
          summarySource: server.summarySource ?? null,
          category: server.category,
          tags: [...server.tags],
        },
        proposed: pending.proposed,
        warnings: pending.warnings,
        omittedTools: pending.omittedTools,
        meta: { model: null, durationMs: 0, promptVersion: 0, costUsd: null },
      };
      openAnnotationPreview(
        annotationDraftFromPreview(
          preview,
          Array.isArray(toolsResponse.tools) ? toolsResponse.tools : [],
        ),
      );
    } catch (error) {
      if (!destroyed) {
        const box = el('div');
        add(box, notice(aiErrorText(error), 'error'));
        drawer.open(`AI 标注 · ${pending.serverId}`, box);
      }
    } finally {
      state.aiAnnotationBusy = false;
    }
  }

  function openAnnotationPreview(draft: AnnotationDraft): void {
    const wrapper = el('div');
    setStyle(wrapper, { display: 'flex', flexDirection: 'column', gap: '16px' });
    const head = el('div', 'toolbar');
    add(
      head,
      badge(draft.serverId, 'info'),
      badge(`summary 来源 ${draft.current.summarySource ?? '未设置'}`, 'neutral'),
      draft.omittedTools > 0
        ? badge(`仅标注前 80 个工具（另有 ${formatNumber(draft.omittedTools)} 个）`, 'queue')
        : null,
    );
    add(wrapper, head);
    if (draft.warnings.length > 0) {
      const list = el('ul');
      setStyle(list, { margin: '0', paddingLeft: '20px' });
      for (const warning of draft.warnings) list.appendChild(el('li', '', warning));
      add(wrapper, list);
    }

    const summaryBox = el('input');
    summaryBox.type = 'checkbox';
    summaryBox.checked =
      draft.proposed.summary !== null &&
      draft.current.summarySource !== 'manual' &&
      draft.current.summarySource !== 'ai';
    summaryBox.disabled = draft.proposed.summary === null;
    const categoryBox = el('input');
    categoryBox.type = 'checkbox';
    categoryBox.checked =
      draft.proposed.category !== null && draft.proposed.category !== draft.current.category;
    categoryBox.disabled = draft.proposed.category === null;
    const tagsBox = el('input');
    tagsBox.type = 'checkbox';
    tagsBox.checked = draft.proposed.tags.length > 0;
    tagsBox.disabled = draft.proposed.tags.length === 0;
    const mergedTags = [...new Set([...draft.current.tags, ...draft.proposed.tags])];
    const tagsInput = input({ value: mergedTags.join(', '), placeholder: 'db, sql' });

    const summaryCurrent = el('span', 'muted', draft.current.summary ?? '—');
    const summaryProposed = el('pre', '', draft.proposed.summary ?? '—');
    setStyle(summaryProposed, {
      whiteSpace: 'pre-wrap',
      margin: '0',
      fontFamily: 'inherit',
      fontSize: '13px',
    });
    const summaryLine = el('div', 'toolbar');
    add(summaryLine, summaryBox, el('span', '', '应用 summary'), summaryCurrent, el('span', '', '→'), summaryProposed);
    const categoryLine = el('div', 'toolbar');
    add(
      categoryLine,
      categoryBox,
      el('span', '', '应用 category'),
      el('span', 'muted', draft.current.category ?? '—'),
      el('span', '', '→'),
      el('span', '', draft.proposed.category ?? '—'),
    );
    const tagsLine = el('div', 'toolbar');
    add(
      tagsLine,
      tagsBox,
      el('span', '', '应用 tags（当前 ∪ 建议）'),
      badge(`当前 ${draft.current.tags.join(', ') || '—'}`, 'neutral'),
      tagsInput,
    );
    add(wrapper, summaryLine, categoryLine, tagsLine);

    const toolControls: Array<{
      name: string;
      descriptionBox: HTMLInputElement;
      tagsBox: HTMLInputElement;
      proposedDescription: string | null;
      proposedTags: string[];
    }> = [];
    if (draft.tools.length > 0) {
      const table = el('table');
      const thead = el('thead');
      const headRow = el('tr');
      for (const label of ['工具', '当前描述', '建议描述', '建议 tags', '应用描述', '应用 tags']) {
        add(headRow, el('th', '', label));
      }
      thead.appendChild(headRow);
      const tbody = el('tbody');
      for (const tool of draft.tools) {
        const row = el('tr');
        const descriptionBox = el('input');
        descriptionBox.type = 'checkbox';
        descriptionBox.checked =
          tool.proposedDescription !== null &&
          tool.currentDescriptionSource !== 'override' &&
          tool.proposedDescription !== tool.currentDescription;
        descriptionBox.disabled = tool.proposedDescription === null;
        const toolTagsBox = el('input');
        toolTagsBox.type = 'checkbox';
        toolTagsBox.checked = tool.proposedTags.length > 0;
        toolTagsBox.disabled = tool.proposedTags.length === 0;
        toolControls.push({
          name: tool.name,
          descriptionBox,
          tagsBox: toolTagsBox,
          proposedDescription: tool.proposedDescription,
          proposedTags: tool.proposedTags,
        });
        add(
          row,
          el('td', 'mono', tool.name),
          clippedCell(tool.currentDescription ?? '—', 240),
          clippedCell(tool.proposedDescription ?? '—', 240),
          tagCell(tool.proposedTags),
          td(descriptionBox),
          td(toolTagsBox),
        );
        tbody.appendChild(row);
      }
      add(table, thead, tbody);
      add(wrapper, tablePanel(table));
    } else {
      add(wrapper, notice('本次建议没有工具级覆盖。', 'info'));
    }

    const errorLine = formError();
    const apply = button('应用标注', () => {
      setFormError(errorLine, null);
      const applyBody: Record<string, unknown> = {};
      if (summaryBox.checked && draft.proposed.summary !== null) {
        applyBody['summary'] = draft.proposed.summary;
      }
      if (categoryBox.checked && draft.proposed.category !== null) {
        applyBody['category'] = draft.proposed.category;
      }
      if (tagsBox.checked) {
        const tags = splitList(tagsInput.value);
        if (tags.length > 0) applyBody['tags'] = tags;
      }
      const overrides: Array<Record<string, unknown>> = [];
      for (const control of toolControls) {
        if (!control.descriptionBox.checked && !control.tagsBox.checked) continue;
        const entry: Record<string, unknown> = { name: control.name };
        if (control.descriptionBox.checked) entry['description'] = control.proposedDescription;
        if (control.tagsBox.checked && control.proposedTags.length > 0) {
          entry['tags'] = control.proposedTags;
        }
        overrides.push(entry);
      }
      if (overrides.length > 0) applyBody['toolOverrides'] = overrides;
      if (Object.keys(applyBody).length === 0) {
        setFormError(errorLine, '没有勾选任何要应用的字段。');
        return;
      }
      apply.disabled = true;
      apply.textContent = '应用中…';
      void context.api
        .post<{ changed: string[]; revision: number }>(
          `/ai/annotate/${encodeURIComponent(draft.serverId)}`,
          { mode: 'apply', apply: applyBody },
          {
            signal: controller.signal,
            headers: { 'If-Match': String(state.serversRevision) },
          },
        )
        .then(async (response) => {
          if (destroyed) return;
          state.serversRevision = numberOr(response.revision, state.serversRevision);
          const changed = Array.isArray(response.changed) ? response.changed : [];
          if (changed.length === 0) toast('标注没有变化。', 'info');
          else succeeded(`已应用标注：${formatNumber(changed.length)} 项变更。`);
          drawer.close();
          state.serversLoaded = false;
          state.tools = [];
          state.toolsServerId = null;
          try {
            await ensureServers(true);
            if (!destroyed) await loadAiPending();
          } catch (refreshError) {
            if (!destroyed) {
              setStatus(`标注已应用，但刷新列表失败：${describeError(refreshError)}`, 'queue');
            }
          }
          if (!destroyed) renderTab();
        })
        .catch((error: unknown) => {
          if (!destroyed) setFormError(errorLine, aiErrorText(error));
          apply.disabled = false;
          apply.textContent = '应用标注';
        });
    }, { variant: 'primary', icon: 'check' });
    const cancel = button('取消', () => drawer.close(), { variant: 'ghost' });
    const actions = el('div', 'toolbar');
    add(actions, apply, cancel);
    add(wrapper, errorLine, actions);
    drawer.open(`AI 标注 · ${draft.serverId}`, wrapper);
  }

  async function applyPendingAnnotation(pending: PendingAnnotationView): Promise<void> {
    if (
      !confirmAction(
        `直接把 ${pending.serverId} 的待处理标注写入 catalog（summary/category/tags 与全部工具覆盖）？`,
      )
    ) {
      return;
    }
    const apply: Record<string, unknown> = {};
    if (pending.proposed.summary !== null) apply['summary'] = pending.proposed.summary;
    if (pending.proposed.category !== null) apply['category'] = pending.proposed.category;
    const currentServer = serverById(pending.serverId);
    const mergedTags = [
      ...new Set([...(currentServer?.tags ?? []), ...pending.proposed.tags]),
    ];
    if (mergedTags.length > 0) apply['tags'] = mergedTags;
    const overrides = pending.proposed.toolOverrides.map((override) => {
      const entry: Record<string, unknown> = { name: override.name };
      if (override.description !== null) entry['description'] = override.description;
      if (override.tags.length > 0) entry['tags'] = override.tags;
      return entry;
    });
    if (overrides.length > 0) apply['toolOverrides'] = overrides;
    if (Object.keys(apply).length === 0) {
      setStatus('这条待处理标注没有可应用的字段；请先预览。', 'queue');
      return;
    }
    try {
      const response = await context.api.post<{ changed: string[]; revision: number }>(
        `/ai/annotate/${encodeURIComponent(pending.serverId)}`,
        { mode: 'apply', apply },
        {
          signal: controller.signal,
          headers: { 'If-Match': String(state.serversRevision) },
        },
      );
      if (destroyed) return;
      state.serversRevision = numberOr(response.revision, state.serversRevision);
      const changed = Array.isArray(response.changed) ? response.changed : [];
      if (changed.length === 0) toast('标注没有变化。', 'info');
      else succeeded(`已应用标注：${formatNumber(changed.length)} 项变更。`);
      state.serversLoaded = false;
      state.tools = [];
      state.toolsServerId = null;
      try {
        await ensureServers(true);
        if (!destroyed) await loadAiPending();
      } catch (refreshError) {
        if (!destroyed) {
          setStatus(`标注已应用，但刷新列表失败：${describeError(refreshError)}`, 'queue');
        }
      }
      if (!destroyed) renderTab();
    } catch (error) {
      if (!destroyed) setStatus(aiErrorText(error), 'error');
    }
  }

  function aiErrorText(error: unknown): string {
    if (!(error instanceof ApiError)) return describeError(error);
    const details = errorDetails(error);
    switch (error.code) {
      case 'AI_DISABLED':
        return 'AI 未启用；请先在配置卡启用并保存。';
      case 'AI_BUSY':
        return '已有 AI 任务在运行，请 1 秒后重试。';
      case 'AI_TIMEOUT':
        return `已超过配置的 timeoutMs${details?.['timeoutMs'] === undefined ? '' : `（${String(details['timeoutMs'])}ms）`}；可调大 timeoutMs 后重试。`;
      case 'AI_INPUT_EMPTY':
        return '输入不能为空。';
      case 'AI_INPUT_TOO_LARGE':
        return `输入为 ${String(details?.['actualBytes'] ?? '?')} 字节，超过上限 ${String(details?.['maxBytes'] ?? '?')} 字节。`;
      case 'AI_RUN_FAILED':
        return `Claude 运行失败：${error.message}`;
      case 'AI_BAD_ENVELOPE':
      case 'AI_INVALID_JSON':
        return `Claude 输出无法解析：${error.message}`;
      case 'AI_OUTPUT_TOO_LARGE':
        return 'Claude 输出超过 256 KiB，已拒绝。';
      case 'AI_RUNNER_UNAVAILABLE':
        return `找不到或无法启动 Claude CLI：${error.message}。请检查 claudeBin 配置。`;
      case 'AI_PROPOSAL_INVALID':
        return `草案不合法：${error.message}`;
      case 'AI_SECRET_LITERAL':
        return '草案里出现疑似字面密钥；请改用 $secret 引用。';
      case 'AI_PROPOSAL_NOT_FOUND':
        return '草图不存在或已被使用，请重新生成。';
      case 'AI_PROPOSAL_EXPIRED':
        return '草图已过期，请重新生成。';
      case 'AI_ANNOTATION_INVALID':
        return `标注结果不合法：${error.message}`;
      case 'AI_UNKNOWN_TOOL': {
        const names = details?.['names'];
        const list = Array.isArray(names) ? names.map(String).join(', ') : '未知工具';
        return `标注引用了不存在的工具：${list}；请重新预览。`;
      }
      case 'SERVER_NOT_ANNOTATABLE':
        return '该 server 不支持 AI 标注（builtin 或 seed server）。';
      case 'STDIO_CONFIRM_REQUIRED':
        return 'stdio server 需要确认命令后才能创建。';
      case 'SERVER_EXISTS':
        return `server ${String(details?.['serverId'] ?? '')} 已存在。`;
      case 'EMPTY_PATCH':
        return '没有可应用的变更。';
      case 'REVISION_CONFLICT':
        return `${error.message}；配置已被其他页面修改，请刷新后重试。`;
      default:
        return describeError(error);
    }
  }

  function alertErrorText(error: unknown): string {
    if (!(error instanceof ApiError)) return describeError(error);
    const details = errorDetails(error);
    switch (error.code) {
      case 'WEBHOOK_NOT_CONFIGURED':
        return '还没有配置 webhook；先保存一个企业微信 webhook。';
      case 'WEBHOOK_URL_INVALID':
        return `webhook URL 不合法${details?.['rule'] === undefined ? '' : `（${String(details['rule'])}）`}。`;
      case 'ALERT_TEST_THROTTLED':
        return `测试发送过于频繁；${retryAfterText(details)}。`;
      case 'REVISION_CONFLICT':
        return `${error.message}；配置已被其他页面修改，请刷新后重试。`;
      default:
        return describeError(error);
    }
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
      stopReportsPolling();
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

function errorDetails(error: ApiError): Record<string, unknown> | null {
  const details = error.details;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return null;
  return details as Record<string, unknown>;
}

function retryAfterText(details: Record<string, unknown> | null): string {
  const value = details?.['retryAfterMs'];
  return typeof value === 'number' && Number.isFinite(value)
    ? `${formatDuration(value)} 后重试`
    : '稍后重试';
}

function severityTone(severity: Severity): 'error' | 'queue' | 'info' | 'neutral' {
  if (severity === 'critical') return 'error';
  if (severity === 'high') return 'queue';
  if (severity === 'medium') return 'info';
  return 'neutral';
}

function reportStatusTone(status: ReportStatus): 'ok' | 'queue' | 'info' {
  if (status === 'closed') return 'ok';
  if (status === 'ack') return 'queue';
  return 'info';
}

function alertStateBadge(state: AlertState): HTMLSpanElement {
  const tone =
    state === 'sent'
      ? 'ok'
      : state === 'failed' || state === 'no_webhook'
        ? 'error'
        : state === 'skipped'
          ? 'queue'
          : state === 'pending' || state === 'sending'
            ? 'info'
            : 'neutral';
  return badge(state, tone);
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

/** Renders secret-backed args as the `<secret:NAME>` form accepted by {@link parseArgs}. */
function argsForEditing(args: Array<string | { $secret: string }>): string {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : `<secret:${arg.$secret}>`))
    .join('\n');
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
