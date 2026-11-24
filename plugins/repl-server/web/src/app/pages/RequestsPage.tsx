/** Request-level audit view: one row per MCP request/response pair with payloads. */
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader, stateLabel } from '../components/common.tsx';
import {
  RequestDetailDrawer,
  loadRequestDetailEvents,
  type DetailAuditEvent as AuditEvent,
  type RequestFramePair as ProtocolFramePair,
} from '../components/RequestDetailDrawer.tsx';
import {
  ApiError,
  framesTruncatedNotice,
  type FramesResponse,
  type StreamState,
} from '../../lib/api.ts';
import { listOptions, mergeBindings, mergeValues } from '../../lib/filter-options.ts';
import { formatBytes, formatDuration, formatNumber, formatTimestamp } from '../../lib/format.ts';
import {
  isProtocolFrame,
  matchesDetailKeys,
  toolCallOutcome,
  type RequestDetailKeys,
} from '../../lib/request-detail.ts';
import { scriptInfoFromRequest } from '../../lib/script-info.ts';

const { Text } = Typography;

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
  /** Client-side narrowing on the loaded frames; the frames endpoint has no script filter yet. */
  scriptId: string;
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
  scriptId: '',
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
        const response = await api.get<FramesResponse<ProtocolFramePair>>('/logs/frames', {
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
    const stream = api.stream('/logs/stream', {
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
      const detail = await loadRequestDetailEvents(api, pair);
      if (ticket !== eventTicketRef.current) return;
      detailRef.current.keys = detail.keys;
      setEvents(detail.events);
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
      title: '客户端',
      key: 'client',
      ellipsis: true,
      render: (_value, pair) => pairClientLabel(pair),
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
  // The frames endpoint has no scriptId filter yet; narrow the loaded page locally.
  const visibleFrames = useMemo(() => {
    const list = frames?.frames ?? [];
    const wanted = filters.scriptId.trim();
    if (wanted === '') return list;
    return list.filter((pair) => scriptInfoFromRequest(pair.request)?.scriptId === wanted);
  }, [frames, filters.scriptId]);
  const summary =
    frames === null
      ? '—'
      : `共 ${formatNumber(visibleFrames.length)} 次请求${
          frames.hasMore === true ? '（还有更多，缩小时间范围）' : ''
        }`;

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
          <Input
            allowClear
            placeholder="脚本 ID（本地过滤）"
            style={{ width: 200 }}
            value={filters.scriptId}
            onChange={(event) => setFilters({ ...filters, scriptId: event.target.value })}
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
          dataSource={visibleFrames}
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
              <Empty description="没有匹配的请求。放宽时间范围、清空脚本 ID，或确认服务端已在 full 帧模式重启。" />
            ),
          }}
        />
      </Card>

      <RequestDetailDrawer
        pair={selected}
        events={events}
        loading={eventsLoading}
        error={eventsError}
        onClose={() => {
          eventTicketRef.current += 1;
          // Stop following the eval: a closed panel must not keep refetching.
          detailRef.current.pair = null;
          detailRef.current.keys = { runIds: [], taskIds: [] };
          setSelected(null);
          setEvents(null);
        }}
      />
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

/** `params.name` of a `tools/call` request; other methods have no tool. */
function requestToolName(pair: ProtocolFramePair): string | null {
  if (pair.method !== 'tools/call') return null;
  const params = pair.request?.['params'];
  if (typeof params !== 'object' || params === null) return null;
  const name = (params as Record<string, unknown>)['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

/** Client name only; the legacy `client` label is `name/version`. */
function pairClientLabel(pair: ProtocolFramePair): string {
  const event = pair.request ?? pair.response;
  if (event === null) return '—';
  const name = text(event, 'clientName');
  if (name !== null) return name;
  return text(event, 'client')?.split('/')[0] || '—';
}

function text(event: NonNullable<ProtocolFramePair['request']>, key: string): string | null {
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
