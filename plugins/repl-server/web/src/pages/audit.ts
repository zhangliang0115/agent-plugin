/** Audit page: filter toolbar, KPI stat row, trend, virtual call table, call drawer with
 * eval gantt and side-by-side protocol frames (RS-18, 03 §4.6–4.7).
 *
 * All data comes from `/admin/api/audit/*` through the typed API client. The live view
 * polls through that client (so token and same-origin rules stay in one place), batches
 * incoming events for {@link BATCH_MS} before touching the DOM, keeps at most
 * {@link MAX_EVENTS} events in a ring buffer, and pauses polling plus rendering while
 * the document is hidden. Rendering is throttled to roughly 30 fps.
 *
 * The table is a virtual scroller keyed by event identity: only the visible rows exist in
 * the DOM, so a full 5000-event buffer costs the same as one viewport. Export streams the
 * applied filter as JSONL through the same client.
 *
 * Audit events are intentionally typed loosely: the JSONL schema grows per event type,
 * and the page must still render unfamiliar fields instead of dropping the row.
 * @module
 */

import {
  durationTone,
  formatBytes,
  formatDuration,
  formatId,
  formatJson,
  formatNumber,
  formatPercent,
  formatTime,
  formatTimestamp,
  statusTone,
} from '../lib/format.ts';
import {
  add,
  badge,
  button,
  cardSection,
  copyButton,
  createDrawer,
  definitionList,
  describeError,
  el,
  emptyState,
  field,
  icon,
  loading,
  notice,
  onVisibilityChange,
  pageFrame,
  selectControl,
  setStyle,
  startPolling,
  statCard,
  switchControl,
  textInput,
  toast,
  type NoticeTone,
  type PageContext,
  type PageHandle,
} from './shared.ts';

// ---------------------------------------------------------------------------
// Wire shapes (03 §4.6)
// ---------------------------------------------------------------------------

interface AuditEvent {
  ts?: string;
  event?: string;
  [key: string]: unknown;
}

interface AuditQueryResponse {
  events: AuditEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface AuditStats {
  snapshotId: string;
  computedAt: string;
  cached: boolean;
  tookMs: number;
  calls: number;
  errors: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
  queueAvgMs: number | null;
  scannedRows?: number;
}

interface TraceResponse {
  exec: string;
  evalId: number;
  events: AuditEvent[];
  count: number;
}

interface ProtocolFramePair {
  mcp: string;
  id: string | number | null;
  method: string | null;
  request: AuditEvent | null;
  response: AuditEvent | null;
  durMs?: number;
  ok?: boolean;
}

interface FramesResponse {
  detail: string;
  frames: ProtocolFramePair[];
  hasMore?: boolean;
  droppedFrames?: number;
}

interface Filters {
  from: string;
  to: string;
  event: string;
  client: string;
  binding: string;
  tool: string;
  server: string;
  status: string;
  minMs: string;
  live: boolean;
}

interface Bucket {
  start: number;
  ok: number;
  error: number;
  timeout: number;
  queueSum: number;
  queueCount: number;
}

interface GanttSpan {
  label: string;
  start: number;
  queueMs: number;
  ms: number;
  end: number;
  ok: boolean | null;
}

interface ListView {
  count: HTMLElement;
  badges: HTMLElement;
  viewport: HTMLElement;
  spacer: HTMLElement;
  paint(): void;
}

interface FilterControls {
  from: HTMLInputElement;
  to: HTMLInputElement;
  eventType: HTMLSelectElement;
  status: HTMLSelectElement;
  client: HTMLInputElement;
  binding: HTMLInputElement;
  tool: HTMLInputElement;
  server: HTMLInputElement;
  minMs: HTMLInputElement;
  live: HTMLInputElement;
}

interface CellOptions {
  mono?: boolean;
  align?: 'right';
  title?: string;
}

interface Column {
  key: string;
  label: string;
  flex: number;
  align?: 'right';
  mono?: boolean;
}

const MAX_EVENTS = 5_000;
const BATCH_MS = 200;
const RENDER_FRAME_MS = 33;
const PAGE_SIZE = 400;
const POLL_MS = 2_000;
const STATS_EVERY_TICKS = 5;
const ROW_HEIGHT = 32;
const TREND_BUCKETS = 32;
const SLOW_MS = 1_000;
const FRAME_LIMIT = 20;

const RANGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '15', label: '最近 15 分钟' },
  { value: '60', label: '最近 1 小时' },
  { value: '360', label: '最近 6 小时' },
  { value: '1440', label: '最近 24 小时' },
  { value: '10080', label: '最近 7 天' },
  { value: '', label: '自定义时间' },
];

const DEFAULT_RANGE = '60';

const EVENT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部事件' },
  { value: 'tool_call', label: 'tool_call' },
  { value: 'tool_result', label: 'tool_result' },
  { value: 'tool_denied', label: 'tool_denied' },
  { value: 'eval_start', label: 'eval_start' },
  { value: 'eval_end', label: 'eval_end' },
  { value: 'exec_start', label: 'exec_start' },
  { value: 'exec_end', label: 'exec_end' },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'ok', label: 'ok' },
  { value: 'error', label: 'error' },
  { value: 'timeout', label: 'timeout' },
];

const COLUMNS: ReadonlyArray<Column> = [
  { key: 'time', label: '时间', flex: 1.15 },
  { key: 'client', label: '客户端 / binding', flex: 1.5 },
  { key: 'tool', label: '工具 / 方法', flex: 1.75, mono: true },
  { key: 'mode', label: '模式', flex: 0.75 },
  { key: 'queue', label: 'queueMs', flex: 0.8, align: 'right' },
  { key: 'ms', label: 'ms', flex: 0.75, align: 'right' },
  { key: 'status', label: '状态', flex: 0.8 },
  { key: 'eval', label: 'exec / eval', flex: 1.35, mono: true },
];

export function createAuditPage(context: PageContext): PageHandle {
  const { section, body } = pageFrame(
    '审计',
    '调用列表、eval 轨迹与协议帧；筛选在服务端流式完成，实时视图最多保留 5000 条。',
  );

  const initialFrom = toDateTimeLocal(Date.now() - 3_600_000);
  const state = {
    filters: {
      from: initialFrom,
      to: '',
      event: '',
      client: '',
      binding: '',
      tool: '',
      server: '',
      status: '',
      minMs: '',
      live: true,
    } as Filters,
    events: [] as AuditEvent[],
    seen: new Set<string>(),
    pending: [] as AuditEvent[],
    cursor: null as string | null,
    hasMore: false,
    truncated: false,
    loading: true,
    loadingMore: false,
    exporting: false,
    error: null as string | null,
    stats: null as AuditStats | null,
    statsError: null as string | null,
    notice: null as { text: string; tone: NoticeTone } | null,
    drawer: null as AuditEvent | null,
  };

  let destroyed = false;
  let loadToken = 0;
  let statsToken = 0;
  let pollTicks = 0;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let paintFrame: number | null = null;
  let lastRenderAt = 0;
  let drawerTicket = 0;
  const controller = new AbortController();

  const banner = el('div');
  const pendingKeys = new Set<string>();
  let listView: ListView | null = null;
  let filterControls: FilterControls;
  const filterCard = buildFilterCard();
  const statsHost = el('div');
  const trendHost = el('div');
  const listHost = el('div');
  const listFooter = el('div', 'toolbar');
  const drawer = createDrawer();

  add(body, statsHost, filterCard, banner, trendHost, listHost, listFooter);
  filterCard.addEventListener('submit', (event) => {
    event.preventDefault();
    applyFilters();
  });

  // -------------------------------------------------------------------------
  // Filters
  // -------------------------------------------------------------------------

  function buildFilterCard(): HTMLFormElement {
    const card = el('form', 'card');
    card.noValidate = true;
    setStyle(card, {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      padding: '16px 18px',
    });

    const range = selectControl(RANGE_OPTIONS, { value: DEFAULT_RANGE, ariaLabel: '时间范围' });
    const from = textInput({ type: 'datetime-local', value: state.filters.from });
    const to = textInput({ type: 'datetime-local', value: state.filters.to });
    const eventType = selectControl(EVENT_OPTIONS, {
      value: state.filters.event,
      ariaLabel: '事件类型',
    });
    const status = selectControl(STATUS_OPTIONS, {
      value: state.filters.status,
      ariaLabel: '状态',
    });
    const search = textInput({
      type: 'search',
      value: state.filters.tool,
      placeholder: '工具名（精确匹配）',
      ariaLabel: '按工具名搜索',
      autocomplete: 'off',
      spellcheck: false,
    });
    const client = textInput({
      value: state.filters.client,
      placeholder: 'claude-code/2.1.327',
      ariaLabel: '客户端',
      autocomplete: 'off',
    });
    const binding = textInput({
      value: state.filters.binding,
      placeholder: 'cb_…',
      ariaLabel: 'binding',
      autocomplete: 'off',
    });
    const server = textInput({
      value: state.filters.server,
      placeholder: 'server id',
      ariaLabel: 'server',
      autocomplete: 'off',
    });
    const minMs = textInput({
      type: 'number',
      value: state.filters.minMs,
      min: '0',
      placeholder: '0',
      ariaLabel: '最小耗时 ms',
    });

    const live = switchControl({
      checked: state.filters.live,
      label: '实时',
      onChange: (checked) => {
        state.filters.live = checked;
        scheduleRender();
      },
    });

    const searchBox = el('div');
    setStyle(searchBox, { position: 'relative' });
    const searchIcon = icon('search', 14);
    searchIcon.style.position = 'absolute';
    searchIcon.style.top = '50%';
    searchIcon.style.left = '10px';
    searchIcon.style.color = 'var(--text-faint)';
    searchIcon.style.transform = 'translateY(-50%)';
    searchIcon.style.pointerEvents = 'none';
    setStyle(search, { paddingLeft: '30px' });
    add(searchBox, searchIcon, search);

    const advanced = el('div', 'toolbar');
    advanced.hidden = true;
    const more = button(
      '更多筛选',
      () => {
        setAdvanced(advanced.hidden === true);
      },
      { variant: 'ghost', size: 'sm', icon: 'filter' },
    );
    more.setAttribute('aria-expanded', 'false');
    more.title = '展开更多筛选';

    function setAdvanced(open: boolean): void {
      advanced.hidden = !open;
      more.setAttribute('aria-expanded', String(open));
      more.title = open ? '收起更多筛选' : '展开更多筛选';
    }

    const apply = button('应用', () => undefined, {
      type: 'submit',
      variant: 'primary',
      icon: 'check',
    });
    const reset = button('重置', () => {
      const now = Date.now();
      state.filters = {
        from: toDateTimeLocal(now - 3_600_000),
        to: '',
        event: '',
        client: '',
        binding: '',
        tool: '',
        server: '',
        status: '',
        minMs: '',
        live: true,
      };
      range.value = DEFAULT_RANGE;
      from.value = state.filters.from;
      to.value = '';
      eventType.value = '';
      status.value = '';
      search.value = '';
      client.value = '';
      binding.value = '';
      server.value = '';
      minMs.value = '';
      live.input.checked = true;
      setAdvanced(false);
      applyFilters();
    }, { variant: 'secondary', icon: 'refresh' });

    const head = el('div', 'toolbar');
    add(head, el('p', 'eyebrow', '筛选'), el('span', 'spacer'), more);

    const primary = el('div', 'toolbar');
    add(
      primary,
      flexibleField('时间范围', range, '0 0 168px'),
      flexibleField('事件类型', eventType, '0 0 158px'),
      flexibleField('状态', status, '0 0 128px'),
      flexibleField('搜索工具', searchBox, '1 1 240px'),
      el('span', 'spacer'),
      live,
      apply,
      reset,
    );

    const secondary = el('div', 'toolbar');
    add(
      secondary,
      flexibleField('从', from, '1 1 190px'),
      flexibleField('到（留空=至今）', to, '1 1 190px'),
      flexibleField('client', client, '1 1 150px'),
      flexibleField('binding', binding, '1 1 150px'),
      flexibleField('server', server, '1 1 150px'),
      flexibleField('minMs', minMs, '1 1 120px'),
    );
    advanced.appendChild(secondary);

    range.addEventListener('change', () => {
      const minutes = Number(range.value);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        setAdvanced(true);
        return;
      }
      from.value = toDateTimeLocal(Date.now() - minutes * 60_000);
      to.value = '';
      applyFilters();
    });
    from.addEventListener('change', () => {
      range.value = '';
    });
    to.addEventListener('change', () => {
      range.value = '';
    });

    add(card, head, primary, advanced);
    card.dataset['from'] = 'audit-filter';
    filterControls = {
      from,
      to,
      eventType,
      status,
      client,
      binding,
      tool: search,
      server,
      minMs,
      live: live.input,
    };
    return card;
  }

  function flexibleField(labelText: string, control: HTMLElement, flex: string): HTMLLabelElement {
    const wrapper = field(labelText, control);
    setStyle(wrapper, { flex, minWidth: '0' });
    return wrapper;
  }

  function applyFilters(): void {
    const controls = filterControls;
    state.filters = {
      from: controls.from.value,
      to: controls.to.value,
      event: controls.eventType.value,
      client: controls.client.value,
      binding: controls.binding.value,
      tool: controls.tool.value,
      server: controls.server.value,
      status: controls.status.value,
      minMs: controls.minMs.value,
      live: controls.live.checked,
    };
    state.events = [];
    state.seen.clear();
    state.pending = [];
    pendingKeys.clear();
    state.cursor = null;
    state.hasMore = false;
    state.truncated = false;
    state.loading = true;
    state.loadingMore = false;
    state.error = null;
    state.notice = null;
    state.stats = null;
    state.statsError = null;
    invalidateList();
    loadToken += 1;
    statsToken += 1;
    if (batchTimer !== null) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    renderBanner();
    renderNow();
    void loadFirstPage(loadToken);
    void loadStats();
  }

  function filterQuery(): Record<string, string | number | undefined> {
    const filters = state.filters;
    return {
      from: toIso(filters.from),
      to: toIso(filters.to),
      event: emptyToUndefined(filters.event),
      client: emptyToUndefined(filters.client),
      binding: emptyToUndefined(filters.binding),
      tool: emptyToUndefined(filters.tool),
      server: emptyToUndefined(filters.server),
      status: emptyToUndefined(filters.status),
      minMs: emptyToUndefined(filters.minMs),
    };
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async function loadFirstPage(token: number): Promise<void> {
    try {
      const response = await context.api.get<AuditQueryResponse>('/audit/query', {
        query: { ...filterQuery(), limit: PAGE_SIZE },
        signal: controller.signal,
      });
      if (destroyed || token !== loadToken) return;
      state.events = [];
      state.seen.clear();
      state.pending = [];
      appendEvents(Array.isArray(response.events) ? response.events : []);
      state.cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
      state.hasMore = response.hasMore === true;
      state.loading = false;
      state.error = null;
      renderBanner();
      renderNow();
      scheduleRender();
    } catch (error) {
      if (destroyed || token !== loadToken) return;
      if (controller.signal.aborted) return;
      state.loading = false;
      state.error = describeError(error);
      renderBanner();
      renderNow();
    }
  }

  async function loadMore(): Promise<void> {
    if (state.loadingMore || state.cursor === null) return;
    const token = loadToken;
    state.loadingMore = true;
    renderFooter();
    try {
      const response = await context.api.get<AuditQueryResponse>('/audit/query', {
        query: { ...filterQuery(), limit: PAGE_SIZE, cursor: state.cursor },
        signal: controller.signal,
      });
      if (destroyed || token !== loadToken) return;
      appendEvents(Array.isArray(response.events) ? response.events : []);
      state.cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
      state.hasMore = response.hasMore === true;
      state.loadingMore = false;
      scheduleRender();
      renderFooter();
    } catch (error) {
      if (destroyed || token !== loadToken) return;
      state.loadingMore = false;
      state.error = describeError(error);
      renderBanner();
      renderFooter();
    }
  }

  async function loadStats(): Promise<void> {
    const token = ++statsToken;
    try {
      const stats = await context.api.get<AuditStats>('/audit/stats', {
        query: filterQuery(),
        signal: controller.signal,
      });
      if (destroyed || token !== statsToken) return;
      state.stats = stats;
      state.statsError = null;
      scheduleRender();
    } catch (error) {
      if (destroyed || token !== statsToken || controller.signal.aborted) return;
      state.stats = null;
      state.statsError = describeError(error);
      scheduleRender();
    }
  }

  async function exportEvents(): Promise<void> {
    if (state.exporting) return;
    state.exporting = true;
    renderFooter();
    try {
      const text = await context.api.get<string>('/audit/export', {
        query: filterQuery(),
        signal: controller.signal,
      });
      if (destroyed) return;
      const blob = new Blob([text], { type: 'application/x-ndjson;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = el('a');
      link.href = url;
      link.download = `audit-${exportStamp()}.jsonl`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
      toast('已导出当前筛选结果', 'ok');
    } catch (error) {
      if (destroyed) return;
      toast(`导出失败：${describeError(error)}`, 'error');
    } finally {
      state.exporting = false;
      if (!destroyed) renderFooter();
    }
  }

  function appendEvents(incoming: readonly AuditEvent[]): void {
    for (const event of incoming) {
      const key = eventKey(event);
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      state.events.push(event);
    }
    state.events.sort(compareByTime);
    trimRing();
  }

  function trimRing(): void {
    while (state.events.length > MAX_EVENTS) {
      const removed = state.events.shift();
      if (removed === undefined) break;
      state.seen.delete(eventKey(removed));
      state.truncated = true;
    }
  }

  // -------------------------------------------------------------------------
  // Live polling and batching
  // -------------------------------------------------------------------------

  async function pollLive(): Promise<void> {
    if (!state.filters.live || state.loading) return;
    pollTicks += 1;
    if (pollTicks % STATS_EVERY_TICKS === 0) void loadStats();

    const last = latestTimestamp();
    const from = last ?? new Date(Date.now() - 60_000).toISOString();
    const token = loadToken;
    try {
      const response = await context.api.get<AuditQueryResponse>('/audit/query', {
        query: { ...filterQuery(), from, limit: 200 },
        signal: controller.signal,
      });
      if (destroyed || token !== loadToken || !state.filters.live) return;
      const incoming = Array.isArray(response.events) ? response.events : [];
      if (incoming.length > 0) enqueueBatch(incoming);
    } catch {
      // A transient polling failure is retried by the next tick; the banner already
      // reflects the last full-load error.
    }
  }

  function enqueueBatch(incoming: readonly AuditEvent[]): void {
    for (const event of incoming) {
      const key = eventKey(event);
      if (state.seen.has(key) || pendingKeys.has(key)) continue;
      pendingKeys.add(key);
      state.pending.push(event);
    }
    if (state.pending.length === 0) return;
    if (document.visibilityState === 'hidden') return;
    if (batchTimer !== null) return;
    batchTimer = window.setTimeout(() => {
      batchTimer = null;
      flushBatch();
    }, BATCH_MS);
  }

  function flushBatch(): void {
    if (state.pending.length === 0) {
      pendingKeys.clear();
      return;
    }
    const batch = state.pending;
    state.pending = [];
    pendingKeys.clear();
    appendEvents(batch);
    scheduleRender();
  }

  function latestTimestamp(): string | null {
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const event = state.events[index];
      const ts = event?.ts;
      if (typeof ts === 'string' && Number.isFinite(Date.parse(ts))) return ts;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderBanner(): void {
    banner.replaceChildren();
    if (state.error !== null) {
      add(banner, notice(`查询失败：${state.error}`, 'error'));
    }
    if (state.notice !== null) {
      add(banner, notice(state.notice.text, state.notice.tone));
    }
    if (state.statsError !== null) {
      add(banner, notice(`统计不可用：${state.statsError}`, 'queue'));
    }
  }

  function renderNow(): void {
    if (destroyed) return;
    renderStats();
    renderTrend();
    renderList();
    renderFooter();
  }

  function scheduleRender(): void {
    if (destroyed || document.visibilityState === 'hidden') return;
    if (renderTimer !== null) return;
    const delay = Math.max(0, RENDER_FRAME_MS - (performance.now() - lastRenderAt));
    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      lastRenderAt = performance.now();
      renderStats();
      renderTrend();
      renderList();
      renderFooter();
    }, delay);
  }

  function renderStats(): void {
    statsHost.replaceChildren();
    const stats = state.stats;
    const grid = el('div', 'card-grid');
    setStyle(grid, { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' });
    const errorRate = stats === null ? null : stats.errorRate;
    const p95 = stats === null ? null : stats.p95;
    const queueAvg = stats === null ? null : stats.queueAvgMs;

    add(
      grid,
      statCard({
        label: '调用量',
        value: stats === null ? '—' : formatNumber(stats.calls),
        hint: 'tool 结果事件聚合',
        icon: 'activity',
        tone: 'accent',
      }),
      statCard({
        label: '错误率',
        value: stats === null ? '—' : formatPercent(errorRate),
        hint: stats === null ? '等待统计' : `${formatNumber(stats.errors)} 个错误`,
        icon: 'alert',
        tone: errorRate !== null && errorRate > 0 ? 'error' : 'ok',
      }),
      statCard({
        label: 'p50',
        value: stats === null ? '—' : formatDuration(stats.p50),
        hint: '调用耗时中位数',
        icon: 'clock',
        tone: 'info',
      }),
      statCard({
        label: 'p95',
        value: stats === null ? '—' : formatDuration(p95),
        hint: '长尾耗时',
        icon: 'activity',
        tone: p95 !== null && p95 >= SLOW_MS ? 'slow' : 'neutral',
      }),
      statCard({
        label: '排队均值',
        value: stats === null ? '—' : formatDuration(queueAvg),
        hint: 'queueMs 平均',
        icon: 'layers',
        tone: queueAvg !== null && queueAvg > 0 ? 'queue' : 'neutral',
      }),
    );

    const meta = el('p', 'muted');
    if (stats !== null) {
      meta.textContent = `snapshot ${formatId(stats.snapshotId, 12)} · 计算于 ${formatTime(stats.computedAt)} · 扫描 ${formatNumber(stats.scannedRows)} 行 · took ${formatDuration(stats.tookMs)}${stats.cached ? ' · 缓存命中' : ''}；列表与统计可能来自不同扫描。`;
    } else if (state.statsError !== null) {
      meta.textContent = '统计不可用；缩小时间范围后重试。';
    } else {
      meta.textContent = '正在读取统计…';
    }
    setStyle(meta, { fontSize: '11.5px' });
    add(statsHost, grid, meta);
  }

  function renderTrend(): void {
    trendHost.replaceChildren();
    const legend = el('div', 'toolbar');
    setStyle(legend, { gap: '12px' });
    add(
      legend,
      legendDot('ok', '成功'),
      legendDot('error', '失败'),
      legendDot('slow', '超时'),
      legendDot('queue', 'queue 均值'),
    );

    const card = cardSection({
      title: '调用趋势',
      subtitle: '按 tool_result / eval_end 聚合，最近 32 个时间桶',
      icon: 'activity',
      actions: legend,
    });
    const buckets = computeBuckets(state.events);
    if (buckets.every((bucket) => bucket.ok + bucket.error + bucket.timeout === 0)) {
      add(card.body, emptyState('当前筛选没有可绘制的调用。', '趋势按 tool_result / eval_end 聚合。'));
    } else {
      add(card.body, buildTrendSvg(buckets));
    }
    trendHost.appendChild(card.element);
  }

  function legendDot(cssColor: string, label: string): HTMLElement {
    const item = el('span', 'muted');
    setStyle(item, { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11.5px' });
    const swatch = el('span');
    setStyle(swatch, {
      width: '7px',
      height: '7px',
      borderRadius: '50%',
      background: `var(--${cssColor})`,
      display: 'inline-block',
    });
    add(item, swatch, label);
    return item;
  }

  function computeBuckets(events: readonly AuditEvent[]): Bucket[] {
    const from = parseTime(state.filters.from);
    const to = parseTime(state.filters.to);
    const times = events
      .map((event) => parseEventTime(event))
      .filter((time): time is number => time !== null);
    const start = from ?? (times.length > 0 ? Math.min(...times) : Date.now() - 3_600_000);
    const end = to ?? (times.length > 0 ? Math.max(...times) : Date.now());
    const span = Math.max(1_000, end - start);
    const bucketMs = span / TREND_BUCKETS;
    const buckets: Bucket[] = Array.from({ length: TREND_BUCKETS }, (_, index) => ({
      start: start + index * bucketMs,
      ok: 0,
      error: 0,
      timeout: 0,
      queueSum: 0,
      queueCount: 0,
    }));

    const hasToolResults = events.some((event) => event.event === 'tool_result');
    for (const event of events) {
      const type = event.event;
      const timeoutEval = type === 'eval_end' && event['outcome'] === 'timeout';
      const counted = type === 'tool_result' || timeoutEval || (!hasToolResults && type === 'eval_end');
      if (!counted) continue;
      const time = parseEventTime(event);
      if (time === null) continue;
      const index = Math.min(
        TREND_BUCKETS - 1,
        Math.max(0, Math.floor((time - start) / bucketMs)),
      );
      const bucket = buckets[index];
      if (bucket === undefined) continue;

      const status = eventStatus(event);
      if (status === 'error') bucket.error += 1;
      else if (status === 'timeout') bucket.timeout += 1;
      else if (status === 'ok') bucket.ok += 1;

      const queue = asNumber(event['queueMs']);
      if (queue !== null) {
        bucket.queueSum += queue;
        bucket.queueCount += 1;
      }
    }
    return buckets;
  }

  function buildTrendSvg(buckets: readonly Bucket[]): SVGSVGElement {
    const width = 900;
    const height = 180;
    const left = 40;
    const right = 12;
    const top = 14;
    const bottom = 26;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const totals = buckets.map((bucket) => bucket.ok + bucket.error + bucket.timeout);
    const max = Math.max(1, ...totals);
    const queueAverages = buckets.map((bucket) =>
      bucket.queueCount === 0 ? 0 : bucket.queueSum / bucket.queueCount,
    );
    const maxQueue = Math.max(1, ...queueAverages);
    const slot = plotWidth / buckets.length;
    const barWidth = Math.max(2, Math.min(18, slot - 3));

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '调用趋势：成功、失败、超时堆叠，黄色折线为排队均值');

    for (const ratio of [0, 0.5, 1]) {
      const y = top + plotHeight * (1 - ratio);
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('x1', String(left));
      line.setAttribute('x2', String(width - right));
      line.setAttribute('y1', String(y));
      line.setAttribute('y2', String(y));
      line.setAttribute('stroke', 'var(--border)');
      line.setAttribute('stroke-dasharray', ratio === 0 ? 'none' : '3 5');
      svg.appendChild(line);
    }

    const scale = document.createElementNS(svg.namespaceURI, 'text');
    scale.setAttribute('x', String(left - 8));
    scale.setAttribute('y', String(top + 4));
    scale.setAttribute('text-anchor', 'end');
    scale.setAttribute('fill', 'var(--text-faint)');
    scale.setAttribute('font-size', '10');
    scale.textContent = String(max);
    svg.appendChild(scale);

    buckets.forEach((bucket, index) => {
      const x = left + index * slot + (slot - barWidth) / 2;
      const total = bucket.ok + bucket.error + bucket.timeout;
      let y = height - bottom;
      const layers: Array<{ count: number; color: string; name: string }> = [
        { count: bucket.ok, color: 'var(--ok)', name: 'ok' },
        { count: bucket.error, color: 'var(--error)', name: 'error' },
        { count: bucket.timeout, color: 'var(--slow)', name: 'timeout' },
      ];
      for (const layer of layers) {
        if (layer.count === 0) continue;
        const barHeight = (layer.count / max) * plotHeight;
        const rect = document.createElementNS(svg.namespaceURI, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y - barHeight));
        rect.setAttribute('width', String(barWidth));
        rect.setAttribute('height', String(barHeight));
        rect.setAttribute('fill', layer.color);
        rect.setAttribute('rx', barHeight > 4 ? '2' : '0');
        const title = document.createElementNS(svg.namespaceURI, 'title');
        title.textContent = `${formatTime(bucket.start)} · ${layer.name} ${layer.count} · 总 ${total}`;
        rect.appendChild(title);
        svg.appendChild(rect);
        y -= barHeight;
      }
    });

    if (queueAverages.some((value) => value > 0)) {
      const points = queueAverages.map((average, index) => {
        const x = left + index * slot + slot / 2;
        const y = height - bottom - (average / maxQueue) * plotHeight * 0.86;
        return `${x},${y}`;
      });
      const line = document.createElementNS(svg.namespaceURI, 'polyline');
      line.setAttribute('points', points.join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', 'var(--queue)');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('stroke-linejoin', 'round');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('stroke-dasharray', '4 3');
      svg.appendChild(line);
    }

    for (const [index, anchor] of [0, Math.floor(buckets.length / 2), buckets.length - 1].entries()) {
      const bucket = buckets[anchor];
      if (bucket === undefined) continue;
      const label = document.createElementNS(svg.namespaceURI, 'text');
      label.setAttribute('x', String(left + anchor * slot + slot / 2));
      label.setAttribute('y', String(height - 6));
      label.setAttribute('text-anchor', index === 0 ? 'start' : index === 2 ? 'end' : 'middle');
      label.setAttribute('fill', 'var(--text-faint)');
      label.setAttribute('font-size', '10');
      label.textContent = formatTime(bucket.start);
      svg.appendChild(label);
    }
    return svg;
  }

  function renderList(): void {
    if (state.loading && state.events.length === 0) {
      listView = null;
      listHost.replaceChildren(loading('正在读取审计事件…'));
      return;
    }
    if (state.events.length === 0) {
      listView = null;
      listHost.replaceChildren(
        emptyState(
          state.error === null ? '当前筛选没有事件。' : '事件加载失败。',
          state.error === null
            ? '放宽时间范围或清空过滤条件；实时开关只追加新事件，不回填历史。'
            : '检查 /admin/api/audit/query 后重试。',
        ),
      );
      return;
    }
    if (listView !== null) {
      updateList();
      return;
    }

    const count = el('span', 'muted', listSummary());
    const badges = el('div', 'toolbar');
    setStyle(badges, { gap: '6px' });
    const meta = el('div', 'toolbar');
    add(meta, count, badges);

    const card = cardSection({
      title: '调用列表',
      icon: 'audit',
      flush: true,
      actions: meta,
    });

    const headerRow = el('div', 'virtual-row');
    setStyle(headerRow, {
      position: 'relative',
      background: 'var(--surface-muted)',
      color: 'var(--text-faint)',
      fontSize: '11px',
      fontWeight: '600',
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
    });
    for (const column of COLUMNS) {
      headerRow.appendChild(
        listCell(column.label, column.flex, { mono: column.mono, align: column.align }),
      );
    }
    card.body.appendChild(headerRow);

    const viewport = el('div', 'virtual-list');
    setStyle(viewport, {
      maxHeight: '560px',
      minHeight: '220px',
      border: 'none',
      borderRadius: '0',
    });
    const spacer = el('div', 'virtual-list-spacer');
    viewport.appendChild(spacer);
    card.body.appendChild(viewport);
    listHost.replaceChildren(card.element);

    const paint = (): void => {
      paintFrame = null;
      const scrollTop = viewport.scrollTop;
      const viewportHeight = viewport.clientHeight;
      const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 6);
      const last = Math.min(
        state.events.length,
        Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + 6,
      );
      const existing = new Map<string, HTMLElement>();
      for (const child of Array.from(spacer.children)) {
        const element = child as HTMLElement;
        const key = element.dataset['key'];
        if (key !== undefined) existing.set(key, element);
      }

      const next: HTMLElement[] = [];
      for (let index = first; index < last; index += 1) {
        const event = displayEvent(index);
        if (event === undefined) continue;
        // Reuse by event identity: the ring buffer drops the oldest rows, and an
        // index-keyed reuse would repaint a row with another event's content.
        const key = eventKey(event);
        let row = existing.get(key);
        if (row === undefined) row = buildListRow(event);
        row.dataset['key'] = key;
        row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
        next.push(row);
        existing.delete(key);
      }
      for (const unused of existing.values()) unused.remove();
      for (const row of next) {
        if (row.parentElement !== spacer) spacer.appendChild(row);
      }
    };

    const schedulePaint = (): void => {
      if (paintFrame !== null) return;
      paintFrame = window.requestAnimationFrame(paint);
    };

    viewport.addEventListener('scroll', schedulePaint, { passive: true });
    listView = { count, badges, viewport, spacer, paint };
    updateList();
    // The factory builds the section before the shell inserts it, so `clientHeight`
    // is still zero on the first synchronous paint; repaint once layout is known.
    schedulePaint();
  }

  function updateList(): void {
    if (listView === null) return;
    listView.count.textContent = listSummary();
    listView.badges.replaceChildren();
    if (state.filters.live) listView.badges.appendChild(badge('实时', 'info'));
    if (state.truncated) listView.badges.appendChild(badge('实时视图已截断', 'queue'));
    listView.spacer.style.height = `${state.events.length * ROW_HEIGHT}px`;
    listView.paint();
  }

  function invalidateList(): void {
    listView = null;
  }

  function listSummary(): string {
    const loaded = formatNumber(state.events.length);
    const limit = formatNumber(MAX_EVENTS);
    return state.hasMore
      ? `已加载 ${loaded} 条（上限 ${limit}，还有更多）`
      : `已加载 ${loaded} 条（上限 ${limit}）`;
  }

  function displayEvent(index: number): AuditEvent | undefined {
    return state.events[state.events.length - 1 - index];
  }

  function buildListRow(event: AuditEvent): HTMLElement {
    const row = el('div', 'virtual-row');
    const status = eventStatus(event);
    setStyle(row, { cursor: 'pointer', background: 'var(--surface)' });
    if (status === 'error') setStyle(row, { boxShadow: 'inset 2px 0 0 var(--error)' });
    else if (status === 'timeout') setStyle(row, { boxShadow: 'inset 2px 0 0 var(--slow)' });
    row.tabIndex = 0;
    row.setAttribute('role', 'row');
    row.setAttribute('aria-label', listRowLabel(event));

    const time = parseEventTime(event);
    const queueMs = asNumber(event['queueMs']);
    const duration = eventDuration(event);
    const queueCell = listCell(formatDuration(queueMs), 0.8, {
      mono: true,
      align: 'right',
      title: queueMs === null ? 'queueMs 缺失' : `queueMs ${formatDuration(queueMs)}`,
    });
    if (queueMs !== null && queueMs >= 500) setStyle(queueCell, { color: 'var(--queue)' });
    const durationCell = listCell(formatDuration(duration), 0.75, {
      mono: true,
      align: 'right',
      title: duration === null ? 'ms 缺失' : `ms ${formatDuration(duration)}`,
    });
    if (duration !== null && duration >= SLOW_MS) setStyle(durationCell, { color: 'var(--slow)' });

    const statusCell = el('span');
    setStyle(statusCell, {
      display: 'flex',
      alignItems: 'center',
      flex: '0.8 1 0%',
      minWidth: '0',
    });
    add(statusCell, status === '' ? el('span', 'muted', '—') : badge(status, statusTone(status)));

    const chevron = icon('chevron-right', 14);
    chevron.style.flex = '0 0 auto';
    chevron.style.color = 'var(--text-faint)';

    add(
      row,
      listCell(time === null ? '—' : formatTime(time), 1.15, {
        title: formatTimestamp(event.ts ?? null),
      }),
      listCell(eventText(event, 'client') ?? eventText(event, 'binding') ?? '—', 1.5),
      listCell(eventText(event, 'tool') ?? eventText(event, 'method') ?? event.event ?? '—', 1.75, {
        mono: true,
      }),
      listCell(eventText(event, 'mode') ?? eventText(event, 'concurrency') ?? '—', 0.75),
      queueCell,
      durationCell,
      statusCell,
      listCell(evalLabel(event), 1.35, { mono: true }),
      chevron,
    );

    row.addEventListener('click', () => openEvent(event));
    row.addEventListener('keydown', (keyboard) => {
      if (keyboard.key === 'Enter' || keyboard.key === ' ') {
        keyboard.preventDefault();
        openEvent(event);
      }
    });
    return row;
  }

  function listCell(text: string, flex: number, options: CellOptions = {}): HTMLElement {
    const classes: string[] = [];
    if (options.mono === true) classes.push('mono');
    if (options.align === 'right') classes.push('num');
    const cell = el('span', classes.join(' '), text);
    setStyle(cell, {
      flex: `${flex} 1 0%`,
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
    if (options.title !== undefined) cell.title = options.title;
    return cell;
  }

  function listRowLabel(event: AuditEvent): string {
    const time = parseEventTime(event);
    return `${time === null ? 'unknown time' : formatTimestamp(time)} ${event.event ?? 'event'} ${eventText(event, 'tool') ?? eventText(event, 'method') ?? ''}`;
  }

  function evalLabel(event: AuditEvent): string {
    const exec = eventText(event, 'exec');
    const evalId = asNumber(event['evalId']);
    if (exec !== null && evalId !== null) return `${formatId(exec, 10)}#${evalId}`;
    if (exec !== null) return formatId(exec, 14);
    const taskId = eventText(event, 'evalTaskId') ?? eventText(event, 'taskId');
    return taskId === null ? '—' : formatId(taskId, 14);
  }

  function renderFooter(): void {
    listFooter.replaceChildren();
    const summary = el('span', 'muted', listSummary());
    const exportButton = button('导出 JSONL', () => void exportEvents(), {
      variant: 'secondary',
      size: 'sm',
      icon: 'download',
      disabled: state.exporting,
    });
    const refresh = button(
      '刷新',
      () => {
        loadToken += 1;
        state.loading = true;
        renderNow();
        void loadFirstPage(loadToken);
        void loadStats();
      },
      { variant: 'ghost', size: 'sm', icon: 'refresh' },
    );
    const more = button('加载更多', () => void loadMore(), {
      variant: 'secondary',
      size: 'sm',
      icon: 'chevron-down',
      disabled: state.cursor === null || state.loadingMore,
    });
    add(listFooter, summary);
    if (state.truncated) add(listFooter, badge('超过 5000 条，仅保留最新', 'queue'));
    add(listFooter, el('span', 'spacer'), refresh, exportButton, more);
  }

  // -------------------------------------------------------------------------
  // Drawer: single call, eval gantt, protocol frames
  // -------------------------------------------------------------------------

  function openEvent(event: AuditEvent): void {
    state.drawer = event;
    const ticket = ++drawerTicket;
    const content = el('div');
    setStyle(content, { display: 'flex', flexDirection: 'column', gap: '16px' });

    add(content, buildEventSummary(event));
    const traceHost = el('div');
    const framesHost = el('div');
    add(content, traceHost, framesHost);
    drawer.open(eventText(event, 'tool') ?? event.event ?? '事件详情', content);

    void loadTrace(event, traceHost, ticket);
    void loadFrames(event, framesHost, ticket);
  }

  function buildEventSummary(event: AuditEvent): HTMLElement {
    const status = eventStatus(event);
    const card = cardSection({
      title: '事件概要',
      icon: 'info',
      ...(status === '' ? {} : { actions: badge(status, statusTone(status)) }),
    });

    const entries: Array<{ label: string; value: Node | string; mono?: boolean }> = [
      { label: '时间', value: formatTimestamp(event.ts ?? null), mono: true },
      { label: '事件', value: event.event ?? '—', mono: true },
      { label: 'client', value: eventText(event, 'client') ?? '—' },
      { label: 'binding', value: eventText(event, 'binding') ?? 'unbound', mono: true },
      { label: 'exec', value: eventText(event, 'exec') ?? '—', mono: true },
      { label: 'evalId', value: formatNumber(asNumber(event['evalId'])) },
      { label: '工具', value: eventText(event, 'tool') ?? eventText(event, 'method') ?? '—', mono: true },
      { label: 'server', value: eventText(event, 'server') ?? '—', mono: true },
      {
        label: 'queueMs / ms',
        value: `${formatDuration(asNumber(event['queueMs']))} / ${formatDuration(eventDuration(event))}`,
      },
      { label: '状态', value: status === '' ? '—' : status },
      { label: '结果字节', value: formatNumber(asNumber(event['resultBytes'] ?? event['bytes'])) },
    ];
    add(card.body, definitionList(entries));

    const copyRow = el('div', 'toolbar');
    for (const [label, value] of [
      ['复制 evalId', String(asNumber(event['evalId']) ?? '')],
      ['复制 exec', eventText(event, 'exec') ?? ''],
      ['复制 taskId', eventText(event, 'evalTaskId') ?? eventText(event, 'taskId') ?? ''],
      ['复制请求 id', String(event['rpcId'] ?? event['requestId'] ?? event['id'] ?? '')],
    ] as const) {
      if (value === '' || value === 'null') continue;
      copyRow.appendChild(copyButton(label, () => value));
    }
    if (copyRow.childElementCount > 0) card.body.appendChild(copyRow);

    const details = el('details');
    const pre = el('pre');
    setStyle(pre, { maxHeight: '260px' });
    pre.textContent = formatJson(event, 2);
    add(details, el('summary', 'muted', '原始事件 JSON'), pre);
    card.body.appendChild(details);
    return card.element;
  }

  async function loadTrace(
    event: AuditEvent,
    host: HTMLElement,
    ticket: number,
  ): Promise<void> {
    host.replaceChildren(loading('正在读取 eval 轨迹…'));
    const exec = eventText(event, 'exec');
    const evalId = asNumber(event['evalId']);
    if (exec === null || evalId === null) {
      host.replaceChildren(
        emptyState('这条事件没有 exec / evalId。', 'eval 甘特只对 eval 内事件可用；协议帧仍可单独查看。'),
      );
      return;
    }
    try {
      const response = await context.api.get<TraceResponse>(
        `/audit/evals/${encodeURIComponent(exec)}/${evalId}`,
        { signal: controller.signal },
      );
      if (destroyed || ticket !== drawerTicket || !drawer.isOpen) return;
      const events = Array.isArray(response.events) ? response.events : [];
      host.replaceChildren(buildGanttSection(events, exec, evalId));
    } catch (error) {
      if (destroyed || ticket !== drawerTicket) return;
      host.replaceChildren(notice(`eval 轨迹读取失败：${describeError(error)}`, 'error'));
    }
  }

  function buildGanttSection(
    events: readonly AuditEvent[],
    exec: string,
    evalId: number,
  ): HTMLElement {
    const card = cardSection({
      title: 'eval 轨迹',
      subtitle: `${formatId(exec, 12)}#${evalId}`,
      icon: 'play',
      actions: badge(`${formatNumber(events.length)} 个事件`, 'neutral'),
    });

    const spans = buildGanttSpans(events);
    if (spans.length === 0) {
      add(card.body, emptyState('这次 eval 没有 tool_call/tool_result。', '甘特只画工具调用；其他事件见原始轨迹。'));
    } else {
      add(card.body, buildGantt(spans));
    }

    const details = el('details');
    const pre = el('pre');
    setStyle(pre, { maxHeight: '240px' });
    pre.textContent = events.map((entry) => JSON.stringify(entry)).join('\n');
    add(details, el('summary', 'muted', '原始轨迹 JSONL'), pre);
    card.body.appendChild(details);
    return card.element;
  }

  function buildGanttSpans(events: readonly AuditEvent[]): GanttSpan[] {
    const sorted = [...events].sort(compareByTime);
    const pending = new Map<string, Array<{ event: AuditEvent; ts: number }>>();
    const loose: AuditEvent[] = [];
    const spans: GanttSpan[] = [];

    for (const event of sorted) {
      if (event.event === 'tool_call') {
        const ts = parseEventTime(event);
        if (ts === null) continue;
        const key = callKey(event);
        if (key === null) {
          loose.push(event);
        } else {
          const queue = pending.get(key) ?? [];
          queue.push({ event, ts });
          pending.set(key, queue);
        }
        continue;
      }
      if (event.event !== 'tool_result') continue;
      const ts = parseEventTime(event);
      if (ts === null) continue;
      const key = callKey(event);
      const queue = key === null ? undefined : pending.get(key);
      const matched = queue?.shift();
      if (queue !== undefined && queue.length === 0 && key !== null) pending.delete(key);
      const call = matched?.event ?? loose.shift();
      const start = call === undefined ? ts : (parseEventTime(call) ?? ts);
      const queueMs = Math.max(0, asNumber(event['queueMs']) ?? asNumber(call?.['queueMs']) ?? 0);
      const measured = asNumber(event['ms']) ?? asNumber(event['durationMs']);
      const computed = Math.max(0, ts - start - queueMs);
      const ms = measured ?? (computed > 0 ? computed : 0);
      spans.push({
        label: eventText(call ?? event, 'tool') ?? eventText(event, 'tool') ?? 'tool',
        start,
        queueMs,
        ms,
        end: Math.max(ts, start + queueMs + ms),
        ok: event['ok'] === false ? false : event['ok'] === true ? true : null,
      });
    }

    for (const queue of pending.values()) {
      for (const leftover of queue) {
        const queueMs = Math.max(0, asNumber(leftover.event['queueMs']) ?? 0);
        const ms = Math.max(
          0,
          asNumber(leftover.event['ms']) ?? asNumber(leftover.event['durationMs']) ?? 0,
        );
        spans.push({
          label: eventText(leftover.event, 'tool') ?? 'tool',
          start: leftover.ts,
          queueMs,
          ms,
          end: leftover.ts + queueMs + ms,
          ok: null,
        });
      }
    }
    for (const event of loose) {
      const ts = parseEventTime(event);
      if (ts === null) continue;
      const queueMs = Math.max(0, asNumber(event['queueMs']) ?? 0);
      const ms = Math.max(0, asNumber(event['ms']) ?? 0);
      spans.push({
        label: eventText(event, 'tool') ?? 'tool',
        start: ts,
        queueMs,
        ms,
        end: ts + queueMs + ms,
        ok: null,
      });
    }

    spans.sort((left, right) => left.start - right.start);
    return spans;
  }

  function buildGantt(spans: readonly GanttSpan[]): HTMLElement {
    const wrapper = el('div');
    setStyle(wrapper, {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      maxHeight: '340px',
      overflowY: 'auto',
    });
    const base = Math.min(...spans.map((span) => span.start - span.queueMs));
    const end = Math.max(...spans.map((span) => span.end));
    const total = Math.max(1, end - base);

    for (const span of spans) {
      const row = el('div');
      setStyle(row, { display: 'flex', alignItems: 'center', gap: '10px', height: '24px' });
      const label = el('span', 'mono', span.label);
      setStyle(label, {
        flex: '0 0 150px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '11.5px',
        color: 'var(--text-muted)',
      });
      label.title = span.label;
      const track = el('div');
      setStyle(track, {
        position: 'relative',
        flex: '1 1 auto',
        height: '18px',
        border: '1px solid var(--border)',
        borderRadius: '5px',
        background: 'var(--surface-inset)',
        overflow: 'hidden',
      });
      const queueLeft = ((span.start - span.queueMs - base) / total) * 100;
      const queueWidth = (span.queueMs / total) * 100;
      const execLeft = ((span.start - base) / total) * 100;
      const execWidth = (span.ms / total) * 100;
      if (span.queueMs > 0) {
        const queue = el('div');
        queue.title = `queueMs ${formatDuration(span.queueMs)}`;
        setStyle(queue, {
          position: 'absolute',
          left: `${queueLeft}%`,
          width: `${Math.max(0.5, queueWidth)}%`,
          top: '0',
          bottom: '0',
          background: 'var(--queue)',
          opacity: '0.35',
        });
        track.appendChild(queue);
      }
      const bar = el('div');
      bar.title = `${span.label} · queue ${formatDuration(span.queueMs)} · ms ${formatDuration(span.ms)}`;
      setStyle(bar, {
        position: 'absolute',
        left: `${execLeft}%`,
        width: `${Math.max(0.5, execWidth)}%`,
        top: '2px',
        bottom: '2px',
        borderRadius: '3px',
        background:
          span.ok === false ? 'var(--error)' : span.ok === true ? 'var(--ok)' : 'var(--accent)',
        minWidth: '2px',
      });
      track.appendChild(bar);
      add(row, label, track);
      wrapper.appendChild(row);
    }

    const legend = el('div', 'toolbar');
    add(
      legend,
      legendDot('queue', 'queueMs'),
      legendDot('ok', 'ms'),
      el('span', 'spacer'),
      el(
        'span',
        'muted',
        `跨度 ${formatDuration(total)}，从 ${formatTime(base)} 到 ${formatTime(end)}`,
      ),
    );
    wrapper.appendChild(legend);
    return wrapper;
  }

  async function loadFrames(
    event: AuditEvent,
    host: HTMLElement,
    ticket: number,
  ): Promise<void> {
    host.replaceChildren(loading('正在读取协议帧…'));
    const mcp = eventText(event, 'mcp');
    const idValue = event['rpcId'] ?? event['requestId'] ?? event['id'];
    const id = typeof idValue === 'string' || typeof idValue === 'number' ? idValue : undefined;
    try {
      let response = await requestFrames(mcp, id);
      if (destroyed || ticket !== drawerTicket || !drawer.isOpen) return;
      if ((response.frames ?? []).length === 0 && id !== undefined) {
        response = await requestFrames(mcp, undefined);
        if (destroyed || ticket !== drawerTicket || !drawer.isOpen) return;
      }
      host.replaceChildren(buildFramesSection(response, mcp, id));
    } catch (error) {
      if (destroyed || ticket !== drawerTicket) return;
      host.replaceChildren(notice(`协议帧读取失败：${describeError(error)}`, 'error'));
    }
  }

  function requestFrames(mcp: string | null, id: string | number | undefined): Promise<FramesResponse> {
    const query: Record<string, string | number | undefined> = {
      detail: 'full',
      from: toIso(state.filters.from),
      to: toIso(state.filters.to),
      mcp: mcp ?? undefined,
      id,
      limit: FRAME_LIMIT,
    };
    return context.api.get<FramesResponse>('/audit/frames', {
      query,
      signal: controller.signal,
    });
  }

  function buildFramesSection(
    response: FramesResponse,
    mcp: string | null,
    id: string | number | undefined,
  ): HTMLElement {
    const actions = el('div', 'toolbar');
    setStyle(actions, { gap: '6px' });
    add(actions, badge(`detail=${response.detail ?? 'full'}`, 'neutral'));
    if (response.droppedFrames !== undefined && response.droppedFrames > 0) {
      add(actions, badge(`丢帧 ${formatNumber(response.droppedFrames)}`, 'error'));
    }
    const card = cardSection({
      title: '协议帧',
      subtitle:
        mcp === null ? '全部会话' : `mcp ${formatId(mcp, 14)}${id === undefined ? '' : ` · id ${id}`}`,
      icon: 'terminal',
      actions,
    });

    const frames = Array.isArray(response.frames) ? response.frames : [];
    if (frames.length === 0) {
      add(card.body, emptyState('没有匹配的协议帧。', '协议帧模式可能为 off，或请求/响应不在当前时间范围内。'));
      return card.element;
    }
    for (const frame of frames.slice(0, FRAME_LIMIT)) {
      card.body.appendChild(buildFramePair(frame));
    }
    if (response.hasMore === true) {
      add(card.body, el('p', 'muted', '还有更多帧；缩小时间范围或指定 mcp / id。'));
    }
    return card.element;
  }

  function buildFramePair(frame: ProtocolFramePair): HTMLElement {
    const block = el('article');
    setStyle(block, {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '12px',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      background: 'var(--surface-inset)',
    });
    const header = el('div', 'toolbar');
    add(
      header,
      el('span', 'mono', frame.method ?? eventText(frame.request ?? undefined, 'method') ?? 'frame'),
      el('span', 'muted', `id ${frame.id ?? '—'} · mcp ${formatId(frame.mcp, 12)}`),
      el('span', 'spacer'),
    );
    if (frame.durMs !== undefined) {
      header.appendChild(badge(formatDuration(frame.durMs), durationTone(frame.durMs)));
    }
    if (frame.ok !== undefined) {
      header.appendChild(badge(frame.ok ? 'ok' : 'error', frame.ok ? 'ok' : 'error'));
    }

    const columns = el('div');
    setStyle(columns, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' });
    columns.appendChild(frameColumn('请求', frame.request));
    columns.appendChild(frameColumn('响应', frame.response));
    add(block, header, columns);
    return block;
  }

  function frameColumn(label: string, event: AuditEvent | null): HTMLElement {
    const column = el('div');
    setStyle(column, { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0' });
    const title = el('p', 'muted', label);
    setStyle(title, { fontSize: '11.5px', fontWeight: '550' });
    column.appendChild(title);
    if (event === null) {
      column.appendChild(el('p', 'muted', '（缺少这一侧）'));
      return column;
    }
    const eventTruncation = frameTruncation(event);
    if (eventTruncation !== null) column.appendChild(badge(eventTruncation, 'queue'));
    const payload = framePayload(event);
    const payloadTruncation = payloadTruncationLabel(payload);
    if (payloadTruncation !== null) column.appendChild(badge(payloadTruncation, 'queue'));
    const pre = el('pre');
    setStyle(pre, { maxHeight: '240px' });
    const head = truncatedHead(payload);
    pre.textContent = head === null ? formatJson(payload, 2) : `${head}\n…（已截断）`;
    column.appendChild(pre);
    return column;
  }

  function framePayload(event: AuditEvent): unknown {
    if (event['params'] !== undefined) return event['params'];
    if (event['result'] !== undefined) return event['result'];
    if (event['error'] !== undefined) return event['error'];
    return event;
  }

  function frameTruncation(event: AuditEvent): string | null {
    const truncated = event['truncated'] === true || event['payloadTruncated'] === true;
    if (!truncated) return null;
    const bytes =
      asNumber(event['bytes']) ??
      asNumber(event['truncatedBytes']) ??
      asNumber(event['originalBytes']);
    const sha = eventText(event, 'sha256');
    return `已截断${bytes === null ? '' : ` ${formatBytes(bytes)}`}${sha === null ? '' : ` · sha256 ${sha.slice(0, 12)}…`}`;
  }

  /** `boundFramePayload` replaces an oversized payload with `{truncated, bytes, sha256, head}`. */
  function payloadTruncationLabel(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    if (record['truncated'] !== true) return null;
    const bytes = asNumber(record['bytes']);
    const sha = typeof record['sha256'] === 'string' ? record['sha256'] : null;
    return `已截断${bytes === null ? '' : ` ${formatBytes(bytes)}`}${sha === null ? '' : ` · sha256 ${sha.slice(0, 12)}…`}`;
  }

  function truncatedHead(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    if (record['truncated'] !== true) return null;
    return typeof record['head'] === 'string' ? record['head'] : '';
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function eventText(event: AuditEvent | undefined, key: string): string | null {
    if (event === undefined) return null;
    const value = event[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
    return null;
  }

  function eventDuration(event: AuditEvent): number | null {
    return (
      asNumber(event['ms']) ??
      asNumber(event['durationMs']) ??
      asNumber(event['elapsedMs']) ??
      asNumber(event['durMs'])
    );
  }

  function eventStatus(event: AuditEvent): string {
    const explicit = event['status'];
    if (typeof explicit === 'string' && explicit !== '') return explicit;
    if (event.event === 'tool_result') return event['ok'] === false ? 'error' : 'ok';
    if (event.event === 'eval_end') {
      if (event['outcome'] === 'timeout') return 'timeout';
      if (event['outcome'] === 'cancelled') return 'cancelled';
      if (event['outcome'] === 'failed' || event['outcome'] === 'error') return 'error';
      return 'ok';
    }
    if (event['ok'] === true) return 'ok';
    if (event['ok'] === false) return 'error';
    return '';
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const polling = startPolling(pollLive, POLL_MS);
  const removeVisibility = onVisibilityChange(() => {
    if (document.visibilityState === 'visible') {
      flushBatch();
      scheduleRender();
    }
  });

  renderNow();
  void loadFirstPage(loadToken);
  void loadStats();

  return {
    element: section,
    destroy(): void {
      destroyed = true;
      drawerTicket += 1;
      polling.stop();
      removeVisibility();
      controller.abort();
      if (batchTimer !== null) clearTimeout(batchTimer);
      if (renderTimer !== null) clearTimeout(renderTimer);
      if (paintFrame !== null) window.cancelAnimationFrame(paintFrame);
      paintFrame = null;
      drawer.destroy();
      section.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level pure helpers
// ---------------------------------------------------------------------------

function compareByTime(left: AuditEvent, right: AuditEvent): number {
  const a = parseEventTime(left) ?? 0;
  const b = parseEventTime(right) ?? 0;
  if (a === b) return eventKey(left).localeCompare(eventKey(right));
  return a - b;
}

function parseEventTime(event: AuditEvent): number | null {
  const ts = event.ts;
  if (typeof ts !== 'string') return null;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTime(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: string): string | undefined {
  const parsed = parseTime(value);
  return parsed === null ? undefined : new Date(parsed).toISOString();
}

function toDateTimeLocal(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function eventKey(event: AuditEvent): string {
  const fields = ['ts', 'event', 'exec', 'evalId', 'callSeq', 'id', 'rpcId', 'tool', 'taskId', 'mcp'];
  return fields
    .map((field) => {
      const value = event[field];
      return typeof value === 'string' || typeof value === 'number' ? `${field}=${value}` : '';
    })
    .join('|');
}

function callKey(event: AuditEvent): string | null {
  const sequence = event['callSeq'] ?? event['seq'];
  if (typeof sequence === 'number' || typeof sequence === 'string') return `seq:${sequence}`;
  const rpcId = event['rpcId'] ?? event['requestId'] ?? event['id'];
  if (typeof rpcId === 'number' || typeof rpcId === 'string') return `id:${rpcId}`;
  const tool = event['tool'];
  if (typeof tool === 'string') return `tool:${tool}`;
  return null;
}

function exportStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
