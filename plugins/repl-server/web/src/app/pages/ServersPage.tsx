/** Servers page: searchable list on the left, connection/detail actions on the right. */
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  ApiOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  RedoOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader, StateTag } from '../components/common.tsx';
import { TagPicker, tagLabel, useTagDictionary, type TagDefinition } from '../components/TagPicker.tsx';
import { ApiError } from '../../lib/api.ts';
import { formatDuration, formatRelativeTime, formatTimestamp } from '../../lib/format.ts';

type ServerTransport = 'stdio' | 'http' | 'builtin';
type ConnectMode = 'lazy' | 'eager';

interface ServerView {
  id: string;
  label: string;
  transport: ServerTransport;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  connectMode: ConnectMode;
  summary: string | null;
  category: string | null;
  tags: string[];
  timeoutMs: number;
  maxConcurrency: number;
  revision: number;
  state: string;
  lastError?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface ServersResponse {
  servers: ServerView[];
  revision: number;
}

interface Operation {
  operationId: string;
  state: 'running' | 'ok' | 'error';
  error?: { code: string; message: string };
}

interface ServerFormValues {
  id: string;
  label: string;
  transport: ServerTransport;
  command?: string;
  args?: string;
  cwd?: string;
  url?: string;
  envKeys?: string;
  headerKeys?: string;
  connectMode: ConnectMode;
  summary?: string;
  category?: string;
  tags?: string[];
  enabled: boolean;
  timeoutMs?: number | null;
  maxConcurrency?: number | null;
}

interface TestResult {
  serverId: string;
  ok: boolean;
  text: string;
}

interface BusyState {
  serverId: string;
  label: string;
}

type ServerAction = 'connect' | 'disconnect' | 'restart';

const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_PATTERN = /^[A-Za-z0-9-]+$/;

export function ServersPage(): React.ReactElement {
  const api = useApi();
  const { message, modal } = AntApp.useApp();
  const dictionary = useTagDictionary();
  const [servers, setServers] = useState<ServerView[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ServerView | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ServerFormValues>();
  const transport = Form.useWatch('transport', form) ?? 'stdio';
  const alive = useRef(true);
  const messageKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const key of messageKeys.current) message.destroy(key);
      messageKeys.current.clear();
    };
  }, [message]);

  function showMessage(config: Parameters<typeof message.open>[0] & { key: string }): void {
    messageKeys.current.add(config.key);
    message.open(config);
  }

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await api.get<ServersResponse>('/servers');
      const items = Array.isArray(response.servers) ? response.servers : [];
      if (!alive.current) return;
      setServers(items);
      setRevision(typeof response.revision === 'number' ? response.revision : 0);
      setSelectedId((current) =>
        current !== null && items.some((server) => server.id === current) ? current : items[0]?.id ?? null,
      );
    } catch (error) {
      if (alive.current) message.error(failureText(error));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [api, message]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    const onRefresh = (): void => void load();
    window.addEventListener('repl:refresh', onRefresh);
    return () => window.removeEventListener('repl:refresh', onRefresh);
  }, [load]);

  // A connect/restart can outlive the operation poll. Keep refreshing while any
  // server is transient so the tag leaves "启动中" without a manual reload.
  useEffect(() => {
    const transient = servers.some(
      (server) =>
        server.state === 'starting' ||
        server.state === 'connecting' ||
        server.state === 'reconnecting',
    );
    if (!transient) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [servers, load]);

  const selected = servers.find((server) => server.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return servers;
    return servers.filter(
      (server) =>
        server.id.toLowerCase().includes(needle) ||
        server.label.toLowerCase().includes(needle) ||
        server.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }, [query, servers]);

  const tagDefinitions = dictionary.tags;

  const columns = useMemo(
    () => [
      {
        title: '服务端',
        dataIndex: 'label',
        render: (value: string, server: ServerView) => (
          <div>
            <div>{value}</div>
            <div className="mono muted">{server.id}</div>
          </div>
        ),
      },
      {
        title: '传输',
        dataIndex: 'transport',
        width: 90,
        render: (value: ServerTransport) => <span className="mono">{value}</span>,
      },
      {
        title: '状态',
        dataIndex: 'state',
        width: 110,
        render: (value: string) => <StateTag state={value} />,
      },
      {
        title: '启用',
        dataIndex: 'enabled',
        width: 80,
        render: (value: boolean) => (
          <Tag color={value ? 'success' : 'default'} bordered={false}>
            {value ? '启用' : '停用'}
          </Tag>
        ),
      },
      {
        title: '标签',
        dataIndex: 'tags',
        width: 190,
        render: (value: string[]) => <TagList tags={value} dictionary={tagDefinitions} />,
      },
      {
        title: '更新',
        dataIndex: 'updatedAt',
        width: 130,
        render: (value: string | undefined) => (
          <span className="muted" title={value}>
            {formatRelativeTime(value ?? null)}
          </span>
        ),
      },
    ],
    [tagDefinitions],
  );

  function openEditor(server: ServerView | null): void {
    setEditing(server);
    setEditorOpen(true);
    setTestResult(null);
    form.resetFields();
    form.setFieldsValue(
      server === null
        ? {
            id: '',
            label: '',
            transport: 'stdio',
            command: '',
            args: '',
            cwd: '',
            url: '',
            envKeys: '',
            headerKeys: '',
            connectMode: 'lazy',
            summary: '',
            category: '',
            tags: [],
            enabled: true,
            timeoutMs: 60000,
            maxConcurrency: 8,
          }
        : {
            id: server.id,
            label: server.label,
            transport: server.transport,
            command: server.command ?? '',
            args: server.args.join('\n'),
            cwd: server.cwd ?? '',
            url: server.url ?? '',
            envKeys: server.envKeys.join('\n'),
            headerKeys: server.headerKeys.join('\n'),
            connectMode: server.connectMode,
            summary: server.summary ?? '',
            category: server.category ?? '',
            tags: server.tags,
            enabled: server.enabled,
            timeoutMs: server.timeoutMs,
            maxConcurrency: server.maxConcurrency,
          },
    );
  }

  function confirmDialog(title: string, content: string, okText: string, danger = false): Promise<boolean> {
    return new Promise((resolve) => {
      modal.confirm({
        title,
        content,
        okText,
        cancelText: '取消',
        okButtonProps: danger ? { danger: true } : undefined,
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  async function submitServer(values: ServerFormValues): Promise<void> {
    const target = editing;
    const creating = target === null;
    if (creating && values.transport === 'stdio') {
      const proceed = await confirmDialog(
        '确认注册 stdio server',
        `启动命令：${values.command ?? ''} ${values.args ?? ''}\n这等于允许在该 cwd 下执行任意命令。继续？`,
        '注册',
      );
      if (!proceed) return;
    }
    await persistServer(values, target);
  }

  async function persistServer(values: ServerFormValues, target: ServerView | null): Promise<void> {
    const creating = target === null;
    const builtin = target?.transport === 'builtin';
    const id = values.id.trim();
    const label = values.label.trim() === '' ? id : values.label.trim();
    const timeoutMs = typeof values.timeoutMs === 'number' ? values.timeoutMs : 60000;
    const maxConcurrency = typeof values.maxConcurrency === 'number' ? values.maxConcurrency : 8;
    setSaving(true);
    try {
      if (creating) {
        if (values.transport === 'builtin') {
          message.error('builtin server 不能通过 API 注册。');
          return;
        }
        const body: Record<string, unknown> = {
          id,
          transport: values.transport,
          label,
          enabled: values.enabled,
          connectMode: values.connectMode,
          summary: nullIfEmpty(values.summary),
          category: nullIfEmpty(values.category),
          tags: values.tags ?? [],
          timeoutMs,
          maxConcurrency,
          envKeys: splitList(values.envKeys),
          headerKeys: splitList(values.headerKeys),
        };
        if (values.transport === 'stdio') {
          body['command'] = nullIfEmpty(values.command);
          body['args'] = parseArgs(values.args);
          body['cwd'] = nullIfEmpty(values.cwd);
          body['url'] = null;
        } else {
          body['command'] = null;
          body['args'] = [];
          body['cwd'] = null;
          body['url'] = nullIfEmpty(values.url);
        }
        const response = await api.post<{ server: ServerView; revision: number }>('/servers', body);
        if (!alive.current) return;
        setRevision(response.revision);
        setSelectedId(response.server.id);
        message.success(`已注册 server ${response.server.id}`);
      } else {
        if (target === null) return;
        const patch: Record<string, unknown> = builtin
          ? {
              label,
              enabled: values.enabled,
              summary: nullIfEmpty(values.summary),
              category: nullIfEmpty(values.category),
              tags: values.tags ?? [],
            }
          : {
              label,
              enabled: values.enabled,
              connectMode: values.connectMode,
              summary: nullIfEmpty(values.summary),
              category: nullIfEmpty(values.category),
              tags: values.tags ?? [],
              timeoutMs,
              maxConcurrency,
              envKeys: splitList(values.envKeys),
              headerKeys: splitList(values.headerKeys),
              ...(values.transport === 'stdio'
                ? {
                    command: nullIfEmpty(values.command),
                    args: parseArgs(values.args),
                    cwd: nullIfEmpty(values.cwd),
                  }
                : { url: nullIfEmpty(values.url) }),
            };
        const response = await api.patch<{ server: ServerView; revision: number }>(
          `/servers/${encodeURIComponent(target.id)}`,
          patch,
          { headers: { 'If-Match': String(revision) } },
        );
        if (!alive.current) return;
        setRevision(response.revision);
        message.success(`已保存 server ${response.server.id}`);
      }
      setEditorOpen(false);
      setEditing(null);
      await load();
    } catch (error) {
      if (!alive.current) return;
      if (isConflictError(error)) {
        message.error('配置已被他人修改（revision 冲突），已刷新最新版本；请核对后重新保存。');
        await load();
      } else {
        message.error(failureText(error));
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  async function followOperation(operationId: string, label: string, key: string): Promise<void> {
    const started = Date.now();
    for (;;) {
      if (!alive.current) return;
      try {
        const operation = await api.get<Operation>(`/operations/${encodeURIComponent(operationId)}`);
        if (!alive.current) return;
        if (operation.state === 'ok') {
          showMessage({ type: 'success', content: `${label} 完成`, key, duration: 3 });
          await load();
          return;
        }
        if (operation.state === 'error') {
          const detail = operation.error?.message ?? operation.error?.code ?? '未知错误';
          showMessage({ type: 'error', content: `${label} 失败：${detail}`, key, duration: 5 });
          await load();
          return;
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          showMessage({
            type: 'info',
            content: `${label} 已提交（服务端不提供操作详情），稍后刷新查看状态。`,
            key,
            duration: 4,
          });
          await load();
          return;
        }
      }
      if (Date.now() - started > 15_000) {
        showMessage({
          type: 'warning',
          content: `${label} 仍在运行，稍后刷新查看状态。`,
          key,
          duration: 5,
        });
        await load();
        return;
      }
      await wait(800);
    }
  }

  async function runServerAction(server: ServerView, action: ServerAction): Promise<void> {
    const label = `${actionLabel(action)} ${server.id}`;
    const key = `server-op-${server.id}`;
    setBusy({ serverId: server.id, label });
    showMessage({ type: 'loading', content: `${label}…`, key, duration: 0 });
    try {
      const operation = await api.post<Operation>(
        `/servers/${encodeURIComponent(server.id)}/${action}`,
      );
      if (!alive.current) return;
      showMessage({
        type: 'loading',
        content: `${label}：operation ${operation.operationId}`,
        key,
        duration: 0,
      });
      await followOperation(operation.operationId, label, key);
    } catch (error) {
      if (alive.current) showMessage({ type: 'error', content: failureText(error), key, duration: 5 });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function testServer(server: ServerView): Promise<void> {
    setTestingId(server.id);
    setTestResult(null);
    try {
      const result = await api.post<{ ok: boolean; tools: unknown[]; count: number; elapsedMs: number }>(
        `/servers/${encodeURIComponent(server.id)}/test`,
      );
      if (!alive.current) return;
      const names = result.tools
        .map((tool) =>
          isRecord(tool) && typeof tool['name'] === 'string' ? tool['name'] : '',
        )
        .filter((name) => name !== '')
        .slice(0, 8);
      const text = `测试通过：${result.count} 个工具，耗时 ${formatDuration(result.elapsedMs)}${
        names.length === 0 ? '' : `。${names.join(', ')}${result.count > names.length ? ' 等' : ''}`
      }`;
      setTestResult({ serverId: server.id, ok: true, text });
      message.success(text);
    } catch (error) {
      if (!alive.current) return;
      const missing = missingSecrets(error);
      const text =
        missing.length > 0
          ? `缺少密钥：${missing.join(', ')}。请到“密钥”页填写后重试。`
          : failureText(error);
      setTestResult({ serverId: server.id, ok: false, text });
      message.error(text);
    } finally {
      if (alive.current) setTestingId(null);
    }
  }

  async function deleteServer(server: ServerView, force: boolean): Promise<void> {
    try {
      const response = await api.delete<{ revision: number }>(`/servers/${encodeURIComponent(server.id)}`, {
        query: force ? { force: true } : undefined,
        headers: { 'If-Match': String(revision) },
      });
      if (!alive.current) return;
      setRevision(response.revision);
      message.success(force ? `已强制删除 server ${server.id}` : `已删除 server ${server.id}`);
      await load();
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.code === 'SERVER_BUSY' && !force) {
        const proceed = await confirmDialog(
          `${server.id} 仍有在飞调用`,
          '强制删除会中止这些调用，继续？',
          '强制删除',
          true,
        );
        if (proceed) await deleteServer(server, true);
        return;
      }
      if (isConflictError(error)) {
        message.error('配置已被他人修改（revision 冲突），已刷新列表；请重新确认后删除。');
        await load();
        return;
      }
      message.error(failureText(error));
    }
  }

  function requestDelete(server: ServerView): void {
    void confirmDialog(
      `删除 server ${server.id}？`,
      '默认 drain：在飞调用结束后删除；若仍有在飞调用会再询问是否强制删除。',
      '删除',
      true,
    ).then((proceed) => {
      if (proceed) void deleteServer(server, false);
    });
  }

  const builtin = selected?.transport === 'builtin';
  const revisionLabel = selected === null ? null : `revision ${selected.revision}`;

  return (
    <div className="page">
      <PageHeader
        title="服务端"
        description="注册与运维 MCP server。env/header 只声明键名，值在“密钥”页填写；写操作按 revision 校验。"
        actions={
          <Space wrap>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索 id / label / tag"
              style={{ width: 230 }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
              新增 server
            </Button>
          </Space>
        }
      />
      <Row gutter={[16, 16]} align="top">
        <Col xs={24} xl={15}>
          <Card title="服务端列表" extra={<span className="muted">{filtered.length} / {servers.length}</span>}>
            <Table
              size="small"
              rowKey="id"
              loading={loading}
              dataSource={filtered}
              columns={columns}
              pagination={false}
              scroll={{ y: 'calc(100vh - 280px)' }}
              rowClassName={(record) => (record.id === selectedId ? 'row-selected' : '')}
              onRow={(record) => ({
                onClick: () => {
                  setSelectedId(record.id);
                  setTestResult(null);
                },
              })}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={servers.length === 0 ? '还没有注册的 server' : '没有匹配的 server'}
                  />
                ),
              }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card
            className="detail-card"
            title={selected === null ? '服务详情' : selected.label}
            extra={
              selected !== null && busy !== null && busy.serverId === selected.id ? (
                <Space size={6}>
                  <Spin size="small" />
                  <span className="muted">{busy.label}</span>
                </Space>
              ) : selected === null ? null : (
                <StateTag state={selected.state} />
              )
            }
          >
            {selected === null ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从左侧选择一个 server" />
            ) : (
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                {selected.lastError === undefined || selected.lastError === '' ? null : (
                  <Alert type="error" showIcon message={selected.lastError} />
                )}
                {testResult === null || testResult.serverId !== selected.id ? null : (
                  <Alert
                    type={testResult.ok ? 'success' : 'error'}
                    showIcon
                    closable
                    message={testResult.text}
                    onClose={() => setTestResult(null)}
                  />
                )}
                <Space wrap size={6}>
                  <Tag bordered={false} color={selected.enabled ? 'success' : 'default'}>
                    {selected.enabled ? '启用' : '停用'}
                  </Tag>
                  <Tag bordered={false} color="blue">
                    {selected.transport}
                  </Tag>
                  {revisionLabel === null ? null : (
                    <Tag bordered={false} className="muted">
                      {revisionLabel}
                    </Tag>
                  )}
                </Space>
                <Descriptions column={2} size="small">
                  <Descriptions.Item label="id">
                    <span className="mono">{selected.id}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="connectMode">{selected.connectMode}</Descriptions.Item>
                  <Descriptions.Item label="command" span={2}>
                    <span className="mono">{commandLine(selected)}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="cwd" span={2}>
                    <span className="mono">{selected.cwd ?? '—'}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="url" span={2}>
                    <span className="mono">{selected.url ?? '—'}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="env 键名" span={2}>
                    {selected.envKeys.join(', ') || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="header 键名" span={2}>
                    {selected.headerKeys.join(', ') || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="summary" span={2}>
                    {selected.summary ?? '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="category">{selected.category ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="tags">
                    <TagList tags={selected.tags} dictionary={tagDefinitions} />
                  </Descriptions.Item>
                  <Descriptions.Item label="timeoutMs">{selected.timeoutMs}</Descriptions.Item>
                  <Descriptions.Item label="maxConcurrency">{selected.maxConcurrency}</Descriptions.Item>
                  <Descriptions.Item label="创建">{formatTimestamp(selected.createdAt ?? null)}</Descriptions.Item>
                  <Descriptions.Item label="更新">{formatTimestamp(selected.updatedAt ?? null)}</Descriptions.Item>
                </Descriptions>
                <Space wrap>
                  {builtin ? null : (
                    <Button
                      icon={<ApiOutlined />}
                      disabled={busy !== null && busy.serverId === selected.id}
                      onClick={() => void runServerAction(selected, 'connect')}
                    >
                      连接
                    </Button>
                  )}
                  {builtin ? null : (
                    <Button
                      icon={<DisconnectOutlined />}
                      disabled={busy !== null && busy.serverId === selected.id}
                      onClick={() => void runServerAction(selected, 'disconnect')}
                    >
                      断开
                    </Button>
                  )}
                  {builtin ? null : (
                    <Button
                      icon={<RedoOutlined />}
                      disabled={busy !== null && busy.serverId === selected.id}
                      onClick={() => void runServerAction(selected, 'restart')}
                    >
                      重启
                    </Button>
                  )}
                  {builtin ? null : (
                    <Button
                      icon={<ExperimentOutlined />}
                      loading={testingId === selected.id}
                      onClick={() => void testServer(selected)}
                    >
                      测试连接
                    </Button>
                  )}
                  <Button type="primary" icon={<EditOutlined />} onClick={() => openEditor(selected)}>
                    编辑
                  </Button>
                  {builtin ? null : (
                    <Button danger icon={<DeleteOutlined />} onClick={() => requestDelete(selected)}>
                      删除
                    </Button>
                  )}
                </Space>
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Drawer
        forceRender
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editing === null ? '新增 server' : `编辑 ${editing.id}`}
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
        <Form form={form} layout="vertical" onFinish={(values) => void submitServer(values)}>
          {editing?.transport === 'builtin' ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="builtin server 的传输、超时与并发字段只读；label 与元数据仍可修改。"
            />
          ) : null}
          <Form.Item
            name="id"
            label="id"
            rules={
              editing === null
                ? [
                    { required: true, message: 'id 不能为空，例如 pg' },
                    {
                      validator: async (_rule, value?: string) => {
                        const text = (value ?? '').trim();
                        if (text === '__official__' || text === '__builtin__') {
                          throw new Error('__official__ 与 __builtin__ 是保留 id');
                        }
                        if (text !== '' && !SERVER_ID_PATTERN.test(text)) {
                          throw new Error('id 需以字母或数字开头，只能包含字母、数字、点、下划线与短横线（≤64）');
                        }
                        if (text !== '' && servers.some((server) => server.id === text)) {
                          throw new Error('该 id 已存在，请换一个');
                        }
                      },
                    },
                  ]
                : []
            }
          >
            <Input disabled={editing !== null} placeholder="pg" />
          </Form.Item>
          <Form.Item name="label" label="label" rules={[{ max: 128, message: 'label 最多 128 个字符' }]}>
            <Input placeholder="PostgreSQL" />
          </Form.Item>
          {editing?.transport === 'builtin' ? null : (
            <>
              <Form.Item name="transport" label="transport">
                <Select
                  disabled={editing !== null}
                  options={[
                    { value: 'stdio', label: 'stdio（本地进程）' },
                    { value: 'http', label: 'http（远程 endpoint）' },
                  ]}
                />
              </Form.Item>
              {transport === 'stdio' ? (
                <>
                  <Form.Item
                    name="command"
                    label="command"
                    rules={[{ required: true, whitespace: true, message: 'stdio server 需要 command，例如 npx' }]}
                  >
                    <Input placeholder="npx" />
                  </Form.Item>
                  <Form.Item name="args" label="args（每行一个参数）">
                    <Input.TextArea rows={3} placeholder={'-y\n@modelcontextprotocol/server-everything'} />
                  </Form.Item>
                  <Form.Item
                    name="cwd"
                    label="cwd"
                    rules={[
                      {
                        validator: async (_rule, value?: string) => {
                          const text = (value ?? '').trim();
                          if (text !== '' && !isAbsolutePath(text)) {
                            throw new Error('cwd 必须是绝对路径，例如 /Users/me/work');
                          }
                        },
                      },
                    ]}
                  >
                    <Input placeholder="/Users/me/work" />
                  </Form.Item>
                </>
              ) : (
                <Form.Item
                  name="url"
                  label="url"
                  rules={[
                    { required: true, whitespace: true, message: 'http server 需要 url，例如 https://example.com/mcp' },
                    {
                      validator: async (_rule, value?: string) => {
                        const text = (value ?? '').trim();
                        if (text === '') return;
                        const problem = validateHttpUrl(text);
                        if (problem !== null) throw new Error(problem);
                      },
                    },
                  ]}
                >
                  <Input placeholder="https://example.com/mcp" />
                </Form.Item>
              )}
              <Form.Item
                name="envKeys"
                label="env 键名（每行一个）"
                extra="只填写键名；值到“密钥”页写入，不会随配置保存。"
                rules={[
                  {
                    validator: async (_rule, value?: string) => {
                      for (const key of splitList(value)) {
                        if (!ENV_KEY_PATTERN.test(key)) {
                          throw new Error(`env 键名 ${key} 不合法：需以字母或下划线开头，只含字母、数字与下划线`);
                        }
                      }
                    },
                  },
                ]}
              >
                <Input.TextArea rows={2} placeholder={'DATABASE_URL\nAPI_TOKEN'} />
              </Form.Item>
              <Form.Item
                name="headerKeys"
                label="header 名（每行一个）"
                extra="只填写 header 名；值到“密钥”页写入。"
                rules={[
                  {
                    validator: async (_rule, value?: string) => {
                      for (const key of splitList(value)) {
                        if (!HEADER_KEY_PATTERN.test(key)) {
                          throw new Error(`header 名 ${key} 不合法：只能包含字母、数字与短横线`);
                        }
                      }
                    },
                  },
                ]}
              >
                <Input.TextArea rows={2} placeholder={'Authorization\nX-Api-Key'} />
              </Form.Item>
              <Form.Item name="connectMode" label="connectMode">
                <Select
                  options={[
                    { value: 'lazy', label: 'lazy（默认，首次调用时连接）' },
                    { value: 'eager', label: 'eager（启动即连接）' },
                  ]}
                />
              </Form.Item>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item
                    name="timeoutMs"
                    label="timeoutMs"
                    rules={[{ type: 'number', min: 1000, max: 7200000, message: 'timeoutMs 必须在 1000 到 7200000 之间' }]}
                  >
                    <InputNumber min={1000} max={7200000} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="maxConcurrency"
                    label="maxConcurrency"
                    rules={[{ type: 'number', min: 1, max: 64, message: 'maxConcurrency 必须在 1 到 64 之间' }]}
                  >
                    <InputNumber min={1} max={64} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            </>
          )}
          <Form.Item name="summary" label="summary">
            <Input placeholder="用于检索的 server 摘要" />
          </Form.Item>
          <Form.Item name="category" label="category">
            <Input placeholder="database" />
          </Form.Item>
          <Form.Item name="tags" label="tags">
            <TagsField dictionary={dictionary.tags} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Typography.Text type="secondary">
            {editing === null
              ? '新增 stdio server 等于允许执行任意命令；保存前请确认 command 与 args。'
              : 'transport 不可修改；要更换传输方式需删除后重新注册。'}
          </Typography.Text>
        </Form>
      </Drawer>
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

function TagList({
  tags,
  dictionary,
}: {
  tags: string[];
  dictionary: readonly TagDefinition[];
}): React.ReactElement {
  if (tags.length === 0) return <span className="muted">—</span>;
  return (
    <Space size={4} wrap>
      {tags.map((tag) => (
        <Tag key={tag} bordered={false} title={tag}>
          {tagLabel(dictionary, tag)}
        </Tag>
      ))}
    </Space>
  );
}

function actionLabel(action: ServerAction): string {
  switch (action) {
    case 'connect':
      return '连接';
    case 'disconnect':
      return '断开';
    case 'restart':
      return '重启';
    default:
      return action;
  }
}

function commandLine(server: ServerView): string {
  const line = [server.command ?? '', ...server.args].join(' ').trim();
  return line === '' ? '—' : line;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function validateHttpUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'url 不是合法 URL，例如 https://example.com/mcp';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'url 必须使用 http 或 https';
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'url 不能内嵌凭据；请改用 header 的 $secret 引用';
  }
  return null;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function parseArgs(value: string | undefined): Array<string | { $secret: string }> {
  return splitList(value).map((line) => {
    const match = /^<secret:(.+)>$/.exec(line);
    return match === null || match[1] === undefined || match[1] === ''
      ? line
      : { $secret: match[1] };
  });
}

function nullIfEmpty(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingSecrets(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.details;
  if (!isRecord(details)) return [];
  const raw = details['missingSecrets'];
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isConflictError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const code = error.code.toUpperCase();
  return code === 'CONFLICT' || code.endsWith('_CONFLICT');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
