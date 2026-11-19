/** Servers page: filterable full-width list with row actions; details open in a drawer. */
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  DownOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader, StateTag } from '../components/common.tsx';
import { CategorySelect, useCategoryDictionary } from '../components/CategorySelect.tsx';
import { CategoryPillEditor, TagPillEditor } from '../components/PillEditors.tsx';
import { TagPicker, tagLabel, useTagDictionary, type TagDefinition } from '../components/TagPicker.tsx';
import {
  AI_INPUT_MAX_BYTES,
  argsForEditing,
  buildProposalApplyBody,
  nullIfEmpty,
  parseArgs,
  proposalInputError,
  splitList,
  utf8ByteLength,
  type ProposalArg,
  type ProposalDraftValues,
  type ProposalResponse,
  type ProposalServerDraft,
} from '../../lib/ai-proposal.ts';
import { dictionaryLabel } from '../../lib/dictionary.ts';
import { ApiError, isTimeoutError, timeoutSignal } from '../../lib/api.ts';
import {
  formatDuration,
  formatNumber,
  formatRelativeTime,
  formatTimestamp,
} from '../../lib/format.ts';
import { navigate } from '../router.ts';
import {
  serverRowActions,
  type ServerRowActionKey,
} from '../../lib/server-actions.ts';

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
  const categoryDictionary = useCategoryDictionary();
  const [servers, setServers] = useState<ServerView[]>([]);
  const [revision, setRevision] = useState(0);
  // Counts, not flags: two queued edits on the same field must not clear the
  // pending state when the first one finishes.
  const [inlinePending, setInlinePending] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ServerView | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [aiProposal, setAiProposal] = useState<ProposalResponse | null>(null);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiApplying, setAiApplying] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiTimeoutMs, setAiTimeoutMs] = useState(60_000);
  const [form] = Form.useForm<ServerFormValues>();
  const [aiForm] = Form.useForm<ProposalDraftValues>();
  const transport = Form.useWatch('transport', form) ?? 'stdio';
  const aiTransport = Form.useWatch('transport', aiForm) ?? 'stdio';
  const selectedTags = Form.useWatch('tags', form) ?? [];
  const envTags = selectedTags.filter((tag) => tag.startsWith('env.'));
  const alive = useRef(true);
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

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await api.get<ServersResponse>('/servers');
      const items = Array.isArray(response.servers) ? response.servers : [];
      if (!alive.current) return;
      setServers(items);
      const nextRevision = typeof response.revision === 'number' ? response.revision : 0;
      revisionRef.current = nextRevision;
      setRevision(nextRevision);
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

  const selected = servers.find((server) => server.id === detailId) ?? null;

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
  const categoryDefinitions = categoryDictionary.categories;

  const columns = [
    {
      title: '服务端',
      dataIndex: 'label',
      width: 180,
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
      width: 80,
      render: (value: ServerTransport) => <span className="mono">{value}</span>,
    },
    {
      title: '状态',
      dataIndex: 'state',
      width: 100,
      render: (value: string) => <StateTag state={value} />,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 90,
      render: (value: boolean, server: ServerView) => (
        <div onClick={(event) => event.stopPropagation()}>
          <Switch
            size="small"
            checked={value}
            checkedChildren="启用"
            unCheckedChildren="停用"
            loading={(inlinePending[`${server.id}:enabled`] ?? 0) > 0}
            onChange={(checked) => void patchInline(server, { enabled: checked }, 'enabled')}
          />
        </div>
      ),
    },
    {
      title: '分类',
      dataIndex: 'category',
      width: 150,
      render: (value: string | null, server: ServerView) => (
        <CategoryPillEditor
          dictionary={categoryDefinitions}
          value={value}
          disabled={(inlinePending[`${server.id}:category`] ?? 0) > 0}
          onChange={(next) =>
            void patchInline(server, { category: next === '' ? null : next }, 'category')
          }
        />
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 240,
      render: (value: string[], server: ServerView) => (
        <TagPillEditor
          dictionary={tagDefinitions}
          value={value}
          disabled={(inlinePending[`${server.id}:tags`] ?? 0) > 0}
          onChange={(next) => void patchInline(server, { tags: next }, 'tags')}
        />
      ),
    },
    {
      title: '更新',
      dataIndex: 'updatedAt',
      width: 120,
      render: (value: string | undefined) => (
        <span className="muted" title={value}>
          {formatRelativeTime(value ?? null)}
        </span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      render: (_value: unknown, server: ServerView) => {
        const plan = serverRowActions(server, busy !== null && busy.serverId === server.id);
        return (
          <div className="row-actions" onClick={(event) => event.stopPropagation()}>
            <Space size={0}>
              {plan.primary.map((action) => (
                <Button
                  key={`${action.key}-${action.label}`}
                  size="small"
                  type="link"
                  danger={action.danger}
                  disabled={action.disabled}
                  loading={action.key === 'pending'}
                  onClick={() => runRowAction(server, action.key)}
                >
                  {action.label}
                </Button>
              ))}
              {plan.more.length === 0 ? null : (
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: plan.more.map((action) => ({
                      key: action.key,
                      label: action.label,
                      danger: action.danger,
                      disabled: action.disabled === true || (action.key === 'test' && testingId === server.id),
                    })),
                    onClick: ({ key }) => runRowAction(server, key as ServerRowActionKey),
                  }}
                >
                  <Button size="small" type="link">
                    更多 <DownOutlined />
                  </Button>
                </Dropdown>
              )}
            </Space>
          </div>
        );
      },
    },
  ];

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
            connectMode: 'eager',
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
        revisionRef.current = response.revision;
        setRevision(response.revision);
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
        revisionRef.current = response.revision;
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

  function openAiDrawer(): void {
    setAiOpen(true);
    // Only the loading label needs the timeout; a failed read keeps the 60s fallback.
    void api
      .get<{ ai?: { timeoutMs?: number } }>('/ai/config')
      .then((response) => {
        const value = response.ai?.timeoutMs;
        if (alive.current && typeof value === 'number' && Number.isFinite(value) && value > 0) {
          setAiTimeoutMs(value);
        }
      })
      .catch(() => undefined);
  }

  function fillAiDraft(draft: ProposalServerDraft): void {
    aiForm.resetFields();
    aiForm.setFieldsValue({
      id: draft.id,
      label: draft.label,
      transport: draft.transport,
      command: draft.command ?? '',
      args: argsForEditing(draft.args),
      cwd: draft.cwd ?? '',
      url: draft.url ?? '',
      envKeys: draft.envKeys.join('\n'),
      headerKeys: draft.headerKeys.join('\n'),
      enabled: draft.enabled,
      connectMode: draft.connectMode,
      category: draft.category ?? '',
      tags: draft.tags,
      summary: draft.summary ?? '',
    });
  }

  async function generateAiProposal(): Promise<void> {
    const problem = proposalInputError(aiInput);
    if (problem !== null) {
      setAiError(problem);
      return;
    }
    setAiError(null);
    setAiGenerating(true);
    try {
      const response = await api.post<ProposalResponse>('/ai/propose', { input: aiInput });
      if (!alive.current) return;
      setAiProposal(response);
      if (response.server === null) aiForm.resetFields();
      else fillAiDraft(response.server);
    } catch (error) {
      if (alive.current) setAiError(aiErrorText(error));
    } finally {
      if (alive.current) setAiGenerating(false);
    }
  }

  async function submitAiProposal(values: ProposalDraftValues): Promise<void> {
    const proposal = aiProposal;
    if (proposal === null || proposal.proposalId === null) {
      setAiError('草稿已失效，请重新生成。');
      return;
    }
    if (values.transport === 'stdio') {
      const command = [values.command ?? '', ...parseArgs(values.args).map(renderArg)]
        .join(' ')
        .trim();
      const proceed = await confirmDialog(
        '确认创建 stdio server',
        `启动命令：${command}\n这等于允许在该 cwd 下执行任意命令。继续？`,
        '创建',
      );
      if (!proceed) return;
    }
    setAiApplying(true);
    setAiError(null);
    try {
      const response = await api.post<{ server: ServerView; revision: number }>(
        '/ai/propose/apply',
        buildProposalApplyBody(proposal.proposalId, values),
      );
      if (!alive.current) return;
      revisionRef.current = response.revision;
      setRevision(response.revision);
      setAiOpen(false);
      setAiInput('');
      setAiError(null);
      setAiProposal(null);
      aiForm.resetFields();
      message.success(`已创建 server ${response.server.id}`);
      await load();
    } catch (error) {
      if (alive.current) setAiError(aiErrorText(error));
    } finally {
      if (alive.current) setAiApplying(false);
    }
  }

  // Inline edits bypass the drawer; the revision lives in a ref so rapid edits
  // across rows chain off the newest value instead of a stale render closure.
  // Requests are serialized so two quick edits never send the same If-Match;
  // each queued request reads revisionRef when it starts, after the previous
  // response has advanced it.
  function patchInline(
    server: ServerView,
    patch: Record<string, unknown>,
    fieldKey: string,
  ): Promise<void> {
    const key = `${server.id}:${fieldKey}`;
    setInlinePending((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
    const task = inlineQueue.current.then(() => sendInlinePatch(server, patch, key));
    // A rejected task would stall every later edit; sendInlinePatch catches its
    // own errors, and this guard keeps the chain alive if that ever changes.
    inlineQueue.current = task.catch(() => undefined);
    return task;
  }

  async function sendInlinePatch(
    server: ServerView,
    patch: Record<string, unknown>,
    key: string,
  ): Promise<void> {
    try {
      const response = await api.patch<{ server: ServerView; revision: number }>(
        `/servers/${encodeURIComponent(server.id)}`,
        patch,
        {
          headers: { 'If-Match': String(revisionRef.current) },
          signal: timeoutSignal(15_000),
        },
      );
      if (!alive.current) return;
      revisionRef.current = response.revision;
      setRevision(response.revision);
      setServers((prev) =>
        prev.map((item) => (item.id === response.server.id ? response.server : item)),
      );
    } catch (error) {
      if (!alive.current) return;
      if (isTimeoutError(error)) {
        message.error('保存超时（15 秒），已刷新列表；请确认结果后再修改。');
        await load();
      } else if (isConflictError(error)) {
        message.error('配置已被他人修改（revision 冲突），已刷新最新版本；请重新操作。');
        await load();
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
      revisionRef.current = response.revision;
      setRevision(response.revision);
      if (detailId === server.id) setDetailId(null);
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

  function runRowAction(server: ServerView, action: ServerRowActionKey): void {
    switch (action) {
      case 'connect':
      case 'disconnect':
      case 'restart':
        void runServerAction(server, action);
        return;
      case 'test':
        void testServer(server);
        return;
      case 'edit':
        openEditor(server);
        return;
      case 'detail':
        setDetailId(server.id);
        return;
      case 'delete':
        requestDelete(server);
        return;
      default:
        return;
    }
  }

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
            <Button icon={<RobotOutlined />} onClick={openAiDrawer}>
              AI 生成配置
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
              新增 server
            </Button>
          </Space>
        }
      />
      <Card title="服务端列表" extra={<span className="muted">{filtered.length} / {servers.length}</span>}>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={filtered}
          columns={columns}
          pagination={false}
          scroll={{ x: 1220 }}
          rowClassName="row-clickable"
          onRow={(record) => ({
            onClick: () => {
              setTestResult(null);
              navigate('/manage', 'tools', record.id);
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

      <Drawer
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        title={selected === null ? '服务详情' : `${selected.label} · ${selected.id}`}
        width={560}
        extra={selected === null ? null : <StateTag state={selected.state} />}
      >
        {selected === null ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该 server 已不存在" />
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
              <Descriptions.Item label="category">
                {selected.category === null
                  ? '—'
                  : dictionaryLabel(categoryDefinitions, selected.category)}
              </Descriptions.Item>
              <Descriptions.Item label="tags">
                <TagList tags={selected.tags} dictionary={tagDefinitions} />
              </Descriptions.Item>
              <Descriptions.Item label="timeoutMs">{selected.timeoutMs}</Descriptions.Item>
              <Descriptions.Item label="maxConcurrency">{selected.maxConcurrency}</Descriptions.Item>
              <Descriptions.Item label="创建">{formatTimestamp(selected.createdAt ?? null)}</Descriptions.Item>
              <Descriptions.Item label="更新">{formatTimestamp(selected.updatedAt ?? null)}</Descriptions.Item>
            </Descriptions>
          </Space>
        )}
      </Drawer>

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
                    { value: 'eager', label: 'eager（默认，启动即连接）' },
                    { value: 'lazy', label: 'lazy（首次调用时连接）' },
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
            <CategorySelect dictionary={categoryDefinitions} />
          </Form.Item>
          <Form.Item name="tags" label="tags">
            <TagsField dictionary={dictionary.tags} />
          </Form.Item>
          {envTags.length >= 2 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="跨环境"
              description="已选择多个 env.* 标签。标签只声明该 server 涉及的环境范围，不构成隔离边界；需要隔离请拆分 server 或使用独立凭证。"
            />
          ) : null}
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

      <Drawer
        forceRender
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        title="AI 生成配置"
        width={640}
        extra={
          <Space>
            <Button onClick={() => setAiOpen(false)}>取消</Button>
            {aiProposal === null || aiProposal.server === null ? null : (
              <Button type="primary" loading={aiApplying} onClick={() => aiForm.submit()}>
                确认创建
              </Button>
            )}
          </Space>
        }
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Input.TextArea
            rows={5}
            value={aiInput}
            placeholder="例如：帮我配一个 github MCP，需要 GITHUB_TOKEN"
            onChange={(event) => setAiInput(event.target.value)}
          />
          <Space wrap>
            <Typography.Text type="secondary">
              {formatNumber(utf8ByteLength(aiInput))} / {formatNumber(AI_INPUT_MAX_BYTES)} 字节
            </Typography.Text>
            <Button type="primary" loading={aiGenerating} onClick={() => void generateAiProposal()}>
              {aiGenerating
                ? `Claude 正在生成，最长 ${Math.ceil(aiTimeoutMs / 1000)} 秒…`
                : '生成配置'}
            </Button>
          </Space>
          {aiError === null ? null : (
            <Alert type="error" showIcon closable message={aiError} onClose={() => setAiError(null)} />
          )}
          {aiProposal === null ? null : (
            <>
              <Alert
                type="info"
                showIcon
                message="AI 生成，未经审核"
                description="stdio 等于允许执行命令，确认前请核对 command 与 args。"
              />
              {aiProposal.explanation.trim() === '' ? null : (
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  {aiProposal.explanation}
                </Typography.Paragraph>
              )}
              {aiProposal.warnings.length === 0 ? null : (
                <Alert
                  type="warning"
                  showIcon
                  message="模型提示"
                  description={
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {aiProposal.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  }
                />
              )}
              {aiProposal.inputWarning === true ? (
                <Alert
                  type="warning"
                  showIcon
                  message="输入中可能包含字面密钥，已发送给模型；建议改用 <secret:NAME> 引用。"
                />
              ) : null}
              {aiProposal.idConflict ? (
                <Alert type="error" showIcon message="生成的 id 已存在；请修改 id 或重新生成。" />
              ) : null}
              {aiProposal.server === null ? (
                <Alert
                  type="error"
                  showIcon
                  message="模型没有给出可用的 server 草稿；请调整输入后重新生成。"
                />
              ) : (
                <Form
                  form={aiForm}
                  layout="vertical"
                  onFinish={(values) => void submitAiProposal(values)}
                >
                  <Form.Item
                    name="id"
                    label="id"
                    rules={[
                      { required: true, message: 'id 不能为空，例如 pg' },
                      {
                        validator: async (_rule, value?: string) => {
                          const text = (value ?? '').trim();
                          if (text === '__official__' || text === '__builtin__') {
                            throw new Error('__official__ 与 __builtin__ 是保留 id');
                          }
                          if (text !== '' && !SERVER_ID_PATTERN.test(text)) {
                            throw new Error(
                              'id 需以字母或数字开头，只能包含字母、数字、点、下划线与短横线（≤64）',
                            );
                          }
                          if (text !== '' && servers.some((server) => server.id === text)) {
                            throw new Error('该 id 已存在，请换一个');
                          }
                        },
                      },
                    ]}
                  >
                    <Input placeholder="pg" />
                  </Form.Item>
                  <Form.Item
                    name="label"
                    label="label"
                    rules={[{ max: 128, message: 'label 最多 128 个字符' }]}
                  >
                    <Input placeholder="PostgreSQL" />
                  </Form.Item>
                  <Form.Item name="transport" label="transport">
                    <Select
                      options={[
                        { value: 'stdio', label: 'stdio（本地进程）' },
                        { value: 'http', label: 'http（远程 endpoint）' },
                      ]}
                    />
                  </Form.Item>
                  {aiTransport === 'stdio' ? (
                    <>
                      <Form.Item
                        name="command"
                        label="command"
                        rules={[
                          {
                            required: true,
                            whitespace: true,
                            message: 'stdio server 需要 command，例如 npx',
                          },
                        ]}
                      >
                        <Input placeholder="npx" />
                      </Form.Item>
                      <Form.Item
                        name="args"
                        label="args（每行一个参数）"
                        extra="密钥写 <secret:NAME>，不会以明文保存。"
                      >
                        <Input.TextArea
                          rows={3}
                          placeholder={'-y\n@modelcontextprotocol/server-everything\n<secret:TOKEN>'}
                        />
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
                        {
                          required: true,
                          whitespace: true,
                          message: 'http server 需要 url，例如 https://example.com/mcp',
                        },
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
                              throw new Error(
                                `env 键名 ${key} 不合法：需以字母或下划线开头，只含字母、数字与下划线`,
                              );
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
                        { value: 'eager', label: 'eager（默认，启动即连接）' },
                        { value: 'lazy', label: 'lazy（首次调用时连接）' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="summary" label="summary">
                    <Input placeholder="用于检索的 server 摘要" />
                  </Form.Item>
                  <Form.Item name="category" label="category">
                    <CategorySelect dictionary={categoryDefinitions} />
                  </Form.Item>
                  <Form.Item name="tags" label="tags">
                    <TagsField dictionary={dictionary.tags} />
                  </Form.Item>
                  <Form.Item name="enabled" label="启用" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                  <Typography.Text type="secondary">
                    确认创建后按 /ai/propose/apply 创建；stdio server 提交前会再次确认 command 与 args。
                  </Typography.Text>
                </Form>
              )}
            </>
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

function renderArg(arg: ProposalArg): string {
  return typeof arg === 'string' ? arg : `<secret:${arg.$secret}>`;
}

/** AI errors stay on this page; no branch echoes a secret value. */
function aiErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return failureText(error);
  switch (error.code) {
    case 'AI_DISABLED':
      return 'AI 未启用；请先到“AI 配置”页启用并保存。';
    case 'AI_BUSY':
      return '已有 AI 任务在运行，请 1 秒后重试。';
    case 'AI_TIMEOUT':
      return '已超过配置的 timeoutMs；可在“AI 配置”页调大 timeoutMs 后重试。';
    case 'AI_RUNNER_UNAVAILABLE':
      return `找不到或无法启动 Claude CLI：${error.message}。请检查 claudeBin 配置。`;
    case 'AI_RUN_FAILED':
      return 'Claude CLI 运行失败；请检查 claudeBin 与运行环境后重试。';
    case 'AI_BAD_ENVELOPE':
      return 'Claude CLI 输出不是预期的 JSON 包装格式；请检查 Claude CLI 版本后重试。';
    case 'AI_INVALID_JSON':
      return 'Claude 返回的草案不是合法 JSON；请调整输入后重试。';
    case 'AI_OUTPUT_TOO_LARGE':
      return 'Claude 输出超过大小上限；请缩短输入或稍后重试。';
    case 'SERVER_EXISTS': {
      const serverId =
        isRecord(error.details) && typeof error.details['serverId'] === 'string'
          ? error.details['serverId']
          : '';
      return serverId === ''
        ? '该 id 已存在，请修改后重试。'
        : `server ${serverId} 已存在；请修改 id 后重试。`;
    }
    case 'AI_INPUT_EMPTY':
      return '输入不能为空。';
    case 'AI_INPUT_TOO_LARGE':
      return `输入超过上限 ${formatNumber(AI_INPUT_MAX_BYTES)} 字节。`;
    case 'AI_PROPOSAL_INVALID':
      return `草案不合法：${error.message}`;
    case 'AI_SECRET_LITERAL':
      return '草案里出现疑似字面密钥；请把密钥改为 <secret:NAME> 引用。';
    case 'AI_PROPOSAL_NOT_FOUND':
      return '草稿不存在或已被使用，请重新生成。';
    case 'AI_PROPOSAL_EXPIRED':
      return '草稿已过期，请重新生成。';
    case 'STDIO_CONFIRM_REQUIRED':
      return 'stdio server 需要确认后才能创建。';
    default:
      return failureText(error);
  }
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
