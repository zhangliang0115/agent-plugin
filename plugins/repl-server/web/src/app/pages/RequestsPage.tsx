/** Request-level audit view: one row per MCP request/response pair with payloads. */
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader, stateLabel } from '../components/common.tsx';
import { FrameColumn, type FrameEvent } from '../components/FramePayload.tsx';
import { RequestTimeline } from '../components/RequestTimeline.tsx';
import {
  ApiError,
  framesTruncatedNotice,
  type FramesResponse,
  type StreamState,
} from '../../lib/api.ts';
import { eventLabel, eventSubject } from '../../lib/audit-labels.ts';
import { formatBytes, formatDuration, formatNumber, formatTimestamp } from '../../lib/format.ts';
import {
  eventWindow,
  isAsyncResponse,
  isProtocolFrame,
  requestRunIds,
} from '../../lib/request-detail.ts';

const { Text } = Typography;

interface ProtocolFramePair {
  mcp: string;
  id: string | number | null;
  method: string | null;
  request: FrameEvent | null;
  response: FrameEvent | null;
  durMs?: number;
  ok?: boolean;
}

interface AuditEvent {
  ts?: string;
  event?: string;
  tool?: string;
  server?: string;
  method?: string;
  outcome?: string;
  ok?: boolean;
  evalId?: number;
  exec?: string;
  ms?: number;
  durMs?: number;
  elapsedMs?: number;
  error?: string;
  [key: string]: unknown;
}

interface RequestFilters {
  range: string;
  clientName: string;
  binding: string;
  method: string;
}

const RANGE_OPTIONS = [
  { value: '15', label: '最近 15 分钟' },
  { value: '60', label: '最近 1 小时' },
  { value: '360', label: '最近 6 小时' },
  { value: '1440', label: '最近 24 小时' },
  { value: '10080', label: '最近 7 天' },
];

const DEFAULT_FILTERS: RequestFilters = {
  range: '60',
  clientName: '',
  binding: '',
  method: '',
};

const STREAM_LABELS: Record<StreamState, string> = {
  connecting: '连接中',
  open: '已连接',
  reconnecting: '重连中',
  fallback: '轮询中',
  closed: '已关闭',
};

export function RequestsPage(): React.ReactElement {
  const api = useApi();
  const [filters, setFilters] = useState<RequestFilters>(DEFAULT_FILTERS);
  const [frames, setFrames] = useState<FramesResponse<ProtocolFramePair> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [streamState, setStreamState] = useState<StreamState>('closed');
  const [selected, setSelected] = useState<ProtocolFramePair | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const filtersRef = useRef(filters);
  const reloadTimerRef = useRef<number | null>(null);
  const eventTicketRef = useRef(0);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const load = useCallback(
    async (next: RequestFilters, silent = false): Promise<void> => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const from = new Date(Date.now() - Number(next.range) * 60_000).toISOString();
        const response = await api.get<FramesResponse<ProtocolFramePair>>('/audit/frames', {
          query: {
            detail: 'full',
            from,
            clientName: next.clientName.trim() === '' ? undefined : next.clientName.trim(),
            binding: next.binding.trim() === '' ? undefined : next.binding.trim(),
            method: next.method.trim() === '' ? undefined : next.method.trim(),
            limit: 200,
          },
        });
        // The endpoint returns oldest-first; the table shows the newest request first.
        setFrames({ ...response, frames: [...response.frames].reverse() });
      } catch (failure) {
        setError(failureText(failure));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load(DEFAULT_FILTERS);
  }, [load]);

  const scheduleLiveReload = useCallback((): void => {
    if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null;
      if (document.visibilityState === 'visible') void load(filtersRef.current, true);
    }, 500);
  }, [load]);

  useEffect(() => {
    if (!live) {
      setStreamState('closed');
      return;
    }
    const stream = api.stream('/audit/stream', {
      eventTypes: ['audit', 'message'],
      onEvent: (frame) => {
        if (isProtocolFrame(frame.data)) scheduleLiveReload();
      },
      onGap: scheduleLiveReload,
      onStateChange: setStreamState,
      onFallbackPoll: scheduleLiveReload,
    });
    setStreamState(stream.state);
    return () => {
      stream.close();
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
  }, [api, live, scheduleLiveReload]);

  function update(patch: Partial<RequestFilters>): void {
    const next = { ...filters, ...patch };
    setFilters(next);
    void load(next);
  }

  async function openRequest(pair: ProtocolFramePair): Promise<void> {
    setSelected(pair);
    setEvents(null);
    setEventsError(null);
    setEventsLoading(true);
    const ticket = ++eventTicketRef.current;
    try {
      // Exact link: `eval_start` carries the id of the `tools/call` that started
      // it, and every tool event of that eval carries the same `runId`. The
      // padded window only bounds this lookup (async evals keep the tail open).
      const starts = await api.get<{ events?: AuditEvent[] }>('/audit/query', {
        query: {
          ...eventWindow(pair.request?.ts, pair.response?.ts, isAsyncResponse(pair.response)),
          mcp: pair.mcp,
          limit: 500,
        },
      });
      if (ticket !== eventTicketRef.current) return;
      const runIds = requestRunIds(Array.isArray(starts.events) ? starts.events : [], pair.id);
      const collected: AuditEvent[] = [];
      for (const runId of runIds) {
        const response = await api.get<{ events?: AuditEvent[] }>('/audit/query', {
          query: { runId, limit: 500 },
        });
        if (ticket !== eventTicketRef.current) return;
        if (Array.isArray(response.events)) collected.push(...response.events);
      }
      collected.sort((left, right) => timeOf(left) - timeOf(right));
      setEvents(collected);
    } catch (failure) {
      if (ticket !== eventTicketRef.current) return;
      setEventsError(failureText(failure));
    } finally {
      if (ticket === eventTicketRef.current) setEventsLoading(false);
    }
  }

  const columns: TableProps<ProtocolFramePair>['columns'] = [
    {
      title: '时间',
      key: 'time',
      width: 170,
      render: (_value, pair) => (
        <span className="mono">{formatTimestamp(pair.request?.ts ?? pair.response?.ts ?? null)}</span>
      ),
    },
    {
      title: '客户端 / binding',
      key: 'client',
      ellipsis: true,
      render: (_value, pair) => pairClientLabel(pair),
    },
    {
      title: '方法',
      key: 'method',
      width: 180,
      ellipsis: true,
      render: (_value, pair) => <span className="mono">{pair.method ?? '—'}</span>,
    },
    {
      title: 'id',
      key: 'id',
      width: 110,
      ellipsis: true,
      render: (_value, pair) => <span className="mono">{pair.id ?? '—'}</span>,
    },
    {
      title: '状态',
      key: 'status',
      width: 92,
      render: (_value, pair) =>
        pair.response === null ? (
          <Tag color="gold" bordered={false}>
            无响应
          </Tag>
        ) : (
          <Tag color={pair.ok === false ? 'red' : 'green'} bordered={false}>
            {stateLabel(pair.ok === false ? 'error' : 'ok')}
          </Tag>
        ),
    },
    {
      title: '耗时',
      key: 'duration',
      width: 90,
      align: 'right',
      render: (_value, pair) => <span className="mono">{formatDuration(pair.durMs ?? null)}</span>,
    },
    {
      title: '请求 / 响应字节',
      key: 'bytes',
      width: 150,
      align: 'right',
      render: (_value, pair) => (
        <span className="mono">
          {formatBytes(asNumber(pair.request?.['bytes']))} /{' '}
          {formatBytes(asNumber(pair.response?.['bytes']))}
        </span>
      ),
    },
  ];

  const notice = frames === null ? null : framesTruncatedNotice(frames);
  const summary =
    frames === null
      ? '—'
      : `共 ${formatNumber(frames.frames.length)} 次请求${
          frames.hasMore === true ? '（还有更多，缩小时间范围）' : ''
        }`;
  const eventCount = events === null ? null : events.length;

  return (
    <div className="page">
      <PageHeader
        title="请求记录"
        description="一行一次 MCP 请求。点击一行查看本次请求的过程、协议帧与审计事件；列表在实时模式下随协议帧自动刷新。"
        actions={
          <Space size={10}>
            <Tag color={streamState === 'open' ? 'green' : 'default'} bordered={false}>
              {STREAM_LABELS[streamState]}
            </Tag>
            <Switch
              size="small"
              checked={live}
              checkedChildren="实时"
              unCheckedChildren="暂停"
              onChange={setLive}
            />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(filters)}>
              刷新
            </Button>
          </Space>
        }
      />

      <Card size="small" title="筛选">
        <Space wrap size={[12, 10]}>
          <Space size={6}>
            <Text type="secondary">时间范围</Text>
            <Select
              value={filters.range}
              style={{ width: 150 }}
              options={RANGE_OPTIONS}
              onChange={(value) => update({ range: value })}
            />
          </Space>
          <Input
            allowClear
            style={{ width: 160 }}
            placeholder="客户端名称"
            value={filters.clientName}
            onChange={(event) => setFilters({ ...filters, clientName: event.target.value })}
            onPressEnter={() => void load(filters)}
          />
          <Input
            allowClear
            style={{ width: 200 }}
            placeholder="binding"
            value={filters.binding}
            onChange={(event) => setFilters({ ...filters, binding: event.target.value })}
            onPressEnter={() => void load(filters)}
          />
          <Input
            allowClear
            style={{ width: 180 }}
            placeholder="方法，如 tools/call"
            value={filters.method}
            onChange={(event) => setFilters({ ...filters, method: event.target.value })}
            onPressEnter={() => void load(filters)}
          />
          <Button onClick={() => void load(filters)} loading={loading}>
            查询
          </Button>
        </Space>
      </Card>

      {error === null ? null : (
        <Alert type="error" showIcon message="请求记录读取失败" description={error} />
      )}
      {notice === null ? null : <Alert type="warning" showIcon message={notice} />}

      <Card size="small" title="请求" extra={<Text type="secondary">{summary}</Text>}>
        <Table<ProtocolFramePair>
          size="small"
          rowKey={(pair, index) => `${pair.mcp}-${String(pair.id ?? '')}-${index ?? 0}`}
          dataSource={frames?.frames ?? []}
          columns={columns}
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 1_000 }}
          onRow={(pair) => ({
            className: selected === pair ? 'row-clickable row-selected' : 'row-clickable',
            onClick: () => void openRequest(pair),
          })}
          locale={{
            emptyText: (
              <Empty description="没有匹配的请求。放宽时间范围，或确认服务端已在 full 帧模式重启。" />
            ),
          }}
        />
      </Card>

      <Drawer
        placement="left"
        open={selected !== null}
        onClose={() => {
          eventTicketRef.current += 1;
          setSelected(null);
          setEvents(null);
        }}
        width={1120}
        title={
          selected === null ? (
            '请求详情'
          ) : (
            <Space size={8}>
              <span className="mono">{selected.method ?? 'request'}</span>
              <span className="muted">#{selected.id ?? '—'}</span>
              <Tag color={selected.ok === false ? 'red' : 'green'} bordered={false}>
                {selected.response === null
                  ? '无响应'
                  : stateLabel(selected.ok === false ? 'error' : 'ok')}
              </Tag>
            </Space>
          )
        }
      >
        {selected === null ? null : (
          <Tabs
            items={[
              {
                key: 'timeline',
                label: '过程',
                children: (
                  <RequestTimeline
                    request={selected.request}
                    response={selected.response}
                    events={events}
                    loading={eventsLoading}
                    error={eventsError}
                  />
                ),
              },
              {
                key: 'frames',
                label: '协议帧',
                children: (
                  <Row gutter={12}>
                    <Col span={12}>
                      <FrameColumn
                        label="请求报文"
                        event={selected.request}
                        maxHeight="calc(100vh - 210px)"
                      />
                    </Col>
                    <Col span={12}>
                      <FrameColumn
                        label="响应报文"
                        event={selected.response}
                        maxHeight="calc(100vh - 210px)"
                      />
                    </Col>
                  </Row>
                ),
              },
              {
                key: 'events',
                label: eventCount === null ? '事件' : `事件（${eventCount}）`,
                children: (
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                      只显示与本次请求关联的事件：eval_start 上的 requestId 指向这条请求，其余事件共享同一次执行的 runId。没有执行事件的请求（连接、server/discover、tools/list、search_tools 等）显示为空。
                    </Typography.Text>
                    {eventsError === null ? null : (
                      <Alert type="error" showIcon message="事件读取失败" description={eventsError} />
                    )}
                    <Table<AuditEvent>
                      size="small"
                      rowKey={(event, index) => `${event.ts ?? ''}-${event.event ?? ''}-${index ?? 0}`}
                      loading={eventsLoading}
                      dataSource={events ?? []}
                      pagination={false}
                      columns={eventColumns}
                      scroll={{ x: 760 }}
                      locale={{
                        emptyText: (
                          <Empty description="本次请求没有关联的执行事件。连接、server/discover、tools/list、search_tools 这类请求本来就没有执行事件；本次升级之前写入的旧审计记录也没有关联字段。" />
                        ),
                      }}
                    />
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Drawer>
    </div>
  );
}

const eventColumns: TableProps<AuditEvent>['columns'] = [
  {
    title: '时间',
    dataIndex: 'ts',
    width: 170,
    render: (value: unknown) => (
      <span className="mono">{formatTimestamp(typeof value === 'string' ? value : null)}</span>
    ),
  },
  {
    title: '事件',
    dataIndex: 'event',
    width: 110,
    render: (value: unknown) => <span>{eventLabel(value)}</span>,
  },
  {
    title: '对象',
    key: 'subject',
    ellipsis: true,
    render: (_value, event) => <span className="mono">{eventSubject(event)}</span>,
  },
  {
    title: 'eval',
    key: 'eval',
    width: 110,
    render: (_value, event) =>
      typeof event.evalId === 'number' ? (
        <span className="mono">
          {event.exec === undefined ? event.evalId : `${event.exec}/${event.evalId}`}
        </span>
      ) : (
        <span className="muted">—</span>
      ),
  },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: (_value, event) => eventStatusTag(event),
  },
  {
    title: '耗时',
    key: 'ms',
    width: 90,
    align: 'right',
    render: (_value, event) => (
      <span className="mono">
        {formatDuration(asNumber(event.ms) ?? asNumber(event.durMs) ?? asNumber(event.elapsedMs))}
      </span>
    ),
  },
];

function eventStatusTag(event: AuditEvent): React.ReactElement {
  const status =
    typeof event.status === 'string'
      ? event.status
      : typeof event.outcome === 'string'
        ? event.outcome
        : typeof event.ok === 'boolean'
          ? event.ok
            ? 'ok'
            : 'error'
          : '';
  if (status === '') return <span className="muted">—</span>;
  const color = status === 'error' || status === 'failed' ? 'red' : status === 'timeout' ? 'orange' : 'green';
  return (
    <Tag color={color} bordered={false}>
      {stateLabel(status)}
    </Tag>
  );
}

function timeOf(event: AuditEvent): number {
  const time = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function pairClientLabel(pair: ProtocolFramePair): string {
  const event = pair.request ?? pair.response;
  if (event === null) return '—';
  const name = text(event, 'clientName');
  const version = text(event, 'clientVersion');
  if (name !== null) return version === null ? name : `${name}/${version}`;
  return text(event, 'client') ?? text(event, 'binding') ?? '—';
}

function text(event: FrameEvent, key: string): string | null {
  const value = event[key];
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
