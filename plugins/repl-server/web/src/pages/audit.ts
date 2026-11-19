/** Audit page: filter toolbar, KPI stat row, trend, virtual call table, call drawer with
 * eval gantt and side-by-side protocol frames (RS-18, 03 §4.6–4.7).
 *
 * All data comes from `/admin/api/audit/*` through the typed API client. The live view
 * subscribes to `/admin/api/audit/stream` (same cookie session), batches incoming events
 * for {@link BATCH_MS} before touching the DOM, keeps at most {@link MAX_EVENTS} events in
 * a ring buffer, and pauses the subscription plus rendering while the document is hidden.
 * A gap frame forces a full refresh; the 2s `/audit/query` poll stays as the disconnect
 * fallback and still refreshes the stat row. Rendering is throttled to roughly 30 fps.
 *
 * The table is a virtual scroller keyed by event identity: only the visible rows exist in
 * the DOM, so a full 5000-event buffer costs the same as one viewport. Export streams the
 * applied filter as JSONL through the same client.
 *
 * Filters default to the last hour (local time) and persist to a versioned localStorage
 * key; corrupt records fall back to the defaults. The column picker persists which
 * optional columns are visible, and secondary columns are dropped automatically on
 * narrow viewports without touching the event buffers or the live filter.
 *
 * Audit events are intentionally typed loosely: the JSONL schema grows per event type,
 * and the page must still render unfamiliar fields instead of dropping the row.
 * @module
 */

import { ApiError, type EventStream } from '../lib/api.ts';
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
  checkbox,
  copyButton,
  createDrawer,
  definitionList,
  describeError,
  el,
  emptyState,
  errorActionHint,
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

export interface AuditFilters {
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
  /** Preset minutes as a string (`'60'`); empty means a custom from/to range. */
  range: string;
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
  range: HTMLSelectElement;
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
  setAdvanced(open: boolean): void;
}

interface CellOptions {
  mono?: boolean;
  align?: 'right';
  title?: string;
}

export interface AuditColumn {
  key: string;
  label: string;
  flex: number;
  align?: 'right';
  mono?: boolean;
  /** Always visible; the column picker cannot hide it. */
  fixed?: boolean;
  /** Dropped automatically on narrow viewports. */
  secondary?: boolean;
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

/** Default preset: the last hour, rendered in the browser's local timezone. */
export const DEFAULT_RANGE = '60';

/** Versioned keys; the `version` field inside the records must match as well. */
export const FILTER_STORAGE_KEY = ['repl-server', 'admin', 'audit', 'filters', 'v1'].join('.');
export const COLUMN_STORAGE_KEY = ['repl-server', 'admin', 'audit', 'columns', 'v1'].join('.');

const STORAGE_VERSION = 1;
const NARROW_MEDIA_QUERY = '(max-width: 900px)';
const PRESET_MINUTES: readonly number[] = [15, 60, 360, 1_440, 10_080];

const EVENT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部事件' },
  { value: 'tool_call', label: 'tool_call' },
  { value: 'tool_result', label: 'tool_result' },
  { value: 'tool_denied', label: 'tool_denied' },
  { value: 'eval_start', label: 'eval_start' },
  { value: 'eval_end', label: 'eval_end' },
  { value: 'exec_start', label: 'exec_start' },
  { value: 'exec_end', label: 'exec_end' },
  { value: 'ai_run', label: 'ai_run' },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'ok', label: 'ok' },
  { value: 'error', label: 'error' },
  { value: 'timeout', label: 'timeout' },
];

export const AUDIT_COLUMNS: ReadonlyArray<AuditColumn> = [
  { key: 'time', label: '时间', flex: 1.15, fixed: true },
  { key: 'client', label: '客户端 / binding', flex: 1.5, secondary: true },
  { key: 'server', label: 'server', flex: 1.05, mono: true, secondary: true },
  { key: 'tool', label: '工具 / 方法', flex: 1.75, mono: true, fixed: true },
  { key: 'mode', label: '模式', flex: 0.75, secondary: true },
  { key: 'queueMs', label: 'queueMs', flex: 0.8, align: 'right', mono: true },
  { key: 'ms', label: 'ms', flex: 0.75, align: 'right', mono: true },
  { key: 'status', label: '状态', flex: 0.8 },
  { key: 'eval', label: 'exec / eval', flex: 1.35, mono: true, secondary: true },
];

export function createAuditPage(context: PageContext): PageHandle {
  const { section, body } = pageFrame(
    '审计',
    '调用列表、eval 轨迹与协议帧；筛选在服务端流式完成，实时视图最多保留 5000 条。',
  );

  const initialFilters = parsePersistedAuditFilters(readStorage(FILTER_STORAGE_KEY));
  const state = {
    filters: { ...initialFilters },
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
    errorCode: null as string | null,
    stats: null as AuditStats | null,
    statsError: null as string | null,
    statsErrorCode: null as string | null,
    notice: null as { text: string; tone: NoticeTone } | null,
    drawer: null as AuditEvent | null,
  };

  let columnVisibility = parsePersistedColumns(readStorage(COLUMN_STORAGE_KEY));
  const narrowMedia =
    typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_MEDIA_QUERY) : null;
  let narrow = narrowMedia?.matches === true;
  const onNarrowChange = (event: MediaQueryListEvent): void => {
    narrow = event.matches;
    invalidateList();
    renderNow();
  };
  narrowMedia?.addEventListener('change', onNarrowChange);

  let destroyed = false;
  let loadToken = 0;
  let statsToken = 0;
  let pollTicks = 0;
  let streamOpen = false;
  let stream: EventStream | null = null;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let paintFrame: number | null = null;
  let lastRenderAt = 0;
  let drawerTicket = 0;
  const controller = new AbortController();

  const banner = el('div');
  const pendingKeys = new Set<string>();
  const rangeSummary = el('p', 'muted');
  setStyle(rangeSummary, { fontSize: '11.5px' });
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

    const range = selectControl(RANGE_OPTIONS, {
      value: state.filters.range,
      ariaLabel: '时间范围',
    });
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
        persistFilters(state.filters);
        syncLiveStream();
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

    const columnPanel = buildColumnPanel();
    const columns = button(
      '列',
      () => {
        const open = columnPanel.hidden === true;
        columnPanel.hidden = !open;
        columns.setAttribute('aria-expanded', String(open));
        columns.title = open ? '收起列选择' : '选择显示列';
      },
      { variant: 'ghost', size: 'sm', icon: 'layers' },
    );
    columns.setAttribute('aria-expanded', 'false');
    columns.title = '选择显示列';

    const apply = button('应用', () => undefined, {
      type: 'submit',
      variant: 'primary',
      icon: 'check',
    });
    const reset = button(
      '清空筛选',
      () => {
        clearFilters();
      },
      { variant: 'secondary', icon: 'refresh' },
    );

    const head = el('div', 'toolbar');
    add(head, el('p', 'eyebrow', '筛选'), el('span', 'spacer'), columns, more);

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

    add(card, head, primary, rangeSummary, advanced, columnPanel);
    card.dataset['from'] = 'audit-filter';
    filterControls = {
      range,
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
      setAdvanced,
    };
    return card;
  }

  function buildColumnPanel(): HTMLElement {
    const panel = el('div', 'toolbar');
    panel.hidden = true;
    setStyle(panel, {
      flexWrap: 'wrap',
      gap: '10px 16px',
      padding: '10px 12px',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      background: 'var(--surface-inset)',
    });

    const hint = el(
      'p',
      'muted',
      '勾选要显示的列；窄屏（≤900px）自动隐藏客户端、server、模式与 exec/eval 列。',
    );
    setStyle(hint, { flex: '1 0 100%', fontSize: '11.5px' });
    add(panel, hint);

    for (const column of AUDIT_COLUMNS) {
      if (column.fixed === true) continue;
      const item = checkbox(column.label, columnVisibility[column.key] !== false);
      item.input.addEventListener('change', () => {
        columnVisibility = { ...columnVisibility, [column.key]: item.input.checked };
        writeStorage(COLUMN_STORAGE_KEY, serializeColumnVisibility(columnVisibility));
        invalidateList();
        renderNow();
      });
      add(panel, item.wrapper);
    }
    return panel;
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
      range: controls.range.value,
    };
    persistFilters(state.filters);
    renderRangeSummary();
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
    state.errorCode = null;
    state.notice = null;
    state.stats = null;
    state.statsError = null;
    state.statsErrorCode = null;
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
    syncLiveStream();
  }

  /** Returns every filter control to the first-entry defaults and applies them. */
  function clearFilters(): void {
    const controls = filterControls;
    state.filters = defaultAuditFilters(Date.now());
    controls.range.value = DEFAULT_RANGE;
    controls.from.value = state.filters.from;
    controls.to.value = '';
    controls.eventType.value = '';
    controls.status.value = '';
    controls.client.value = '';
    controls.binding.value = '';
    controls.tool.value = '';
    controls.server.value = '';
    controls.minMs.value = '';
    controls.live.checked = true;
    controls.setAdvanced(false);
    applyFilters();
  }

  /** Grows the window without ever shrinking it; past the last preset it doubles the span. */
  function expandTimeRange(): void {
    const next = expandedRangeMinutes(rangeMinutes(state.filters));
    const controls = filterControls;
    const preset = RANGE_OPTIONS.some((option) => option.value === String(next));
    controls.range.value = preset ? String(next) : '';
    controls.from.value = toDateTimeLocal(Date.now() - next * 60_000);
    controls.to.value = '';
    applyFilters();
  }

  function renderRangeSummary(): void {
    const filters = state.filters;
    const preset = RANGE_OPTIONS.find(
      (option) => option.value !== '' && option.value === filters.range,
    );
    const label = preset === undefined ? '自定义时间' : preset.label;
    const from = parseTime(filters.from);
    const to = parseTime(filters.to);
    const fromText = from === null ? '不限' : formatTimestamp(from);
    const toText = to === null ? '至今' : formatTimestamp(to);
    rangeSummary.textContent = `当前范围（本地时区）：${label} · ${fromText} → ${toText}`;
  }

  function persistFilters(filters: AuditFilters): void {
    writeStorage(FILTER_STORAGE_KEY, serializeAuditFilters(filters));
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
    // Stream frames can arrive while this request is in flight; `applyFilters` has
    // already dropped the old rows, so keeping the current buffers only carries rows
    // that belong to the current filter set.
    try {
      const response = await context.api.get<AuditQueryResponse>('/audit/query', {
        query: { ...filterQuery(), limit: PAGE_SIZE },
        signal: controller.signal,
      });
      if (destroyed || token !== loadToken) return;
      const carried = state.events;
      const inFlight = state.pending;
      state.pending = [];
      pendingKeys.clear();
      state.events = [];
      state.seen.clear();
      appendEvents(Array.isArray(response.events) ? response.events : []);
      appendEvents(carried);
      appendEvents(inFlight);
      state.cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
      state.hasMore = response.hasMore === true;
      state.loading = false;
      state.error = null;
      state.errorCode = null;
      renderBanner();
      renderNow();
      scheduleRender();
    } catch (error) {
      if (destroyed || token !== loadToken) return;
      if (controller.signal.aborted) return;
      state.loading = false;
      state.error = describeError(error);
      state.errorCode = error instanceof ApiError ? error.code : null;
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
      state.errorCode = error instanceof ApiError ? error.code : null;
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
      state.statsErrorCode = null;
      scheduleRender();
    } catch (error) {
      if (destroyed || token !== statsToken || controller.signal.aborted) return;
      state.stats = null;
      state.statsError = describeError(error);
      state.statsErrorCode = error instanceof ApiError ? error.code : null;
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
      const hint = errorActionHint(error instanceof ApiError ? error.code : undefined);
      toast(`导出失败：${describeError(error)}。${hint}`, 'error');
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

  // -------------------------------------------------------------------------
  // Live stream (SSE) with the 2s poll as fallback
  // -------------------------------------------------------------------------

  function syncLiveStream(): void {
    if (state.filters.live) startStream();
    else stopStream();
  }

  function stopStream(): void {
    stream?.close();
    stream = null;
    streamOpen = false;
  }

  function startStream(): void {
    if (destroyed || !state.filters.live) return;
    stopStream();
    stream = context.api.stream('/audit/stream', {
      eventTypes: ['audit', 'message'],
      onEvent: (frame) => {
        const incoming = auditEventsFromStreamPayload(frame.data).filter(matchesLiveFilters);
        if (incoming.length > 0) enqueueBatch(incoming);
      },
      onGap: () => {
        state.notice = {
          text: '实时流出现缺口（服务端回放窗口已溢出），已触发全量刷新；较早事件可能缺失。',
          tone: 'queue',
        };
        renderBanner();
        refreshFromScratch();
      },
      onStateChange: (next) => {
        streamOpen = next === 'open';
        scheduleRender();
      },
      onFallbackPoll: () => {
        void pollLive();
      },
    });
  }

  /** Re-runs the first page and stats without dropping rows until the response lands. */
  function refreshFromScratch(): void {
    loadToken += 1;
    void loadFirstPage(loadToken);
    void loadStats();
  }

  /** The stream is unfiltered; keep only rows that match the current form filters. */
  function matchesLiveFilters(event: AuditEvent): boolean {
    const filters = state.filters;
    if (filters.event !== '' && event.event !== filters.event) return false;
    const time = parseEventTime(event);
    const from = parseTime(filters.from);
    const to = parseTime(filters.to);
    if (from !== null && (time === null || time < from)) return false;
    if (to !== null && (time === null || time > to)) return false;
    const client = filters.client.trim();
    if (client !== '' && eventText(event, 'client') !== client) return false;
    const binding = filters.binding.trim();
    if (binding !== '' && eventText(event, 'binding') !== binding) return false;
    const tool = filters.tool.trim();
    if (tool !== '' && eventText(event, 'tool') !== tool) return false;
    const server = filters.server.trim();
    if (server !== '') {
      // `ai_run` carries no `server`; the server-side filter also accepts `serverId`.
      const serverId = eventText(event, 'server') ?? eventText(event, 'serverId');
      if (serverId !== server) return false;
    }
    if (filters.status !== '' && (eventStatus(event) || 'ok') !== filters.status) return false;
    const minMs = filters.minMs.trim();
    if (minMs !== '') {
      const minimum = Number(minMs);
      const duration = eventDuration(event);
      if (!Number.isFinite(minimum) || duration === null || duration < minimum) return false;
    }
    return true;
  }

  async function pollLive(): Promise<void> {
    if (!state.filters.live || state.loading) return;
    pollTicks += 1;
    if (pollTicks % STATS_EVERY_TICKS === 0) void loadStats();
    // While the SSE stream is healthy it carries new events; this loop stays as the
    // disconnect fallback and still refreshes stats on its own cadence.
    if (streamOpen) return;

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
      const hint = errorActionHint(
        state.errorCode ?? undefined,
        '检查 /admin/api/audit/query 后重试。',
      );
      add(banner, notice(`查询失败：${state.error}。${hint}`, 'error'));
    }
    if (state.notice !== null) {
      add(banner, notice(state.notice.text, state.notice.tone));
    }
    if (state.statsError !== null) {
      const hint = errorActionHint(state.statsErrorCode ?? undefined, '缩小时间范围后重试。');
      add(banner, notice(`统计不可用：${state.statsError}。${hint}`, 'queue'));
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
      invalidateList();
      listHost.replaceChildren(loading('正在读取审计事件…'));
      return;
    }
    if (state.events.length === 0) {
      invalidateList();
      if (state.error !== null) {
        const hint = errorActionHint(
          state.errorCode ?? undefined,
          '检查 /admin/api/audit/query 后重试。',
        );
        listHost.replaceChildren(
          actionEmptyState('事件加载失败。', `${state.error}。${hint}`, [
            button('重试', () => refreshEvents(), {
              variant: 'primary',
              size: 'sm',
              icon: 'refresh',
            }),
            button('清空筛选', () => clearFilters(), { variant: 'secondary', size: 'sm' }),
          ]),
        );
      } else {
        const next = expandedRangeMinutes(rangeMinutes(state.filters));
        listHost.replaceChildren(
          actionEmptyState(
            '当前筛选没有事件。',
            '放宽时间范围或清空过滤条件；实时开关只追加新事件，不回填历史。',
            [
              button('清空筛选', () => clearFilters(), {
                variant: 'secondary',
                size: 'sm',
                icon: 'refresh',
              }),
              button('扩大时间范围', () => expandTimeRange(), {
                variant: 'ghost',
                size: 'sm',
                icon: 'clock',
                title: `切换到${rangeLabel(next)}`,
              }),
            ],
          ),
        );
      }
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
      subtitle:
        '每行一通调用：queueMs 是排队等待，ms 是执行耗时；左侧色条标出失败（红）与超时（橙）。',
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
    for (const column of currentColumns()) {
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
    if (state.filters.live) {
      listView.badges.appendChild(
        badge(streamOpen ? 'SSE 实时' : '轮询兜底', streamOpen ? 'info' : 'queue'),
      );
    }
    if (state.truncated) listView.badges.appendChild(badge('实时视图已截断', 'queue'));
    listView.spacer.style.height = `${state.events.length * ROW_HEIGHT}px`;
    listView.paint();
  }

  function invalidateList(): void {
    listView = null;
    if (paintFrame !== null) {
      window.cancelAnimationFrame(paintFrame);
      paintFrame = null;
    }
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

  function currentColumns(): readonly AuditColumn[] {
    return visibleAuditColumns(columnVisibility, narrow);
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

    for (const column of currentColumns()) {
      row.appendChild(buildColumnCell(column, event));
    }

    const chevron = icon('chevron-right', 14);
    chevron.style.flex = '0 0 auto';
    chevron.style.color = 'var(--text-faint)';
    row.appendChild(chevron);

    row.addEventListener('click', () => openEvent(event));
    row.addEventListener('keydown', (keyboard) => {
      if (keyboard.key === 'Enter' || keyboard.key === ' ') {
        keyboard.preventDefault();
        openEvent(event);
      }
    });
    return row;
  }

  function buildColumnCell(column: AuditColumn, event: AuditEvent): HTMLElement {
    switch (column.key) {
      case 'time': {
        const time = parseEventTime(event);
        return listCell(time === null ? '—' : formatTime(time), column.flex, {
          title: formatTimestamp(event.ts ?? null),
        });
      }
      case 'client':
        return listCell(eventClientLabel(event), column.flex);
      case 'server': {
        const serverId = eventText(event, 'server') ?? eventText(event, 'serverId');
        return listCell(serverId ?? '—', column.flex, {
          mono: true,
          title: serverId ?? 'server 缺失',
        });
      }
      case 'tool':
        return listCell(eventSubject(event), column.flex, { mono: true });
      case 'mode':
        return listCell(eventModeLabel(event), column.flex);
      case 'queueMs': {
        const queueMs = asNumber(event['queueMs']);
        const cell = listCell(formatDuration(queueMs), column.flex, {
          mono: true,
          align: 'right',
          title: queueMs === null ? 'queueMs 缺失' : `queueMs ${formatDuration(queueMs)}`,
        });
        if (queueMs !== null && queueMs >= 500) setStyle(cell, { color: 'var(--queue)' });
        return cell;
      }
      case 'ms': {
        const duration = eventDuration(event);
        const cell = listCell(formatDuration(duration), column.flex, {
          mono: true,
          align: 'right',
          title: duration === null ? 'ms 缺失' : `ms ${formatDuration(duration)}`,
        });
        if (duration !== null && duration >= SLOW_MS) setStyle(cell, { color: 'var(--slow)' });
        return cell;
      }
      case 'status':
        return buildStatusCell(event, column.flex);
      case 'eval':
        return listCell(evalLabel(event), column.flex, { mono: true });
      default:
        return listCell('—', column.flex);
    }
  }

  function buildStatusCell(event: AuditEvent, flex: number): HTMLElement {
    const status = eventStatus(event);
    const statusCell = el('span');
    setStyle(statusCell, {
      display: 'flex',
      alignItems: 'center',
      flex: `${flex} 1 0%`,
      minWidth: '0',
    });
    if (status === '') {
      add(statusCell, el('span', 'muted', '—'));
    } else {
      const pill = badge(status, statusTone(status));
      const outcome = eventText(event, 'outcome');
      if (outcome !== null) pill.title = `outcome ${outcome}`;
      add(statusCell, pill);
    }
    if (eventCancelled(event)) {
      // Display-only marker; `cancelled` stays out of the status vocabulary (§4.6).
      setStyle(statusCell, { gap: '4px' });
      add(statusCell, el('span', 'muted', '已取消'));
    }
    return statusCell;
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
    const parts = [
      time === null ? 'unknown time' : formatTimestamp(time),
      event.event ?? 'event',
      eventSubject(event),
    ];
    const serverId = eventText(event, 'serverId');
    if (serverId !== null) parts.push(serverId);
    const outcome = eventText(event, 'outcome');
    if (outcome !== null) parts.push(outcome);
    return parts.join(' ');
  }

  function evalLabel(event: AuditEvent): string {
    const exec = eventText(event, 'exec');
    const evalId = asNumber(event['evalId']);
    if (exec !== null && evalId !== null) return `${formatId(exec, 10)}#${evalId}`;
    if (exec !== null) return formatId(exec, 14);
    const taskId = eventText(event, 'evalTaskId') ?? eventText(event, 'taskId');
    return taskId === null ? '—' : formatId(taskId, 14);
  }

  /** `emptyState` plus an action row, so an empty table always suggests a next step. */
  function actionEmptyState(
    title: string,
    hint: string,
    actions: readonly HTMLElement[],
  ): HTMLElement {
    const box = emptyState(title, hint);
    const body = box.querySelector<HTMLElement>('.empty-body');
    if (body !== null && actions.length > 0) {
      const toolbar = el('div', 'toolbar');
      setStyle(toolbar, { marginTop: '10px', justifyContent: 'center' });
      add(toolbar, ...actions);
      body.appendChild(toolbar);
    }
    return box;
  }

  /** One-line "what this is / how to read it" hint inside a card. */
  function helpText(text: string): HTMLElement {
    const hint = el('p', 'muted', text);
    setStyle(hint, { fontSize: '11.5px', lineHeight: '1.55', maxWidth: '760px' });
    return hint;
  }

  function rangeLabel(minutes: number): string {
    const preset = RANGE_OPTIONS.find((option) => option.value === String(minutes));
    if (preset !== undefined) return preset.label;
    if (minutes % 1_440 === 0) return `最近 ${minutes / 1_440} 天`;
    if (minutes % 60 === 0) return `最近 ${minutes / 60} 小时`;
    return `最近 ${minutes} 分钟`;
  }

  function refreshEvents(): void {
    loadToken += 1;
    state.loading = true;
    state.error = null;
    state.errorCode = null;
    renderBanner();
    renderNow();
    void loadFirstPage(loadToken);
    void loadStats();
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
    const refresh = button('刷新', () => refreshEvents(), {
      variant: 'ghost',
      size: 'sm',
      icon: 'refresh',
    });
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
    drawer.open(eventSubject(event), content);

    void loadTrace(event, traceHost, ticket);
    void loadFrames(event, framesHost, ticket);
  }

  function buildEventSummary(event: AuditEvent): HTMLElement {
    const status = eventStatus(event);
    const actions: HTMLSpanElement[] = [];
    if (status !== '') actions.push(badge(status, statusTone(status)));
    if (eventCancelled(event)) actions.push(badge('已取消', 'info'));
    const card = cardSection({
      title: '事件概要',
      icon: 'info',
      ...(actions.length === 0 ? {} : { actions }),
    });

    const entries: Array<{ label: string; value: Node | string; mono?: boolean }> = [
      { label: '时间', value: formatTimestamp(event.ts ?? null), mono: true },
      { label: '事件', value: event.event ?? '—', mono: true },
      { label: 'client', value: eventText(event, 'client') ?? '—' },
      { label: 'binding', value: eventText(event, 'binding') ?? 'unbound', mono: true },
      { label: 'exec', value: eventText(event, 'exec') ?? '—', mono: true },
      { label: 'evalId', value: formatNumber(asNumber(event['evalId'])) },
      { label: '工具 / kind', value: eventSubject(event), mono: true },
      {
        label: 'server / serverId',
        value: eventText(event, 'server') ?? eventText(event, 'serverId') ?? '—',
        mono: true,
      },
      { label: 'kind', value: eventText(event, 'kind') ?? '—', mono: true },
      { label: 'outcome', value: eventText(event, 'outcome') ?? '—' },
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
      const hint = errorActionHint(
        error instanceof ApiError ? error.code : undefined,
        '检查 eval 轨迹接口后重试。',
      );
      host.replaceChildren(
        notice(`eval 轨迹读取失败：${describeError(error)}。${hint}`, 'error'),
      );
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
    add(
      card.body,
      helpText(
        '怎么读：每行一次工具调用，横轴为时间；半透明黄色段是排队（queueMs），实心条是执行（ms），红色条表示该次调用失败。',
      ),
    );
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
      const hint = errorActionHint(
        error instanceof ApiError ? error.code : undefined,
        '确认 mcp / id 与时间范围后重试。',
      );
      host.replaceChildren(notice(`协议帧读取失败：${describeError(error)}。${hint}`, 'error'));
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
    add(
      card.body,
      helpText(
        '怎么读：同一 request id 的请求与响应并排显示；左列是 params，右列是 result 或 error，durMs 为往返耗时。',
      ),
    );
    if (frames.length === 0) {
      add(
        card.body,
        emptyState(
          '没有匹配的协议帧。',
          '协议帧记录模式可能为 off（关闭后不落盘），或这对请求/响应不在当前筛选的时间范围内；可调整时间范围后重试。',
        ),
      );
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

  /** Tool for calls; `kind` for `ai_run`; the event name as the last resort. */
  function eventSubject(event: AuditEvent): string {
    return (
      eventText(event, 'tool') ??
      eventText(event, 'method') ??
      eventText(event, 'kind') ??
      event.event ??
      '—'
    );
  }

  function eventClientLabel(event: AuditEvent): string {
    if (event.event === 'ai_run') {
      const client = eventText(event, 'client') ?? 'admin';
      const serverId = eventText(event, 'serverId') ?? eventText(event, 'server');
      return serverId === null ? client : `${client} · ${serverId}`;
    }
    return eventText(event, 'client') ?? eventText(event, 'binding') ?? '—';
  }

  function eventModeLabel(event: AuditEvent): string {
    if (event.event === 'ai_run') {
      const outcome = eventText(event, 'outcome');
      const trigger = eventText(event, 'trigger');
      if (outcome !== null && trigger !== null) return `${outcome} · ${trigger}`;
      return outcome ?? trigger ?? '—';
    }
    return eventText(event, 'mode') ?? eventText(event, 'concurrency') ?? '—';
  }

  function eventDuration(event: AuditEvent): number | null {
    return (
      asNumber(event['ms']) ??
      asNumber(event['durationMs']) ??
      asNumber(event['elapsedMs']) ??
      asNumber(event['durMs'])
    );
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

  renderRangeSummary();
  renderNow();
  void loadFirstPage(loadToken);
  void loadStats();
  syncLiveStream();

  return {
    element: section,
    destroy(): void {
      destroyed = true;
      drawerTicket += 1;
      narrowMedia?.removeEventListener('change', onNarrowChange);
      stopStream();
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

/** Status mapping shared by the table, trend and live filter (`docs/03 §4.6`).
 *
 * Mirrors the server-side mapping in `server/src/audit/query.ts` so the live SSE rows,
 * the trend buckets and `/audit/query?status=` agree. For `eval_end` only
 * `outcome=timeout` is `timeout`: every other outcome — including `cancelled`, `failed`
 * and `worker_dead` — is `ok`, so cancellation is surfaced through
 * {@link eventCancelled} instead of a status value. For `tool_result` only `ok=false` is
 * `error`; `ai_run` uses its `outcome` (`error`/`ok`, design 08 §2.4) because the admin
 * AI call has no `ok` column. Other event types keep a display-only fallback.
 */
export function eventStatus(event: AuditEvent): string {
  const explicit = event['status'];
  if (typeof explicit === 'string' && explicit !== '') return normalizeExplicitStatus(explicit);
  if (event.event === 'tool_result') return event['ok'] === false ? 'error' : 'ok';
  if (event.event === 'eval_end') return event['outcome'] === 'timeout' ? 'timeout' : 'ok';
  if (event.event === 'ai_run') return event['outcome'] === 'error' ? 'error' : 'ok';
  // Other events may still carry `outcome`; keep a display-friendly fallback for those
  // without letting `cancelled` leak into the status vocabulary.
  const outcome = event['outcome'];
  if (typeof outcome === 'string' && outcome !== '') {
    const normalized = outcome.toLowerCase();
    if (normalized === 'timeout') return 'timeout';
    if (normalized === 'failed' || normalized === 'error') return 'error';
    return 'ok';
  }
  if (event['ok'] === true) return 'ok';
  if (event['ok'] === false) return 'error';
  return '';
}

/** `cancelled` is display-only (`design 03 §4.6`); it never participates in status filters. */
function normalizeExplicitStatus(status: string): string {
  const normalized = status.toLowerCase();
  return normalized === 'cancelled' || normalized === 'canceled' ? 'ok' : status;
}

/** Display-only cancellation hint for the list and drawer; does not affect filtering. */
export function eventCancelled(event: AuditEvent): boolean {
  const outcome = event['outcome'];
  if (typeof outcome !== 'string' || outcome === '') return false;
  const normalized = outcome.toLowerCase();
  return normalized === 'cancelled' || normalized === 'canceled';
}

/**
 * Normalizes one `/audit/stream` payload. The server publishes one event object per
 * frame; arrays and `{ events: [...] }` wrappers are accepted for forward compatibility,
 * and malformed frames are ignored instead of breaking the live view.
 */
export function auditEventsFromStreamPayload(data: unknown): AuditEvent[] {
  if (Array.isArray(data)) return data.filter(isAuditEvent);
  if (isRecord(data)) {
    const nested = data['events'];
    if (Array.isArray(nested)) return nested.filter(isAuditEvent);
    if (isAuditEvent(data)) return [data];
  }
  return [];
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return isRecord(value) && typeof value['ts'] === 'string' && typeof value['event'] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  const fields = [
    'ts',
    'event',
    'exec',
    'evalId',
    'callSeq',
    'id',
    'rpcId',
    'tool',
    'taskId',
    'mcp',
    'kind',
    'serverId',
    'proposalId',
  ];
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

// ---------------------------------------------------------------------------
// Filter and column persistence (pure; storage access is guarded separately)
// ---------------------------------------------------------------------------

/** First-entry defaults: the last hour (local time), live on, no other filters. */
export function defaultAuditFilters(now: number = Date.now()): AuditFilters {
  return {
    from: toDateTimeLocal(now - Number(DEFAULT_RANGE) * 60_000),
    to: '',
    event: '',
    client: '',
    binding: '',
    tool: '',
    server: '',
    status: '',
    minMs: '',
    live: true,
    range: DEFAULT_RANGE,
  };
}

/**
 * Reads the versioned filter record. Preset ranges are recomputed against `now` so
 * "最近 15 分钟" means the last 15 minutes on the next visit, not a stale window;
 * custom ranges keep their stored from/to. Corrupt or unknown payloads fall back to
 * {@link defaultAuditFilters}.
 */
export function parsePersistedAuditFilters(
  raw: string | null,
  now: number = Date.now(),
): AuditFilters {
  const fallback = defaultAuditFilters(now);
  if (raw === null || raw.trim() === '') return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed) || parsed['version'] !== STORAGE_VERSION) return fallback;
  const range = parsed['range'];
  if (typeof range !== 'string') return fallback;

  let from: string;
  let to: string;
  if (range !== '') {
    if (!isPresetRange(range)) return fallback;
    from = toDateTimeLocal(now - Number(range) * 60_000);
    to = '';
  } else {
    const storedFrom = parsed['from'];
    const storedTo = parsed['to'];
    if (typeof storedFrom !== 'string' || typeof storedTo !== 'string') return fallback;
    if (storedFrom.trim() === '' && storedTo.trim() === '') return fallback;
    if (storedFrom.trim() !== '' && !isDateTimeLocal(storedFrom)) return fallback;
    if (storedTo.trim() !== '' && !isDateTimeLocal(storedTo)) return fallback;
    from = storedFrom;
    to = storedTo;
  }

  return {
    from,
    to,
    event: pickOption(parsed['event'], EVENT_OPTIONS),
    client: pickString(parsed['client']),
    binding: pickString(parsed['binding']),
    tool: pickString(parsed['tool']),
    server: pickString(parsed['server']),
    status: pickOption(parsed['status'], STATUS_OPTIONS),
    minMs: pickMinMs(parsed['minMs']),
    live: typeof parsed['live'] === 'boolean' ? parsed['live'] : true,
    range,
  };
}

export function serializeAuditFilters(filters: AuditFilters): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    range: filters.range,
    from: filters.from,
    to: filters.to,
    event: filters.event,
    client: filters.client,
    binding: filters.binding,
    tool: filters.tool,
    server: filters.server,
    status: filters.status,
    minMs: filters.minMs,
    live: filters.live,
  });
}

/** Preset minutes when `range` is set; otherwise the span of a custom range. */
export function rangeMinutes(
  filters: Pick<AuditFilters, 'range' | 'from' | 'to'>,
  now: number = Date.now(),
): number | null {
  if (isPresetRange(filters.range)) return Number(filters.range);
  const from = parseTime(filters.from);
  if (from === null) return null;
  const to = parseTime(filters.to) ?? now;
  return Math.max(0, (to - from) / 60_000);
}

/** Next larger preset; unknown/empty spans start at the one-hour default. */
export function nextRangeMinutes(current: number | null): number {
  const fallback = Number(DEFAULT_RANGE);
  if (current === null || !Number.isFinite(current) || current <= 0) return fallback;
  return (
    PRESET_MINUTES.find((minutes) => minutes > current) ??
    PRESET_MINUTES[PRESET_MINUTES.length - 1] ??
    fallback
  );
}

/** "扩大时间范围" target: next preset, or twice the span once past the last preset. */
export function expandedRangeMinutes(current: number | null): number {
  if (current === null || !Number.isFinite(current) || current <= 0) {
    return Number(DEFAULT_RANGE);
  }
  const next = nextRangeMinutes(current);
  return next > current ? next : current * 2;
}

/** All columns start visible; the picker persists one boolean per column. */
export function defaultColumnVisibility(): Record<string, boolean> {
  const visibility: Record<string, boolean> = {};
  for (const column of AUDIT_COLUMNS) visibility[column.key] = true;
  return visibility;
}

/** Corrupt payloads, a version mismatch or a non-object `columns` use the defaults. */
export function parsePersistedColumns(raw: string | null): Record<string, boolean> {
  const fallback = defaultColumnVisibility();
  if (raw === null || raw.trim() === '') return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed) || parsed['version'] !== STORAGE_VERSION) return fallback;
  const stored = parsed['columns'];
  if (!isRecord(stored)) return fallback;

  const visibility = { ...fallback };
  for (const column of AUDIT_COLUMNS) {
    const value = stored[column.key];
    if (typeof value === 'boolean') visibility[column.key] = value;
  }
  return visibility;
}

export function serializeColumnVisibility(visibility: Record<string, boolean>): string {
  const columns: Record<string, boolean> = {};
  for (const column of AUDIT_COLUMNS) columns[column.key] = visibility[column.key] !== false;
  return JSON.stringify({ version: STORAGE_VERSION, columns });
}

/** Fixed columns ignore the picker; secondary columns disappear on narrow viewports. */
export function visibleAuditColumns(
  visibility: Record<string, boolean>,
  narrow: boolean,
): readonly AuditColumn[] {
  return AUDIT_COLUMNS.filter((column) => {
    if (column.fixed !== true && visibility[column.key] === false) return false;
    return !(narrow && column.secondary === true);
  });
}

function isPresetRange(value: string): boolean {
  return RANGE_OPTIONS.some((option) => option.value !== '' && option.value === value);
}

/** Accepts the browser `datetime-local` shape; a bare date would silently clear the input. */
function isDateTimeLocal(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(value) &&
    parseTime(value) !== null
  );
}

function pickOption(value: unknown, entries: ReadonlyArray<{ value: string }>): string {
  return typeof value === 'string' && entries.some((entry) => entry.value === value) ? value : '';
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pickMinMs(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? value : '';
}

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked storage must not break filtering or the column picker.
  }
}
