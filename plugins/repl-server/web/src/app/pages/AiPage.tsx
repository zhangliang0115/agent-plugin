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
import { useCategoryDictionary } from '../components/CategorySelect.tsx';
import { tagLabel, useTagDictionary, type TagDefinition } from '../components/TagPicker.tsx';
import { dictionaryLabel } from '../../lib/dictionary.ts';
import { isLockedCategoryKey, isLockedTagKey } from '../../lib/tags.ts';
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
  tags?: string[];
}

interface DictionarySuggestion {
  key: string;
  zh: string;
  en: string;
}

interface AnnotationProposed {
  summary: string | null;
  category: string | null;
  categorySuggestion?: DictionarySuggestion | null;
  tags: string[];
  tagSuggestions?: DictionarySuggestion[];
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
  const { categories: categoryDefinitions, reload: reloadCategories } = useCategoryDictionary();
  const { tags: tagDefinitions, reload: reloadTags } = useTagDictionary();
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
      message.error('先选择一个服务端。');
      return;
    }
    const ok = await confirm(
      '生成标注',
      `将把 ${selectedServer} 的工具名与描述（最多 80 个，每个 400 字符）发送给模型。敏感服务端请取消。继续？`,
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

  function editCategorySuggestion(field: keyof DictionarySuggestion, value: string): void {
    setReview((current) => {
      const suggestion = current?.proposed.categorySuggestion;
      if (current === null || suggestion === null || suggestion === undefined) return current;
      return {
        ...current,
        proposed: {
          ...current.proposed,
          categorySuggestion: { ...suggestion, [field]: value },
        },
      };
    });
  }

  function editTagSuggestion(index: number, field: keyof DictionarySuggestion, value: string): void {
    setReview((current) => {
      const suggestions = [...(current?.proposed.tagSuggestions ?? [])];
      const target = suggestions[index];
      if (current === null || target === undefined) return current;
      suggestions[index] = { ...target, [field]: value };
      const proposed: AnnotationProposed = { ...current.proposed, tagSuggestions: suggestions };
      if (field === 'key') {
        proposed.toolOverrides = renameToolTagReferences(
          current.proposed.toolOverrides,
          target.key,
          value,
        );
      }
      return { ...current, proposed };
    });
  }

  function rejectCategorySuggestion(): void {
    setReview((current) =>
      current === null || current.proposed.categorySuggestion == null
        ? current
        : { ...current, proposed: { ...current.proposed, categorySuggestion: null } },
    );
  }

  function rejectTagSuggestion(index: number): void {
    setReview((current) => {
      if (current === null) return current;
      const dictionaryKeys = new Set(tagDefinitions.map((tag) => tag.key));
      return { ...current, proposed: rejectTagSuggestionAt(current.proposed, index, dictionaryKeys) };
    });
  }

  async function applyAnnotation(target: AnnotationReview): Promise<void> {
    const invalid = suggestionValidationError(target.proposed, categoryDefinitions);
    if (invalid !== null) {
      message.error(invalid);
      return;
    }
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
        message.error('没有读取到服务端配置的 revision，请刷新后重试。');
        return;
      }
      const body = buildApplyBody(target.proposed);
      if (Object.keys(body).length === 0) {
        message.error('这条标注没有可应用的字段。');
        return;
      }
      const response = await api.post<{ changed?: string[]; warnings?: string[] }>(
        `/ai/annotate/${encodeURIComponent(target.serverId)}`,
        { mode: 'apply', apply: body },
        { headers: { 'If-Match': String(revision) } },
      );
      const changed = Array.isArray(response.changed) ? response.changed.length : 0;
      const warnings = Array.isArray(response.warnings) ? response.warnings : [];
      if (changed === 0) message.info('标注没有变化。');
      else message.success(`已应用标注：${changed} 项变更。`);
      if (warnings.length > 0) {
        modal.info({
          title: `部分建议已丢弃（${warnings.length}）`,
          width: 640,
          content: (
            <div
              className="mono"
              style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}
            >
              {warnings.join('\n')}
            </div>
          ),
          okText: '知道了',
        });
      }
      setReview(null);
      await Promise.all([loadPending(), loadServers(), reloadCategories(), reloadTags()]);
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
      render: (_value, record) => {
        const suggestions = record.proposed.tagSuggestions ?? [];
        if (record.proposed.tags.length === 0 && suggestions.length === 0) return '—';
        return (
          <Space size={4} wrap>
            {record.proposed.tags.map((tag) => (
              <Tag key={tag} bordered={false} title={tag}>
                {tagLabel(tagDefinitions, tag)}
              </Tag>
            ))}
            {suggestions.map((suggestion) => (
              <Tag key={`new-${suggestion.key}`} color="gold" bordered={false} title={suggestion.en}>
                {suggestion.zh}（建议）
              </Tag>
            ))}
          </Space>
        );
      },
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
                <Space direction="vertical" size={2}>
                  <Switch checked={autoAnnotate} onChange={setAutoAnnotate} />
                  <Typography.Text type="secondary">
                    启用且 AI 已启用时，工具索引完成后，标注不完整（summary/category/tags 未齐全）的 server
                    会自动生成 summary/category/tags 建议，进入下方「待处理标注」；服务重启后首次连接也会补齐。不会自动写入，需审阅或点「直接应用」。失败不重试，可手动生成标注预览。
                  </Typography.Text>
                </Space>
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
          调用会把工具名与描述发送给模型；结果先预览，应用前人工核对。一句话生成 MCP
          配置在“服务端”页的“AI 生成配置”。
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
        placement="left"
        open={review !== null}
        onClose={() => setReview(null)}
        width={840}
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
                <Space wrap size={6}>
                  <span>
                    {review.current.category === null
                      ? '—'
                      : dictionaryLabel(categoryDefinitions, review.current.category)}
                  </span>
                  <span>→</span>
                  {review.proposed.category !== null ? (
                    <Tag color="blue" bordered={false}>
                      {dictionaryLabel(categoryDefinitions, review.proposed.category)}
                    </Tag>
                  ) : review.proposed.categorySuggestion == null ? (
                    <span className="muted">—</span>
                  ) : (
                    <Tag
                      color="gold"
                      bordered={false}
                      title={review.proposed.categorySuggestion.key}
                    >
                      建议新分类 {review.proposed.categorySuggestion.zh}
                    </Tag>
                  )}
                </Space>
                {review.proposed.categorySuggestion == null ? null : (
                  <Space wrap size={6} style={{ marginTop: 8 }}>
                    <Input
                      size="small"
                      style={{ width: 140 }}
                      placeholder="key"
                      value={review.proposed.categorySuggestion.key}
                      onChange={(event) => editCategorySuggestion('key', event.target.value)}
                    />
                    <Input
                      size="small"
                      style={{ width: 140 }}
                      placeholder="中文"
                      value={review.proposed.categorySuggestion.zh}
                      onChange={(event) => editCategorySuggestion('zh', event.target.value)}
                    />
                    <Input
                      size="small"
                      style={{ width: 160 }}
                      placeholder="English"
                      value={review.proposed.categorySuggestion.en}
                      onChange={(event) => editCategorySuggestion('en', event.target.value)}
                    />
                    <Button size="small" danger onClick={rejectCategorySuggestion}>
                      拒绝
                    </Button>
                  </Space>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="tags">
                <AnnotationTags
                  current={review.current.tags}
                  proposed={review.proposed.tags}
                  suggestions={review.proposed.tagSuggestions ?? []}
                  dictionary={tagDefinitions}
                />
                {(review.proposed.tagSuggestions ?? []).map((suggestion, index) => (
                  <Space key={index} wrap size={6} style={{ marginTop: 6, display: 'flex' }}>
                    <Tag color="gold" bordered={false}>
                      建议新标签
                    </Tag>
                    <Input
                      size="small"
                      style={{ width: 140 }}
                      placeholder="key"
                      value={suggestion.key}
                      onChange={(event) => editTagSuggestion(index, 'key', event.target.value)}
                    />
                    <Input
                      size="small"
                      style={{ width: 140 }}
                      placeholder="中文"
                      value={suggestion.zh}
                      onChange={(event) => editTagSuggestion(index, 'zh', event.target.value)}
                    />
                    <Input
                      size="small"
                      style={{ width: 160 }}
                      placeholder="English"
                      value={suggestion.en}
                      onChange={(event) => editTagSuggestion(index, 'en', event.target.value)}
                    />
                    <Button size="small" danger onClick={() => rejectTagSuggestion(index)}>
                      拒绝
                    </Button>
                  </Space>
                ))}
                <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                  已有标签全部保留，AI 只做新增；建议的新分类/新标签在应用时自动写入字典，不需要的可在行内点“拒绝”移除。
                  系统内置标签与分类由管理员维护，AI 不会改动或删除已有项。
                </Typography.Text>
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
                  title: '建议标签',
                  dataIndex: 'tags',
                  width: 200,
                  render: (value: string[] | undefined) =>
                    value === undefined || value.length === 0
                      ? '—'
                      : value.map((tag) => (
                          <Tag key={tag} bordered={false} title={tag}>
                            {tagLabelWithSuggestions(
                              tagDefinitions,
                              review?.proposed.tagSuggestions ?? [],
                              tag,
                            )}
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

/** Category dictionary rule (`server/src/ai/validate.ts` CATEGORY_PATTERN). */
const CATEGORY_SUGGESTION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/** Tag dictionary rule (`server/src/ai/validate.ts` TAG_PATTERN). */
const TAG_SUGGESTION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SUGGESTION_LABEL_MAX = 40;
/** Editing a suggestion key must follow the tool overrides that reference it. */
export function renameToolTagReferences(
  overrides: readonly ToolOverride[],
  previousKey: string,
  nextKey: string,
): ToolOverride[] {
  if (previousKey === nextKey) return [...overrides];
  return overrides.map((override) =>
    override.tags === undefined
      ? { ...override }
      : {
          ...override,
          tags: [...new Set(override.tags.map((tag) => (tag === previousKey ? nextKey : tag)))],
        },
  );
}

/** Drops one tag suggestion and keeps tool overrides valid when the key was only a suggestion. */
export function rejectTagSuggestionAt(
  proposed: AnnotationProposed,
  index: number,
  dictionaryKeys: ReadonlySet<string>,
): AnnotationProposed {
  const suggestions = proposed.tagSuggestions ?? [];
  const rejected = suggestions[index];
  if (rejected === undefined) return proposed;
  const tagSuggestions = suggestions.filter((_, position) => position !== index);
  if (dictionaryKeys.has(rejected.key)) return { ...proposed, tagSuggestions };
  const toolOverrides = proposed.toolOverrides.map((override) =>
    override.tags === undefined
      ? override
      : { ...override, tags: override.tags.filter((tag) => tag !== rejected.key) },
  );
  return { ...proposed, tagSuggestions, toolOverrides };
}

function suggestionShapeError(
  label: string,
  suggestion: DictionarySuggestion,
  pattern: RegExp,
): string | null {
  const key = suggestion.key.trim();
  if (key === '') return `${label} key 不能为空。`;
  if (!pattern.test(key)) {
    return `${label} key 不合法：需以小写字母或数字开头，仅含小写字母、数字、点、下划线、连接线，最长 32 个字符。`;
  }
  if (suggestion.zh.trim() === '') return `${label} 中文名不能为空。`;
  if (suggestion.en.trim() === '') return `${label} 英文名不能为空。`;
  if (suggestion.zh.trim().length > SUGGESTION_LABEL_MAX) {
    return `${label} 中文名不能超过 ${SUGGESTION_LABEL_MAX} 个字符。`;
  }
  if (suggestion.en.trim().length > SUGGESTION_LABEL_MAX) {
    return `${label} 英文名不能超过 ${SUGGESTION_LABEL_MAX} 个字符。`;
  }
  return null;
}

/** Mirrors the server-side validation so obviously invalid suggestions never reach a 422. */
export function suggestionValidationError(
  proposed: AnnotationProposed,
  categories: readonly { key: string }[],
): string | null {
  const categoryKeys = new Set(categories.map((entry) => entry.key));
  // buildApplyBody only sends the suggestion when no concrete category was chosen.
  const categorySuggestion = proposed.category === null ? proposed.categorySuggestion ?? null : null;
  if (categorySuggestion !== null) {
    const error = suggestionShapeError(
      '建议分类',
      categorySuggestion,
      CATEGORY_SUGGESTION_KEY_PATTERN,
    );
    if (error !== null) return error;
    const key = categorySuggestion.key.trim();
    // A key already in the dictionary is an existing category, not a new reserved name.
    if (!categoryKeys.has(key) && isLockedCategoryKey(key)) {
      return '建议分类 key 不能与系统内置分类重名。';
    }
  }
  for (const [index, suggestion] of (proposed.tagSuggestions ?? []).entries()) {
    const label = `建议标签第 ${index + 1} 项`;
    const error = suggestionShapeError(label, suggestion, TAG_SUGGESTION_KEY_PATTERN);
    if (error !== null) return error;
    const key = suggestion.key.trim();
    if (isLockedTagKey(key)) {
      return `${label} key 不能与系统内置标签重名。`;
    }
    if (categoryKeys.has(key)) return `${label} key 与现有分类 ${key} 重复。`;
  }
  return null;
}

/** Dictionary label first, then a not-yet-saved tag suggestion, else the raw key. */
function tagLabelWithSuggestions(
  dictionary: readonly TagDefinition[],
  suggestions: readonly DictionarySuggestion[],
  key: string,
): string {
  const direct = dictionary.find((entry) => entry.key === key);
  if (direct !== undefined) return direct.zh;
  return suggestions.find((suggestion) => suggestion.key === key)?.zh ?? key;
}

function trimSuggestion(suggestion: DictionarySuggestion): DictionarySuggestion {
  return {
    key: suggestion.key.trim(),
    zh: suggestion.zh.trim(),
    en: suggestion.en.trim(),
  };
}

export function buildApplyBody(proposed: AnnotationProposed): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (proposed.summary !== null) body['summary'] = proposed.summary;
  if (proposed.category !== null) {
    body['category'] = proposed.category;
  } else if (proposed.categorySuggestion != null) {
    body['categorySuggestion'] = trimSuggestion(proposed.categorySuggestion);
  }
  // The server merges tags into the existing set; sending only the proposal
  // keeps "AI cannot delete tags" a server-side guarantee.
  const tags = [...new Set(proposed.tags)];
  if (tags.length > 0) body['tags'] = tags;
  const tagSuggestions = (proposed.tagSuggestions ?? []).map(trimSuggestion);
  if (tagSuggestions.length > 0) body['tagSuggestions'] = tagSuggestions;
  const overrides: Array<Record<string, unknown>> = [];
  for (const override of proposed.toolOverrides) {
    const entry: Record<string, unknown> = { name: override.name };
    if (override.tags !== undefined && override.tags.length > 0) entry['tags'] = override.tags;
    overrides.push(entry);
  }
  if (overrides.length > 0) body['toolOverrides'] = overrides;
  return body;
}

/** Existing tags kept as-is plus the model's new existing tags and suggestions. */
function AnnotationTags({
  current,
  proposed,
  suggestions,
  dictionary,
}: {
  current: readonly string[];
  proposed: readonly string[];
  suggestions: readonly DictionarySuggestion[];
  dictionary: readonly { key: string; zh: string; en: string }[];
}): React.ReactElement {
  const currentSet = new Set(current);
  const added = proposed.filter((tag) => !currentSet.has(tag));
  if (current.length === 0 && added.length === 0 && suggestions.length === 0) {
    return <span className="muted">—</span>;
  }
  return (
    <Space size={4} wrap>
      {current.map((tag) => (
        <Tag key={`keep-${tag}`} bordered={false} title={tag}>
          {tagLabel(dictionary, tag)}（保留）
        </Tag>
      ))}
      {added.map((tag) => (
        <Tag key={`add-${tag}`} color="green" bordered={false} title={tag}>
          {tagLabel(dictionary, tag)}（新增）
        </Tag>
      ))}
      {suggestions.map((suggestion) => (
        <Tag key={`new-${suggestion.key}`} color="gold" bordered={false} title={suggestion.en}>
          {suggestion.zh}（建议新标签）
        </Tag>
      ))}
    </Space>
  );
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
      return '该服务端不支持 AI 标注（内置或种子服务端）。';
    case 'AI_UNKNOWN_TOOL':
      return '标注引用了不存在的工具；请重新生成预览。';
    case 'AI_PROMPT_TOO_LARGE':
      return '标注提示词超过 64 KiB；请精简 env/header 键或分类/标签字典后重试。';
    case 'REVISION_CONFLICT':
      return '配置已被其他页面修改，请刷新后重试。';
    default:
      return failureText(error);
  }
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
