/** Overview page: onboarding, attention, process, capacity, pool and active-session cards.
 *
 * The live snapshot comes from `GET /admin/api/overview`; `GET /admin/api/settings` adds
 * `strictAuth` and the capacity keys the snapshot does not cover. The onboarding and
 * attention blocks read `/servers`, `/clients`, `/alerts/config` and `/reports`; they are
 * refreshed on the first load, on manual refresh and after a short TTL, because counting
 * tools needs one request per user server.
 *
 * Capacity values prefer the snapshot: it is what the running gateway, serve runtime and
 * pool gates enforce, including the keys that have no live counter ("cold keys"). Stored
 * settings only fill the keys the snapshot omits and are marked as such.
 * @module
 */

import { ApiError } from '../lib/api.ts';
import { formatNumber, formatPercent, formatTime, type Tone } from '../lib/format.ts';
import {
  add,
  badge,
  button,
  cardSection,
  describeError,
  el,
  emptyState,
  icon,
  loading,
  notice,
  pageFrame,
  setStyle,
  startPolling,
  tabIntro,
  type PageContext,
  type PageHandle,
} from './shared.ts';

interface OverviewSnapshot {
  capacity: Record<string, number>;
  pool: { total: number; ready: number; reconnecting: number; failed: number };
  sessions: { transport: number; exec: number; inFlightEvals: number };
  servers: { total: number; enabled: number };
}

interface RuntimeSettings {
  capacity?: Record<string, number>;
  strictAuth?: boolean;
  [key: string]: unknown;
}

interface SettingsResponse {
  settings?: RuntimeSettings;
  revision?: number;
}

/** One row of `GET /servers`, reduced to what this page checks. */
interface ServerView {
  id: string;
  label: string;
  enabled: boolean;
  state: string;
  transport?: string;
  lastError?: string;
}

interface GuidanceState {
  /** User-configured servers only; the builtin seed rows are filtered out. */
  servers: ServerView[] | null;
  clientsTotal: number | null;
  toolCount: number | null;
  alerts: AttentionAlertConfig | null;
  openReports: number | null;
  openReportsHasMore: boolean;
  errors: string[];
  loadedAt: number | null;
}

const CAPACITY_LABELS: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: 'maxExecSessions', label: '执行会话', hint: '全进程上限' },
  { key: 'maxExecSessionsPerBinding', label: '每 binding 执行会话', hint: '单个客户端身份' },
  { key: 'maxWorkspacesPerMcpSession', label: '每 MCP 会话 workspace', hint: '单个传输会话' },
  { key: 'maxServeProcesses', label: 'serve 进程', hint: '必须不小于执行会话上限' },
  { key: 'maxWorkers', label: 'worker', hint: '全进程上限' },
  { key: 'maxInFlightEvalsPerExecSession', label: '每执行会话在飞 eval', hint: '异步派发后释放锁' },
  { key: 'maxInFlightEvalsPerBinding', label: '每 binding 在飞 eval', hint: '跨执行会话总量' },
  {
    key: 'maxInFlightCallsPerBindingPerServer',
    label: '每 binding × server 在飞调用',
    hint: '共享池公平性',
  },
  {
    key: 'maxQueuedCallsPerBindingPerServer',
    label: '每 binding × server 排队',
    hint: '超出返回 MCP_QUEUE_FULL',
  },
  { key: 'evictIdleMs', label: '容量淘汰空闲阈值', hint: '按 lastEvalAt 判定' },
];

const POLL_MS = 5_000;
const GUIDANCE_TTL_MS = 30_000;
const OPEN_REPORTS_LIMIT = 50;

const MANAGE_SERVERS_HREF = '#/manage?tab=servers';
const MANAGE_TOOLS_HREF = '#/manage?tab=tools';
const MANAGE_CLIENTS_HREF = '#/manage?tab=clients';
const MANAGE_ALERTS_HREF = '#/manage?tab=alerts';

const BUILTIN_SERVER_IDS: ReadonlySet<string> = new Set(['__official__', '__builtin__']);

interface Status {
  label: string;
  tone: Tone;
  valueTone?: 'error' | 'queue' | 'info';
}

interface KpiOptions {
  label: string;
  value: string;
  hint: string;
  status: string;
  statusTone: Tone;
  valueTone?: 'error' | 'queue' | 'info';
  progress?: { ratio: number; tone: 'ok' | 'queue' | 'error' };
}

// ---------------------------------------------------------------------------
// Pure guidance logic (unit-tested in test/overview-guidance.test.ts)
// ---------------------------------------------------------------------------

export type OnboardingStepId = 'servers' | 'tools' | 'clients';
export type OnboardingStatus = 'done' | 'todo' | 'unknown';

export interface OnboardingInput {
  /** User-configured servers; `null` when the list could not be read. */
  serversTotal: number | null;
  toolCount: number | null;
  clientsTotal: number | null;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStatus;
  count: number | null;
}

export interface OnboardingResult {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  allDone: boolean;
  hasUnknown: boolean;
}

function statusOf(count: number | null): OnboardingStatus {
  if (count === null) return 'unknown';
  return count > 0 ? 'done' : 'todo';
}

/** Three-step onboarding state; a `null` count stays `unknown` instead of guessing. */
export function evaluateOnboarding(input: OnboardingInput): OnboardingResult {
  const steps: OnboardingStep[] = [
    { id: 'servers', status: statusOf(input.serversTotal), count: input.serversTotal },
    { id: 'tools', status: statusOf(input.toolCount), count: input.toolCount },
    { id: 'clients', status: statusOf(input.clientsTotal), count: input.clientsTotal },
  ];
  const completed = steps.filter((step) => step.status === 'done').length;
  const hasUnknown = steps.some((step) => step.status === 'unknown');
  return {
    steps,
    completed,
    total: steps.length,
    allDone: completed === steps.length && !hasUnknown,
    hasUnknown,
  };
}

/** The two `servers` seed rows are not something an operator "接入"; skip them. */
export function isBuiltinServer(server: { id: string; transport?: string }): boolean {
  return server.transport === 'builtin' || BUILTIN_SERVER_IDS.has(server.id);
}

export type AttentionTone = 'error' | 'queue' | 'info' | 'ok';

export interface AttentionServer {
  id: string;
  label?: string;
  enabled: boolean;
  state: string;
  transport?: string;
  lastError?: string;
}

export interface AttentionAlertConfig {
  enabled: boolean;
  webhookConfigured: boolean;
}

export interface ServerSummary {
  total: number;
  enabled: number;
}

export interface AttentionInput {
  servers: readonly AttentionServer[] | null;
  /** Fallback counts from `/overview` when the detailed list is unavailable. */
  serverSummary?: ServerSummary | null;
  alerts: AttentionAlertConfig | null;
  openReports: number | null;
  openReportsHasMore?: boolean;
}

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  detail: string;
  actionLabel?: string;
  href?: string;
}

/** Derives "需要关注" rows; unavailable inputs (null) are skipped, not reported as OK. */
export function evaluateAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (input.servers !== null) {
    if (input.servers.length === 0) {
      items.push({
        id: 'servers-empty',
        tone: 'info',
        title: '还没有接入 server',
        detail: '先添加一个 MCP server，连接并在「Tools」刷新后才能发现工具。',
        actionLabel: '去接入',
        href: MANAGE_SERVERS_HREF,
      });
    } else {
      const disabled = input.servers.filter(
        (server) => !server.enabled || server.state === 'disabled',
      );
      if (disabled.length > 0) {
        items.push({
          id: 'servers-disabled',
          tone: 'queue',
          title: `${formatNumber(disabled.length)} 个 server 已停用`,
          detail: '停用的 server 不会暴露工具，也不会接新调用。',
          actionLabel: '去启用',
          href: MANAGE_SERVERS_HREF,
        });
      }

      const failed = input.servers.filter(
        (server) => server.enabled && server.state === 'failed',
      );
      if (failed.length > 0) {
        const first = failed[0];
        items.push({
          id: 'servers-failed',
          tone: 'error',
          title: `${formatNumber(failed.length)} 个 server 连接失败`,
          detail:
            first?.lastError === undefined
              ? '检查命令、URL 与凭据后重启 server。'
              : `最近的错误：${first.lastError}`,
          actionLabel: '查看并重启',
          href: MANAGE_SERVERS_HREF,
        });
      }

      const unstable = input.servers.filter(
        (server) =>
          server.enabled && (server.state === 'reconnecting' || server.state === 'degraded'),
      );
      if (unstable.length > 0) {
        items.push({
          id: 'servers-unstable',
          tone: 'queue',
          title: `${formatNumber(unstable.length)} 个 server 连接不稳定`,
          detail: '重连或降级期间，工具调用可能失败或变慢。',
          actionLabel: '查看状态',
          href: MANAGE_SERVERS_HREF,
        });
      }
    }
  } else if (input.serverSummary !== null && input.serverSummary !== undefined) {
    const disabled = input.serverSummary.total - input.serverSummary.enabled;
    if (disabled > 0) {
      items.push({
        id: 'servers-disabled-summary',
        tone: 'queue',
        title: `${formatNumber(disabled)} 个 server 已停用`,
        detail: 'server 明细暂不可用；到管理页确认哪些 server 被停用。',
        actionLabel: '去查看',
        href: MANAGE_SERVERS_HREF,
      });
    }
  }

  if (input.alerts !== null) {
    if (!input.alerts.enabled) {
      items.push({
        id: 'alerts-disabled',
        tone: 'queue',
        title: '告警未启用',
        detail: '问题报告不会通过 webhook 推送。',
        actionLabel: '去配置',
        href: MANAGE_ALERTS_HREF,
      });
    } else if (!input.alerts.webhookConfigured) {
      items.push({
        id: 'alerts-webhook-missing',
        tone: 'queue',
        title: '告警 webhook 未配置',
        detail: '告警已启用，但没有 webhook 地址，通知无法发出。',
        actionLabel: '去配置',
        href: MANAGE_ALERTS_HREF,
      });
    }
  }

  if (input.openReports !== null && input.openReports > 0) {
    items.push({
      id: 'reports-open',
      tone: 'queue',
      title: `${formatNumber(input.openReports)} 条问题报告未处理`,
      detail:
        input.openReportsHasMore === true
          ? '还有更多 open 报告；确认或关闭后才会离开列表。'
          : 'open 状态的报告需要确认或关闭。',
      actionLabel: '去处理',
      href: MANAGE_ALERTS_HREF,
    });
  }

  return items;
}

export type CapacitySource = 'effective' | 'settings';

export interface CapacityView {
  values: Record<string, number>;
  sources: Record<string, CapacitySource>;
}

function finiteNumbers(
  source: Record<string, number> | null | undefined,
): Record<string, number> {
  const values: Record<string, number> = {};
  if (source === null || source === undefined) return values;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) values[key] = value;
  }
  return values;
}

/**
 * Snapshot values win over `/settings`; the settings values fill keys the snapshot
 * omits and keep their source so the card can mark them.
 */
export function mergeCapacity(
  effective: Record<string, number> | null | undefined,
  settings: Record<string, number> | null | undefined,
): CapacityView {
  const values = finiteNumbers(settings);
  const sources: Record<string, CapacitySource> = {};
  for (const key of Object.keys(values)) sources[key] = 'settings';
  for (const [key, value] of Object.entries(finiteNumbers(effective))) {
    values[key] = value;
    sources[key] = 'effective';
  }
  return { values, sources };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function createOverviewPage(context: PageContext): PageHandle {
  const { section, body } = pageFrame(
    '概览',
    '先看「需要关注」，再看进程、容量、连接池与活跃会话；每 5 秒刷新，页面隐藏时暂停。',
  );
  const state: {
    snapshot: OverviewSnapshot | null;
    settings: RuntimeSettings | null;
    settingsError: string | null;
    error: string | null;
    lastUpdated: number | null;
    guidance: GuidanceState;
  } = {
    snapshot: null,
    settings: null,
    settingsError: null,
    error: null,
    lastUpdated: null,
    guidance: {
      servers: null,
      clientsTotal: null,
      toolCount: null,
      alerts: null,
      openReports: null,
      openReportsHasMore: false,
      errors: [],
      loadedAt: null,
    },
  };

  const banner = el('div');
  const content = el('div');
  setStyle(content, { display: 'flex', flexDirection: 'column', gap: '20px' });
  const updated = el('p', 'muted');
  setStyle(updated, { fontSize: '11.5px' });
  const refresh = button(
    '刷新',
    () => {
      void load(true);
    },
    { variant: 'secondary', size: 'sm', icon: 'refresh' },
  );
  const toolbar = el('div', 'toolbar');
  add(toolbar, refresh, el('span', 'spacer'), badge('每 5 秒自动刷新', 'neutral'), updated);

  const intro = tabIntro({
    title: '先看「需要关注」，再看实时指标',
    description:
      '页面从上到下依次是：开始使用引导、需要关注、进程与容量、连接池与运行提示。',
    hint: '颜色含义：绿色正常，蓝色提示，黄色需要处理，红色异常；实时指标每 5 秒刷新，页面隐藏时暂停。',
  });

  add(body, intro, banner, toolbar, content);
  content.replaceChildren(loading('正在读取概览…'));

  let destroyed = false;
  let guidanceInFlight = false;
  const controller = new AbortController();
  // The page rebuilds its cards on every poll; keep `<details>` open state across renders.
  const openDisclosures = new Set<string>();

  function shouldLoadGuidance(force: boolean): boolean {
    if (guidanceInFlight) return false;
    if (force) return true;
    if (state.guidance.loadedAt === null) return true;
    return Date.now() - state.guidance.loadedAt >= GUIDANCE_TTL_MS;
  }

  async function loadGuidance(): Promise<void> {
    if (guidanceInFlight || destroyed) return;
    guidanceInFlight = true;
    try {
      const [serversResult, clientsResult, alertsResult, reportsResult] = await Promise.allSettled([
        context.api.get<unknown>('/servers', { signal: controller.signal }),
        context.api.get<unknown>('/clients', { signal: controller.signal }),
        context.api.get<unknown>('/alerts/config', { signal: controller.signal }),
        context.api.get<unknown>('/reports', {
          query: { status: 'open', limit: OPEN_REPORTS_LIMIT },
          signal: controller.signal,
        }),
      ]);
      if (destroyed) return;

      const errors: string[] = [];
      const allServers = normalizeServers(settledValue(serversResult));
      const servers =
        allServers === null ? null : allServers.filter((server) => !isBuiltinServer(server));
      if (servers === null) errors.push(`server 列表${settledProblem(serversResult)}`);

      const clientsTotal = countClients(settledValue(clientsResult));
      if (clientsTotal === null) errors.push(`客户端绑定${settledProblem(clientsResult)}`);

      const alerts = normalizeAlerts(settledValue(alertsResult));
      if (alerts === null) errors.push(`告警配置${settledProblem(alertsResult)}`);

      const reports = normalizeOpenReports(settledValue(reportsResult));
      if (reports === null) errors.push(`问题报告${settledProblem(reportsResult)}`);

      let toolCount: number | null = null;
      if (servers !== null) {
        if (servers.length === 0) {
          toolCount = 0;
        } else {
          const counts = await Promise.all(servers.map((server) => fetchToolCount(server.id)));
          if (destroyed) return;
          const known = counts.filter((count): count is number => count !== null);
          if (known.length < counts.length) errors.push('部分 server 的工具目录读取失败');
          toolCount = known.length === 0 ? null : known.reduce((sum, count) => sum + count, 0);
        }
      }

      state.guidance = {
        servers,
        clientsTotal,
        toolCount,
        alerts,
        openReports: reports?.count ?? null,
        openReportsHasMore: reports?.hasMore ?? false,
        errors,
        loadedAt: Date.now(),
      };
    } finally {
      guidanceInFlight = false;
    }
  }

  async function fetchToolCount(serverId: string): Promise<number | null> {
    try {
      const response = await context.api.get<unknown>(
        `/servers/${encodeURIComponent(serverId)}/tools`,
        { signal: controller.signal },
      );
      if (!isRecord(response) || !Array.isArray(response['tools'])) return null;
      return response['tools'].length;
    } catch {
      return null;
    }
  }

  async function load(forceGuidance = false): Promise<void> {
    if (destroyed) return;
    refresh.disabled = true;
    const guidancePending = shouldLoadGuidance(forceGuidance);
    const guidanceTask = guidancePending ? loadGuidance() : Promise.resolve();
    try {
      try {
        const snapshot = await context.api.get<OverviewSnapshot>('/overview', {
          signal: controller.signal,
        });
        if (destroyed) return;
        state.snapshot = normalizeSnapshot(snapshot);
        state.error = null;
        try {
          const settings = await context.api.get<SettingsResponse>('/settings', {
            signal: controller.signal,
          });
          if (destroyed) return;
          state.settings = normalizeSettings(settings);
          state.settingsError = null;
        } catch (error) {
          if (destroyed) return;
          // Settings are optional for the counters; keep the snapshot and say why.
          state.settings = null;
          state.settingsError = describeError(error);
        }
        state.lastUpdated = Date.now();
      } catch (error) {
        if (destroyed) return;
        if (error instanceof ApiError && error.status === 0 && controller.signal.aborted) return;
        state.error = describeError(error);
      }
      if (destroyed) return;
      // Paint the live cards first; guidance may still be counting tools.
      render();
      if (guidancePending) {
        try {
          await guidanceTask;
        } catch {
          // loadGuidance records per-source errors; keep the previous guidance on a crash.
        }
        if (destroyed) return;
        render();
      }
    } finally {
      if (!destroyed) refresh.disabled = false;
    }
  }

  function unavailableState(): HTMLElement {
    const box = emptyState(
      '尚未取得概览数据。',
      '检查管理 API 是否可用后重试；也可以先去管理页确认 server 配置。',
    );
    const actions = el('div', 'toolbar');
    setStyle(actions, { justifyContent: 'center', gap: '8px' });
    add(
      actions,
      button('重试', () => void load(true), {
        variant: 'primary',
        size: 'sm',
        icon: 'refresh',
      }),
      manageLink('去管理页', MANAGE_SERVERS_HREF),
    );
    add(box, actions);
    return box;
  }

  function render(): void {
    banner.replaceChildren();
    if (state.error !== null) {
      add(banner, notice(`概览加载失败：${state.error}`, 'error'));
    }
    if (state.settingsError !== null) {
      add(
        banner,
        notice(`部分容量项读取失败（仅快照生效值可用）：${state.settingsError}`, 'queue'),
      );
    }

    if (state.snapshot === null) {
      if (state.error !== null) {
        content.replaceChildren(unavailableState());
      }
      updated.textContent = '';
      return;
    }

    updated.textContent =
      state.lastUpdated === null
        ? ''
        : `更新于 ${formatTime(state.lastUpdated)} · 数据源 /admin/api/overview`;

    const snapshot = state.snapshot;
    const capacity = mergeCapacity(snapshot.capacity, state.settings?.capacity);
    const serversTotal =
      state.guidance.servers === null ? null : state.guidance.servers.length;
    const onboarding = evaluateOnboarding({
      serversTotal,
      toolCount: state.guidance.toolCount,
      clientsTotal: state.guidance.clientsTotal,
    });
    const attention = evaluateAttention({
      servers: state.guidance.servers,
      serverSummary: snapshot.servers,
      alerts: state.guidance.alerts,
      openReports: state.guidance.openReports,
      openReportsHasMore: state.guidance.openReportsHasMore,
    });

    content.replaceChildren(
      buildOnboarding(onboarding, openDisclosures),
      buildAttention(attention, state.guidance.errors),
      buildKpis(snapshot, capacity),
      buildCapacitySection(capacity, state.settings !== null),
      buildHints(state.settings?.strictAuth),
    );
  }

  const polling = startPolling(() => load(), POLL_MS);
  void load();

  return {
    element: section,
    destroy(): void {
      destroyed = true;
      polling.stop();
      controller.abort();
      section.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Guidance data normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

function settledProblem(result: PromiseSettledResult<unknown>): string {
  return result.status === 'rejected' ? `读取失败：${describeError(result.reason)}` : '返回格式异常';
}

function normalizeServers(value: unknown): ServerView[] | null {
  if (!isRecord(value) || !Array.isArray(value['servers'])) return null;
  const servers: ServerView[] = [];
  for (const entry of value['servers']) {
    if (!isRecord(entry)) continue;
    const id = typeof entry['id'] === 'string' ? entry['id'] : '';
    if (id === '') continue;
    const transport = typeof entry['transport'] === 'string' ? entry['transport'] : undefined;
    const label = typeof entry['label'] === 'string' ? entry['label'] : id;
    const state = typeof entry['state'] === 'string' ? entry['state'] : 'unknown';
    const lastError =
      typeof entry['lastError'] === 'string' && entry['lastError'] !== ''
        ? entry['lastError']
        : undefined;
    servers.push({
      id,
      label,
      enabled: entry['enabled'] === true,
      state,
      ...(transport === undefined ? {} : { transport }),
      ...(lastError === undefined ? {} : { lastError }),
    });
  }
  return servers;
}

function countClients(value: unknown): number | null {
  if (!isRecord(value) || !Array.isArray(value['clients'])) return null;
  return value['clients'].length;
}

function normalizeAlerts(value: unknown): AttentionAlertConfig | null {
  if (!isRecord(value) || typeof value['enabled'] !== 'boolean') return null;
  const webhook = value['webhook'];
  return {
    enabled: value['enabled'],
    webhookConfigured: isRecord(webhook) && webhook['configured'] === true,
  };
}

function normalizeOpenReports(value: unknown): { count: number; hasMore: boolean } | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const cursor = value['nextCursor'];
  return {
    count: value['items'].length,
    hasMore: typeof cursor === 'string' && cursor !== '',
  };
}

// ---------------------------------------------------------------------------
// Onboarding and attention rendering
// ---------------------------------------------------------------------------

function manageLink(label: string, href: string): HTMLAnchorElement {
  const link = el('a', 'button secondary sm', label);
  link.href = href;
  return link;
}

interface StepMeta {
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  unknownDetail: string;
}

function stepMeta(id: OnboardingStepId): StepMeta {
  switch (id) {
    case 'servers':
      return {
        title: '接入一个 server',
        description: '在「管理 → Servers」新增 stdio 或 http MCP server。',
        actionLabel: '去接入',
        href: MANAGE_SERVERS_HREF,
        unknownDetail: 'server 列表暂不可用，刷新后重试。',
      };
    case 'tools':
      return {
        title: '测试连接并刷新工具',
        description: '测试 server 连接，并在「Tools」刷新工具目录。',
        actionLabel: '去测试',
        href: MANAGE_TOOLS_HREF,
        unknownDetail: '工具目录暂不可用，刷新后重试。',
      };
    case 'clients':
      return {
        title: '创建客户端 token 接入',
        description: '在「Clients」创建绑定，把一次性 token 配到客户端。',
        actionLabel: '去创建',
        href: MANAGE_CLIENTS_HREF,
        unknownDetail: '客户端绑定暂不可用，刷新后重试。',
      };
  }
}

function stepTodoDetail(id: OnboardingStepId): string {
  switch (id) {
    case 'servers':
      return '还没有注册 server。';
    case 'tools':
      return '工具数为 0；连接 server 后点「刷新工具」。';
    case 'clients':
      return '还没有客户端绑定；创建后明文 token 只显示一次。';
  }
}

function stepDoneDetail(id: OnboardingStepId, count: number | null): string {
  const amount = count === null ? '未知' : formatNumber(count);
  switch (id) {
    case 'servers':
      return `已注册 ${amount} 个 server。`;
    case 'tools':
      return `工具目录里有 ${amount} 个工具。`;
    case 'clients':
      return `已有 ${amount} 个客户端绑定。`;
  }
}

/** Keeps a disclosure open across the page's 5-second full re-render. */
function bindDisclosure(
  details: HTMLDetailsElement,
  key: string,
  openSet: Set<string>,
): void {
  details.dataset['disclosure'] = key;
  details.open = openSet.has(key);
  details.addEventListener('toggle', () => {
    if (details.open) openSet.add(key);
    else openSet.delete(key);
  });
}

function buildOnboarding(
  result: OnboardingResult,
  openSet: Set<string>,
): HTMLElement {
  if (result.allDone) return buildCompletedOnboarding(result.steps, openSet);

  const card = cardSection({
    title: '开始使用',
    subtitle: '按顺序完成三步，就能从客户端调用这里的工具。',
    icon: 'play',
    actions: badge(
      `${result.completed}/${result.total} 步已完成`,
      result.completed > 0 ? 'info' : 'neutral',
    ),
  });
  const list = el('div');
  setStyle(list, { display: 'flex', flexDirection: 'column', gap: '10px' });
  result.steps.forEach((step, index) => {
    add(
      list,
      step.status === 'done' ? doneStep(step, openSet) : pendingStep(step, index),
    );
  });
  add(card.body, list);
  return card.element;
}

/** Completed card folds to one line; the steps stay available behind the disclosure. */
function buildCompletedOnboarding(
  steps: readonly OnboardingStep[],
  openSet: Set<string>,
): HTMLElement {
  const details = el('details', 'section-group section-group-collapsible');
  bindDisclosure(details, 'onboarding', openSet);

  const summary = el('summary', 'section-group-summary');
  const check = icon('check-circle', 16);
  check.style.color = 'var(--ok)';
  const heading = el('span', 'section-group-heading');
  add(heading, el('span', 'section-group-title', '已完成初始配置'));
  const progress = el(
    'span',
    'section-group-description',
    `${steps.length}/${steps.length} 步已完成 · 展开可复习`,
  );
  add(summary, check, heading, progress);

  const list = el('div');
  setStyle(list, { display: 'flex', flexDirection: 'column', gap: '10px' });
  for (const step of steps) add(list, doneStep(step, openSet));
  const body = el('div', 'section-group-body');
  add(body, list);
  add(details, summary, body);
  return details;
}

function doneStep(step: OnboardingStep, openSet: Set<string>): HTMLElement {
  const meta = stepMeta(step.id);
  const details = el('details');
  bindDisclosure(details, `step-${step.id}`, openSet);
  setStyle(details, {
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    background: 'var(--surface-inset)',
    padding: '10px 12px',
  });

  const summary = el('summary');
  setStyle(summary, {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    cursor: 'pointer',
    listStyle: 'none',
  });
  const check = icon('check-circle', 16);
  check.style.color = 'var(--ok)';
  const title = el('span', '', meta.title);
  setStyle(title, { fontSize: '12.5px', fontWeight: '600' });
  const chevron = icon('chevron-down', 14);
  chevron.style.marginLeft = 'auto';
  chevron.style.color = 'var(--text-faint)';
  add(summary, check, title, badge('已完成', 'ok'), chevron);

  const body = el('div');
  setStyle(body, { display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 0 0 26px' });
  const description = el('p', 'muted', meta.description);
  setStyle(description, { fontSize: '12px', lineHeight: '1.55' });
  const detail = el('p', 'muted', stepDoneDetail(step.id, step.count));
  setStyle(detail, { fontSize: '12px', lineHeight: '1.55' });
  add(body, description, detail, manageLink('查看配置', meta.href));

  add(details, summary, body);
  return details;
}

function pendingStep(step: OnboardingStep, index: number): HTMLElement {
  const meta = stepMeta(step.id);
  const row = el('div');
  setStyle(row, {
    display: 'grid',
    gridTemplateColumns: '24px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    background: 'var(--surface-inset)',
  });

  const marker = el('span', '', String(index + 1));
  setStyle(marker, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    border: '1px solid var(--border-strong)',
    borderRadius: '999px',
    color: 'var(--text-muted)',
    fontSize: '11.5px',
    lineHeight: '1',
  });

  const text = el('div');
  setStyle(text, { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '0' });
  const titleRow = el('div');
  setStyle(titleRow, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
  const title = el('p', '', meta.title);
  setStyle(title, { fontSize: '12.5px', fontWeight: '600' });
  add(titleRow, title);
  if (step.status === 'unknown') {
    add(titleRow, badge('待确认', 'neutral'));
  }
  const detail = el(
    'p',
    'muted',
    step.status === 'unknown' ? meta.unknownDetail : stepTodoDetail(step.id),
  );
  setStyle(detail, { fontSize: '12px', lineHeight: '1.55' });
  add(text, titleRow, detail);

  add(row, marker, text, manageLink(meta.actionLabel, meta.href));
  return row;
}

function buildAttention(items: readonly AttentionItem[], errors: readonly string[]): HTMLElement {
  const hasError = items.some((item) => item.tone === 'error');
  const hasQueue = items.some((item) => item.tone === 'queue');
  const badgeTone: Tone =
    items.length === 0 && errors.length === 0
      ? 'ok'
      : hasError
        ? 'error'
        : hasQueue || errors.length > 0
          ? 'queue'
          : 'info';
  const badgeText =
    items.length === 0
      ? errors.length === 0
        ? '全部正常'
        : '数据不完整'
      : `${items.length} 项`;

  const card = cardSection({
    title: '需要关注',
    subtitle: '先处理这里的项，再看下面的实时指标。',
    icon: 'alert',
    actions: badge(badgeText, badgeTone),
  });

  const list = el('div');
  setStyle(list, { display: 'flex', flexDirection: 'column', gap: '8px' });
  if (items.length === 0) {
    add(
      list,
      attentionRow(
        errors.length === 0
          ? {
              id: 'attention-ok',
              tone: 'ok',
              title: '暂无需要关注的问题',
              detail: 'server 状态、告警开关与问题报告均未发现异常。',
            }
          : {
              id: 'attention-unknown',
              tone: 'info',
              title: '检查数据不完整',
              detail: '部分来源读取失败，刷新后重试；已读取到的来源未发现异常。',
            },
      ),
    );
  } else {
    for (const item of items) add(list, attentionRow(item));
  }
  add(card.body, list);

  if (errors.length > 0) {
    const note = el('p', 'muted', `部分数据读取失败，已跳过对应检查：${errors.join('；')}`);
    setStyle(note, { fontSize: '11.5px', lineHeight: '1.55' });
    add(card.body, note);
  }
  return card.element;
}

function attentionRow(item: AttentionItem): HTMLElement {
  const row = el('div');
  setStyle(row, {
    display: 'grid',
    gridTemplateColumns: '20px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    background: 'var(--surface-inset)',
  });

  const glyph = icon(
    item.tone === 'ok' ? 'check-circle' : item.tone === 'info' ? 'info' : 'alert',
    16,
  );
  glyph.style.color = `var(--${item.tone})`;

  const text = el('div');
  setStyle(text, { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' });
  const title = el('p', '', item.title);
  setStyle(title, { fontSize: '12.5px', fontWeight: '600' });
  const detail = el('p', 'muted', item.detail);
  setStyle(detail, { fontSize: '12px', lineHeight: '1.55' });
  add(text, title, detail);

  add(
    row,
    glyph,
    text,
    item.href !== undefined && item.actionLabel !== undefined
      ? manageLink(item.actionLabel, item.href)
      : el('span'),
  );
  return row;
}

// ---------------------------------------------------------------------------
// Snapshot normalization
// ---------------------------------------------------------------------------

function normalizeSnapshot(value: OverviewSnapshot): OverviewSnapshot {
  const capacity: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value.capacity ?? {})) {
    if (typeof entry === 'number' && Number.isFinite(entry)) capacity[key] = entry;
  }
  return {
    capacity,
    pool: {
      total: numberOrZero(value.pool?.total),
      ready: numberOrZero(value.pool?.ready),
      reconnecting: numberOrZero(value.pool?.reconnecting),
      failed: numberOrZero(value.pool?.failed),
    },
    sessions: {
      transport: numberOrZero(value.sessions?.transport),
      exec: numberOrZero(value.sessions?.exec),
      inFlightEvals: numberOrZero(value.sessions?.inFlightEvals),
    },
    servers: {
      total: numberOrZero(value.servers?.total),
      enabled: numberOrZero(value.servers?.enabled),
    },
  };
}

function normalizeSettings(response: SettingsResponse): RuntimeSettings {
  const raw = response.settings ?? {};
  const capacity: Record<string, number> = {};
  for (const [key, entry] of Object.entries(raw.capacity ?? {})) {
    if (typeof entry === 'number' && Number.isFinite(entry)) capacity[key] = entry;
  }
  return { ...raw, capacity };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Live metric cards
// ---------------------------------------------------------------------------

function buildKpis(snapshot: OverviewSnapshot, capacity: CapacityView): HTMLElement {
  const grid = el('div', 'card-grid');
  const execLimit = capacity.values['maxExecSessions'];
  const evalLimit = capacity.values['maxInFlightEvalsPerExecSession'];
  const execLimitSource = capacity.sources['maxExecSessions'];
  const sessionTotal = snapshot.sessions.transport + snapshot.sessions.exec;
  const execRatio =
    execLimit !== undefined && execLimit > 0 ? snapshot.sessions.exec / execLimit : null;

  const server = serverStatus(snapshot.servers);
  const capacityState = capacityStatus(execLimit, execRatio);
  const pool = poolStatus(snapshot.pool);
  const session = sessionStatus(snapshot, sessionTotal);

  const capacityHint =
    execLimit === undefined
      ? '执行会话占用（上限不可用）'
      : execRatio === null
        ? '执行会话占用；上限为 0'
        : `占用 ${formatPercent(execRatio, 0)} · 上限来自 ${
            execLimitSource === 'settings' ? '/settings 设置值' : '/overview 生效值'
          }`;

  const sessionHint = [
    `传输 ${formatNumber(snapshot.sessions.transport)}`,
    `执行 ${formatNumber(snapshot.sessions.exec)}`,
    `在飞 eval ${formatNumber(snapshot.sessions.inFlightEvals)}`,
  ];
  if (evalLimit !== undefined) sessionHint.push(`每会话上限 ${formatNumber(evalLimit)}`);

  add(
    grid,
    kpiCard({
      label: '进程 / 服务',
      value: `${formatNumber(snapshot.servers.enabled)} / ${formatNumber(snapshot.servers.total)}`,
      hint: `已启用 ${formatNumber(snapshot.servers.enabled)} · 已注册 ${formatNumber(snapshot.servers.total)} · 池连接 ${formatNumber(snapshot.pool.total)}`,
      status: server.label,
      statusTone: server.tone,
      valueTone: server.valueTone,
    }),
    kpiCard({
      label: '容量占用',
      value:
        execLimit === undefined
          ? formatNumber(snapshot.sessions.exec)
          : `${formatNumber(snapshot.sessions.exec)} / ${formatNumber(execLimit)}`,
      hint: capacityHint,
      status: capacityState.label,
      statusTone: capacityState.tone,
      valueTone: capacityState.valueTone,
      progress:
        execRatio === null
          ? undefined
          : {
              ratio: execRatio,
              tone: execRatio >= 1 ? 'error' : execRatio >= 0.8 ? 'queue' : 'ok',
            },
    }),
    kpiCard({
      label: '连接池',
      value: `${formatNumber(snapshot.pool.ready)} / ${formatNumber(snapshot.pool.total)}`,
      hint: `ready ${formatNumber(snapshot.pool.ready)} · reconnecting ${formatNumber(snapshot.pool.reconnecting)} · failed ${formatNumber(snapshot.pool.failed)}`,
      status: pool.label,
      statusTone: pool.tone,
      valueTone: pool.valueTone,
    }),
    kpiCard({
      label: '活跃会话',
      value: formatNumber(sessionTotal),
      hint: sessionHint.join(' · '),
      status: session.label,
      statusTone: session.tone,
    }),
  );
  return grid;
}

function serverStatus(servers: OverviewSnapshot['servers']): Status {
  if (servers.total === 0) return { label: '无服务', tone: 'neutral' };
  if (servers.enabled === 0) return { label: '全部停用', tone: 'queue', valueTone: 'queue' };
  if (servers.enabled < servers.total) return { label: '部分启用', tone: 'info' };
  return { label: '全部启用', tone: 'ok' };
}

function capacityStatus(execLimit: number | undefined, ratio: number | null): Status {
  if (execLimit === undefined) return { label: '上限未知', tone: 'neutral' };
  if (ratio === null) return { label: '上限为 0', tone: 'queue', valueTone: 'queue' };
  if (ratio >= 1) return { label: '已满', tone: 'error', valueTone: 'error' };
  if (ratio >= 0.8) return { label: '接近上限', tone: 'queue', valueTone: 'queue' };
  return { label: '充裕', tone: 'ok' };
}

function poolStatus(pool: OverviewSnapshot['pool']): Status {
  if (pool.total === 0) return { label: '无连接', tone: 'neutral' };
  if (pool.failed > 0) return { label: '有失败', tone: 'error', valueTone: 'error' };
  if (pool.reconnecting > 0) return { label: '重连中', tone: 'queue', valueTone: 'queue' };
  if (pool.ready < pool.total) return { label: '部分就绪', tone: 'info' };
  return { label: '全部就绪', tone: 'ok' };
}

function sessionStatus(snapshot: OverviewSnapshot, total: number): Status {
  if (total === 0) return { label: '空闲', tone: 'neutral' };
  if (snapshot.sessions.inFlightEvals > 0) return { label: '有在飞 eval', tone: 'info' };
  return { label: '活跃', tone: 'ok' };
}

function kpiCard(options: KpiOptions): HTMLElement {
  const card = el('article', 'card stat-card');
  card.dataset['tone'] = options.valueTone ?? 'neutral';
  const head = el('div', 'stat-head');
  add(
    head,
    el('p', 'eyebrow stat-label', options.label),
    badge(options.status, options.statusTone),
  );
  add(
    card,
    head,
    el('strong', 'stat-value', options.value),
    el('p', 'stat-hint', options.hint),
  );
  if (options.progress !== undefined) {
    add(card, progressBar(options.progress.ratio, options.progress.tone));
  }
  return card;
}

/** Thin capsule meter for the capacity KPI; the track stays visible when usage is low. */
function progressBar(ratio: number, tone: 'ok' | 'queue' | 'error'): HTMLElement {
  const clamped = Math.max(0, Math.min(1, ratio));
  const percent = Math.round(clamped * 100);
  const track = el('div');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', '执行会话容量占用');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(percent));
  setStyle(track, {
    position: 'relative',
    zIndex: '1',
    height: '4px',
    marginTop: '4px',
    borderRadius: '999px',
    background: 'var(--surface-strong)',
    overflow: 'hidden',
  });
  const fill = el('div');
  setStyle(fill, {
    width: `${clamped * 100}%`,
    height: '100%',
    borderRadius: 'inherit',
    background:
      tone === 'error'
        ? 'var(--error)'
        : tone === 'queue'
          ? 'var(--queue)'
          : 'var(--gradient)',
    transition: 'width 150ms ease-out',
  });
  track.appendChild(fill);
  return track;
}

// ---------------------------------------------------------------------------
// Capacity and runtime hints
// ---------------------------------------------------------------------------

function buildCapacitySection(
  capacity: CapacityView,
  settingsAvailable: boolean,
): HTMLElement {
  const settingsCount = Object.values(capacity.sources).filter(
    (source) => source === 'settings',
  ).length;
  const stateLabel = !settingsAvailable
    ? '仅快照生效值'
    : settingsCount > 0
      ? `${settingsCount} 项来自设置`
      : '全部为生效值';

  const card = cardSection({
    title: '容量生效值',
    subtitle:
      '以 /overview 快照为准（运行时实际生效值）；快照未覆盖的项用 /settings 设置值补齐并标注。',
    icon: 'layers',
    actions: badge(
      stateLabel,
      !settingsAvailable ? 'queue' : settingsCount === 0 ? 'ok' : 'neutral',
    ),
  });
  const grid = el('div');
  setStyle(grid, {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, max(300px, 45%)), 1fr))',
    gap: '12px',
  });
  for (const entry of CAPACITY_LABELS) {
    add(
      grid,
      capacityItem(entry, capacity.values[entry.key], capacity.sources[entry.key]),
    );
  }
  add(card.body, grid);
  return card.element;
}

function capacityItem(
  entry: { key: string; label: string; hint: string },
  value: number | undefined,
  source: CapacitySource | undefined,
): HTMLElement {
  const item = el('article', 'card');
  setStyle(item, {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px 14px',
    minWidth: '0',
  });

  const top = el('div');
  setStyle(top, {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
  });
  const names = el('div');
  setStyle(names, { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '0' });
  const label = el('p', '', entry.label);
  setStyle(label, { color: 'var(--text)', fontSize: '12.5px', fontWeight: '550' });
  const key = el('code', '', entry.key);
  key.title = entry.key;
  setStyle(key, {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  add(names, label, key);

  const meta = el('div');
  setStyle(meta, { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' });
  const amount = el('strong', '', value === undefined ? '—' : formatNumber(value));
  setStyle(amount, {
    fontSize: '20px',
    fontWeight: '650',
    lineHeight: '1.2',
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
  });
  add(meta, amount);
  if (source === 'settings') add(meta, badge('设置值', 'neutral'));
  else if (source === undefined) add(meta, badge('不可用', 'neutral'));
  add(top, names, meta);

  const hint = el('p', 'muted', entry.hint);
  setStyle(hint, { fontSize: '11.5px', lineHeight: '1.5' });
  add(item, top, hint);
  return item;
}

function buildHints(strictAuth: boolean | undefined): HTMLElement {
  const card = cardSection({
    title: '运行提示',
    subtitle: '鉴权、淘汰与连接状态的关键约定。',
    icon: 'info',
  });
  const list = el('div');
  setStyle(list, { display: 'flex', flexDirection: 'column', gap: '10px' });

  const authTitle =
    strictAuth === undefined
      ? '鉴权模式未知'
      : strictAuth
        ? '严格鉴权模式'
        : '宽松鉴权模式';
  const authDetail =
    strictAuth === undefined
      ? '/mcp 默认宽松，未知 token 仍返回 401。'
      : strictAuth
        ? '未带 token 的 /mcp 请求直接 401。'
        : '未带 token 记为 unbound；未知或格式错的 token 仍返回 401。';

  add(
    list,
    infoCard('shield', authTitle, authDetail, strictAuth === true ? 'queue' : 'info'),
    infoCard(
      'clock',
      '容量淘汰',
      '按 lastEvalAt 判定，只回收无在飞 eval 且空闲超过 evictIdleMs 的执行会话。',
      'info',
    ),
    infoCard(
      'layers',
      '连接与 catalog',
      '连接状态是实时的，catalog 在 eval 开始时快照；两者不一致时按“暂时不可用”处理。',
      'info',
    ),
  );
  add(card.body, list);
  return card.element;
}

function infoCard(iconName: string, title: string, detail: string, tone: Tone): HTMLElement {
  const row = el('div');
  setStyle(row, {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '12px 14px',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    background: 'var(--surface-inset)',
  });
  const glyph = icon(iconName, 16);
  glyph.style.marginTop = '1px';
  glyph.style.color = tone === 'neutral' ? 'var(--text-faint)' : `var(--${tone})`;
  const text = el('div');
  setStyle(text, { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' });
  const heading = el('p', '', title);
  setStyle(heading, { fontSize: '12.5px', fontWeight: '600' });
  const detailLine = el('p', 'muted', detail);
  setStyle(detailLine, { fontSize: '12px', lineHeight: '1.55' });
  add(text, heading, detailLine);
  add(row, glyph, text);
  return row;
}
