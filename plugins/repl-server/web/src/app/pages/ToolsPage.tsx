/** Tools page: per-server catalog overrides, upstream refresh and lazy discovery. */
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  BookOutlined,
  CloudDownloadOutlined,
  EditOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from '../components/common.tsx';
import { CategorySelect, useCategoryDictionary } from '../components/CategorySelect.tsx';
import { TagPillEditor } from '../components/PillEditors.tsx';
import { ToolSchemaDoc } from '../components/ToolSchemaDoc.tsx';
import { TagPicker, tagLabel, useTagDictionary, type TagDefinition } from '../components/TagPicker.tsx';
import { dictionaryLabel } from '../../lib/dictionary.ts';
import { ApiError, isTimeoutError, timeoutSignal } from '../../lib/api.ts';
import { formatDuration, formatJson, formatTimestamp } from '../../lib/format.ts';
import { navigate } from '../router.ts';

type ToolConcurrency = 'parallel' | 'serial' | 'exclusive';

interface ToolRecord {
  serverId: string;
  name: string;
  displayName: string | null;
  description: string | null;
  descriptionOverride: string | null;
  enabled: boolean;
  concurrency: ToolConcurrency;
  /** @deprecated Still returned by the API; the page no longer reads or writes it. */
  type: string | null;
  schema: unknown;
  tags: string[];
  category: string | null;
  discoveredVia?: 'static' | 'search';
  stale: boolean;
  staleOverride: boolean;
  effective?: {
    description: string | null;
    enabled: boolean;
    concurrency: ToolConcurrency;
    tags: string[];
    category: string | null;
    stale: boolean;
    exposed: boolean;
  };
}

interface ToolsResponse {
  server: {
    id: string;
    label: string;
    enabled: boolean;
    tags: string[];
    category: string | null;
    summary?: string | null;
  };
  tools: ToolRecord[];
  revision: number;
  /** Why a lazy `__official__` sync produced no rows (for example: no claude binary). */
  notice?: string;
}

interface ToolDiscoveryConfig {
  mode: 'static' | 'search';
  searchTool?: string;
  query?: string;
  args?: Record<string, unknown>;
  maxTools?: number;
  prepareOnCall?: boolean;
}

interface ServerListItem {
  id: string;
  label: string;
  enabled: boolean;
  transport: string;
  tags: string[];
  category: string | null;
  toolDiscovery?: ToolDiscoveryConfig | null;
}

interface ServersResponse {
  servers: ServerListItem[];
  revision: number;
}

interface Operation {
  operationId: string;
  state: 'running' | 'ok' | 'error';
  error?: { code: string; message: string };
}

interface ToolFormValues {
  description?: string;
  enabled: boolean;
  concurrency: ToolConcurrency;
  tags?: string[];
  category?: string;
  staleOverride: boolean;
}

interface DiscoverFormValues {
  searchTool: string;
  query?: string;
  args?: string;
  maxTools?: number | null;
  prepareOnCall: boolean;
  staleOthers: boolean;
}

interface DiscoveryToolView {
  name: string;
  description: string | null;
  schemaMissing: boolean;
  descriptionTruncated: boolean;
  conflict: 'none' | 'static' | 'search';
  action: 'create' | 'update' | 'skip_static';
}

interface DiscoveryPreview {
  discoveryId: string;
  serverId: string;
  searchTool: string;
  query: string;
  parsed: boolean;
  shape: string;
  tools: DiscoveryToolView[];
  skipped: Array<{ name?: string; reason: string }>;
  omitted: number;
  partial: boolean;
  willStale: string[];
  willStaleCount: number;
  nextCursor: string | null;
  raw: string | null;
  rawTruncated: boolean;
  elapsedMs: number;
  previewExpiresAt: string;
}

interface DiscoveryApplyResult {
  applied: number;
  created: number;
  updated: number;
  skippedStatic: number;
  skippedOther: number;
  stale: number;
  revision: number;
}

const CONCURRENCY_OPTIONS = [
  { value: 'parallel', label: 'parallel（读锁）' },
  { value: 'serial', label: 'serial（写锁）' },
  { value: 'exclusive', label: 'exclusive（全局独占）' },
];

/** Compact tag face for the concurrency column; the dropdown keeps inline editing. */
const CONCURRENCY_TAGS: Record<
  ToolConcurrency,
  { label: string; hint: string; color: 'green' | 'gold' | 'red' }
> = {
  parallel: { label: 'parallel', hint: '读锁：同类工具可并发执行', color: 'green' },
  serial: { label: 'serial', hint: '写锁：与其它工具串行执行', color: 'gold' },
  exclusive: { label: 'exclusive', hint: '全局独占：同一时刻只允许一个调用', color: 'red' },
};

export function ToolsPage({ serverId }: { serverId?: string | null }): React.ReactElement {
  const api = useApi();
  const { message, modal } = AntApp.useApp();
  const dictionary = useTagDictionary();
  const categoryDictionary = useCategoryDictionary();
  const [servers, setServers] = useState<ServerListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(serverId ?? null);
  const [tools, setTools] = useState<ToolRecord[]>([]);
  const [toolServer, setToolServer] = useState<ToolsResponse['server'] | null>(null);
  const [toolNotice, setToolNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // Counts, not flags: two queued edits on the same field must not clear the
  // pending state when the first one finishes.
  const [inlinePending, setInlinePending] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<ToolRecord | null>(null);
  const [docTool, setDocTool] = useState<ToolRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [preview, setPreview] = useState<DiscoveryPreview | null>(null);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [toolForm] = Form.useForm<ToolFormValues>();
  const [discoverForm] = Form.useForm<DiscoverFormValues>();
  const alive = useRef(true);
  // Inline edits read the revision from a ref so a queued edit sends the value
  // the previous edit just produced, not a stale render closure.
  const revisionRef = useRef(0);
  const inlineQueue = useRef<Promise<void>>(Promise.resolve());
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

  const loadServers = useCallback(async (): Promise<void> => {
    try {
      const response = await api.get<ServersResponse>('/servers');
      if (!alive.current) return;
      const items = Array.isArray(response.servers) ? response.servers : [];
      setServers(items);
      setSelectedId((current) =>
        current !== null && items.some((server) => server.id === current) ? current : items[0]?.id ?? null,
      );
    } catch (error) {
      if (alive.current) message.error(failureText(error));
    }
  }, [api, message]);

  const loadTools = useCallback(
    async (serverId: string): Promise<void> => {
      setLoading(true);
      try {
        const response = await api.get<ToolsResponse>(
          `/servers/${encodeURIComponent(serverId)}/tools`,
        );
        if (!alive.current) return;
        setTools(Array.isArray(response.tools) ? response.tools : []);
        setToolServer(response.server);
        setToolNotice(typeof response.notice === 'string' ? response.notice : null);
        const nextRevision = typeof response.revision === 'number' ? response.revision : 0;
        revisionRef.current = nextRevision;
        setRevision(nextRevision);
      } catch (error) {
        if (!alive.current) return;
        setTools([]);
        setToolServer(null);
        setToolNotice(null);
        message.error(failureText(error));
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [api, message],
  );

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  // A hash deep link (`?server=…`) can arrive while this page is already mounted.
  useEffect(() => {
    if (serverId === undefined || serverId === null) return;
    setSelectedId(serverId);
  }, [serverId]);

  useEffect(() => {
    if (selectedId === null) {
      setTools([]);
      setToolServer(null);
      setToolNotice(null);
      return;
    }
    void loadTools(selectedId);
  }, [loadTools, selectedId]);

  useEffect(() => {
    const onRefresh = (): void => {
      void loadServers();
      if (selectedId !== null) void loadTools(selectedId);
    };
    window.addEventListener('repl:refresh', onRefresh);
    return () => window.removeEventListener('repl:refresh', onRefresh);
  }, [loadServers, loadTools, selectedId]);

  const selectedServer = servers.find((server) => server.id === selectedId) ?? null;
  const tagDefinitions = dictionary.tags;
  const categoryDefinitions = categoryDictionary.categories;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return tools;
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(needle) ||
        (tool.displayName ?? '').toLowerCase().includes(needle) ||
        (tool.description ?? '').toLowerCase().includes(needle) ||
        (tool.descriptionOverride ?? '').toLowerCase().includes(needle) ||
        (tool.effective?.description ?? '').toLowerCase().includes(needle) ||
        (tool.category ?? '').toLowerCase().includes(needle) ||
        tool.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }, [query, tools]);

  const columns = useMemo(
    () => [
      {
        title: '工具',
        dataIndex: 'name',
        width: 150,
        render: (value: string, tool: ToolRecord) => (
          <div>
            {tool.displayName !== null && tool.displayName !== value ? <div>{tool.displayName}</div> : null}
            <span
              className="mono"
              title={value}
              style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {value}
            </span>
          </div>
        ),
      },
      {
        title: '来源',
        dataIndex: 'discoveredVia',
        width: 64,
        render: (value: 'static' | 'search' | undefined) => (
          <Tag bordered={false} color={value === 'search' ? 'blue' : 'default'}>
            {value === 'search' ? 'search' : 'static'}
          </Tag>
        ),
      },
      {
        title: '启用',
        dataIndex: 'enabled',
        width: 72,
        render: (value: boolean, tool: ToolRecord) => {
          const pending = (inlinePending[inlineKey(tool, 'enabled')] ?? 0) > 0;
          return (
            <div onClick={(event) => event.stopPropagation()}>
              <Switch
                size="small"
                checked={value}
                checkedChildren={pending ? '保存中' : '启用'}
                unCheckedChildren={pending ? '保存中' : '停用'}
                loading={pending}
                onChange={(checked) => void patchInline(tool, { enabled: checked }, 'enabled')}
              />
            </div>
          );
        },
      },
      {
        title: '并发',
        dataIndex: 'concurrency',
        width: 88,
        render: (value: ToolConcurrency, tool: ToolRecord) => {
          const pending = (inlinePending[inlineKey(tool, 'concurrency')] ?? 0) > 0;
          const tag = CONCURRENCY_TAGS[value];
          return (
            <div onClick={(event) => event.stopPropagation()}>
              <Dropdown
                trigger={['click']}
                disabled={pending}
                menu={{
                  selectable: true,
                  selectedKeys: [value],
                  items: CONCURRENCY_OPTIONS.map((option) => ({
                    key: option.value,
                    label: option.label,
                  })),
                  onClick: ({ key }) =>
                    void patchInline(tool, { concurrency: key as ToolConcurrency }, 'concurrency'),
                }}
              >
                <Tag
                  bordered={false}
                  color={tag.color}
                  title={tag.hint}
                  style={{ cursor: pending ? 'default' : 'pointer', opacity: pending ? 0.5 : 1 }}
                >
                  {tag.label}
                </Tag>
              </Dropdown>
            </div>
          );
        },
      },
      {
        title: '标签（含继承）',
        dataIndex: 'tags',
        render: (value: string[], tool: ToolRecord) => (
          <TagPillEditor
            dictionary={tagDefinitions}
            value={value}
            inherited={toolServer?.tags ?? []}
            disabled={(inlinePending[inlineKey(tool, 'tags')] ?? 0) > 0}
            clearLabel="清空工具标签"
            onChange={(next) => void patchInline(tool, { tags: next }, 'tags')}
          />
        ),
      },
      {
        title: '暴露',
        width: 76,
        render: (_value: unknown, tool: ToolRecord) => {
          if (tool.effective === undefined) {
            return tool.stale ? <Tag color="gold">stale</Tag> : <span className="muted">—</span>;
          }
          return (
            <Tag bordered={false} color={tool.effective.exposed ? 'success' : 'default'}>
              {tool.effective.exposed ? '可见' : '隐藏'}
            </Tag>
          );
        },
      },
      {
        title: '描述',
        ellipsis: true,
        render: (_value: unknown, tool: ToolRecord) => {
          const text = tool.effective?.description ?? tool.description ?? '';
          return (
            <span className="muted" title={text}>
              {text === '' ? '—' : text}
            </span>
          );
        },
      },
      {
        title: '操作',
        width: 180,
        render: (_value: unknown, tool: ToolRecord) => (
          <Space size={0}>
            <Button size="small" type="link" icon={<BookOutlined />} onClick={() => setDocTool(tool)}>
              说明
            </Button>
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openToolEditor(tool)}>
              编辑
            </Button>
          </Space>
        ),
      },
    ],
    // openToolEditor, patchInline and the state setters are stable enough for this render-only callback.
    [inlinePending, tagDefinitions, toolServer],
  );

  function openToolEditor(tool: ToolRecord): void {
    setEditingTool(tool);
    setEditorOpen(true);
    toolForm.resetFields();
    toolForm.setFieldsValue({
      description: tool.descriptionOverride ?? '',
      enabled: tool.enabled,
      concurrency: tool.concurrency,
      tags: tool.tags,
      category: tool.category ?? '',
      staleOverride: tool.staleOverride,
    });
  }

  async function saveTool(values: ToolFormValues): Promise<void> {
    const tool = editingTool;
    if (tool === null) return;
    setSaving(true);
    try {
      const description = values.description ?? '';
      const response = await api.patch<{ tool: ToolRecord; revision: number }>(
        `/tools/${encodeURIComponent(tool.serverId)}/${encodeURIComponent(tool.name)}`,
        {
          description: description.trim() === '' ? null : description,
          enabled: values.enabled,
          concurrency: values.concurrency,
          tags: values.tags ?? [],
          category: nullIfEmpty(values.category),
          staleOverride: values.staleOverride,
        },
        { headers: { 'If-Match': String(revision) } },
      );
      if (!alive.current) return;
      revisionRef.current = response.revision;
      setRevision(response.revision);
      message.success(`已保存工具 ${tool.serverId}/${tool.name}；下一次 eval 生效`);
      setEditorOpen(false);
      setEditingTool(null);
      await loadTools(tool.serverId);
    } catch (error) {
      if (!alive.current) return;
      if (isConflictError(error)) {
        message.error('工具目录已被他人修改（revision 冲突），已刷新列表；请核对后重新保存。');
        await loadTools(tool.serverId);
      } else {
        message.error(failureText(error));
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  // Inline edits bypass the drawer. Requests are chained through one promise so
  // each one sends the revision the previous response produced.
  function patchInline(
    tool: ToolRecord,
    patch: Record<string, unknown>,
    fieldKey: string,
  ): Promise<void> {
    const key = inlineKey(tool, fieldKey);
    const run = async (): Promise<void> => {
      if (!alive.current) return;
      setInlinePending((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
      try {
        const response = await api.patch<{ tool: ToolRecord; revision: number }>(
          `/tools/${encodeURIComponent(tool.serverId)}/${encodeURIComponent(tool.name)}`,
          patch,
          {
            headers: { 'If-Match': String(revisionRef.current) },
            signal: timeoutSignal(15_000),
          },
        );
        if (!alive.current) return;
        revisionRef.current = response.revision;
        setRevision(response.revision);
        setTools((prev) =>
          prev.map((item) =>
            item.serverId === tool.serverId && item.name === tool.name ? response.tool : item,
          ),
        );
      } catch (error) {
        if (!alive.current) return;
        if (isTimeoutError(error)) {
          message.error('保存超时（15 秒），已刷新列表；请确认结果后再修改。');
          await loadTools(tool.serverId);
        } else if (isConflictError(error)) {
          message.error('工具目录已被他人修改（revision 冲突），已刷新列表；请重新操作。');
          await loadTools(tool.serverId);
        } else {
          message.error(failureText(error));
        }
      } finally {
        if (alive.current) {
          setInlinePending((prev) => {
            const count = (prev[key] ?? 1) - 1;
            if (count > 0) return { ...prev, [key]: count };
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }
      }
    };
    const next = inlineQueue.current.then(run);
    inlineQueue.current = next.catch(() => undefined);
    return next;
  }

  async function followOperation(
    operationId: string,
    label: string,
    key: string,
    after: () => Promise<void>,
  ): Promise<void> {
    const started = Date.now();
    for (;;) {
      if (!alive.current) return;
      try {
        const operation = await api.get<Operation>(`/operations/${encodeURIComponent(operationId)}`);
        if (!alive.current) return;
        if (operation.state === 'ok') {
          showMessage({ type: 'success', content: `${label} 完成`, key, duration: 3 });
          await after();
          return;
        }
        if (operation.state === 'error') {
          const detail = operation.error?.message ?? operation.error?.code ?? '未知错误';
          showMessage({ type: 'error', content: `${label} 失败：${detail}`, key, duration: 5 });
          await after();
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
          await after();
          return;
        }
      }
      if (Date.now() - started > 15_000) {
        showMessage({ type: 'warning', content: `${label} 仍在运行，稍后刷新查看状态。`, key, duration: 5 });
        await after();
        return;
      }
      await wait(800);
    }
  }

  async function refreshFromUpstream(): Promise<void> {
    if (selectedId === null) return;
    const serverId = selectedId;
    const key = `tools-refresh-${serverId}`;
    setBusy('刷新工具');
    showMessage({ type: 'loading', content: `刷新 ${serverId} 的工具…`, key, duration: 0 });
    try {
      const operation = await api.post<Operation>(
        `/servers/${encodeURIComponent(serverId)}/tools/refresh`,
      );
      if (!alive.current) return;
      showMessage({
        type: 'loading',
        content: `刷新 ${serverId} 的工具：operation ${operation.operationId}`,
        key,
        duration: 0,
      });
      await followOperation(operation.operationId, `刷新 ${serverId} 的工具`, key, async () => {
        await loadTools(serverId);
        await loadServers();
      });
    } catch (error) {
      if (alive.current) showMessage({ type: 'error', content: failureText(error), key, duration: 5 });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  function changeServer(nextId: string | null): void {
    setSelectedId(nextId);
    setQuery('');
    setEditingTool(null);
    setDocTool(null);
    setEditorOpen(false);
    setDiscoverOpen(false);
    setPreview(null);
    setSelectedNames([]);
    navigate('/manage', 'tools', nextId);
  }

  function openDiscovery(): void {
    if (selectedId === null) return;
    const staticTools = tools.filter((tool) => tool.discoveredVia !== 'search');
    const saved = selectedServer?.toolDiscovery;
    const useSaved = saved?.mode === 'search';
    discoverForm.resetFields();
    discoverForm.setFieldsValue({
      searchTool: useSaved && (saved?.searchTool ?? '') !== '' ? saved?.searchTool : staticTools[0]?.name ?? '',
      query: useSaved ? saved?.query ?? '' : '',
      args: useSaved && saved?.args !== undefined ? formatJson(saved.args, 2) : '',
      maxTools: useSaved ? saved?.maxTools ?? 50 : 50,
      prepareOnCall: useSaved ? saved?.prepareOnCall ?? true : true,
      staleOthers: true,
    });
    setPreview(null);
    setSelectedNames([]);
    setDiscoverError(null);
    setDiscoverOpen(true);
  }

  async function previewDiscovery(values: DiscoverFormValues): Promise<void> {
    if (selectedId === null) return;
    const serverId = selectedId;
    const searchTool = values.searchTool.trim();
    if (searchTool === '') {
      message.error('搜索工具不能为空');
      return;
    }
    let args: Record<string, unknown> | undefined;
    const argsText = (values.args ?? '').trim();
    if (argsText !== '') {
      try {
        const parsed: unknown = JSON.parse(argsText);
        if (!isRecord(parsed)) throw new Error('object required');
        args = parsed;
      } catch {
        message.error('固定参数必须是 JSON 对象');
        return;
      }
    }
    setPreviewing(true);
    setDiscoverError(null);
    try {
      const response = await api.post<DiscoveryPreview>(
        `/servers/${encodeURIComponent(serverId)}/tools/discover`,
        {
          preview: true,
          searchTool,
          query: values.query ?? '',
          maxTools: typeof values.maxTools === 'number' ? values.maxTools : 50,
          prepareOnCall: values.prepareOnCall,
          ...(args === undefined ? {} : { args }),
        },
      );
      if (!alive.current) return;
      setPreview(response);
      setSelectedNames(
        response.tools.filter((tool) => tool.action !== 'skip_static').map((tool) => tool.name),
      );
      message.success(`扫描完成：${response.tools.length} 个结果`);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && isExpiredPreviewCode(error.code)) setPreview(null);
      const text = discoveryErrorText(error);
      setDiscoverError(text);
      message.error(text);
    } finally {
      if (alive.current) setPreviewing(false);
    }
  }

  function requestApplyDiscovery(): void {
    if (preview === null || selectedId === null) return;
    const selectedTools = preview.tools.filter((tool) => selectedNames.includes(tool.name));
    if (selectedTools.length === 0) {
      message.warning('至少选择一个要应用的工具');
      return;
    }
    const staleOthers = discoverForm.getFieldValue('staleOthers') === true;
    const overwriteStatic = selectedTools.some((tool) => tool.action === 'skip_static');
    const partialStale = preview.partial && staleOthers;
    const notes: string[] = [];
    if (overwriteStatic) {
      notes.push('选中的工具与上游声明的同名 static 工具冲突，应用会覆盖它们并改成 search 来源。');
    }
    if (staleOthers && preview.willStaleCount > 0) {
      notes.push(`本次会把 ${preview.willStaleCount} 个已有工具标记为 stale。`);
    }
    if (partialStale) {
      notes.push('本次预览不完整；确认后会把未返回的旧 search 工具标记为 stale。');
    }
    const run = (): void => {
      void applyDiscovery(
        selectedTools.map((tool) => tool.name),
        overwriteStatic,
        staleOthers,
        partialStale,
      );
    };
    if (notes.length === 0) {
      run();
      return;
    }
    modal.confirm({
      title: '应用扫描结果',
      content: <div style={{ whiteSpace: 'pre-line' }}>{notes.join('\n')}</div>,
      okText: '应用',
      cancelText: '取消',
      onOk: run,
    });
  }

  async function applyDiscovery(
    accept: string[],
    overwriteStatic: boolean,
    staleOthers: boolean,
    confirmPartialStale: boolean,
  ): Promise<void> {
    if (preview === null || selectedId === null) return;
    const serverId = selectedId;
    const body: Record<string, unknown> = {
      preview: false,
      discoveryId: preview.discoveryId,
      accept,
      staleOthers,
    };
    if (overwriteStatic) body['overwriteStatic'] = true;
    if (confirmPartialStale) body['confirmPartialStale'] = true;
    setApplying(true);
    try {
      const result = await api.post<DiscoveryApplyResult>(
        `/servers/${encodeURIComponent(serverId)}/tools/discover`,
        body,
        { headers: { 'If-Match': String(revision) } },
      );
      if (!alive.current) return;
      message.success(
        `已应用 ${result.applied} 个工具：新增 ${result.created}、更新 ${result.updated}、标记 stale ${result.stale}`,
      );
      revisionRef.current = result.revision;
      setPreview(null);
      setSelectedNames([]);
      setDiscoverOpen(false);
      await loadTools(serverId);
      await loadServers();
    } catch (error) {
      if (!alive.current) return;
      if (isConflictError(error)) {
        message.error('工具目录已被他人修改（revision 冲突），已刷新列表；请重新扫描后应用。');
        await loadTools(serverId);
        return;
      }
      if (error instanceof ApiError && isExpiredPreviewCode(error.code)) setPreview(null);
      const text = discoveryErrorText(error);
      setDiscoverError(text);
      message.error(text);
    } finally {
      if (alive.current) setApplying(false);
    }
  }

  async function reloadSelected(): Promise<void> {
    if (selectedId !== null) {
      await loadTools(selectedId);
      await loadServers();
    }
  }

  const canManage = selectedId !== null && selectedServer?.transport !== 'builtin';

  return (
    <div className="page">
      <PageHeader
        title="工具"
        description="查看并覆盖每个 server 的工具目录（tools/list）。先选择 server；覆盖字段在下一次 eval 生效。"
        actions={
          <Space wrap>
            <Select
              showSearch
              allowClear
              optionFilterProp="label"
              style={{ width: 260 }}
              placeholder="选择 server"
              value={selectedId ?? undefined}
              onChange={(value?: string) => changeServer(value ?? null)}
              options={servers.map((server) => ({
                value: server.id,
                label: `${server.id} · ${server.label}`,
              }))}
              notFoundContent={<span className="muted">还没有 server，请先到“服务端”注册</span>}
            />
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索名称 / 描述 / 标签"
              style={{ width: 240 }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              disabled={selectedId === null}
              onClick={() => void reloadSelected()}
            >
              刷新列表
            </Button>
            <Button
              type="primary"
              icon={<CloudDownloadOutlined />}
              loading={busy !== null}
              disabled={!canManage}
              onClick={() => void refreshFromUpstream()}
            >
              刷新工具
            </Button>
            <Button
              icon={<SearchOutlined />}
              disabled={!canManage}
              onClick={openDiscovery}
            >
              扫描懒加载工具
            </Button>
          </Space>
        }
      />
      <Card
        title={
          toolServer === null
            ? '工具目录'
            : `${toolServer.id} · ${toolServer.label}${toolServer.enabled ? '' : '（已停用）'}`
        }
        extra={
          toolServer === null ? null : (
            <Space size={6} wrap>
              {toolServer.tags.map((tag) => (
                <Tag key={tag} bordered={false} title={tag}>
                  {tagLabel(tagDefinitions, tag)}
                </Tag>
              ))}
              {toolServer.category === null ? null : (
                <Tag bordered={false} title={toolServer.category}>
                  {dictionaryLabel(categoryDefinitions, toolServer.category)}
                </Tag>
              )}
              <span className="muted">共 {tools.length} 个工具 · revision {revision}</span>
            </Space>
          )
        }
      >
        {toolNotice === null ? null : (
          <Alert type="warning" showIcon message={toolNotice} style={{ marginBottom: 12 }} />
        )}
        {selectedId === null ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有可管理的 server；先在“服务端”注册"
          />
        ) : (
          <Table
            size="small"
            rowKey="name"
            loading={loading}
            dataSource={filtered}
            columns={columns}
            pagination={false}
            tableLayout="fixed"
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    tools.length === 0
                      ? '该服务端还没有工具行；先点“刷新工具”从上游重拉'
                      : '没有匹配的工具'
                  }
                />
              ),
            }}
          />
        )}
      </Card>

      <Drawer
        forceRender
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editingTool === null ? '编辑工具' : `编辑 ${editingTool.serverId}/${editingTool.name}`}
        width={520}
        extra={
          <Space>
            <Button onClick={() => setEditorOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => toolForm.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={toolForm} layout="vertical" onFinish={(values) => void saveTool(values)}>
          <Typography.Paragraph type="secondary">
            覆盖字段只影响 catalog 视图；保存后下一次 eval 生效。
          </Typography.Paragraph>
          <Form.Item
            name="description"
            label="descriptionOverride"
            extra="留空则继续使用上游 description。"
          >
            <Input.TextArea rows={4} placeholder="覆盖上游描述，用于检索与提示" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="concurrency" label="并发级别">
            <Select options={CONCURRENCY_OPTIONS} />
          </Form.Item>
          <Form.Item name="tags" label="tags（标签）">
            <TagsField dictionary={tagDefinitions} />
          </Form.Item>
          <Form.Item name="category" label="category（分类）" extra="留空继承 server 的 category。">
            <CategorySelect dictionary={categoryDefinitions} placeholder="从分类字典选择（留空继承 server）" />
          </Form.Item>
          <Form.Item
            name="staleOverride"
            label="保留检索可见性（staleOverride）"
            valuePropName="checked"
            extra="search 来源的 stale 工具仍不可直接调用。"
          >
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        open={docTool !== null}
        onClose={() => setDocTool(null)}
        title={docTool === null ? '工具说明' : `工具说明 · ${docTool.serverId}/${docTool.name}`}
        width={820}
      >
        {docTool === null ? null : <ToolSchemaDoc tool={docTool} />}
      </Drawer>

      <Drawer
        forceRender
        open={discoverOpen}
        onClose={() => setDiscoverOpen(false)}
        title={selectedId === null ? '扫描懒加载工具' : `扫描懒加载工具 · ${selectedId}`}
        width={760}
        extra={
          <Space>
            <Button onClick={() => setDiscoverOpen(false)}>关闭</Button>
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={previewing}
              onClick={() => discoverForm.submit()}
            >
              预览
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="预览会调用一次上游搜索工具；应用只写本地 catalog，不再次访问上游。"
          />
          {discoverError === null ? null : (
            <Alert type="error" showIcon closable message={discoverError} onClose={() => setDiscoverError(null)} />
          )}
          <Form form={discoverForm} layout="vertical" onFinish={(values) => void previewDiscovery(values)}>
            <Form.Item
              name="searchTool"
              label="搜索工具"
              rules={[{ required: true, whitespace: true, message: '搜索工具不能为空' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={tools
                  .filter((tool) => tool.discoveredVia !== 'search')
                  .map((tool) => ({ value: tool.name, label: tool.name }))}
                placeholder="选择该 server 的 static 搜索工具"
              />
            </Form.Item>
            <Form.Item name="query" label="查询词">
              <Input placeholder="database" />
            </Form.Item>
            <Form.Item name="args" label="固定参数（JSON）" extra='例如 {"q": "$query"}；留空表示不带固定参数。'>
              <Input.TextArea rows={3} className="mono" placeholder={'{\n  "q": "$query"\n}'} />
            </Form.Item>
            <Form.Item name="maxTools" label="最大条数">
              <InputNumber min={1} max={200} precision={0} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="prepareOnCall" label="调用前预热" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="staleOthers" label="把本次未返回的旧 search 工具标记为 stale" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Form>

          {preview === null ? null : (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space size={6} wrap>
                <Tag color={preview.parsed ? 'success' : 'error'} bordered={false}>
                  {preview.parsed ? '已解析' : '未解析'}
                </Tag>
                <Tag bordered={false}>{preview.shape}</Tag>
                <Tag bordered={false}>{preview.tools.length} 个工具</Tag>
                <Tag bordered={false}>{formatDuration(preview.elapsedMs)}</Tag>
                <Tag bordered={false}>过期 {formatTimestamp(preview.previewExpiresAt)}</Tag>
              </Space>
              {preview.skipped.length === 0 ? null : (
                <Alert
                  type="warning"
                  showIcon
                  message={`有 ${preview.skipped.length} 个结果被跳过：${preview.skipped
                    .slice(0, 5)
                    .map((entry) => `${entry.name ?? '?'}（${entry.reason}）`)
                    .join('、')}${preview.skipped.length > 5 ? ' …' : ''}`}
                />
              )}
              {preview.omitted === 0 ? null : (
                <Alert
                  type="warning"
                  showIcon
                  message={`还有 ${preview.omitted} 个结果未显示；当前预览不完整。`}
                />
              )}
              {preview.willStaleCount === 0 ? null : (
                <Alert
                  type="warning"
                  showIcon
                  message={`本次会把 ${preview.willStaleCount} 个已有工具标记为 stale：${preview.willStale
                    .slice(0, 10)
                    .join(', ')}${preview.willStaleCount > 10 ? ' 等' : ''}`}
                />
              )}
              {preview.partial ? (
                <Alert type="warning" showIcon message="本次预览不完整；应用前会再次确认 stale 策略。" />
              ) : null}
              {preview.parsed ? null : (
                <Alert
                  type="error"
                  showIcon
                  message="未能自动识别上游输出；请调整搜索工具或查询词。原始输出仅供人工排查。"
                />
              )}
              {!preview.parsed && preview.raw !== null ? (
                <>
                  {preview.rawTruncated ? <Alert type="warning" showIcon message="原始输出已截断。" /> : null}
                  <pre className="code-block" style={{ maxHeight: 260, overflow: 'auto' }}>
                    {preview.raw}
                  </pre>
                </>
              ) : null}
              {!preview.parsed ? null : preview.tools.length === 0 ? (
                <Alert type="warning" showIcon message="解析成功但没有可应用的工具；请调整后重新扫描。" />
              ) : (
                <>
                  <Table
                    size="small"
                    rowKey="name"
                    dataSource={preview.tools}
                    pagination={false}
                    scroll={{ y: 300 }}
                    rowSelection={{
                      selectedRowKeys: selectedNames,
                      onChange: (keys) => setSelectedNames(keys.map((key) => String(key))),
                    }}
                    columns={[
                      {
                        title: '工具',
                        dataIndex: 'name',
                        width: 220,
                        render: (value: string) => <span className="mono">{value}</span>,
                      },
                      {
                        title: '描述',
                        dataIndex: 'description',
                        ellipsis: true,
                        render: (value: string | null) => (
                          <span className="muted" title={value ?? ''}>
                            {value ?? '—'}
                          </span>
                        ),
                      },
                      {
                        title: '参数结构（schema）',
                        dataIndex: 'schemaMissing',
                        width: 80,
                        render: (value: boolean) => (
                          <Tag bordered={false} color={value ? 'error' : 'success'}>
                            {value ? '缺失' : '有'}
                          </Tag>
                        ),
                      },
                      {
                        title: '冲突',
                        dataIndex: 'conflict',
                        width: 90,
                        render: (value: DiscoveryToolView['conflict']) =>
                          value === 'none' ? <span className="muted">—</span> : <Tag>{value}</Tag>,
                      },
                      {
                        title: '动作',
                        dataIndex: 'action',
                        width: 90,
                        render: (value: DiscoveryToolView['action']) => (
                          <Tag
                            bordered={false}
                            color={value === 'create' ? 'success' : value === 'update' ? 'blue' : 'gold'}
                          >
                            {value === 'create' ? '新建' : value === 'update' ? '更新' : '跳过'}
                          </Tag>
                        ),
                      },
                    ]}
                  />
                  <Space>
                    <Button
                      type="primary"
                      loading={applying}
                      disabled={selectedNames.length === 0}
                      onClick={requestApplyDiscovery}
                    >
                      应用所选（{selectedNames.length}）
                    </Button>
                    <Button
                      onClick={() =>
                        setSelectedNames(
                          preview.tools
                            .filter((tool) => tool.action !== 'skip_static')
                            .map((tool) => tool.name),
                        )
                      }
                    >
                      全选
                    </Button>
                    <Button onClick={() => setSelectedNames([])}>全不选</Button>
                  </Space>
                </>
              )}
            </Space>
          )}
        </Space>
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

function inlineKey(tool: ToolRecord, field: string): string {
  return `${tool.serverId}:${tool.name}:${field}`;
}

function nullIfEmpty(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExpiredPreviewCode(code: string): boolean {
  return code === 'DISCOVERY_PREVIEW_EXPIRED' || code === 'DISCOVERY_PREVIEW_NOT_FOUND';
}

function discoveryErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return failureText(error);
  switch (error.code) {
    case 'DISCOVERY_PREVIEW_EXPIRED':
      return '这次预览已过期或已应用；请重新扫描。';
    case 'DISCOVERY_PREVIEW_NOT_FOUND':
      return '预览不存在（服务可能重启过）；请重新扫描。';
    case 'DISCOVERY_EMPTY_PREVIEW':
      return '预览为空，不能应用；请调整搜索工具或查询词后重新预览。';
    case 'DISCOVERY_PARTIAL_STALE_UNCONFIRMED':
      return '本次预览不完整，不能把未返回的工具标记为 stale。';
    case 'DISCOVERY_BUSY':
      return '另一个扫描正在进行，请稍后重试。';
    case 'REVISION_CONFLICT':
      return '工具目录已被他人修改（revision 冲突），请刷新后重新扫描。';
    default:
      return failureText(error);
  }
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
