/** Request-level audit view: one row per MCP request/response pair with payloads. */
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from '../components/common.tsx';
import { FrameColumn, type FrameEvent } from '../components/FramePayload.tsx';
import { ApiError, framesTruncatedNotice, type FramesResponse } from '../../lib/api.ts';
import { formatBytes, formatDuration, formatNumber, formatTimestamp } from '../../lib/format.ts';

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

export function RequestsPage(): React.ReactElement {
  const api = useApi();
  const [filters, setFilters] = useState<RequestFilters>(DEFAULT_FILTERS);
  const [frames, setFrames] = useState<FramesResponse<ProtocolFramePair> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next: RequestFilters): Promise<void> => {
      setLoading(true);
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
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load(DEFAULT_FILTERS);
  }, [load]);

  function update(patch: Partial<RequestFilters>): void {
    const next = { ...filters, ...patch };
    setFilters(next);
    void load(next);
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
      width: 190,
      ellipsis: true,
      render: (_value, pair) => pairClientLabel(pair),
    },
    {
      title: '方法',
      key: 'method',
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
            {pair.ok === false ? 'error' : 'ok'}
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

  return (
    <div className="page">
      <PageHeader
        title="请求记录"
        description="一行一次 MCP 请求；展开查看脱敏后的请求与响应报文。连接、discover、tools/list 等没有执行事件的请求也在这里。"
        actions={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(filters)}>
            刷新
          </Button>
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
          expandable={{
            expandedRowRender: (pair) => (
              <Row gutter={12}>
                <Col span={12}>
                  <FrameColumn label="请求报文" event={pair.request} />
                </Col>
                <Col span={12}>
                  <FrameColumn label="响应报文" event={pair.response} />
                </Col>
              </Row>
            ),
          }}
          locale={{
            emptyText: (
              <Empty description="没有匹配的请求。放宽时间范围，或确认服务端已在 full 帧模式重启。" />
            ),
          }}
        />
      </Card>
    </div>
  );
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
