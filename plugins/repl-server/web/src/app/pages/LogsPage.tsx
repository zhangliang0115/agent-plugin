/** Logs page: filters, live event table, JSONL export and an event drawer. */
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader, stateLabel } from '../components/common.tsx';
import { JsonView } from '../components/JsonView.tsx';
import { PayloadViewer } from '../components/PayloadViewer.tsx';
import { ScriptInfoCard } from '../components/ScriptInfoCard.tsx';
import { payloadView } from '../../lib/payload-view.ts';
import { scriptInfoFromEvent } from '../../lib/script-info.ts';
import { ApiError, type EventStream, type StreamState } from '../../lib/api.ts';
import {
  aiRunKindLabel,
  aiRunTriggerLabel,
  AUDIT_EVENT_NAMES,
  eventLabel,
  eventSubject,
} from '../../lib/audit-labels.ts';
import {
  listOptions,
  mergeBindings,
  mergeValues,
  optionLabel,
  type LabeledOption,
} from '../../lib/filter-options.ts';
import {
  formatDuration,
  formatId,
  formatNumber,
  formatPercent,
  formatTimestamp,
} from '../../lib/format.ts';

const { Text } = Typography;

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

type StatsGroupBy = 'server' | 'tool' | 'client' | 'status';

interface AuditStatsGroup {
  key: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
  queueAvgMs: number | null;
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
  groupBy?: StatsGroupBy | null;
  groups?: AuditStatsGroup[];
}

interface AuditFilters {
  from: string;
  to: string;
  events: string[];
  clientNames: string[];
  clientVersions: string[];
  bindings: string[];
  tools: string[];
  servers: string[];
  statuses: string[];
  minMs: string;
  /** Exact `scriptId` on script-mode eval events; empty means no filter. */
  scriptId: string;
  live: boolean;
  /** Preset minutes as a string (`'60'`); empty means a custom from/to range. */
  range: string;
}

interface FilterOptions {
  clients: string[];
  versions: string[];
  bindings: Array<{ value: string; label: string }>;
  tools: string[];
  servers: Array<{ value: string; label: string }>;
}

interface ClientsResponse {
  clients: Array<{ id: string; label: string }>;
  sessions: Array<{ clientName: string; clientVersion: string }>;
}

interface ServersResponse {
  servers: Array<{ id: string; label: string }>;
}

const MAX_EVENTS = 5_000;
const BATCH_MS = 200;
const PAGE_SIZE = 400;
const POLL_MS = 2_000;
const STATS_EVERY_TICKS = 5;
const SLOW_MS = 1_000;
const DEFAULT_RANGE = '60';

const GROUP_OPTIONS: Array<{ value: '' | StatsGroupBy; label: string }> = [
  { value: '', label: '不分组' },
  { value: 'server', label: '按来源（server）' },
  { value: 'tool', label: '按工具' },
  { value: 'client', label: '按客户端' },
  { value: 'status', label: '按状态' },
];

const RANGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '15', label: '最近 15 分钟' },
  { value: '60', label: '最近 1 小时' },
  { value: '360', label: '最近 6 小时' },
  { value: '1440', label: '最近 24 小时' },
  { value: '10080', label: '最近 7 天' },
  { value: '', label: '自定义时间' },
];

const EVENT_OPTIONS: Array<{ value: string; label: string }> = AUDIT_EVENT_NAMES.map(
  (value) => ({ value, label: eventLabel(value) }),
);

const STATUS_OPTIONS: Array<{ value: string; label: string }> = (
  ['ok', 'error', 'timeout'] as const
).map((value) => ({ value, label: stateLabel(value) }));

const EMPTY_FILTER_OPTIONS: FilterOptions = {
  clients: [],
  versions: [],
  bindings: [],
  tools: [],
  servers: [],
};


export function LogsPage(): React.ReactElement {
  const api = useApi();
  const { message } = AntApp.useApp();
  const [initialFilters] = useState<AuditFilters>(() => readFiltersFromHash());
  const [draft, setDraft] = useState<AuditFilters>(initialFilters);
  const [applied, setApplied] = useState<AuditFilters>(initialFilters);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<'' | StatsGroupBy>('');
  const [streamState, setStreamState] = useState<StreamState>('closed');
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);

  const aliveRef = useRef(true);
  const appliedRef = useRef<AuditFilters>(applied);

  useEffect(() => {
    let alive = true;
    void Promise.allSettled([
      api.get<ClientsResponse>('/clients'),
      api.get<ServersResponse>('/servers'),
    ]).then(([clients, servers]) => {
      if (!alive) return;
      const delta: Partial<FilterOptions> = {};
      if (clients.status === 'fulfilled') {
        delta.clients = (clients.value.sessions ?? []).map((session) => session.clientName);
        delta.versions = (clients.value.sessions ?? []).map((session) => session.clientVersion);
        delta.bindings = (clients.value.clients ?? []).map((binding) => ({
          value: binding.id,
          label: binding.label === binding.id ? binding.id : `${binding.label} (${binding.id})`,
        }));
      }
      if (servers.status === 'fulfilled') {
        delta.servers = (servers.value.servers ?? []).map((server) => ({
          value: server.id,
          label: server.label === server.id ? server.id : `${server.label} (${server.id})`,
        }));
      }
      rememberFilterOptions(delta);
    });
    return () => {
      alive = false;
    };
  }, [api]);

  // Tool options accumulate from every loaded page; a filter change never shrinks them.
  useEffect(() => {
    if (events.length === 0) return;
    const tools: string[] = [];
    for (const event of events) {
      const tool = eventText(event, 'tool');
      if (tool !== null) tools.push(tool);
    }
    rememberFilterOptions({ tools });
  }, [events]);
  const eventsRef = useRef<AuditEvent[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<AuditEvent[]>([]);
  const pendingKeysRef = useRef<Set<string>>(new Set());
  const batchTimerRef = useRef<number | null>(null);
  const revokeTimerRef = useRef<number | null>(null);
  const loadTokenRef = useRef(0);
  const statsTokenRef = useRef(0);
  const groupByRef = useRef<'' | StatsGroupBy>('');
  const streamOpenRef = useRef(false);
  const loadingRef = useRef(true);
  const pollTicksRef = useRef(0);
  const streamRef = useRef<EventStream | null>(null);

  useEffect(() => {
    appliedRef.current = applied;
  }, [applied]);

  const appendBatch = useCallback((incoming: readonly AuditEvent[]): void => {
    const map = new Map<string, AuditEvent>();
    for (const event of eventsRef.current) map.set(eventKey(event), event);
    for (const event of incoming) {
      const key = eventKey(event);
      if (!map.has(key)) map.set(key, event);
    }
    let next = [...map.values()].sort(compareByTime);
    if (next.length > MAX_EVENTS) {
      next = next.slice(next.length - MAX_EVENTS);
      setTruncated(true);
    }
    eventsRef.current = next;
    setEvents(next);
  }, []);

  const flushBatch = useCallback((): void => {
    if (pendingRef.current.length === 0) {
      pendingKeysRef.current.clear();
      return;
    }
    const batch = pendingRef.current;
    pendingRef.current = [];
    pendingKeysRef.current.clear();
    for (const event of batch) seenRef.current.add(eventKey(event));
    appendBatch(batch);
  }, [appendBatch]);

  const enqueueBatch = useCallback(
    (incoming: readonly AuditEvent[]): void => {
      for (const event of incoming) {
        const key = eventKey(event);
        if (seenRef.current.has(key) || pendingKeysRef.current.has(key)) continue;
        pendingKeysRef.current.add(key);
        pendingRef.current.push(event);
      }
      if (pendingRef.current.length === 0) return;
      if (document.visibilityState === 'hidden') return;
      if (batchTimerRef.current !== null) return;
      batchTimerRef.current = window.setTimeout(() => {
        batchTimerRef.current = null;
        flushBatch();
      }, BATCH_MS);
    },
    [flushBatch],
  );

  const loadFirstPage = useCallback(
    async (filters: AuditFilters, token: number): Promise<void> => {
      try {
        const response = await api.get<AuditQueryResponse>('/logs/query', {
          query: { ...filterQuery(filters), limit: PAGE_SIZE },
        });
        if (!aliveRef.current || token !== loadTokenRef.current) return;
        const responseEvents = Array.isArray(response.events) ? response.events : [];
        const carried = eventsRef.current;
        const queued = pendingRef.current;
        pendingRef.current = [];
        pendingKeysRef.current.clear();
        const map = new Map<string, AuditEvent>();
        for (const event of [...responseEvents, ...carried, ...queued]) {
          const key = eventKey(event);
          if (!map.has(key)) map.set(key, event);
        }
        let merged = [...map.values()].sort(compareByTime);
        if (merged.length > MAX_EVENTS) {
          merged = merged.slice(merged.length - MAX_EVENTS);
          setTruncated(true);
        }
        eventsRef.current = merged;
        seenRef.current = new Set(merged.map(eventKey));
        setEvents(merged);
        setCursor(typeof response.nextCursor === 'string' ? response.nextCursor : null);
        setHasMore(response.hasMore === true);
        setError(null);
        setLoading(false);
        loadingRef.current = false;
      } catch (failure) {
        if (!aliveRef.current || token !== loadTokenRef.current) return;
        const text = failureText(failure);
        setError(text);
        setLoading(false);
        loadingRef.current = false;
        message.error(`查询失败：${text}`);
      }
    },
    [api, message],
  );

  const loadStats = useCallback(
    async (filters: AuditFilters): Promise<void> => {
      const token = ++statsTokenRef.current;
      try {
        const next = await api.get<AuditStats>('/logs/stats', {
          query: {
            ...filterQuery(filters),
            groupBy: groupByRef.current === '' ? undefined : groupByRef.current,
          },
        });
        if (!aliveRef.current || token !== statsTokenRef.current) return;
        setStats(next);
        setStatsError(null);
      } catch (failure) {
        if (!aliveRef.current || token !== statsTokenRef.current) return;
        setStats(null);
        setStatsError(failureText(failure));
      }
    },
    [api],
  );

  function changeGroupBy(value: '' | StatsGroupBy): void {
    groupByRef.current = value;
    setGroupBy(value);
    void loadStats(appliedRef.current);
  }

  const refreshFromScratch = useCallback((): void => {
    const token = ++loadTokenRef.current;
    void loadFirstPage(appliedRef.current, token);
    void loadStats(appliedRef.current);
  }, [loadFirstPage, loadStats]);

  const pollLive = useCallback((): void => {
    const filters = appliedRef.current;
    if (!filters.live || loadingRef.current) return;
    pollTicksRef.current += 1;
    if (pollTicksRef.current % STATS_EVERY_TICKS === 0) void loadStats(filters);
    // While the SSE stream is healthy it carries new events; this loop stays as the
    // disconnect fallback and still refreshes stats on its own cadence.
    if (streamOpenRef.current) return;

    const last = latestTimestamp(eventsRef.current);
    const from = last ?? new Date(Date.now() - 60_000).toISOString();
    const token = loadTokenRef.current;
    api
      .get<AuditQueryResponse>('/logs/query', {
        query: { ...filterQuery(filters), from, limit: 200 },
      })
      .then((response) => {
        if (!aliveRef.current || token !== loadTokenRef.current || !appliedRef.current.live) return;
        const incoming = Array.isArray(response.events) ? response.events : [];
        if (incoming.length > 0) enqueueBatch(incoming);
      })
      .catch(() => {
        // A transient polling failure is retried by the next tick.
      });
  }, [api, enqueueBatch, loadStats]);

  const commitFilters = useCallback(
    (next: AuditFilters): void => {
      setDraft(next);
      setApplied(next);
      appliedRef.current = next;
      writeFiltersToHash(next);
      seenRef.current.clear();
      pendingRef.current = [];
      pendingKeysRef.current.clear();
      if (batchTimerRef.current !== null) {
        window.clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      eventsRef.current = [];
      setEvents([]);
      setPage(1);
      setCursor(null);
      setHasMore(false);
      setTruncated(false);
      setError(null);
      setNotice(null);
      setStats(null);
      setStatsError(null);
      setLoading(true);
      loadingRef.current = true;
      const token = ++loadTokenRef.current;
      void loadFirstPage(next, token);
      void loadStats(next);
    },
    [loadFirstPage, loadStats],
  );

  useEffect(() => {
    aliveRef.current = true;
    const token = loadTokenRef.current;
    void loadFirstPage(appliedRef.current, token);
    void loadStats(appliedRef.current);
    return () => {
      aliveRef.current = false;
    };
  }, [loadFirstPage, loadStats]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') pollLive();
    }, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        flushBatch();
        pollLive();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [flushBatch, pollLive]);

  useEffect(() => {
    if (!applied.live) {
      streamOpenRef.current = false;
      setStreamState('closed');
      return;
    }
    const current = api.stream('/logs/stream', {
      eventTypes: ['audit', 'message'],
      onEvent: (frame) => {
        const incoming = auditEventsFromStreamPayload(frame.data).filter((event) =>
          matchesFilters(event, appliedRef.current),
        );
        if (incoming.length > 0) enqueueBatch(incoming);
      },
      onGap: () => {
        setNotice(
          '实时流出现缺口（服务端回放窗口已溢出），已触发全量刷新；较早事件可能缺失。',
        );
        refreshFromScratch();
      },
      onStateChange: (next) => {
        streamOpenRef.current = next === 'open';
        if (aliveRef.current) setStreamState(next);
      },
      onFallbackPoll: () => pollLive(),
    });
    streamRef.current = current;
    streamOpenRef.current = current.state === 'open';
    setStreamState(current.state);
    return () => {
      current.close();
      if (streamRef.current === current) streamRef.current = null;
      streamOpenRef.current = false;
    };
  }, [api, applied.live, enqueueBatch, pollLive, refreshFromScratch]);

  useEffect(
    () => () => {
      if (batchTimerRef.current !== null) window.clearTimeout(batchTimerRef.current);
      if (revokeTimerRef.current !== null) window.clearTimeout(revokeTimerRef.current);
    },
    [],
  );

  const refreshEvents = useCallback((): void => {
    setLoading(true);
    loadingRef.current = true;
    setError(null);
    refreshFromScratch();
  }, [refreshFromScratch]);

  useEffect(() => {
    const onRefresh = (): void => refreshEvents();
    window.addEventListener('repl:refresh', onRefresh);
    return () => window.removeEventListener('repl:refresh', onRefresh);
  }, [refreshEvents]);

  function applyDraft(): void {
    commitFilters({ ...draft });
  }

  function rememberFilterOptions(delta: Partial<FilterOptions>): void {
    setFilterOptions((previous) => {
      const clients = mergeValues(previous.clients, delta.clients ?? []);
      const versions = mergeValues(previous.versions, delta.versions ?? []);
      const tools = mergeValues(previous.tools, delta.tools ?? []);
      const bindings = mergeBindings(previous.bindings, delta.bindings ?? []);
      const servers = mergeBindings(previous.servers, delta.servers ?? []);
      if (
        clients === previous.clients
        && versions === previous.versions
        && tools === previous.tools
        && bindings === previous.bindings
        && servers === previous.servers
      ) {
        return previous;
      }
      return { clients, versions, bindings, tools, servers };
    });
  }

  function clearFilters(): void {
    commitFilters(defaultAuditFilters());
  }

  function changeRange(value: string): void {
    if (value === '') {
      setDraft({ ...draft, range: '' });
      return;
    }
    commitFilters({
      ...draft,
      range: value,
      from: toDateTimeLocal(Date.now() - Number(value) * 60_000),
      to: '',
    });
  }

  function changeLive(checked: boolean): void {
    setDraft({ ...draft, live: checked });
    const nextApplied = { ...appliedRef.current, live: checked };
    appliedRef.current = nextApplied;
    setApplied(nextApplied);
    writeFiltersToHash(nextApplied);
  }

  async function loadMore(): Promise<void> {
    if (loadingMore || cursor === null) return;
    setLoadingMore(true);
    const token = loadTokenRef.current;
    try {
      const response = await api.get<AuditQueryResponse>('/logs/query', {
        query: { ...filterQuery(appliedRef.current), limit: PAGE_SIZE, cursor },
      });
      if (!aliveRef.current || token !== loadTokenRef.current) return;
      appendBatch(Array.isArray(response.events) ? response.events : []);
      setCursor(typeof response.nextCursor === 'string' ? response.nextCursor : null);
      setHasMore(response.hasMore === true);
    } catch (failure) {
      if (!aliveRef.current || token !== loadTokenRef.current) return;
      const text = failureText(failure);
      setError(text);
      message.error(`加载更多失败：${text}`);
    } finally {
      if (aliveRef.current && token === loadTokenRef.current) setLoadingMore(false);
    }
  }

  async function exportEvents(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    try {
      const text = await api.get<string>('/logs/export', {
        query: filterQuery(appliedRef.current),
      });
      if (!aliveRef.current) return;
      const blob = new Blob([text], { type: 'application/x-ndjson;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `events-${exportStamp()}.jsonl`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (revokeTimerRef.current !== null) window.clearTimeout(revokeTimerRef.current);
      revokeTimerRef.current = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        revokeTimerRef.current = null;
      }, 5_000);
      message.success('已导出当前筛选结果');
    } catch (failure) {
      if (!aliveRef.current) return;
      message.error(`导出失败：${failureText(failure)}`);
    } finally {
      if (aliveRef.current) setExporting(false);
    }
  }

  function closeDrawer(): void {
    setSelected(null);
  }

  function openEvent(event: AuditEvent): void {
    setSelected(event);
  }

  const columns = useMemo<TableProps<AuditEvent>['columns']>(
    () => [
      {
        title: '时间',
        key: 'time',
        width: 170,
        render: (_value, event) => (
          <span className="mono">{formatTimestamp(parseEventTime(event) ?? event.ts ?? null)}</span>
        ),
      },
      {
        title: '事件类型',
        key: 'event',
        width: 130,
        ellipsis: true,
        render: (_value, event) => eventLabel(event.event),
      },
      {
        title: '客户端',
        key: 'client',
        width: 170,
        ellipsis: true,
        render: (_value, event) => eventClientLabel(event),
      },
      {
        title: '服务端（server）',
        key: 'server',
        width: 140,
        ellipsis: true,
        render: (_value, event) => (
          <span className="mono">
            {eventText(event, 'server') ?? eventText(event, 'serverId') ?? '—'}
          </span>
        ),
      },
      {
        title: '对象',
        key: 'tool',
        ellipsis: true,
        render: (_value, event) => <span className="mono">{eventSubject(event)}</span>,
      },
      {
        title: '模式',
        key: 'mode',
        width: 110,
        ellipsis: true,
        render: (_value, event) => eventModeLabel(event),
      },
      {
        title: '排队（ms）',
        key: 'queueMs',
        width: 90,
        align: 'right',
        render: (_value, event) => {
          const queueMs = asNumber(event['queueMs']);
          const text = formatDuration(queueMs);
          return queueMs !== null && queueMs >= 500 ? (
            <Text type="warning" className="mono">
              {text}
            </Text>
          ) : (
            <span className="mono">{text}</span>
          );
        },
      },
      {
        title: '耗时（ms）',
        key: 'ms',
        width: 80,
        align: 'right',
        render: (_value, event) => {
          const duration = eventDuration(event);
          const text = formatDuration(duration);
          return duration !== null && duration >= SLOW_MS ? (
            <Text type="warning" className="mono">
              {text}
            </Text>
          ) : (
            <span className="mono">{text}</span>
          );
        },
      },
      {
        title: '状态',
        key: 'status',
        width: 110,
        render: (_value, event) => <AuditStatusCell event={event} />,
      },
    ],
    [],
  );

  const rows = useMemo(() => [...events].reverse(), [events]);
  const badge = liveBadge(applied, streamState);
  const summary = hasMore
    ? `已加载 ${formatNumber(events.length)} 条（上限 ${formatNumber(MAX_EVENTS)}，还有更多）`
    : `已加载 ${formatNumber(events.length)} 条（上限 ${formatNumber(MAX_EVENTS)}）`;

  return (
    <div className="page">
      <PageHeader
        title="事件"
        description="审计事件列表与详情；一行一条审计事件，不是请求或协议帧。请求与协议帧在「请求记录」查看。筛选在服务端完成，实时视图最多保留 5000 条。"
        actions={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={refreshEvents}>
              刷新
            </Button>
            <Button
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={() => void exportEvents()}
            >
              导出 JSONL
            </Button>
          </Space>
        }
      />

      <Row gutter={[12, 12]}>
        <Col flex="1 1 170px">
          <StatsCard
            label="工具调用量"
            value={stats === null ? '—' : formatNumber(stats.calls)}
            hint="tool_result 事件数"
          />
        </Col>
        <Col flex="1 1 170px">
          <StatsCard
            label="错误率"
            value={stats === null ? '—' : formatPercent(stats.errorRate)}
            hint={stats === null ? '等待统计' : `${formatNumber(stats.errors)} 个错误`}
            danger={stats !== null && stats.errorRate > 0}
          />
        </Col>
        <Col flex="1 1 170px">
          <StatsCard label="p50" value={stats === null ? '—' : formatDuration(stats.p50)} hint="工具调用耗时中位数" />
        </Col>
        <Col flex="1 1 170px">
          <StatsCard
            label="p95"
            value={stats === null ? '—' : formatDuration(stats.p95)}
            hint="长尾耗时"
            danger={stats !== null && stats.p95 !== null && stats.p95 >= SLOW_MS}
          />
        </Col>
        <Col flex="1 1 170px">
          <StatsCard
            label="排队均值"
            value={stats === null ? '—' : formatDuration(stats.queueAvgMs)}
            hint="queueMs 平均"
          />
        </Col>
      </Row>
      {statsError === null ? null : (
        <Alert
          type="warning"
          showIcon
          message="统计不可用"
          description={`${statsError}。缩小时间范围后重试。`}
        />
      )}
      {stats === null ? null : (
        <Text type="secondary" style={{ fontSize: 11.5 }}>
          snapshot {formatId(stats.snapshotId, 12)} · 计算于 {formatTimestamp(stats.computedAt)} · 扫描{' '}
          {formatNumber(stats.scannedRows)} 行 · took {formatDuration(stats.tookMs)}
          {stats.cached ? ' · 缓存命中' : ''}；列表与统计可能来自不同扫描。
        </Text>
      )}

      <Card
        size="small"
        title="分组统计"
        extra={
          <Select
            size="small"
            style={{ width: 170 }}
            value={groupBy}
            options={GROUP_OPTIONS}
            onChange={(value) => changeGroupBy(value)}
          />
        }
      >
        {groupBy === '' ? (
          <Text type="secondary" style={{ fontSize: 11.5 }}>
            选择分组维度：按来源看官方内置工具与各 MCP server 的调用量，按工具看具体工具。统计口径是
            tool_result 事件。
          </Text>
        ) : (
          <Table<AuditStatsGroup>
            size="small"
            rowKey="key"
            loading={stats === null}
            dataSource={stats?.groups ?? []}
            pagination={false}
            columns={[
              {
                title: '分组',
                dataIndex: 'key',
                ellipsis: true,
                render: (value: string) => <span className="mono">{groupLabel(value)}</span>,
              },
              {
                title: '调用量',
                dataIndex: 'calls',
                width: 100,
                align: 'right',
                render: (value: number) => formatNumber(value),
              },
              {
                title: '错误率',
                dataIndex: 'errorRate',
                width: 100,
                align: 'right',
                render: (value: number) => formatPercent(value),
              },
              {
                title: 'p50',
                dataIndex: 'p50',
                width: 90,
                align: 'right',
                render: (value: number | null) => formatDuration(value),
              },
              {
                title: 'p95',
                dataIndex: 'p95',
                width: 90,
                align: 'right',
                render: (value: number | null) => formatDuration(value),
              },
              {
                title: '排队均值',
                dataIndex: 'queueAvgMs',
                width: 110,
                align: 'right',
                render: (value: number | null) => formatDuration(value),
              },
            ]}
            locale={{ emptyText: '当前筛选没有 tool_result 事件' }}
          />
        )}
      </Card>

      <Card
        title="筛选"
        extra={
          <Space>
            <Badge status={badge.status} text={badge.text} />
            {streamState === 'fallback' ? <Tag color="gold">轮询兜底</Tag> : null}
          </Space>
        }
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space wrap size={[12, 10]}>
            <Field label="时间范围">
              <Select
                value={draft.range}
                style={{ width: 150 }}
                options={RANGE_OPTIONS}
                onChange={changeRange}
              />
            </Field>
            <Field label="从">
              <DatePicker
                showTime={{ format: 'HH:mm:ss' }}
                format="YYYY-MM-DD HH:mm:ss"
                placeholder="选择时间"
                value={draft.from === '' ? null : dayjs(draft.from)}
                style={{ width: 200 }}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    from: value === null ? '' : value.format('YYYY-MM-DDTHH:mm:ss'),
                    range: '',
                  })
                }
              />
            </Field>
            <Field label="到（留空=至今）">
              <DatePicker
                showTime={{ format: 'HH:mm:ss' }}
                format="YYYY-MM-DD HH:mm:ss"
                placeholder="选择时间"
                value={draft.to === '' ? null : dayjs(draft.to)}
                style={{ width: 200 }}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    to: value === null ? '' : value.format('YYYY-MM-DDTHH:mm:ss'),
                    range: '',
                  })
                }
              />
            </Field>
            <Field label="事件类型">
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={draft.events}
                style={{ width: 230 }}
                options={EVENT_OPTIONS}
                onChange={(value) => setDraft({ ...draft, events: value })}
              />
            </Field>
            <Field label="状态">
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={draft.statuses}
                style={{ width: 170 }}
                options={STATUS_OPTIONS}
                onChange={(value) => setDraft({ ...draft, statuses: value })}
              />
            </Field>
            <Field label="工具">
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={draft.tools}
                placeholder="工具名"
                style={{ width: 230 }}
                options={listOptions(filterOptions.tools)}
                onChange={(value) => setDraft({ ...draft, tools: value })}
              />
            </Field>
          </Space>
          <Space wrap size={[12, 10]}>
            <Field label="客户端名称">
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={draft.clientNames}
                placeholder="客户端"
                style={{ width: 170 }}
                options={listOptions(filterOptions.clients)}
                onChange={(value) => setDraft({ ...draft, clientNames: value })}
              />
            </Field>
            <Field label="客户端版本">
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={draft.clientVersions}
                placeholder="版本"
                style={{ width: 140 }}
                options={listOptions(filterOptions.versions)}
                onChange={(value) => setDraft({ ...draft, clientVersions: value })}
              />
            </Field>
            <Field label="绑定（binding）">
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={draft.bindings}
                placeholder="binding"
                style={{ width: 210 }}
                options={filterOptions.bindings}
                onChange={(value) => setDraft({ ...draft, bindings: value })}
              />
            </Field>
            <Field label="服务端（server）">
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={draft.servers}
                placeholder="server"
                style={{ width: 200 }}
                options={filterOptions.servers}
                onChange={(value) => setDraft({ ...draft, servers: value })}
              />
            </Field>
            <Field label="最短耗时（ms）">
              <Input
                type="number"
                min={0}
                value={draft.minMs}
                placeholder="0"
                style={{ width: 110 }}
                onChange={(event) => setDraft({ ...draft, minMs: event.target.value })}
                onPressEnter={applyDraft}
              />
            </Field>
            <Field label="脚本 ID">
              <Input
                value={draft.scriptId}
                placeholder="s_..."
                style={{ width: 200 }}
                onChange={(event) => setDraft({ ...draft, scriptId: event.target.value })}
                onPressEnter={applyDraft}
              />
            </Field>
            <Field label="实时">
              <Switch
                checked={draft.live}
                checkedChildren="开"
                unCheckedChildren="关"
                onChange={changeLive}
              />
            </Field>
            <Field label="操作">
              <Space>
                <Button type="primary" onClick={applyDraft}>
                  应用
                </Button>
                <Button onClick={clearFilters}>清空筛选</Button>
              </Space>
            </Field>
          </Space>
        </Space>
      </Card>

      {error === null ? null : (
        <Alert
          type="error"
          showIcon
          message="事件加载失败"
          description={error}
          action={
            <Button size="small" onClick={refreshEvents}>
              重试
            </Button>
          }
        />
      )}
      {notice === null ? null : <Alert type="warning" showIcon message={notice} />}

      <Card
        title="事件列表"
        extra={
          <Space>
            {truncated ? <Tag color="gold">实时视图已截断</Tag> : null}
            <Text type="secondary" style={{ fontSize: 11.5 }}>
              {streamState === 'open' ? 'SSE 实时' : applied.live ? '轮询兜底' : '实时已暂停'}
            </Text>
          </Space>
        }
      >
        <Table<AuditEvent>
          size="small"
          rowKey={(event) => eventKey(event)}
          loading={loading && events.length === 0}
          dataSource={rows}
          columns={columns}
          pagination={{
            current: page,
            pageSize: 100,
            showSizeChanger: false,
            onChange: (next) => setPage(next),
            showTotal: (total) => `共 ${formatNumber(total)} 条`,
          }}
          scroll={{ x: 1_000, y: 520 }}
          onRow={(record) => ({
            onClick: () => openEvent(record),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openEvent(record);
              }
            },
            style: { cursor: 'pointer' },
            tabIndex: 0,
          })}
          locale={{
            emptyText: (
              <Empty
                description={
                  error === null ? '当前筛选没有事件。放宽时间范围或清空过滤条件。' : '事件加载失败'
                }
              />
            ),
          }}
        />
        <Space style={{ marginTop: 12 }}>
          <Text type="secondary">{summary}</Text>
          {hasMore ? (
            <Button size="small" loading={loadingMore} onClick={() => void loadMore()}>
              加载更多
            </Button>
          ) : null}
        </Space>
      </Card>

      <Drawer
        placement="left"
        open={selected !== null}
        onClose={closeDrawer}
        width={900}
        title={
          selected === null ? '事件详情' : <span className="mono">{eventSubject(selected)}</span>
        }
      >
        {selected === null ? null : (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Card size="small" title="事件概要">
              <Descriptions column={2} size="small">
                <Descriptions.Item label="时间">
                  <span className="mono">{formatTimestamp(selected.ts ?? null)}</span>
                </Descriptions.Item>
                <Descriptions.Item label="事件">
                  {eventLabel(selected.event)}
                </Descriptions.Item>
                <Descriptions.Item label="客户端名称">
                  {eventClientParts(selected).name || '—'}
                </Descriptions.Item>
                <Descriptions.Item label="客户端版本">
                  {eventClientParts(selected).version || '—'}
                </Descriptions.Item>
                <Descriptions.Item label="binding">
                  <BindingLabel
                    binding={eventText(selected, 'binding')}
                    options={filterOptions.bindings}
                  />
                </Descriptions.Item>
                <Descriptions.Item label="exec">
                  <span className="mono">{eventText(selected, 'exec') ?? '—'}</span>
                </Descriptions.Item>
                <Descriptions.Item label="evalId">
                  {formatNumber(asNumber(selected['evalId']))}
                </Descriptions.Item>
                <Descriptions.Item label="工具 / kind">
                  <span className="mono">{eventSubject(selected)}</span>
                </Descriptions.Item>
                <Descriptions.Item label="server / serverId">
                  <span className="mono">
                    {eventText(selected, 'server') ?? eventText(selected, 'serverId') ?? '—'}
                  </span>
                </Descriptions.Item>
                <Descriptions.Item label="kind">
                  {aiRunKindLabel(eventText(selected, 'kind'))}
                </Descriptions.Item>
                <Descriptions.Item label="outcome">
                  {stateLabel(eventText(selected, 'outcome') ?? '—')}
                </Descriptions.Item>
                <Descriptions.Item label="queueMs / ms">
                  {`${formatDuration(asNumber(selected['queueMs']))} / ${formatDuration(eventDuration(selected))}`}
                </Descriptions.Item>
                <Descriptions.Item label="状态">
                  {eventStatus(selected) === '' ? '—' : eventStatus(selected)}
                </Descriptions.Item>
                <Descriptions.Item label="结果字节">
                  {formatNumber(asNumber(selected['resultBytes'] ?? selected['bytes']))}
                </Descriptions.Item>
              </Descriptions>
              <Collapse
                size="small"
                items={[
                  {
                    key: 'raw',
                    label: '原始事件 JSON',
                    children: (
                      <JsonView value={selected} maxHeight={260} />
                    ),
                  },
                ]}
              />
            </Card>

            <ScriptInfoCard info={scriptInfoFromEvent(selected)} />

            <EventIO event={selected} />
          </Space>
        )}
      </Drawer>
    </div>
  );
}

/** Event-type-specific input/output fields; bodies come from `payload/` when large. */
function EventIO({ event }: { event: AuditEvent }): React.ReactElement | null {
  if (event.event === 'tool_call') {
    return (
      <Card size="small" title="输入 / 输出">
        <Descriptions column={2} size="small">
          <Descriptions.Item label="输入参数" span={2}>
            <PayloadViewer label="" view={payloadView(event, 'args')} maxHeight={220} />
          </Descriptions.Item>
          <Descriptions.Item label="模式">{eventText(event, 'mode') ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="等待 / 执行">
            {`${formatDuration(asNumber(event.queueMs))} / ${formatDuration(eventDuration(event))}`}
          </Descriptions.Item>
        </Descriptions>
      </Card>
    );
  }
  if (event.event === 'tool_result') {
    return (
      <Card size="small" title="输入 / 输出">
        <Descriptions column={2} size="small">
          <Descriptions.Item label="排队 / 耗时">
            {`${formatDuration(asNumber(event.queueMs))} / ${formatDuration(eventDuration(event))}`}
          </Descriptions.Item>
          <Descriptions.Item label="错误码">{eventText(event, 'errorCode') ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="状态">
            {eventStatus(event) === '' ? '—' : eventStatus(event)}
          </Descriptions.Item>
          <Descriptions.Item label="输出字节">{formatNumber(asNumber(event.outBytes))}</Descriptions.Item>
          {event.error === undefined ? null : (
            <Descriptions.Item label="错误" span={2}>
              <JsonView value={event.error} maxHeight={160} />
            </Descriptions.Item>
          )}
        </Descriptions>
        <div style={{ marginTop: 8 }}>
          <PayloadViewer label="返回内容" view={payloadView(event, 'result')} />
        </div>
      </Card>
    );
  }
  if (event.event === 'eval_start') {
    return (
      <Card size="small" title="输入 / 输出">
        <Descriptions column={2} size="small">
          <Descriptions.Item label="代码字节">{formatNumber(asNumber(event.codeBytes))}</Descriptions.Item>
          <Descriptions.Item label="超时（ms）">{formatNumber(asNumber(event.timeoutMs))}</Descriptions.Item>
          <Descriptions.Item label="异步">
            {event.async === undefined ? '—' : event.async === true ? '是' : '否'}
          </Descriptions.Item>
          <Descriptions.Item label="codeSha256">
            <span className="mono">{eventText(event, 'codeSha256') ?? '—'}</span>
          </Descriptions.Item>
          <Descriptions.Item label="代码前缀" span={2}>
            <pre
              className="mono"
              style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 220, overflow: 'auto' }}
            >
              {eventText(event, 'codePrefix') ?? '—'}
            </pre>
          </Descriptions.Item>
        </Descriptions>
      </Card>
    );
  }
  if (event.event === 'eval_end') {
    return (
      <Card size="small" title="输入 / 输出">
        <Descriptions column={2} size="small">
          <Descriptions.Item label="结果">
            {stateLabel(eventText(event, 'outcome') ?? '—')}
          </Descriptions.Item>
          <Descriptions.Item label="结果字节">{formatNumber(asNumber(event.resultBytes))}</Descriptions.Item>
          <Descriptions.Item label="工具调用数">{formatNumber(asNumber(event.calls))}</Descriptions.Item>
          <Descriptions.Item label="超时层">{eventText(event, 'layer') ?? '—'}</Descriptions.Item>
          {event.error === undefined ? null : (
            <Descriptions.Item label="错误" span={2}>
              <span className="mono">{eventText(event, 'error') ?? '—'}</span>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {label}
      </Text>
      {children}
    </div>
  );
}

function StatsCard({
  label,
  value,
  hint,
  danger = false,
}: {
  label: string;
  value: string;
  hint: string;
  danger?: boolean;
}): React.ReactElement {
  return (
    <Card size="small" style={{ height: '100%' }}>
      <Statistic
        title={label}
        value={value}
        valueStyle={{
          fontSize: 20,
          color: danger ? '#f87171' : undefined,
        }}
      />
      <Text type="secondary" style={{ fontSize: 11 }}>
        {hint}
      </Text>
    </Card>
  );
}

function AuditStatusCell({ event }: { event: AuditEvent }): React.ReactElement {
  const status = eventStatus(event);
  if (status === '') return <span className="muted">—</span>;
  const color = status === 'error' ? 'red' : status === 'timeout' ? 'orange' : 'green';
  return (
    <Space size={4}>
      <Tag color={color} bordered={false}>
        {stateLabel(status)}
      </Tag>
      {eventCancelled(event) ? <span className="muted">已取消</span> : null}
    </Space>
  );
}

// ---------------------------------------------------------------------------
// Filter defaults, hash sync and persistence helpers
// ---------------------------------------------------------------------------

function defaultAuditFilters(now: number = Date.now()): AuditFilters {
  return {
    from: toDateTimeLocal(now - Number(DEFAULT_RANGE) * 60_000),
    to: '',
    events: [],
    clientNames: [],
    clientVersions: [],
    bindings: [],
    tools: [],
    servers: [],
    statuses: [],
    minMs: '',
    scriptId: '',
    live: true,
    range: DEFAULT_RANGE,
  };
}

/** Rebuilds filters from the hash so a reload keeps the current view. */
function readFiltersFromHash(): AuditFilters {
  const base = defaultAuditFilters();
  if (typeof window === 'undefined') return base;
  const raw = window.location.hash.replace(/^#/, '');
  const queryIndex = raw.indexOf('?');
  if (queryIndex === -1) return base;

  const params = new URLSearchParams(raw.slice(queryIndex + 1));
  const range = params.get('range');
  const storedFrom = params.get('from');
  const storedTo = params.get('to');
  let from = base.from;
  let to = '';
  let rangeValue = base.range;

  if (range !== null && isPresetRange(range)) {
    rangeValue = range;
    from = toDateTimeLocal(Date.now() - Number(range) * 60_000);
  } else if (storedFrom !== null && isDateTimeLocal(storedFrom)) {
    from = storedFrom;
    to = storedTo !== null && isDateTimeLocal(storedTo) ? storedTo : '';
    rangeValue = '';
  } else if (storedTo !== null && isDateTimeLocal(storedTo)) {
    from = '';
    to = storedTo;
    rangeValue = '';
  }

  const legacyClient = params.get('client');
  const legacyParts = legacyClient === null ? { name: '', version: '' } : splitClientFilter(legacyClient);

  const list = (name: string): string[] =>
    params
      .getAll(name)
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value !== '');
  const clientNames = list('clientName');
  const clientVersions = list('clientVersion');

  return {
    from,
    to,
    events: list('event'),
    clientNames: clientNames.length > 0 || legacyParts.name === '' ? clientNames : [legacyParts.name],
    clientVersions:
      clientVersions.length > 0 || legacyParts.version === ''
        ? clientVersions
        : [legacyParts.version],
    bindings: list('binding'),
    tools: list('tool'),
    servers: list('server'),
    statuses: list('status').filter((value) =>
      STATUS_OPTIONS.some((option) => option.value === value),
    ),
    minMs: pickMinMs(params.get('minMs')),
    scriptId: params.get('scriptId')?.trim() ?? '',
    live: params.get('live') !== '0',
    range: rangeValue,
  };
}

function writeFiltersToHash(filters: AuditFilters): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (filters.range !== '') params.set('range', filters.range);
  if (filters.from !== '') params.set('from', filters.from);
  if (filters.to !== '') params.set('to', filters.to);
  setListParam(params, 'event', filters.events);
  setListParam(params, 'clientName', filters.clientNames);
  setListParam(params, 'clientVersion', filters.clientVersions);
  setListParam(params, 'binding', filters.bindings);
  setListParam(params, 'tool', filters.tools);
  setListParam(params, 'server', filters.servers);
  setListParam(params, 'status', filters.statuses);
  if (filters.minMs !== '') params.set('minMs', filters.minMs);
  if (filters.scriptId !== '') params.set('scriptId', filters.scriptId);
  params.set('live', filters.live ? '1' : '0');
  const next = `#/logs?${params.toString()}`;
  if (window.location.hash === next) return;
  window.history.replaceState(null, '', next);
}

function setListParam(params: URLSearchParams, name: string, values: readonly string[]): void {
  if (values.length > 0) params.set(name, values.join(','));
}

function isPresetRange(value: string): boolean {
  return RANGE_OPTIONS.some((option) => option.value !== '' && option.value === value);
}

function isDateTimeLocal(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(value) &&
    parseTime(value) !== null
  );
}

function pickMinMs(value: string | null): string {
  if (value === null || value.trim() === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? value : '';
}

function liveBadge(
  filters: AuditFilters,
  state: StreamState,
): { status: 'processing' | 'warning' | 'default'; text: string } {
  if (!filters.live) return { status: 'default', text: '实时已暂停' };
  switch (state) {
    case 'open':
      return { status: 'processing', text: 'SSE 实时' };
    case 'fallback':
      return { status: 'warning', text: '轮询兜底' };
    case 'reconnecting':
      return { status: 'warning', text: '重连中' };
    case 'connecting':
      return { status: 'processing', text: '连接中' };
    default:
      return { status: 'default', text: '未连接' };
  }
}

function filterQuery(filters: AuditFilters): Record<string, string | number | undefined> {
  return {
    from: toIso(filters.from),
    to: toIso(filters.to),
    event: joinFilter(filters.events),
    clientName: joinFilter(filters.clientNames),
    clientVersion: joinFilter(filters.clientVersions),
    binding: joinFilter(filters.bindings),
    tool: joinFilter(filters.tools),
    server: joinFilter(filters.servers),
    status: joinFilter(filters.statuses),
    minMs: emptyToUndefined(filters.minMs),
    scriptId: emptyToUndefined(filters.scriptId),
  };
}

function joinFilter(values: readonly string[]): string | undefined {
  return values.length === 0 ? undefined : values.join(',');
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

function parseTime(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Event helpers (shared by the table, live filter and drawer)
// ---------------------------------------------------------------------------

function eventText(event: AuditEvent | undefined, key: string): string | null {
  if (event === undefined) return null;
  const value = event[key];
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** Explicit `clientName`/`clientVersion`, falling back to the legacy `client` label. */
function eventClientParts(event: AuditEvent): { name: string; version: string } {
  const name = eventText(event, 'clientName');
  const version = eventText(event, 'clientVersion');
  if (name !== null || version !== null) return { name: name ?? '', version: version ?? '' };
  const legacy = eventText(event, 'client');
  return legacy === null ? { name: '', version: '' } : splitClientFilter(legacy);
}

/** Splits the legacy `name/version` filter at the first `/`. */
function splitClientFilter(label: string): { name: string; version: string } {
  const slash = label.indexOf('/');
  if (slash <= 0) return { name: label, version: '' };
  return { name: label.slice(0, slash), version: label.slice(slash + 1) };
}

/** Client name only; `ai_run` events without a client fall back to `admin`. */
function eventClientLabel(event: AuditEvent): string {
  const name = eventClientParts(event).name;
  if (name !== '') return name;
  return event.event === 'ai_run' ? 'admin' : '—';
}

function BindingLabel({
  binding,
  options,
}: {
  binding: string | null;
  options: readonly LabeledOption[];
}): React.ReactElement {
  if (binding === null) return <span className="mono muted">unbound</span>;
  return <span className="mono">{optionLabel(binding, options)}</span>;
}

function eventModeLabel(event: AuditEvent): string {
  if (event.event === 'ai_run') {
    const outcome = eventText(event, 'outcome');
    const trigger = eventText(event, 'trigger');
    if (outcome !== null && trigger !== null) {
      return `${stateLabel(outcome)} · ${aiRunTriggerLabel(trigger)}`;
    }
    return outcome !== null ? stateLabel(outcome) : aiRunTriggerLabel(trigger);
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

/** Mirrors the server-side mapping so live rows, trend and `?status=` agree. */
function eventStatus(event: AuditEvent): string {
  const explicit = event['status'];
  if (typeof explicit === 'string' && explicit !== '') return normalizeExplicitStatus(explicit);
  if (event.event === 'tool_result') return event['ok'] === false ? 'error' : 'ok';
  if (event.event === 'eval_end') {
    if (event['outcome'] === 'timeout') return 'timeout';
    if (event['outcome'] === 'error' || event['outcome'] === 'worker_dead') return 'error';
    return 'ok';
  }
  // The server mapping treats an admin cancel as a normal end.
  if (event.event === 'eval_cancel') return 'ok';
  if (event.event === 'ai_run') return event['outcome'] === 'error' ? 'error' : 'ok';
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

function normalizeExplicitStatus(status: string): string {
  const normalized = status.toLowerCase();
  return normalized === 'cancelled' || normalized === 'canceled' ? 'ok' : status;
}

function eventCancelled(event: AuditEvent): boolean {
  const outcome = event['outcome'];
  if (typeof outcome !== 'string' || outcome === '') return false;
  const normalized = outcome.toLowerCase();
  return normalized === 'cancelled' || normalized === 'canceled';
}

/** The stream publishes one event per frame; arrays and `{ events }` are tolerated. */
function auditEventsFromStreamPayload(data: unknown): AuditEvent[] {
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

/** The stream is unfiltered; keep only rows that match the applied form filters. */
function matchesFilters(event: AuditEvent, filters: AuditFilters): boolean {
  if (filters.events.length > 0 && !filters.events.includes(event.event ?? '')) return false;
  const time = parseEventTime(event);
  const from = parseTime(filters.from);
  const to = parseTime(filters.to);
  if (from !== null && (time === null || time < from)) return false;
  if (to !== null && (time === null || time > to)) return false;
  if (filters.clientNames.length > 0 && !filters.clientNames.includes(eventClientParts(event).name)) {
    return false;
  }
  if (
    filters.clientVersions.length > 0
    && !filters.clientVersions.includes(eventClientParts(event).version)
  ) {
    return false;
  }
  if (filters.bindings.length > 0) {
    const binding = eventText(event, 'binding');
    if (binding === null || !filters.bindings.includes(binding)) return false;
  }
  if (filters.tools.length > 0) {
    const tool = eventText(event, 'tool');
    if (tool === null || !filters.tools.includes(tool)) return false;
  }
  if (filters.servers.length > 0) {
    // `ai_run` carries no `server`; the server-side filter also accepts `serverId`.
    const serverId = eventText(event, 'server') ?? eventText(event, 'serverId');
    if (serverId === null || !filters.servers.includes(serverId)) return false;
  }
  if (
    filters.statuses.length > 0
    && !filters.statuses.includes(eventStatus(event) || 'ok')
  ) {
    return false;
  }
  const minMs = filters.minMs.trim();
  if (minMs !== '') {
    const minimum = Number(minMs);
    const duration = eventDuration(event);
    if (!Number.isFinite(minimum) || duration === null || duration < minimum) return false;
  }
  const scriptId = filters.scriptId.trim();
  if (scriptId !== '' && eventText(event, 'scriptId') !== scriptId) return false;
  return true;
}

function latestTimestamp(events: readonly AuditEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const ts = events[index]?.ts;
    if (typeof ts === 'string' && Number.isFinite(Date.parse(ts))) return ts;
  }
  return null;
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

function exportStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function groupLabel(key: string): string {
  if (key === '__official__') return '官方工具（内置）';
  if (key === '__builtin__') return '协议工具（repl）';
  if (key === 'unknown') return '未知';
  return key;
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
