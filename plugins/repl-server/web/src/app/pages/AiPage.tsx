/** AI page: CLI settings, annotation previews and the pending annotation queue. */
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from '../components/common.tsx';
import { ApiError } from '../../lib/api.ts';
import { formatTimestamp } from '../../lib/format.ts';

interface AiSettingsView {
  enabled: boolean;
  autoAnnotate: boolean;
  claudeBin: string | null;
  model: string | null;
  timeoutMs: number;
  effectiveClaudeBin: string;
  claudeBinSource: string;
}

interface AiConfigView {
  ai: AiSettingsView;
  prompts: { propose: number; annotate: number };
  revision: number;
}

interface ToolOverride {
  name: string;
  description?: string | null;
  tags?: string[];
}

interface AnnotationProposed {
  summary: string | null;
  category: string | null;
  tags: string[];
  toolOverrides: ToolOverride[];
}

interface AnnotationCurrent {
  summary: string | null;
  summarySource: string | null;
  category: string | null;
  tags: string[];
}

interface AnnotationPreviewView {
  serverId: string;
  current: AnnotationCurrent;
  proposed: AnnotationProposed;
  warnings: string[];
  omittedTools: number;
  meta: {
    model: string | null;
    durationMs: number;
    promptVersion: number;
    costUsd: number | null;
  };
}

interface PendingAnnotationView {
  serverId: string;
  proposed: AnnotationProposed;
  warnings: string[];
  omittedTools: number;
  createdAt: string;
}

interface ServerView {
  id: string;
  label: string;
  summary?: string | null;
  category?: string | null;
  tags: string[];
}

interface ServersResponse {
  servers: ServerView[];
  revision: number;
}

interface AnnotationReview {
  serverId: string;
  current: AnnotationCurrent;
  proposed: AnnotationProposed;
  warnings: string[];
  omittedTools: number;
}

export function AiPage(): React.ReactElement {
  const api = useApi();
  const { message, modal } = AntApp.useApp();
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [pending, setPending] = useState<PendingAnnotationView[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [serversLoading, setServersLoading] = useState(true);
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [autoAnnotate, setAutoAnnotate] = useState(false);
  const [claudeBin, setClaudeBin] = useState('');
  const [model, setModel] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('60000');
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [review, setReview] = useState<AnnotationReview | null>(null);

  const loadConfig = useCallback(async (): Promise<void> => {
    setConfigLoading(true);
    try {
      const response = await api.get<AiConfigView>('/ai/config');
      setConfig(response);
      setEnabled(response.ai.enabled);
      setAutoAnnotate(response.ai.autoAnnotate);
      setClaudeBin(response.ai.claudeBin ?? '');
      setModel(response.ai.model ?? '');
      setTimeoutMs(String(response.ai.timeoutMs));
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setConfigLoading(false);
    }
  }, [api, message]);

  const loadPending = useCallback(async (): Promise<void> => {
    setPendingLoading(true);
    try {
      const response = await api.get<{ items?: PendingAnnotationView[] }>('/ai/annotations/pending');
      setPending(Array.isArray(response.items) ? response.items : []);
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setPendingLoading(false);
    }
  }, [api, message]);

  const loadServers = useCallback(async (): Promise<void> => {
    setServersLoading(true);
    try {
      const response = await api.get<ServersResponse>('/servers');
      const list = Array.isArray(response.servers) ? response.servers : [];
      setServers(list);
      setSelectedServer((current) =>
        current !== null && list.some((server) => server.id === current) ? current : list[0]?.id ?? null,
      );
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setServersLoading(false);
    }
  }, [api, message]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  function confirm(title: string, content: string, okText: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      modal.confirm({
        title,
        content,
        okText,
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  async function saveConfig(): Promise<void> {
    if (config === null) return;
    const timeout = Number(timeoutMs.trim());
    if (!Number.isInteger(timeout) || timeout < 5_000 || timeout > 180_000) {
      message.error('timeoutMs 必须是 5000 到 180000 之间的整数。');
      return;
    }
    setSaving(true);
    try {
      const response = await api.put<{ ai: AiSettingsView; revision: number }>(
        '/ai/config',
        {
          ai: {
            enabled,
            autoAnnotate,
            claudeBin: emptyToNull(claudeBin),
            model: emptyToNull(model),
            timeoutMs: timeout,
          },
        },
        { headers: { 'If-Match': String(config.revision) } },
      );
      setConfig({ ai: response.ai, prompts: config.prompts, revision: response.revision });
      setEnabled(response.ai.enabled);
      setAutoAnnotate(response.ai.autoAnnotate);
      setClaudeBin(response.ai.claudeBin ?? '');
      setModel(response.ai.model ?? '');
      setTimeoutMs(String(response.ai.timeoutMs));
      message.success('已保存 AI 配置。');
    } catch (error) {
      message.error(saveErrorText(error));
    } finally {
      setSaving(false);
    }
  }

  async function generatePreview(): Promise<void> {
    if (selectedServer === null) {
      message.error('先选择一个 server。');
      return;
    }
    const ok = await confirm(
      '生成标注',
      `将把 ${selectedServer} 的工具名与描述（最多 80 个，每个 400 字符）发送给模型。敏感 server 请取消。继续？`,
      '生成',
    );
    if (!ok) return;
    setGenerating(true);
    try {
      const response = await api.post<AnnotationPreviewView>(
        `/ai/annotate/${encodeURIComponent(selectedServer)}`,
        { mode: 'preview' },
      );
      setReview({
        serverId: response.serverId,
        current: response.current,
        proposed: response.proposed,
        warnings: response.warnings,
        omittedTools: response.omittedTools,
      });
    } catch (error) {
      message.error(aiErrorText(error));
    } finally {
      setGenerating(false);
    }
  }

  function reviewPending(pendingAnnotation: PendingAnnotationView): void {
    const server = servers.find((entry) => entry.id === pendingAnnotation.serverId);
    setReview({
      serverId: pendingAnnotation.serverId,
      current: {
        summary: server?.summary ?? null,
        summarySource: null,
        category: server?.category ?? null,
        tags: server?.tags ?? [],
      },
      proposed: pendingAnnotation.proposed,
      warnings: pendingAnnotation.warnings,
      omittedTools: pendingAnnotation.omittedTools,
    });
  }

  async function applyAnnotation(target: AnnotationReview): Promise<void> {
    const ok = await confirm(
      '应用标注',
      `把 ${target.serverId} 的标注建议写入 catalog（summary/category/tags 与工具覆盖）？`,
      '应用',
    );
    if (!ok) return;
    setApplying(true);
    try {
      const serversResponse = await api.get<ServersResponse>('/servers');
      const revision = typeof serversResponse.revision === 'number' ? serversResponse.revision : null;
      if (revision === null) {
        message.error('没有读取到 server 配置的 revision，请刷新后重试。');
        return;
      }
      const server = Array.isArray(serversResponse.servers)
        ? serversResponse.servers.find((entry) => entry.id === target.serverId)
        : undefined;
      const body = buildApplyBody(target.proposed, server?.tags ?? []);
      if (Object.keys(body).length === 0) {
        message.error('这条标注没有可应用的字段。');
        return;
      }
      const response = await api.post<{ changed?: string[] }>(
        `/ai/annotate/${encodeURIComponent(target.serverId)}`,
        { mode: 'apply', apply: body },
        { headers: { 'If-Match': String(revision) } },
      );
      const changed = Array.isArray(response.changed) ? response.changed.length : 0;
      if (changed === 0) message.info('标注没有变化。');
      else message.success(`已应用标注：${changed} 项变更。`);
      setReview(null);
      await Promise.all([loadPending(), loadServers()]);
    } catch (error) {
      message.error(aiErrorText(error));
    } finally {
      setApplying(false);
    }
  }

  const pendingColumns: TableColumnsType<PendingAnnotationView> = [
    {
      title: '服务端',
      dataIndex: 'serverId',
      width: 160,
      render: (value: string) => <span className="mono">{value}</span>,
    },
    {
      title: '生成时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: string) => <span className="muted">{formatTimestamp(value)}</span>,
    },
    {
      title: '摘要（summary）',
      width: 280,
      ellipsis: true,
      render: (_value, record) => record.proposed.summary ?? '—',
    },
    {
      title: '标签（tags）',
      width: 220,
      render: (_value, record) =>
        record.proposed.tags.length === 0
          ? '—'
          : record.proposed.tags.map((tag) => (
              <Tag key={tag} bordered={false}>
                {tag}
              </Tag>
            )),
    },
    {
      title: '提示',
      dataIndex: 'warnings',
      width: 70,
      render: (value: string[]) => value.length,
    },
    {
      title: '操作',
      width: 160,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" onClick={() => reviewPending(record)}>
            审阅
          </Button>
          <Button
            size="small"
            type="primary"
            loading={applying}
            onClick={() => void applyAnnotation(reviewFromPending(record, servers))}
          >
            直接应用
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="AI 配置"
        description="配置本地 Claude CLI，为 server 生成 summary/tags 标注建议并审阅待应用的建议。调用会把工具名与描述发送给模型；结果先预览，应用前人工核对。"
        actions={
          <Button
            icon={<ReloadOutlined />}
            loading={configLoading || pendingLoading || serversLoading}
            onClick={() => {
              void Promise.all([loadConfig(), loadPending(), loadServers()]);
            }}
          >
            刷新
          </Button>
        }
      />
      <Card title="CLI 配置" size="small" loading={configLoading}>
        {config === null ? (
          <Empty description="没有读取到 AI 配置，检查服务端 /ai/config 端点。">
            <Button onClick={() => void loadConfig()}>重试</Button>
          </Empty>
        ) : (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color="blue" bordered={false}>
                生效命令 {config.ai.effectiveClaudeBin}
              </Tag>
              <Tag bordered={false}>来源 {config.ai.claudeBinSource}</Tag>
              <Tag bordered={false}>
                prompt v{config.prompts.propose}/{config.prompts.annotate}
              </Tag>
              <Tag bordered={false}>revision {config.revision}</Tag>
            </Space>
            <Form layout="vertical">
              <Form.Item label="启用 AI">
                <Space>
                  <Switch checked={enabled} onChange={setEnabled} />
                  <Typography.Text type="secondary">启用后生成与标注会把工具名和描述发送给模型。</Typography.Text>
                </Space>
              </Form.Item>
              <Form.Item label="新接入 server 自动生成标注预览">
                <Switch checked={autoAnnotate} onChange={setAutoAnnotate} />
              </Form.Item>
              <Form.Item label="claudeBin">
                <Input
                  value={claudeBin}
                  onChange={(event) => setClaudeBin(event.target.value)}
                  placeholder="留空使用环境变量或默认 claude"
                />
              </Form.Item>
              <Form.Item label="model">
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="留空使用 CLI 默认模型"
                />
              </Form.Item>
              <Form.Item label="timeoutMs" extra="单次调用上限，5000–180000 毫秒。">
                <Input
                  type="number"
                  style={{ width: 220 }}
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(event.target.value)}
                  min="5000"
                  max="180000"
                />
              </Form.Item>
              <Button type="primary" loading={saving} onClick={() => void saveConfig()}>
                保存
              </Button>
            </Form>
          </Space>
        )}
      </Card>
      <Card title="生成标注" size="small">
        <Space wrap>
          <Select
            style={{ width: 320 }}
            value={selectedServer ?? undefined}
            onChange={(value: string) => setSelectedServer(value)}
            options={servers.map((server) => ({
              value: server.id,
              label: `${server.id} · ${server.label}`,
            }))}
            placeholder="选择 server"
            showSearch
            optionFilterProp="label"
            loading={serversLoading}
          />
          <Button
            type="primary"
            loading={generating}
            disabled={selectedServer === null}
            onClick={() => void generatePreview()}
          >
            生成标注预览
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0 }}>
          调用会把工具名与描述发送给模型；结果先预览，应用前人工核对。
        </Typography.Paragraph>
      </Card>
      <Card
        title="待处理标注"
        size="small"
        extra={
          <Space>
            <span className="muted">{pending.length} 条</span>
            <Button size="small" icon={<ReloadOutlined />} loading={pendingLoading} onClick={() => void loadPending()}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<PendingAnnotationView>
          size="small"
          rowKey="serverId"
          loading={pendingLoading}
          dataSource={pending}
          columns={pendingColumns}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="没有待处理标注。新接入 server 自动生成建议后会出现在这里。"
              />
            ),
          }}
        />
      </Card>
      <Drawer
        open={review !== null}
        onClose={() => setReview(null)}
        width={720}
        title={review === null ? '标注建议' : `标注建议 · ${review.serverId}`}
        extra={
          review === null ? null : (
            <Space>
              <Button onClick={() => setReview(null)}>关闭</Button>
              <Button type="primary" loading={applying} onClick={() => void applyAnnotation(review)}>
                应用全部
              </Button>
            </Space>
          )
        }
      >
        {review === null ? null : (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color="blue" bordered={false}>
                {review.serverId}
              </Tag>
              {review.omittedTools > 0 ? (
                <Tag color="gold" bordered={false}>
                  仅标注前 80 个工具（另有 {review.omittedTools} 个）
                </Tag>
              ) : null}
            </Space>
            {review.warnings.length === 0 ? null : (
              <Alert
                type="warning"
                showIcon
                message="模型提示"
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {review.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                }
              />
            )}
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="summary">
                {review.current.summary ?? '—'} → {review.proposed.summary ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="category">
                {review.current.category ?? '—'} → {review.proposed.category ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="tags">
                {review.current.tags.join(', ') || '—'} ∪ {review.proposed.tags.join(', ') || '—'}
              </Descriptions.Item>
            </Descriptions>
            <Table<ToolOverride>
              size="small"
              rowKey="name"
              dataSource={review.proposed.toolOverrides}
              pagination={false}
              locale={{
                emptyText: (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次建议没有工具级覆盖。" />
                ),
              }}
              columns={[
                {
                  title: '工具',
                  dataIndex: 'name',
                  width: 180,
                  render: (value: string) => <span className="mono">{value}</span>,
                },
                {
                  title: '建议描述',
                  dataIndex: 'description',
                  ellipsis: true,
                  render: (value: string | null | undefined) => value ?? '—',
                },
                {
                  title: '建议标签',
                  dataIndex: 'tags',
                  width: 200,
                  render: (value: string[] | undefined) =>
                    value === undefined || value.length === 0
                      ? '—'
                      : value.map((tag) => (
                          <Tag key={tag} bordered={false}>
                            {tag}
                          </Tag>
                        )),
                },
              ]}
            />
          </Space>
        )}
      </Drawer>
    </div>
  );
}

function reviewFromPending(
  pendingAnnotation: PendingAnnotationView,
  servers: readonly ServerView[],
): AnnotationReview {
  const server = servers.find((entry) => entry.id === pendingAnnotation.serverId);
  return {
    serverId: pendingAnnotation.serverId,
    current: {
      summary: server?.summary ?? null,
      summarySource: null,
      category: server?.category ?? null,
      tags: server?.tags ?? [],
    },
    proposed: pendingAnnotation.proposed,
    warnings: pendingAnnotation.warnings,
    omittedTools: pendingAnnotation.omittedTools,
  };
}

function buildApplyBody(proposed: AnnotationProposed, currentTags: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (proposed.summary !== null) body['summary'] = proposed.summary;
  if (proposed.category !== null) body['category'] = proposed.category;
  const tags = [...new Set([...currentTags, ...proposed.tags])];
  if (tags.length > 0) body['tags'] = tags;
  const overrides: Array<Record<string, unknown>> = [];
  for (const override of proposed.toolOverrides) {
    const entry: Record<string, unknown> = { name: override.name };
    if (override.description !== undefined && override.description !== null) {
      entry['description'] = override.description;
    }
    if (override.tags !== undefined && override.tags.length > 0) entry['tags'] = override.tags;
    overrides.push(entry);
  }
  if (overrides.length > 0) body['toolOverrides'] = overrides;
  return body;
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function saveErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'AI 配置已被他人修改，请刷新后重试。';
  }
  return aiErrorText(error);
}

function aiErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return failureText(error);
  switch (error.code) {
    case 'AI_DISABLED':
      return 'AI 未启用；请先在配置卡启用并保存。';
    case 'AI_BUSY':
      return '已有 AI 任务在运行，请 1 秒后重试。';
    case 'AI_TIMEOUT':
      return '已超过配置的 timeoutMs；可调大 timeoutMs 后重试。';
    case 'AI_RUNNER_UNAVAILABLE':
      return `找不到或无法启动 Claude CLI：${error.message}。请检查 claudeBin 配置。`;
    case 'SERVER_NOT_ANNOTATABLE':
      return '该 server 不支持 AI 标注（builtin 或 seed server）。';
    case 'AI_UNKNOWN_TOOL':
      return '标注引用了不存在的工具；请重新生成预览。';
    case 'REVISION_CONFLICT':
      return '配置已被其他页面修改，请刷新后重试。';
    default:
      return failureText(error);
  }
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
