/**
 * Shared request-detail drawer: process, protocol frames and audit events for one
 * request pair. RequestsPage owns live refresh; ScriptsPage reuses the same drawer
 * for a script run instead of rendering a second execution view.
 */
import { Alert, Col, Drawer, Empty, Row, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';

import { stateLabel } from './common.tsx';
import { FrameColumn, type FrameEvent } from './FramePayload.tsx';
import { PayloadViewer } from './PayloadViewer.tsx';
import { RequestMetaCard } from './RequestMetaCard.tsx';
import { RequestProcess } from './RequestProcess.tsx';
import { ScriptCodeCard } from './ScriptCodeCard.tsx';
import { ScriptInfoCard } from './ScriptInfoCard.tsx';
import type { ApiClient } from '../../lib/api.ts';
import { eventLabel, eventSubject } from '../../lib/audit-labels.ts';
import { formatDuration, formatTimestamp } from '../../lib/format.ts';
import { payloadView, rowMedia, type PayloadView } from '../../lib/payload-view.ts';
import {
  eventDedupeKey,
  eventWindow,
  requestDetailKeys,
  type RequestDetailKeys,
} from '../../lib/request-detail.ts';
import {
  mergeScriptInfo,
  scriptInfoFromEvents,
  scriptInfoFromRequest,
} from '../../lib/script-info.ts';

const { Text } = Typography;

/** One request/response protocol pair, as returned by `/logs/frames`. */
export interface RequestFramePair {
  mcp: string;
  id: string | number | null;
  method: string | null;
  request: FrameEvent | null;
  response: FrameEvent | null;
  durMs?: number;
  ok?: boolean;
}

/** Audit row shape the drawer reads; extra fields stay available for payloads. */
export interface DetailAuditEvent {
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

function timeOf(event: DetailAuditEvent): number {
  const time = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

/**
 * Loads the events behind one request: the `eval_start` of that JSON-RPC id, then
 * every event sharing its `runId`, plus the async task half addressed by `evalTaskId`.
 */
export async function loadRequestDetailEvents(
  api: ApiClient,
  pair: RequestFramePair,
): Promise<{ events: DetailAuditEvent[]; keys: RequestDetailKeys }> {
  const starts = await api.get<{ events?: DetailAuditEvent[] }>('/logs/query', {
    query: {
      ...eventWindow(pair.request?.ts, pair.response?.ts, isAsyncResponse(pair.response)),
      mcp: pair.mcp,
      limit: 500,
    },
  });
  const first = Array.isArray(starts.events) ? starts.events : [];
  const keys = requestDetailKeys(first, pair.id);

  const collected: DetailAuditEvent[] = [];
  const seen = new Set<string>();
  const push = (batch: DetailAuditEvent[]): void => {
    for (const event of batch) {
      const key = eventDedupeKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(event);
    }
  };
  for (const runId of keys.runIds) {
    const response = await api.get<{ events?: DetailAuditEvent[] }>('/logs/query', {
      query: { runId, limit: 500 },
    });
    if (Array.isArray(response.events)) push(response.events);
  }
  // `async_dispatch` has no `runId`; its `evalTaskId` is the only handle on
  // the background half (settle, cancel), so it needs its own lookup.
  for (const taskId of keys.taskIds) {
    const response = await api.get<{ events?: DetailAuditEvent[] }>('/logs/query', {
      query: { taskId, limit: 500 },
    });
    if (Array.isArray(response.events)) push(response.events);
  }
  collected.sort((left, right) => timeOf(left) - timeOf(right));
  return { events: collected, keys };
}

/** `<repl-output async="true">` keeps the event window's tail open. */
function isAsyncResponse(response: unknown): boolean {
  if (typeof response !== 'object' || response === null) return false;
  const result = (response as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) return false;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === 'string') {
      return /<repl-output[^>]*\basync="true"/u.test(text);
    }
  }
  return false;
}

export function RequestDetailDrawer({
  pair,
  events,
  loading,
  error,
  onClose,
}: {
  pair: RequestFramePair | null;
  events: DetailAuditEvent[] | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}): React.ReactElement {
  const eventCount = events === null ? null : events.length;
  const scriptInfo =
    pair === null ? null : mergeScriptInfo(scriptInfoFromRequest(pair.request), scriptInfoFromEvents(events));

  return (
    <Drawer
      placement="left"
      open={pair !== null}
      onClose={onClose}
      width={1120}
      title={
        pair === null ? (
          '请求详情'
        ) : (
          <Space size={8}>
            <span className="mono">{pair.method ?? 'request'}</span>
            <span className="muted">#{pair.id ?? '—'}</span>
            <Tag color={pair.ok === false ? 'red' : 'green'} bordered={false}>
              {pair.response === null ? '无响应' : stateLabel(pair.ok === false ? 'error' : 'ok')}
            </Tag>
          </Space>
        )
      }
    >
      {pair === null ? null : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <RequestMetaCard pair={pair} events={events} />
          <ScriptInfoCard info={scriptInfo} />
          <Tabs
            items={[
              {
                key: 'timeline',
                label: '过程',
                children: (
                  <RequestProcess
                    request={pair.request}
                    response={pair.response}
                    events={events}
                    loading={loading}
                    error={error}
                  />
                ),
              },
              {
                key: 'frames',
                label: '协议帧',
                children: (
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <ScriptCodeCard
                      key={`${pair.mcp}:${String(pair.id ?? '')}:${pair.request?.ts ?? ''}`}
                      request={pair.request}
                      method={pair.method}
                    />
                    <Row gutter={12}>
                      <Col span={12}>
                        <FrameColumn
                          label="请求报文"
                          event={pair.request}
                          maxHeight="calc(100vh - 210px)"
                        />
                      </Col>
                      <Col span={12}>
                        <FrameColumn
                          label="响应报文"
                          event={pair.response}
                          maxHeight="calc(100vh - 210px)"
                        />
                      </Col>
                    </Row>
                  </Space>
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
                    {error === null ? null : (
                      <Alert type="error" showIcon message="事件读取失败" description={error} />
                    )}
                    <Table<DetailAuditEvent>
                      size="small"
                      rowKey={eventDedupeKey}
                      loading={loading}
                      dataSource={events ?? []}
                      pagination={false}
                      columns={eventColumns}
                      expandable={{
                        rowExpandable: (event) => eventHasPayload(event),
                        expandedRowRender: (event) => <EventPayloadDetail event={event} />,
                      }}
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
        </Space>
      )}
    </Drawer>
  );
}

const eventColumns: TableProps<DetailAuditEvent>['columns'] = [
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

/** Payload sides an event can carry; only the directions that exist are populated. */
function eventPayloadSides(event: DetailAuditEvent): {
  input: PayloadView | null;
  output: PayloadView | null;
} {
  if (event.event === 'tool_call') {
    return { input: payloadView(event, 'args', 'tool'), output: null };
  }
  if (event.event === 'tool_result') {
    return { input: null, output: payloadView(event, 'result', 'tool') };
  }
  if (event.event === 'proto_in') {
    return { input: payloadView(event, 'params', 'frame'), output: null };
  }
  if (event.event === 'proto_out') {
    return { input: null, output: payloadView(event, 'result', 'frame') };
  }
  return { input: null, output: null };
}

/** True when a side carries anything the viewer can render. */
function hasPayloadContent(view: PayloadView | null): boolean {
  return (
    view !== null &&
    (view.inline !== undefined ||
      view.ref !== null ||
      view.preview !== null ||
      view.dropped !== null ||
      view.bytes !== null)
  );
}

function eventHasPayload(event: DetailAuditEvent): boolean {
  const { input, output } = eventPayloadSides(event);
  return hasPayloadContent(input) || hasPayloadContent(output);
}

function EventPayloadDetail({ event }: { event: DetailAuditEvent }): React.ReactElement {
  const { input, output } = eventPayloadSides(event);
  const sides: Array<{ label: string; view: PayloadView }> = [];
  if (input !== null && hasPayloadContent(input)) sides.push({ label: '输入', view: input });
  if (output !== null && hasPayloadContent(output)) sides.push({ label: '输出', view: output });
  if (sides.length === 0) return <Text type="secondary">该事件没有输入/输出载荷</Text>;
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {sides.map((side) => (
        <PayloadViewer key={side.label} label={side.label} view={side.view} maxHeight={220} media={rowMedia(event)} />
      ))}
    </Space>
  );
}

function eventStatusTag(event: DetailAuditEvent): React.ReactElement {
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

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
