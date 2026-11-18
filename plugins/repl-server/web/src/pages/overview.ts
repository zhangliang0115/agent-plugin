/** Overview page: process, capacity, pool and active-session cards (RS-20, 03 §4.2).
 *
 * Data comes from `GET /admin/api/overview` and `GET /admin/api/settings`. The snapshot
 * endpoint is cheap, so the page refreshes it on an interval and pauses while the tab is
 * hidden. Capacity limits are rendered next to the live counters; a missing settings
 * endpoint leaves the counters visible with an explicit "limits unavailable" note.
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

export function createOverviewPage(context: PageContext): PageHandle {
  const { section, body } = pageFrame('概览', '进程、容量、连接池与活跃会话；每 5 秒刷新，页面隐藏时暂停。');
  const state: {
    snapshot: OverviewSnapshot | null;
    settings: RuntimeSettings | null;
    settingsError: string | null;
    error: string | null;
    lastUpdated: number | null;
  } = {
    snapshot: null,
    settings: null,
    settingsError: null,
    error: null,
    lastUpdated: null,
  };

  const banner = el('div');
  const content = el('div');
  setStyle(content, { display: 'flex', flexDirection: 'column', gap: '20px' });
  const updated = el('p', 'muted');
  setStyle(updated, { fontSize: '11.5px' });
  const refresh = button(
    '刷新',
    () => {
      void load();
    },
    { variant: 'secondary', size: 'sm', icon: 'refresh' },
  );
  const toolbar = el('div', 'toolbar');
  add(toolbar, refresh, el('span', 'spacer'), badge('每 5 秒自动刷新', 'neutral'), updated);

  add(body, banner, toolbar, content);
  content.replaceChildren(loading('正在读取概览…'));

  let destroyed = false;
  const controller = new AbortController();

  async function load(): Promise<void> {
    if (destroyed) return;
    refresh.disabled = true;
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
      render();
    } catch (error) {
      if (destroyed) return;
      if (error instanceof ApiError && error.status === 0 && controller.signal.aborted) return;
      state.error = describeError(error);
      render();
    } finally {
      if (!destroyed) refresh.disabled = false;
    }
  }

  function render(): void {
    banner.replaceChildren();
    if (state.error !== null) {
      add(banner, notice(`概览加载失败：${state.error}`, 'error'));
    }
    if (state.settingsError !== null) {
      add(
        banner,
        notice(`容量上限读取失败（卡片只显示实时计数）：${state.settingsError}`, 'queue'),
      );
    }

    if (state.snapshot === null) {
      if (state.error !== null) {
        content.replaceChildren(
          emptyState('尚未取得概览数据。', '检查管理 API 是否可用后重试。'),
        );
      }
      updated.textContent = '';
      return;
    }

    updated.textContent =
      state.lastUpdated === null
        ? ''
        : `更新于 ${formatTime(state.lastUpdated)} · 数据源 /admin/api/overview`;

    const settingsAvailable = state.settings !== null;
    const capacity = state.settings?.capacity ?? state.snapshot.capacity;
    content.replaceChildren(
      buildKpis(state.snapshot, capacity, settingsAvailable),
      buildCapacitySection(capacity, !settingsAvailable),
      buildHints(state.settings?.strictAuth),
    );
  }

  const polling = startPolling(load, POLL_MS);
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

function buildKpis(
  snapshot: OverviewSnapshot,
  capacity: Record<string, number>,
  settingsAvailable: boolean,
): HTMLElement {
  const grid = el('div', 'card-grid');
  const execLimit = capacity['maxExecSessions'];
  const evalLimit = capacity['maxInFlightEvalsPerExecSession'];
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
        : `占用 ${formatPercent(execRatio, 0)} · 上限来自 ${settingsAvailable ? '/settings' : '快照'}`;

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

function buildCapacitySection(
  capacity: Record<string, number>,
  fromSnapshot: boolean,
): HTMLElement {
  const card = cardSection({
    title: '容量默认值',
    subtitle: '每项为运行时上限，并标注其作用范围。',
    icon: 'layers',
    actions: badge(
      fromSnapshot ? '来自快照' : '来自 /settings',
      fromSnapshot ? 'queue' : 'neutral',
    ),
  });
  const grid = el('div');
  setStyle(grid, {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, max(300px, 45%)), 1fr))',
    gap: '12px',
  });
  for (const entry of CAPACITY_LABELS) {
    add(grid, capacityItem(entry, capacity[entry.key]));
  }
  add(card.body, grid);
  return card.element;
}

function capacityItem(
  entry: { key: string; label: string; hint: string },
  value: number | undefined,
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

  const amount = el('strong', '', value === undefined ? '—' : formatNumber(value));
  setStyle(amount, {
    flex: '0 0 auto',
    fontSize: '20px',
    fontWeight: '650',
    lineHeight: '1.2',
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
  });
  add(top, names, amount);

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
