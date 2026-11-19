/** Audit page: filters, live call table, JSONL export and a frame drawer. */
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
  Spin,
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
import { ApiError, framesTruncatedNotice, type EventStream, type FramesResponse, type StreamState } from '../../lib/api.ts';
import {
  formatBytes,
  formatDuration,
  formatId,
  formatJson,
  formatNumber,
  formatPercent,
  formatTime,
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

interface ProtocolFramePair {
  mcp: string;
  id: string | number | null;
  method: string | null;
  request: AuditEvent | null;
  response: AuditEvent | null;
  durMs?: number;
  ok?: boolean;
}

interface AuditFilters {
  from: string;
  to: string;
  event: string;
  clientName: string;
  clientVersion: string;
  binding: string;
  tool: string;
  server: string;
  status: string;
  minMs: string;
  live: boolean;
  /** Preset minutes as a string (`'60'`); empty means a custom from/to range. */
  range: string;
}

const MAX_EVENTS = 5_000;
const BATCH_MS = 200;
const PAGE_SIZE = 400;
const POLL_MS = 2_000;
const STATS_EVERY_TICKS = 5;
const SLOW_MS = 1_000;
const FRAME_LIMIT = 20;
const DEFAULT_RANGE = '60';

const RANGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '15', label: '最近 15 分钟' },
  { value: '60', label: '最近 1 小时' },
  { value: '360', label: '最近 6 小时' },
  { value: '1440', label: '最近 24 小时' },
  { value: '10080', label: '最近 7 天' },
  { value: '', label: '自定义时间' },
];

const EVENT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部事件' },
  { value: 'tool_call', label: '工具调用' },
  { value: 'tool_result', label: '工具结果' },
  { value: 'tool_denied', label: '工具拒绝' },
  { value: 'eval_start', label: '执行开始' },
  { value: 'eval_end', label: '执行结束' },
  { value: 'exec_start', label: '会话开始' },
  { value: 'exec_end', label: '会话结束' },
  { value: 'ai_run', label: 'AI 运行' },
];

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  ...(['ok', 'error', 'timeout'] as const).map((value) => ({ value, label: stateLabel(value) })),
];


export function AuditPage(): React.ReactElement {
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
  const [streamState, setStreamState] = useState<StreamState>('closed');
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [frames, setFrames] = useState<FramesResponse<ProtocolFramePair> | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  const [framesError, setFramesError] = useState<string | null>(null);

  const aliveRef = useRef(true);
  const appliedRef = useRef<AuditFilters>(applied);
  const eventsRef = useRef<AuditEvent[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<AuditEvent[]>([]);
  const pendingKeysRef = useRef<Set<string>>(new Set());
  const batchTimerRef = useRef<number | null>(null);
  const revokeTimerRef = useRef<number | null>(null);
  const loadTokenRef = useRef(0);
  const statsTokenRef = useRef(0);
  const frameTokenRef = useRef(0);
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
        const response = await api.get<AuditQueryResponse>('/audit/query', {
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
        const next = await api.get<AuditStats>('/audit/stats', { query: filterQuery(filters) });
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
      .get<AuditQueryResponse>('/audit/query', {
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
    const current = api.stream('/audit/stream', {
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
      const response = await api.get<AuditQueryResponse>('/audit/query', {
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
      const text = await api.get<string>('/audit/export', {
        query: filterQuery(appliedRef.current),
      });
      if (!aliveRef.current) return;
      const blob = new Blob([text], { type: 'application/x-ndjson;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-${exportStamp()}.jsonl`;
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
    frameTokenRef.current += 1;
    setSelected(null);
    setFrames(null);
    setFramesError(null);
    setFramesLoading(false);
  }

  function openEvent(event: AuditEvent): void {
    setSelected(event);
    setFrames(null);
    setFramesError(null);
    setFramesLoading(true);
    const ticket = ++frameTokenRef.current;
    void loadFrames(event, ticket);
  }

  async function loadFrames(event: AuditEvent, ticket: number): Promise<void> {
    const mcp = eventText(event, 'mcp');
    const idValue = event['rpcId'] ?? event['requestId'] ?? event['id'];
    const id =
      typeof idValue === 'string' || typeof idValue === 'number' ? idValue : undefined;
    const filters = appliedRef.current;
    try {
      let response = await requestFrames(filters, mcp, id);
      if (!aliveRef.current || ticket !== frameTokenRef.current) return;
      if ((response.frames ?? []).length === 0 && id !== undefined) {
        response = await requestFrames(filters, mcp, undefined);
        if (!aliveRef.current || ticket !== frameTokenRef.current) return;
      }
      setFrames(response);
    } catch (failure) {
      if (!aliveRef.current || ticket !== frameTokenRef.current) return;
      const text = failureText(failure);
      setFramesError(text);
      message.error(`协议帧读取失败：${text}`);
    } finally {
      if (aliveRef.current && ticket === frameTokenRef.current) setFramesLoading(false);
    }
  }

  function requestFrames(
    filters: AuditFilters,
    mcp: string | null,
    id: string | number | undefined,
  ): Promise<FramesResponse<ProtocolFramePair>> {
    return api.get<FramesResponse<ProtocolFramePair>>('/audit/frames', {
      query: {
        detail: 'full',
        from: toIso(filters.from),
        to: toIso(filters.to),
        mcp: mcp ?? undefined,
        id,
        limit: FRAME_LIMIT,
      },
    });
  }

  const columns = useMemo<TableProps<AuditEvent>['columns']>(
    () => [
      {
        title: '时间',
        key: 'time',
        width: 96,
        render: (_value, event) => {
          const time = parseEventTime(event);
          return (
            <span className="mono" title={formatTimestamp(event.ts ?? null)}>
              {time === null ? '—' : formatTime(time)}
            </span>
          );
        },
      },
      {
        title: '客户端 / binding',
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
        title: '工具 / 方法',
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
      {
        title: '会话 / 执行',
        key: 'eval',
        width: 150,
        ellipsis: true,
        render: (_value, event) => <span className="mono">{evalLabel(event)}</span>,
      },
    ],
    [],
  );

  const rows = useMemo(() => [...events].reverse(), [events]);
  const framesNotice = framesTruncatedNotice(frames);
  const badge = liveBadge(applied, streamState);
  const summary = hasMore
    ? `已加载 ${formatNumber(events.length)} 条（上限 ${formatNumber(MAX_EVENTS)}，还有更多）`
    : `已加载 ${formatNumber(events.length)} 条（上限 ${formatNumber(MAX_EVENTS)}）`;

  return (
    <div className="page">
      <PageHeader
        title="审计"
        description="调用列表、协议帧与调用详情；筛选在服务端完成，实时视图最多保留 5000 条。"
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
          <StatsCard label="调用量" value={stats === null ? '—' : formatNumber(stats.calls)} hint="tool 结果事件聚合" />
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
          <StatsCard label="p50" value={stats === null ? '—' : formatDuration(stats.p50)} hint="调用耗时中位数" />
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
          snapshot {formatId(stats.snapshotId, 12)} · 计算于 {formatTime(stats.computedAt)} · 扫描{' '}
          {formatNumber(stats.scannedRows)} 行 · took {formatDuration(stats.tookMs)}
          {stats.cached ? ' · 缓存命中' : ''}；列表与统计可能来自不同扫描。
        </Text>
      )}

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
                showTime={{ format: 'HH:mm' }}
                format="YYYY-MM-DD HH:mm"
                placeholder="选择时间"
                value={draft.from === '' ? null : dayjs(draft.from)}
                style={{ width: 190 }}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    from: value === null ? '' : value.format('YYYY-MM-DDTHH:mm'),
                    range: '',
                  })
                }
              />
            </Field>
            <Field label="到（留空=至今）">
              <DatePicker
                showTime={{ format: 'HH:mm' }}
                format="YYYY-MM-DD HH:mm"
                placeholder="选择时间"
                value={draft.to === '' ? null : dayjs(draft.to)}
                style={{ width: 190 }}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    to: value === null ? '' : value.format('YYYY-MM-DDTHH:mm'),
                    range: '',
                  })
                }
              />
            </Field>
            <Field label="事件类型">
              <Select
                value={draft.event}
                style={{ width: 150 }}
                options={EVENT_OPTIONS}
                onChange={(value) => setDraft({ ...draft, event: value })}
              />
            </Field>
            <Field label="状态">
              <Select
                value={draft.status}
                style={{ width: 120 }}
                options={STATUS_OPTIONS}
                onChange={(value) => setDraft({ ...draft, status: value })}
              />
            </Field>
            <Field label="搜索工具">
              <Input
                allowClear
                value={draft.tool}
                placeholder="工具名（精确匹配）"
                style={{ width: 220 }}
                onChange={(event) => setDraft({ ...draft, tool: event.target.value })}
                onPressEnter={applyDraft}
              />
            </Field>
          </Space>
          <Space wrap size={[12, 10]}>
            <Field label="客户端名称">
              <Input
                value={draft.clientName}
                placeholder="claude-code"
                style={{ width: 150 }}
                onChange={(event) => setDraft({ ...draft, clientName: event.target.value })}
                onPressEnter={applyDraft}
              />
            </Field>
            <Field label="客户端版本">
              <Input
                value={draft.clientVersion}
                placeholder="2.1.327"
                style={{ width: 130 }}
                onChange={(event) => setDraft({ ...draft, clientVersion: event.target.value })}
                onPressEnter={applyDraft}
              />
            </Field>
            <Field label="绑定（binding）">
              <Input
                value={draft.binding}
                placeholder="cb_…"
                style={{ width: 150 }}
                onChange={(event) => setDraft({ ...draft, binding: event.target.value })}
                onPressEnter={applyDraft}
              />
            </Field>
            <Field label="服务端（server）">
              <Input
                value={draft.server}
                placeholder="server id"
                style={{ width: 150 }}
                onChange={(event) => setDraft({ ...draft, server: event.target.value })}
                onPressEnter={applyDraft}
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
        title="调用列表"
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
        open={selected !== null}
        onClose={closeDrawer}
        width={760}
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
                  <span className="mono">{selected.event ?? '—'}</span>
                </Descriptions.Item>
                <Descriptions.Item label="客户端名称">
                  {eventClientParts(selected).name || '—'}
                </Descriptions.Item>
                <Descriptions.Item label="客户端版本">
                  {eventClientParts(selected).version || '—'}
                </Descriptions.Item>
                <Descriptions.Item label="binding">
                  <span className="mono">{eventText(selected, 'binding') ?? 'unbound'}</span>
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
                  <span className="mono">{eventText(selected, 'kind') ?? '—'}</span>
                </Descriptions.Item>
                <Descriptions.Item label="outcome">
                  {eventText(selected, 'outcome') ?? '—'}
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
                      <pre className="code-block" style={{ maxHeight: 260, overflow: 'auto' }}>
                        {formatJson(selected, 2)}
                      </pre>
                    ),
                  },
                ]}
              />
            </Card>

            {framesLoading ? (
              <Spin size="small" />
            ) : framesError === null ? null : (
              <Alert
                type="error"
                showIcon
                message="协议帧读取失败"
                description={framesError}
              />
            )}
            {frames === null ? null : (
              <Card
                size="small"
                title="协议帧"
                extra={
                  <Space>
                    <Tag bordered={false}>{`detail=${frames.detail}`}</Tag>
                    {frames.droppedFrames !== undefined && frames.droppedFrames > 0 ? (
                      <Tag color="red">丢帧 {formatNumber(frames.droppedFrames)}</Tag>
                    ) : null}
                  </Space>
                }
              >
                {framesNotice === null ? null : (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 10 }}
                    message={framesNotice}
                  />
                )}
                {frames.frames.length === 0 ? (
                  <Empty description="没有匹配的协议帧。协议帧记录模式可能为 off，或这对请求/响应不在当前筛选的时间范围内。" />
                ) : (
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    {frames.frames.slice(0, FRAME_LIMIT).map((frame, index) => (
                      <FramePairCard
                        key={`${frame.mcp}-${String(frame.id ?? '')}-${index}`}
                        frame={frame}
                      />
                    ))}
                  </Space>
                )}
                {frames.hasMore === true ? (
                  <Text type="secondary" style={{ fontSize: 11.5 }}>
                    还有更多帧；缩小时间范围或指定 mcp / id。
                  </Text>
                ) : null}
              </Card>
            )}
          </Space>
        )}
      </Drawer>
    </div>
  );
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

function FramePairCard({ frame }: { frame: ProtocolFramePair }): React.ReactElement {
  return (
    <Card
      size="small"
      title={
        <span className="mono">
          {frame.method ?? eventText(frame.request ?? undefined, 'method') ?? 'frame'}
        </span>
      }
      extra={
        <Space>
          <span className="muted">
            id {frame.id ?? '—'} · mcp {formatId(frame.mcp, 12)}
          </span>
          {frame.durMs === undefined ? null : (
            <Tag bordered={false}>{formatDuration(frame.durMs)}</Tag>
          )}
          {frame.ok === undefined ? null : (
            <Tag color={frame.ok ? 'green' : 'red'} bordered={false}>
              {frame.ok ? 'ok' : 'error'}
            </Tag>
          )}
        </Space>
      }
    >
      <Row gutter={12}>
        <Col span={12}>
          <FrameColumn label="请求" event={frame.request} />
        </Col>
        <Col span={12}>
          <FrameColumn label="响应" event={frame.response} />
        </Col>
      </Row>
    </Card>
  );
}

function FrameColumn({
  label,
  event,
}: {
  label: string;
  event: AuditEvent | null;
}): React.ReactElement {
  if (event === null) {
    return (
      <div>
        <Text type="secondary" style={{ fontSize: 11.5, fontWeight: 550 }}>
          {label}
        </Text>
        <div className="muted" style={{ fontSize: 12 }}>
          （缺少这一侧）
        </div>
      </div>
    );
  }
  const eventTruncation = frameTruncationLabel(event);
  const payload = framePayload(event);
  const payloadTruncation = payloadTruncationLabel(payload);
  const head = truncatedHead(payload);
  return (
    <div style={{ minWidth: 0 }}>
      <Text type="secondary" style={{ fontSize: 11.5, fontWeight: 550 }}>
        {label}
      </Text>
      {eventTruncation === null && payloadTruncation === null ? null : (
        <Space size={4} wrap>
          {eventTruncation === null ? null : <Tag color="gold">{eventTruncation}</Tag>}
          {payloadTruncation === null ? null : <Tag color="gold">{payloadTruncation}</Tag>}
        </Space>
      )}
      <pre className="code-block" style={{ maxHeight: 240, overflow: 'auto' }}>
        {head === null ? formatJson(payload, 2) : `${head}\n…（已截断）`}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter defaults, hash sync and persistence helpers
// ---------------------------------------------------------------------------

function defaultAuditFilters(now: number = Date.now()): AuditFilters {
  return {
    from: toDateTimeLocal(now - Number(DEFAULT_RANGE) * 60_000),
    to: '',
    event: '',
    clientName: '',
    clientVersion: '',
    binding: '',
    tool: '',
    server: '',
    status: '',
    minMs: '',
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

  return {
    from,
    to,
    event: pickOption(params.get('event'), EVENT_OPTIONS),
    clientName: params.get('clientName') ?? legacyParts.name,
    clientVersion: params.get('clientVersion') ?? legacyParts.version,
    binding: params.get('binding') ?? '',
    tool: params.get('tool') ?? '',
    server: params.get('server') ?? '',
    status: pickOption(params.get('status'), STATUS_OPTIONS),
    minMs: pickMinMs(params.get('minMs')),
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
  if (filters.event !== '') params.set('event', filters.event);
  if (filters.clientName !== '') params.set('clientName', filters.clientName);
  if (filters.clientVersion !== '') params.set('clientVersion', filters.clientVersion);
  if (filters.binding !== '') params.set('binding', filters.binding);
  if (filters.tool !== '') params.set('tool', filters.tool);
  if (filters.server !== '') params.set('server', filters.server);
  if (filters.status !== '') params.set('status', filters.status);
  if (filters.minMs !== '') params.set('minMs', filters.minMs);
  params.set('live', filters.live ? '1' : '0');
  const next = `#/audit?${params.toString()}`;
  if (window.location.hash === next) return;
  window.history.replaceState(null, '', next);
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

function pickOption(
  value: string | null,
  entries: ReadonlyArray<{ value: string }>,
): string {
  return value !== null && entries.some((entry) => entry.value === value) ? value : '';
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
    event: emptyToUndefined(filters.event),
    clientName: emptyToUndefined(filters.clientName),
    clientVersion: emptyToUndefined(filters.clientVersion),
    binding: emptyToUndefined(filters.binding),
    tool: emptyToUndefined(filters.tool),
    server: emptyToUndefined(filters.server),
    status: emptyToUndefined(filters.status),
    minMs: emptyToUndefined(filters.minMs),
  };
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

function evalLabel(event: AuditEvent): string {
  const exec = eventText(event, 'exec');
  const evalId = asNumber(event['evalId']);
  if (exec !== null && evalId !== null) return `${formatId(exec, 10)}#${evalId}`;
  if (exec !== null) return formatId(exec, 14);
  const taskId = eventText(event, 'evalTaskId') ?? eventText(event, 'taskId');
  return taskId === null ? '—' : formatId(taskId, 14);
}

/** Mirrors the server-side mapping so live rows, trend and `?status=` agree. */
function eventStatus(event: AuditEvent): string {
  const explicit = event['status'];
  if (typeof explicit === 'string' && explicit !== '') return normalizeExplicitStatus(explicit);
  if (event.event === 'tool_result') return event['ok'] === false ? 'error' : 'ok';
  if (event.event === 'eval_end') return event['outcome'] === 'timeout' ? 'timeout' : 'ok';
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
  if (filters.event !== '' && event.event !== filters.event) return false;
  const time = parseEventTime(event);
  const from = parseTime(filters.from);
  const to = parseTime(filters.to);
  if (from !== null && (time === null || time < from)) return false;
  if (to !== null && (time === null || time > to)) return false;
  const clientName = filters.clientName.trim();
  if (clientName !== '' && eventClientParts(event).name !== clientName) return false;
  const clientVersion = filters.clientVersion.trim();
  if (clientVersion !== '' && eventClientParts(event).version !== clientVersion) return false;
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

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}

// ---------------------------------------------------------------------------
// Protocol frame truncation (`boundFramePayload` on the server)
// ---------------------------------------------------------------------------

function framePayload(event: AuditEvent): unknown {
  if (event['params'] !== undefined) return event['params'];
  if (event['result'] !== undefined) return event['result'];
  if (event['error'] !== undefined) return event['error'];
  return event;
}

function frameTruncationLabel(event: AuditEvent): string | null {
  const truncated = event['truncated'] === true || event['payloadTruncated'] === true;
  if (!truncated) return null;
  const bytes =
    asNumber(event['bytes']) ??
    asNumber(event['truncatedBytes']) ??
    asNumber(event['originalBytes']);
  const sha = eventText(event, 'sha256');
  return `已截断${bytes === null ? '' : ` ${formatBytes(bytes)}`}${
    sha === null ? '' : ` · sha256 ${sha.slice(0, 12)}…`
  }`;
}

function payloadTruncationLabel(payload: unknown): string | null {
  if (!isRecord(payload) || payload['truncated'] !== true) return null;
  const bytes = asNumber(payload['bytes']);
  const sha = typeof payload['sha256'] === 'string' ? payload['sha256'] : null;
  return `已截断${bytes === null ? '' : ` ${formatBytes(bytes)}`}${
    sha === null ? '' : ` · sha256 ${sha.slice(0, 12)}…`
  }`;
}

function truncatedHead(payload: unknown): string | null {
  if (!isRecord(payload) || payload['truncated'] !== true) return null;
  return typeof payload['head'] === 'string' ? payload['head'] : '';
}
