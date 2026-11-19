/** Clients page: bindings, visibility/quota editing and one-time tokens. */
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from '../components/common.tsx';
import { TagPicker, tagLabel, useTagDictionary, type TagDefinition } from '../components/TagPicker.tsx';
import { ApiError } from '../../lib/api.ts';
import { formatId, formatNumber, formatRelativeTime, formatTimestamp } from '../../lib/format.ts';

type ClientQuotaKey =
  | 'maxExecSessionsPerBinding'
  | 'maxInFlightEvalsPerBinding'
  | 'maxInFlightCallsPerBindingPerServer'
  | 'maxQueuedCallsPerBindingPerServer';

type ClientQuota = Partial<Record<ClientQuotaKey, number>>;

interface ClientBinding {
  id: string;
  label: string;
  defaultWorkspace: string | null;
  allowedServers: string[] | null;
  allowedTags: string[] | null;
  quota: ClientQuota | null;
  createdAt: string;
  lastSeenAt: string | null;
  activeSessions?: number;
}

interface McpSessionRecord {
  mcpSessionId: string;
  bindingId: string | null;
  client: string;
  connectedAt?: string;
  lastRequestAt?: string;
  execSessionIds?: string[];
}

interface ClientsResponse {
  clients: ClientBinding[];
  sessions: McpSessionRecord[];
}

interface ClientFormValues {
  label: string;
  defaultWorkspace?: string;
  allowedServers?: string[];
  allowedTags?: string[];
  maxExecSessionsPerBinding?: number | null;
  maxInFlightEvalsPerBinding?: number | null;
  maxInFlightCallsPerBindingPerServer?: number | null;
  maxQueuedCallsPerBindingPerServer?: number | null;
}

const QUOTA_KEYS: readonly ClientQuotaKey[] = [
  'maxExecSessionsPerBinding',
  'maxInFlightEvalsPerBinding',
  'maxInFlightCallsPerBindingPerServer',
  'maxQueuedCallsPerBindingPerServer',
];

const QUOTA_LABELS: Record<ClientQuotaKey, string> = {
  maxExecSessionsPerBinding: '执行会话',
  maxInFlightEvalsPerBinding: '并发 eval',
  maxInFlightCallsPerBindingPerServer: '单 server 并发调用',
  maxQueuedCallsPerBindingPerServer: '单 server 排队调用',
};

export function ClientsPage(): React.ReactElement {
  const api = useApi();
  const { message, modal } = AntApp.useApp();
  const dictionary = useTagDictionary();
  const [clients, setClients] = useState<ClientBinding[]>([]);
  const [sessions, setSessions] = useState<McpSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ClientBinding | null>(null);
  const [saving, setSaving] = useState(false);
  const [tokenReveal, setTokenReveal] = useState<{ label: string; token: string } | null>(null);
  const [form] = Form.useForm<ClientFormValues>();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await api.get<ClientsResponse>('/clients');
      if (!alive.current) return;
      setClients(Array.isArray(response.clients) ? response.clients : []);
      setSessions(Array.isArray(response.sessions) ? response.sessions : []);
    } catch (error) {
      if (alive.current) message.error(failureText(error));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [api, message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onRefresh = (): void => void load();
    window.addEventListener('repl:refresh', onRefresh);
    return () => window.removeEventListener('repl:refresh', onRefresh);
  }, [load]);

  const tagDefinitions = dictionary.tags;

  const columns = useMemo(
    () => [
      {
        title: '绑定',
        dataIndex: 'label',
        width: 190,
        render: (value: string, client: ClientBinding) => (
          <div>
            <div>{value}</div>
            <div className="mono muted">{client.id}</div>
          </div>
        ),
      },
      {
        title: '可见 server',
        dataIndex: 'allowedServers',
        width: 220,
        render: (value: string[] | null) =>
          value === null ? (
            <span className="muted">全部</span>
          ) : (
            <Space size={4} wrap>
              {value.map((serverId) => (
                <Tag key={serverId} bordered={false} className="mono">
                  {serverId}
                </Tag>
              ))}
            </Space>
          ),
      },
      {
        title: '标签',
        dataIndex: 'allowedTags',
        width: 190,
        render: (value: string[] | null) =>
          value === null ? (
            <span className="muted">全部</span>
          ) : (
            <Space size={4} wrap>
              {value.map((tag) => (
                <Tag key={tag} bordered={false} title={tag}>
                  {tagLabel(tagDefinitions, tag)}
                </Tag>
              ))}
            </Space>
          ),
      },
      {
        title: '配额',
        dataIndex: 'quota',
        width: 260,
        render: (value: ClientQuota | null) => <span className="muted">{quotaSummary(value)}</span>,
      },
      {
        title: '活跃会话',
        dataIndex: 'activeSessions',
        width: 100,
        render: (value: number | undefined) => formatNumber(value ?? 0),
      },
      {
        title: '最近活动',
        dataIndex: 'lastSeenAt',
        width: 130,
        render: (value: string | null) => (
          <span className="muted" title={formatTimestamp(value)}>
            {formatRelativeTime(value)}
          </span>
        ),
      },
      {
        title: '操作',
        width: 150,
        render: (_value: unknown, client: ClientBinding) => (
          <Space size={0}>
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditor(client)}>
              编辑
            </Button>
            <Button
              size="small"
              type="link"
              danger
              icon={<DeleteOutlined />}
              onClick={() => requestDelete(client)}
            >
              删除
            </Button>
          </Space>
        ),
      },
    ],
    [tagDefinitions],
  );

  function openEditor(client: ClientBinding | null): void {
    setEditing(client);
    setEditorOpen(true);
    form.resetFields();
    if (client === null) {
      form.setFieldsValue({
        label: '',
        defaultWorkspace: '',
        allowedServers: [],
        allowedTags: [],
        maxExecSessionsPerBinding: undefined,
        maxInFlightEvalsPerBinding: undefined,
        maxInFlightCallsPerBindingPerServer: undefined,
        maxQueuedCallsPerBindingPerServer: undefined,
      });
      return;
    }
    form.setFieldsValue({
      label: client.label,
      defaultWorkspace: client.defaultWorkspace ?? '',
      allowedServers: client.allowedServers ?? [],
      allowedTags: client.allowedTags ?? [],
      maxExecSessionsPerBinding: client.quota?.maxExecSessionsPerBinding,
      maxInFlightEvalsPerBinding: client.quota?.maxInFlightEvalsPerBinding,
      maxInFlightCallsPerBindingPerServer: client.quota?.maxInFlightCallsPerBindingPerServer,
      maxQueuedCallsPerBindingPerServer: client.quota?.maxQueuedCallsPerBindingPerServer,
    });
  }

  async function saveClient(values: ClientFormValues): Promise<void> {
    const target = editing;
    const label = values.label.trim();
    if (label === '') {
      message.error('label 不能为空');
      return;
    }
    const quota: ClientQuota = {};
    for (const key of QUOTA_KEYS) {
      const value = values[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1) quota[key] = value;
    }
    const body: Record<string, unknown> = {
      label,
      defaultWorkspace: nullIfEmpty(values.defaultWorkspace),
      allowedServers:
        values.allowedServers === undefined || values.allowedServers.length === 0
          ? null
          : values.allowedServers,
      allowedTags:
        values.allowedTags === undefined || values.allowedTags.length === 0
          ? null
          : values.allowedTags,
      quota: Object.keys(quota).length === 0 ? null : quota,
    };
    setSaving(true);
    try {
      if (target === null) {
        const response = await api.post<{ client: ClientBinding; token: string }>('/clients', body);
        if (!alive.current) return;
        setTokenReveal({ label: response.client.label, token: response.token });
        message.success('已创建绑定；明文 token 只显示这一次');
      } else {
        const response = await api.put<{
          client: ClientBinding;
          affectedSessions?: number;
          warning?: string;
        }>(`/clients/${encodeURIComponent(target.id)}`, body);
        if (!alive.current) return;
        const affected = response.affectedSessions ?? 0;
        const text = `已保存绑定；销毁活跃执行会话 ${formatNumber(affected)} 个`;
        if (response.warning === undefined) message.success(text);
        else message.warning(`${text}；${response.warning}`);
      }
      setEditorOpen(false);
      setEditing(null);
      await load();
    } catch (error) {
      if (alive.current) message.error(failureText(error));
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  function requestDelete(client: ClientBinding): void {
    modal.confirm({
      title: `删除绑定 ${client.label}（${client.id}）？`,
      content: 'token 立即失效，并销毁其执行会话。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const response = await api.delete<{ affectedSessions?: number; warning?: string }>(
            `/clients/${encodeURIComponent(client.id)}`,
          );
          if (!alive.current) return;
          const text = `已删除绑定 ${client.id}；销毁执行会话 ${formatNumber(response.affectedSessions ?? 0)} 个`;
          if (response.warning === undefined) message.success(text);
          else message.warning(`${text}；${response.warning}`);
          await load();
        } catch (error) {
          if (alive.current) message.error(failureText(error));
        }
      },
    });
  }

  return (
    <div className="page">
      <PageHeader
        title="客户端"
        description="客户端绑定（binding）的可见范围、标签、配额与 token。明文 token 只在创建后显示一次，离开本页即清除。"
        actions={
          <Space wrap>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
              新建绑定
            </Button>
          </Space>
        }
      />
      <Card
        title="客户端绑定"
        extra={
          <span className="muted">
            {formatNumber(clients.length)} 个绑定 · {formatNumber(sessions.length)} 个活跃 MCP 会话
          </span>
        }
      >
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={clients}
          columns={columns}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有客户端绑定；创建后明文 token 只返回一次"
              />
            ),
          }}
        />
      </Card>

      <Card
        title="活跃 MCP 会话"
        extra={<span className="muted">{formatNumber(sessions.length)} 个传输会话</span>}
      >
        <Table
          size="small"
          rowKey="mcpSessionId"
          loading={loading}
          dataSource={sessions}
          pagination={false}
          columns={[
            {
              title: 'Mcp-Session-Id',
              dataIndex: 'mcpSessionId',
              render: (value: string) => <span className="mono">{formatId(value, 22)}</span>,
            },
            {
              title: '客户端（client）',
              dataIndex: 'client',
              render: (value: string) => value || '—',
            },
            {
              title: '绑定（binding）',
              dataIndex: 'bindingId',
              render: (value: string | null) => (
                <span className={value === null ? 'muted' : 'mono'}>{value ?? 'unbound'}</span>
              ),
            },
            {
              title: '执行会话',
              dataIndex: 'execSessionIds',
              render: (value: string[] | undefined) => (
                <span className="muted">{(value ?? []).join(', ') || '—'}</span>
              ),
            },
            {
              title: '最近请求',
              dataIndex: 'lastRequestAt',
              render: (value: string | undefined, session: McpSessionRecord) => (
                <span className="muted">
                  {formatRelativeTime(value ?? session.connectedAt ?? null)}
                </span>
              ),
            },
          ]}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有活跃会话" />,
          }}
        />
      </Card>

      <Drawer
        forceRender
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editing === null ? '新建客户端绑定' : `编辑 ${editing.id}`}
        width={560}
        extra={
          <Space>
            <Button onClick={() => setEditorOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={(values) => void saveClient(values)}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={
              editing === null
                ? '明文 token 只在创建成功后返回一次；请立即保存。'
                : '保存会按 binding 销毁其活跃执行会话；旧 token 仍按每请求复核保持有效。'
            }
          />
          <Form.Item
            name="label"
            label="label"
            rules={[
              { required: true, whitespace: true, message: 'label 不能为空' },
              { max: 128, message: 'label 最多 128 个字符' },
            ]}
          >
            <Input placeholder="work-laptop" />
          </Form.Item>
          <Form.Item
            name="defaultWorkspace"
            label="defaultWorkspace"
            rules={[
              {
                validator: async (_rule, value?: string) => {
                  const text = (value ?? '').trim();
                  if (text !== '' && !isAbsolutePath(text)) {
                    throw new Error('defaultWorkspace 必须是绝对路径，例如 /Users/me/work');
                  }
                },
              },
            ]}
          >
            <Input placeholder="/Users/me/work（留空继承全局默认）" />
          </Form.Item>
          <Form.Item
            name="allowedServers"
            label="允许的 server"
            extra="留空表示全部；输入 server id 后回车。"
          >
            <Select
              mode="tags"
              allowClear
              placeholder="留空表示全部"
              tokenSeparators={[',']}
            />
          </Form.Item>
          <Form.Item name="allowedTags" label="允许的标签" extra="留空表示全部。">
            <TagsField dictionary={tagDefinitions} />
          </Form.Item>
          <Typography.Text type="secondary">配额留空取全局默认；按 binding 立即生效。</Typography.Text>
          <div>
            {QUOTA_KEYS.map((key) => (
              <Form.Item
                key={key}
                name={key}
                label={`${key}（${QUOTA_LABELS[key]}）`}
                rules={[{ type: 'number', min: 1, max: 1000000, message: '必须是 1 到 1000000 之间的整数' }]}
              >
                <InputNumber min={1} max={1000000} precision={0} style={{ width: '100%' }} placeholder="留空取默认" />
              </Form.Item>
            ))}
          </div>
        </Form>
      </Drawer>

      <Modal
        open={tokenReveal !== null}
        title={tokenReveal === null ? '一次性 token' : `一次性 token · ${tokenReveal.label}`}
        okText="我已保存"
        cancelText="关闭"
        onOk={() => setTokenReveal(null)}
        onCancel={() => setTokenReveal(null)}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="明文 token 只显示这一次；关闭窗口或离开本页后无法再次查看。"
          />
          <Input.TextArea
            readOnly
            className="mono"
            autoSize={{ minRows: 2, maxRows: 4 }}
            value={tokenReveal?.token ?? ''}
          />
          <Typography.Paragraph copyable={{ text: tokenReveal?.token ?? '' }} style={{ marginBottom: 0 }}>
            复制 token，填入客户端的 Authorization header。
          </Typography.Paragraph>
        </Space>
      </Modal>
    </div>
  );
}

function TagsField({
  value,
  onChange,
  dictionary,
}: {
  value?: string[];
  onChange?: (next: string[]) => void;
  dictionary: readonly TagDefinition[];
}): React.ReactElement {
  return (
    <TagPicker dictionary={dictionary} value={value ?? []} onChange={(next) => onChange?.(next)} />
  );
}

function quotaSummary(quota: ClientQuota | null): string {
  if (quota === null) return '默认';
  const parts: string[] = [];
  for (const key of QUOTA_KEYS) {
    const value = quota[key];
    if (value !== undefined) parts.push(`${QUOTA_LABELS[key]}=${value}`);
  }
  return parts.length === 0 ? '默认' : parts.join(', ');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function nullIfEmpty(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
