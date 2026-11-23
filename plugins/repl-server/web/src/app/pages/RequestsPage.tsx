/** Request-level audit view: one row per MCP request/response pair with payloads. */
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
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
import { RequestProcess } from '../components/RequestProcess.tsx';
import {
  ApiError,
  framesTruncatedNotice,
  type FramesResponse,
  type StreamState,
} from '../../lib/api.ts';
import { eventLabel, eventSubject } from '../../lib/audit-labels.ts';
import {
  listOptions,
  mergeBindings,
  mergeValues,
  optionLabel,
  type LabeledOption,
} from '../../lib/filter-options.ts';
import { formatBytes, formatDuration, formatNumber, formatTimestamp } from '../../lib/format.ts';
import {
  eventWindow,
  isAsyncResponse,
  isProtocolFrame,
  matchesDetailKeys,
  requestDetailKeys,
  toolCallOutcome,
  type RequestDetailKeys,
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

/** Identity of one audit row, used to merge the runId and taskId lookups. */
function eventDedupeKey(event: AuditEvent): string {
  return [event.event, event.ts, event.exec, event.evalId, event['seq'], event['mcp'], event['id']]
    .map((part) => (part === undefined ? '' : String(part)))
    .join('|');
}

type FrameProtocolChoice = 'ok' | 'error' | 'none';
type FrameResultChoice = 'ok' | 'error';

interface RequestFilters {
  range: string;
  clientNames: string[];
  clientVersions: string[];
  bindings: string[];
  methods: string[];
  tools: string[];
  protocols: FrameProtocolChoice[];
  results: FrameResultChoice[];
}

interface FilterOptions {
  clients: string[];
  versions: string[];
  bindings: Array<{ value: string; label: string }>;
  methods: string[];
  tools: string[];
}

interface ClientsResponse {
  clients: Array<{ id: string; label: string }>;
  sessions: Array<{ clientName: string; clientVersion: string; bindingId: string | null }>;
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
  clientNames: [],
  clientVersions: [],
  bindings: [],
  methods: [],
  tools: [],
  protocols: [],
  results: [],
};

const PROTOCOL_OPTIONS: Array<{ value: FrameProtocolChoice; label: string }> = [
  { value: 'ok', label: '成功' },
  { value: 'error', label: '失败' },
  { value: 'none', label: '无响应' },
];

const RESULT_OPTIONS: Array<{ value: FrameResultChoice; label: string }> = [
  { value: 'ok', label: '成功' },
  { value: 'error', label: '失败' },
];

const EMPTY_OPTIONS: FilterOptions = {
  clients: [],
  versions: [],
  bindings: [],
  methods: [],
  tools: [],
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
  const [options, setOptions] = useState<FilterOptions>(EMPTY_OPTIONS);
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
  /** Identifiers of the work behind the open detail panel, for live refresh. */
  const detailRef = useRef<{ pair: ProtocolFramePair | null; keys: RequestDetailKeys; timer: number | null }>({
    pair: null,
    keys: { runIds: [], taskIds: [] },
    timer: null,
  });

  useEffect(() => {
    let alive = true;
    void api
      .get<ClientsResponse>('/clients')
      .then((response) => {
        if (!alive) return;
        rememberOptions({
          clients: (response.sessions ?? []).map((session) => session.clientName),
          versions: (response.sessions ?? []).map((session) => session.clientVersion),
          bindings: (response.clients ?? []).map((binding) => ({
            value: binding.id,
            label: binding.label === binding.id ? binding.id : `${binding.label} (${binding.id})`,
          })),
        });
      })
      .catch(() => {
        // Dropdowns still fill from the frames that load below.
      });
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const load = useCallback(
    async (next: RequestFilters, silent = false): Promise<void> => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const from = new Date(Date.now() - Number(next.range) * 60_000).toISOString();
        const query = new URLSearchParams({ detail: 'full', from, limit: '200' });
        for (const value of next.clientNames) query.append('clientName', value);
        for (const value of next.clientVersions) query.append('clientVersion', value);
        for (const value of next.bindings) query.append('binding', value);
        for (const value of next.methods) query.append('method', value);
        for (const value of next.tools) query.append('tool', value);
        for (const value of next.protocols) query.append('protocol', value);
        for (const value of next.results) query.append('result', value);
        const response = await api.get<FramesResponse<ProtocolFramePair>>('/audit/frames', {
          query,
        });
        rememberOptionsFromFrames(response.frames);
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

  /** Re-reads the open detail panel when a live frame belongs to it. */
  const reloadDetail = useCallback((): void => {
    const detail = detailRef.current;
    if (detail.timer !== null) window.clearTimeout(detail.timer);
    detail.timer = window.setTimeout(() => {
      detail.timer = null;
      if (detail.pair === null || document.visibilityState !== 'visible') return;
      void openRequest(detail.pair);
    }, 500);
    // `openRequest` only touches state setters, the api client and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    if (!live) {
      setStreamState('closed');
      return;
    }
    const stream = api.stream('/audit/stream', {
      eventTypes: ['audit', 'message'],
      onEvent: (frame) => {
        if (isProtocolFrame(frame.data)) scheduleLiveReload();
        // The open panel follows its own eval, not the list: an async task can
        // settle long after the request row stopped changing.
        if (matchesDetailKeys(frame.data, detailRef.current.keys)) reloadDetail();
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
      if (detailRef.current.timer !== null) {
        window.clearTimeout(detailRef.current.timer);
        detailRef.current.timer = null;
      }
    };
  }, [api, live, reloadDetail, scheduleLiveReload]);

  function update(patch: Partial<RequestFilters>): void {
    const next = { ...filters, ...patch };
    setFilters(next);
    void load(next);
  }

  function resetFilters(): void {
    setFilters(DEFAULT_FILTERS);
    void load(DEFAULT_FILTERS);
  }

  /** Options only grow during the session, so selecting one value never hides the others. */
  function rememberOptions(delta: Partial<FilterOptions>): void {
    setOptions((previous) => {
      const clients = mergeValues(previous.clients, delta.clients ?? []);
      const versions = mergeValues(previous.versions, delta.versions ?? []);
      const methods = mergeValues(previous.methods, delta.methods ?? []);
      const tools = mergeValues(previous.tools, delta.tools ?? []);
      const bindings = mergeBindings(previous.bindings, delta.bindings ?? []);
      if (
        clients === previous.clients
        && versions === previous.versions
        && methods === previous.methods
        && tools === previous.tools
        && bindings === previous.bindings
      ) {
        return previous;
      }
      return { clients, versions, bindings, methods, tools };
    });
  }

  function rememberOptionsFromFrames(list: readonly ProtocolFramePair[]): void {
    const delta: FilterOptions = {
      clients: [],
      versions: [],
      bindings: [],
      methods: [],
      tools: [],
    };
    for (const pair of list) {
      const frame = pair.request ?? pair.response;
      if (frame !== null) {
        const client = text(frame, 'clientName');
        if (client !== null) delta.clients.push(client);
        const version = text(frame, 'clientVersion');
        if (version !== null) delta.versions.push(version);
        const binding = text(frame, 'binding');
        if (binding !== null) delta.bindings.push({ value: binding, label: binding });
      }
      if (pair.method !== null && pair.method !== undefined) delta.methods.push(pair.method);
      const tool = requestToolName(pair);
      if (tool !== null) delta.tools.push(tool);
    }
    rememberOptions(delta);
  }

  async function openRequest(pair: ProtocolFramePair): Promise<void> {
    setSelected(pair);
    setEvents(null);
    setEventsError(null);
    setEventsLoading(true);
    const ticket = ++eventTicketRef.current;
    detailRef.current.pair = pair;
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
      const first = Array.isArray(starts.events) ? starts.events : [];
      const keys = requestDetailKeys(first, pair.id);
      detailRef.current.keys = keys;

      const collected: AuditEvent[] = [];
      const seen = new Set<string>();
      const push = (batch: AuditEvent[]): void => {
        for (const event of batch) {
          const key = eventDedupeKey(event);
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push(event);
        }
      };
      for (const runId of keys.runIds) {
        const response = await api.get<{ events?: AuditEvent[] }>('/audit/query', {
          query: { runId, limit: 500 },
        });
        if (ticket !== eventTicketRef.current) return;
        if (Array.isArray(response.events)) push(response.events);
      }
      // `async_dispatch` has no `runId`; its `evalTaskId` is the only handle on
      // the background half (settle, cancel), so it needs its own lookup.
      for (const taskId of keys.taskIds) {
        const response = await api.get<{ events?: AuditEvent[] }>('/audit/query', {
          query: { taskId, limit: 500 },
        });
        if (ticket !== eventTicketRef.current) return;
        if (Array.isArray(response.events)) push(response.events);
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
      render: (_value, pair) => pairClientLabel(pair, options.bindings),
    },
    {
      title: '方法',
      key: 'method',
      width: 150,
      ellipsis: true,
      render: (_value, pair) => <span className="mono">{pair.method ?? '—'}</span>,
    },
    {
      title: '工具',
      key: 'tool',
      width: 160,
      ellipsis: true,
      render: (_value, pair) => <span className="mono">{requestToolName(pair) ?? '—'}</span>,
    },
    {
      title: '协议状态',
      key: 'status',
      width: 104,
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
      title: '执行结果',
      key: 'toolResult',
      width: 200,
      ellipsis: true,
      render: (_value, pair) => <ExecutionResultCell pair={pair} />,
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
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            placeholder="客户端"
            style={{ width: 180 }}
            value={filters.clientNames}
            options={listOptions(options.clients)}
            onChange={(value) => update({ clientNames: value })}
          />
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            placeholder="版本"
            style={{ width: 140 }}
            value={filters.clientVersions}
            options={listOptions(options.versions)}
            onChange={(value) => update({ clientVersions: value })}
          />
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            placeholder="binding"
            style={{ width: 200 }}
            value={filters.bindings}
            options={options.bindings}
            onChange={(value) => update({ bindings: value })}
          />
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            placeholder="方法"
            style={{ width: 180 }}
            value={filters.methods}
            options={listOptions(options.methods)}
            onChange={(value) => update({ methods: value })}
          />
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            placeholder="工具"
            style={{ width: 180 }}
            value={filters.tools}
            options={listOptions(options.tools)}
            onChange={(value) => update({ tools: value })}
          />
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            placeholder="协议状态"
            style={{ width: 170 }}
            value={filters.protocols}
            options={PROTOCOL_OPTIONS}
            onChange={(value) => update({ protocols: value })}
          />
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            placeholder="执行结果"
            style={{ width: 160 }}
            value={filters.results}
            options={RESULT_OPTIONS}
            onChange={(value) => update({ results: value })}
          />
          <Button onClick={resetFilters} loading={loading}>
            清空筛选
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
          scroll={{ x: 1_200 }}
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
          // Stop following the eval: a closed panel must not keep refetching.
          detailRef.current.pair = null;
          detailRef.current.keys = { runIds: [], taskIds: [] };
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
                  <RequestProcess
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

function ExecutionResultCell({ pair }: { pair: ProtocolFramePair }): React.ReactElement {
  const outcome = pair.method === 'tools/call' ? toolCallOutcome(pair.response) : null;
  if (outcome === null) return <span className="muted">—</span>;
  if (outcome.ok) {
    return (
      <Tag color="green" bordered={false}>
        成功
      </Tag>
    );
  }
  return (
    <span title={outcome.message}>
      <Tag color="red" bordered={false}>
        失败
      </Tag>
      {outcome.code === undefined ? null : <span className="mono muted">{outcome.code}</span>}
    </span>
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

/** `params.name` of a `tools/call` request; other methods have no tool. */
function requestToolName(pair: ProtocolFramePair): string | null {
  if (pair.method !== 'tools/call') return null;
  const params = pair.request?.['params'];
  if (typeof params !== 'object' || params === null) return null;
  const name = (params as Record<string, unknown>)['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

function timeOf(event: AuditEvent): number {
  const time = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function pairClientLabel(pair: ProtocolFramePair, bindings: readonly LabeledOption[]): string {
  const event = pair.request ?? pair.response;
  if (event === null) return '—';
  const name = text(event, 'clientName');
  const version = text(event, 'clientVersion');
  const client =
    name === null ? text(event, 'client') : version === null ? name : `${name}/${version}`;
  const binding = text(event, 'binding');
  const bindingLabel = binding === null ? null : optionLabel(binding, bindings);
  if (client !== null && bindingLabel !== null) return `${client} · ${bindingLabel}`;
  return client ?? bindingLabel ?? '—';
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
