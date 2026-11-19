/** Reports page: list + detail side by side; create and alert actions stay in place. */
import { App as AntApp, Button, Card, Col, Descriptions, Drawer, Form, Input, Row, Select, Space, Table, Typography } from 'antd';
import { ReloadOutlined, PlusOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader, StateTag, stateLabel } from '../components/common.tsx';
import { ApiError } from '../../lib/api.ts';
import { formatTimestamp } from '../../lib/format.ts';

type Severity = 'low' | 'medium' | 'high' | 'critical';
type ReportStatus = 'open' | 'ack' | 'closed';

interface ReportView {
  id: string;
  createdAt: string;
  updatedAt: string;
  source: 'mcp' | 'admin';
  binding: string | null;
  client: string | null;
  severity: Severity;
  title: string;
  status: ReportStatus;
  alertState: string;
  alertError: string | null;
  alertAttempts: number;
  alertedAt: string | null;
  detail?: string;
  context?: unknown;
}

interface CreateValues {
  title: string;
  detail: string;
  severity: Severity;
  context?: string;
}

const STATUS_OPTIONS: Array<{ value: '' | ReportStatus; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'open', label: stateLabel('open') },
  { value: 'ack', label: stateLabel('ack') },
  { value: 'closed', label: stateLabel('closed') },
];

const SEVERITY_OPTIONS: Array<{ value: Severity; label: string }> = (
  ['low', 'medium', 'high', 'critical'] as const
).map((value) => ({ value, label: stateLabel(value) }));

/** `#/reports?status=…` is the entry used by the overview attention card. */
function initialStatus(): '' | ReportStatus {
  const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('status');
  return value === 'open' || value === 'ack' || value === 'closed' ? value : '';
}

export function ReportsPage(): React.ReactElement {
  const api = useApi();
  const { message } = AntApp.useApp();
  const [reports, setReports] = useState<ReportView[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'' | ReportStatus>(initialStatus);
  const [severity, setSeverity] = useState<'' | Severity>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReportView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<CreateValues>();

  const load = useCallback(async (): Promise<void> => {
    try {
      const query: Record<string, string | number> = { limit: 50 };
      if (status !== '') query['status'] = status;
      if (severity !== '') query['severity'] = severity;
      const response = await api.get<{ items?: ReportView[] }>('/reports', { query });
      const items = Array.isArray(response.items) ? response.items : [];
      setReports(items);
      setSelectedId((current) =>
        current !== null && items.some((item) => item.id === current) ? current : items[0]?.id ?? null,
      );
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setLoading(false);
    }
  }, [api, message, severity, status]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    const onRefresh = (): void => void load();
    window.addEventListener('repl:refresh', onRefresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('repl:refresh', onRefresh);
    };
  }, [load]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void api
      .get<{ report: ReportView }>(`/reports/${encodeURIComponent(selectedId)}`)
      .then((response) => {
        if (!cancelled) setDetail(response.report);
      })
      .catch((error: unknown) => {
        if (!cancelled) message.error(failureText(error));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, message, selectedId]);

  const columns = useMemo(
    () => [
      {
        title: '时间',
        dataIndex: 'createdAt',
        width: 150,
        render: (value: string) => <span className="muted">{formatTimestamp(value)}</span>,
      },
      {
        title: '严重级',
        dataIndex: 'severity',
        width: 96,
        render: (value: Severity) => <StateTag state={value} />,
      },
      { title: '标题', dataIndex: 'title', ellipsis: true },
      {
        title: '状态',
        dataIndex: 'status',
        width: 90,
        render: (value: ReportStatus) => <StateTag state={value} />,
      },
      {
        title: '告警',
        dataIndex: 'alertState',
        width: 110,
        render: (value: string) => <StateTag state={value} />,
      },
    ],
    [],
  );

  async function changeStatus(next: ReportStatus): Promise<void> {
    if (detail === null) return;
    try {
      await api.patch(`/reports/${encodeURIComponent(detail.id)}`, { status: next });
      message.success(`报告状态已更新为 ${next}`);
      await load();
      setDetail({ ...detail, status: next });
    } catch (error) {
      message.error(failureText(error));
    }
  }

  async function retryAlert(): Promise<void> {
    if (detail === null) return;
    try {
      await api.post(`/reports/${encodeURIComponent(detail.id)}/retry-alert`);
      message.success('告警已重新排队');
      await load();
    } catch (error) {
      message.error(failureText(error));
    }
  }

  async function submitReport(values: CreateValues): Promise<void> {
    let context: unknown;
    if (values.context !== undefined && values.context.trim() !== '') {
      try {
        context = JSON.parse(values.context);
      } catch {
        message.error('context 不是合法 JSON');
        return;
      }
      if (typeof context !== 'object' || context === null || Array.isArray(context)) {
        message.error('context 必须是 JSON 对象');
        return;
      }
    }
    try {
      const body: Record<string, unknown> = {
        title: values.title.trim(),
        detail: values.detail.trim(),
        severity: values.severity,
      };
      if (context !== undefined) body['context'] = context;
      const response = await api.post<{ report: ReportView }>('/reports', body);
      message.success(`已创建报告 ${response.report.id}`);
      form.resetFields();
      setCreateOpen(false);
      await load();
      setSelectedId(response.report.id);
    } catch (error) {
      message.error(failureText(error));
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="报告"
        description="问题报告与告警投递。列表常驻，详情在右侧；正文与 context 不进入告警消息。"
        actions={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建报告
            </Button>
          </Space>
        }
      />
      <Row gutter={16} align="top">
        <Col xs={24} xl={14}>
          <Card
            title="问题报告"
            extra={
              <Space wrap>
                <Select
                  value={status}
                  style={{ width: 120 }}
                  onChange={(value) => setStatus(value)}
                  options={STATUS_OPTIONS}
                />
                <Select
                  value={severity}
                  style={{ width: 130 }}
                  onChange={(value) => setSeverity(value)}
                  options={[{ value: '', label: '全部严重级' }, ...SEVERITY_OPTIONS]}
                />
              </Space>
            }
          >
            <Table
              size="small"
              rowKey="id"
              loading={loading}
              dataSource={reports}
              columns={columns}
              pagination={false}
              scroll={{ y: 'calc(100vh - 260px)' }}
              rowClassName={(record) => (record.id === selectedId ? 'row-selected' : '')}
              onRow={(record) => ({ onClick: () => setSelectedId(record.id) })}
              locale={{ emptyText: '还没有问题报告' }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card
            title={detail === null ? '报告详情' : detail.title}
            loading={detailLoading}
            extra={detail === null ? null : <StateTag state={detail.status} />}
            className="detail-card"
          >
            {detail === null ? (
              <Typography.Paragraph type="secondary">从左侧选择一条报告。</Typography.Paragraph>
            ) : (
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                <Descriptions column={2} size="small">
                  <Descriptions.Item label="严重级">
                    <StateTag state={detail.severity} />
                  </Descriptions.Item>
                  <Descriptions.Item label="告警">
                    <StateTag state={detail.alertState} />
                  </Descriptions.Item>
                  <Descriptions.Item label="来源">{detail.source === 'mcp' ? 'MCP' : '管理端'}</Descriptions.Item>
                  <Descriptions.Item label="client">
                    <span className="mono">{detail.client ?? '—'}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="binding">
                    <span className="mono">{detail.binding ?? '—'}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="送达">
                    {detail.alertedAt === null ? '—' : formatTimestamp(detail.alertedAt)}
                  </Descriptions.Item>
                </Descriptions>
                <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                  {detail.detail ?? ''}
                </Typography.Paragraph>
                {detail.context === undefined ? null : (
                  <pre className="code-block">{JSON.stringify(detail.context, null, 2)}</pre>
                )}
                {detail.alertError === null ? null : (
                  <Typography.Text type="danger">{detail.alertError}</Typography.Text>
                )}
                <Space wrap>
                  {detail.status === 'open' ? <Button onClick={() => void changeStatus('ack')}>确认</Button> : null}
                  {detail.status !== 'open' ? <Button onClick={() => void changeStatus('open')}>重新打开</Button> : null}
                  {detail.status !== 'closed' ? (
                    <Button type="primary" onClick={() => void changeStatus('closed')}>
                      关闭
                    </Button>
                  ) : null}
                  {['failed', 'skipped', 'no_webhook'].includes(detail.alertState) ? (
                    <Button onClick={() => void retryAlert()}>重发告警</Button>
                  ) : null}
                </Space>
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Drawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建问题报告"
        width={460}
        extra={
          <Space>
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()}>
              提交
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={(values) => void submitReport(values)} initialValues={{ severity: 'high' }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '标题不能为空' }]}>
            <Input maxLength={200} placeholder="Bash 执行 npm test 时挂起" />
          </Form.Item>
          <Form.Item name="detail" label="详情" rules={[{ required: true, message: '详情不能为空' }]}>
            <Input.TextArea rows={6} maxLength={20000} placeholder="现象、期望与实际、复现步骤；不要粘贴密钥。" />
          </Form.Item>
          <Form.Item name="severity" label="严重级">
            <Select options={SEVERITY_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="context"
            label="context（JSON，可选）"
            rules={[
              {
                validator: async (_rule, value?: string) => {
                  if (value === undefined || value.trim() === '') return;
                  try {
                    const parsed: unknown = JSON.parse(value);
                    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                      throw new Error('object');
                    }
                  } catch {
                    throw new Error('context 必须是 JSON 对象');
                  }
                },
              },
            ]}
          >
            <Input.TextArea rows={3} className="mono" placeholder='{ "tool": "Bash" }' />
          </Form.Item>
          <Typography.Text type="secondary">报告中不要粘贴密钥；详情与 context 不会进入告警消息和审计日志。</Typography.Text>
        </Form>
      </Drawer>
    </div>
  );
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
