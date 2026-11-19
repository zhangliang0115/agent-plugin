/** Discovery page: scan local MCP configs, group by source, register selected servers. */
import {
  App as AntApp,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from '../components/common.tsx';
import { ApiError } from '../../lib/api.ts';
import {
  displayReason,
  filterDeclaredKeys,
  hasPlaceholderArgs,
  parseArgsText,
  rollbackImportedSecrets,
} from '../../lib/discover-secrets.ts';

type Confidence = 'high' | 'medium' | 'low';

interface Suggestion {
  id: string;
  label: string;
  command: string | null;
  args: string[];
  url: string | null;
  reason: string;
  confidence: Confidence;
  alreadyExists: boolean;
  envKeys: string[];
  headerKeys: string[];
  sourcePath: string | null;
  serverName: string | null;
}

interface ImportedSecrets {
  env: Record<string, { $secret: string }>;
  headers: Record<string, { $secret: string }>;
  imported: string[];
  skipped: string[];
}

const GROUP_ORDER = ['Claude Code', 'Kiro', 'Cursor', '工作区', '内置'] as const;

/** Client configs arrive as `来自 <path>`; the path decides the source bucket. */
function sourceGroup(item: Suggestion): string {
  if (!item.reason.startsWith('来自 ')) return '内置';
  const path = item.reason.slice('来自 '.length);
  if (path.endsWith('/.claude.json')) return 'Claude Code';
  // A workspace `.kiro/settings/mcp.json` also lands here; the server reports a bare path.
  if (path.includes('/.kiro/')) return 'Kiro';
  if (path.includes('/.cursor/')) return 'Cursor';
  return '工作区';
}

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  high: 'success',
  medium: 'warning',
  low: 'default',
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export function DiscoverPage(): React.ReactElement {
  const api = useApi();
  const { message } = AntApp.useApp();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [registering, setRegistering] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [argEditor, setArgEditor] = useState<{
    id: string;
    text: string;
    error: string | null;
  } | null>(null);
  const scanAbort = useRef<AbortController | null>(null);
  const registeringGuard = useRef(false);
  const argEditorResolve = useRef<((args: string[] | null) => void) | null>(null);

  const scan = useCallback(async (): Promise<void> => {
    scanAbort.current?.abort();
    const controller = new AbortController();
    scanAbort.current = controller;
    setScanning(true);
    setFailures({});
    try {
      const response = await api.post<{ suggestions?: Suggestion[] }>('/discover', undefined, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const items = Array.isArray(response.suggestions) ? response.suggestions : [];
      setSuggestions(items);
      // Start with nothing selected: bulk registration is destructive and must be explicit.
      setSelected(new Set());
      setScanned(true);
      message.success(`扫描完成：${items.length} 条建议`);
    } catch (error) {
      if (!controller.signal.aborted) message.error(failureText(error));
    } finally {
      if (!controller.signal.aborted) setScanning(false);
    }
  }, [api, message]);

  useEffect(() => {
    void scan();
    return () => scanAbort.current?.abort();
  }, [scan]);

  function markRegistering(id: string, active: boolean): void {
    setRegistering((current) => {
      const next = new Set(current);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Built-in args such as `<workspace>` are not runnable; edit them before registering. */
  function promptArgs(suggestion: Suggestion): Promise<string[] | null> {
    return new Promise((resolve) => {
      argEditorResolve.current = resolve;
      setArgEditor({ id: suggestion.id, text: suggestion.args.join('\n'), error: null });
    });
  }

  function closeArgEditor(args: string[] | null): void {
    const resolve = argEditorResolve.current;
    argEditorResolve.current = null;
    setArgEditor(null);
    resolve?.(args);
  }

  function confirmArgEditor(): void {
    if (argEditor === null) return;
    const args = parseArgsText(argEditor.text);
    if (hasPlaceholderArgs(args)) {
      setArgEditor({ ...argEditor, error: '仍有 <...> 占位符，请全部替换后再继续' });
      return;
    }
    closeArgEditor(args);
  }

  async function registerMany(items: Suggestion[]): Promise<void> {
    if (registeringGuard.current) return;
    const targets = items.filter((item) => !item.alreadyExists);
    if (targets.length === 0) return;
    registeringGuard.current = true;
    let warnedAboutImport = false;
    try {
      for (const target of targets) {
        let suggestion = target;
        markRegistering(target.id, true);
        setFailures((current) => {
          const next = { ...current };
          delete next[target.id];
          return next;
        });
        try {
          if (hasPlaceholderArgs(suggestion.args)) {
            const edited = await promptArgs(suggestion);
            if (edited === null) {
              message.info(`已取消注册 ${suggestion.id}`);
              continue;
            }
            suggestion = { ...suggestion, args: edited };
          }
          // Literal or env-resolved values from the scanned config are copied into
          // the secret store first; the response only carries `$secret` references.
          let imported: ImportedSecrets | undefined;
          if (suggestion.sourcePath !== null && suggestion.serverName !== null) {
            try {
              imported = await api.post<ImportedSecrets>('/discover/secrets', {
                sourcePath: suggestion.sourcePath,
                serverName: suggestion.serverName,
                serverId: suggestion.id,
              });
            } catch {
              if (!warnedAboutImport) {
                warnedAboutImport = true;
                message.warning('密钥自动导入失败，请到密钥页手填');
              }
            }
          }
          try {
            await api.post('/servers', registerBody(suggestion, imported));
          } catch (registrationError) {
            // The import already wrote secrets; drop them only when the server is
            // confirmed absent, otherwise the new server may already reference them.
            await rollbackImportedSecrets(api, suggestion.id, imported?.imported, registrationError);
            throw registrationError;
          }
          // First tools/list feeds the AI auto-annotation preview; a failed refresh
          // must not fail registration, so it stays silent.
          void api
            .post(`/servers/${encodeURIComponent(suggestion.id)}/tools/refresh`)
            .catch(() => undefined);
          setSuggestions((current) =>
            current.map((item) =>
              item.id === suggestion.id ? { ...item, alreadyExists: true } : item,
            ),
          );
          setSelected((current) => {
            const next = new Set(current);
            next.delete(suggestion.id);
            return next;
          });
          message.success(`已注册 ${suggestion.id}`);
        } catch (error) {
          const reason = failureText(error);
          setFailures((current) => ({ ...current, [suggestion.id]: reason }));
          message.error(`${suggestion.id} 注册失败：${reason}`);
        } finally {
          markRegistering(suggestion.id, false);
        }
      }
    } finally {
      registeringGuard.current = false;
    }
  }

  const pendingSelected = suggestions.filter((item) => selected.has(item.id) && !item.alreadyExists);
  const busy = registering.size > 0;

  const columns = [
    {
      title: '建议',
      dataIndex: 'label',
      width: 170,
      render: (label: string, record: Suggestion) => (
        <Space direction="vertical" size={0}>
          <span>{label}</span>
          <span className="mono muted">{record.id}</span>
        </Space>
      ),
    },
    {
      title: '命令行 / URL',
      key: 'command',
      render: (_value: unknown, record: Suggestion) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <span className="mono" style={{ wordBreak: 'break-all' }}>
            {record.url ?? [record.command ?? '', ...record.args].join(' ')}
          </span>
          {failures[record.id] === undefined ? null : (
            <Typography.Text type="danger">注册失败：{failures[record.id]}</Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '环境 / Header 键',
      key: 'keys',
      width: 190,
      render: (_value: unknown, record: Suggestion) => {
        const keys = [
          ...record.envKeys.map((key) => ({ key: `env-${key}`, label: `env ${key}` })),
          ...record.headerKeys.map((key) => ({ key: `header-${key}`, label: `header ${key}` })),
        ];
        if (keys.length === 0) return <span className="muted">—</span>;
        return (
          <Space wrap size={[4, 4]}>
            {keys.map((entry) => (
              <Tag key={entry.key} bordered={false}>
                {entry.label}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '置信度',
      dataIndex: 'confidence',
      width: 90,
      render: (value: Confidence) => <Tag color={CONFIDENCE_COLOR[value]}>{CONFIDENCE_LABEL[value]}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'alreadyExists',
      width: 92,
      render: (value: boolean) =>
        value ? <Tag color="success">已注册</Tag> : <Tag bordered={false}>未注册</Tag>,
    },
    {
      title: '原因',
      dataIndex: 'reason',
      render: (value: string, record: Suggestion) => (
        <Typography.Text type="secondary" ellipsis={{ tooltip: displayReason(value, record.args) }}>
          {displayReason(value, record.args)}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_value: unknown, record: Suggestion) => (
        <Button
          size="small"
          type="link"
          disabled={record.alreadyExists || scanning || busy}
          loading={registering.has(record.id)}
          onClick={() => void registerMany([record])}
        >
          注册
        </Button>
      ),
    },
  ];

  const buckets = new Map<string, Suggestion[]>();
  for (const item of suggestions) {
    const group = sourceGroup(item);
    const bucket = buckets.get(group);
    if (bucket === undefined) buckets.set(group, [item]);
    else bucket.push(item);
  }
  const collapseItems = GROUP_ORDER.filter((group) => buckets.has(group)).map((group) => {
    const items = buckets.get(group) ?? [];
    return {
      key: group,
      label: `${group}（${items.length}）`,
      children: (
        <Table<Suggestion>
          size="small"
          rowKey="id"
          dataSource={items}
          columns={columns}
          pagination={false}
          loading={scanning}
          scroll={{ x: 860 }}
          rowSelection={{
            selectedRowKeys: items.filter((item) => selected.has(item.id)).map((item) => item.id),
            onChange: (keys) => {
              setSelected((current) => {
                const next = new Set(current);
                for (const item of items) next.delete(item.id);
                for (const key of keys) next.add(String(key));
                return next;
              });
            },
            getCheckboxProps: (item) => ({ disabled: item.alreadyExists || scanning || busy }),
          }}
        />
      ),
    };
  });

  return (
    <div className="page">
      <PageHeader
        title="发现"
        description="探测 Claude Code、Kiro、Cursor 的 MCP 配置；工作区配置仅在服务端显式配置时扫描；注册时会自动导入字面密钥和可解析的 ${VAR} 占位符，按 server 命名空间保存，值不回显。"
        actions={
          <Space>
            <Button
              icon={<SearchOutlined />}
              loading={scanning}
              disabled={busy}
              onClick={() => void scan()}
            >
              重新扫描
            </Button>
            <Button
              type="primary"
              disabled={pendingSelected.length === 0 || scanning || busy}
              loading={busy}
              onClick={() => void registerMany(pendingSelected)}
            >
              注册所选（{pendingSelected.length}）
            </Button>
          </Space>
        }
      />
      <Card title="扫描结果" extra={<Typography.Text type="secondary">手动勾选后再注册</Typography.Text>}>
        {scanning && !scanned ? (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : !scanned ? (
          <Empty description="尚未扫描本机环境。" />
        ) : suggestions.length === 0 ? (
          <Empty description="没有发现可注册的 MCP server。" />
        ) : (
          <Collapse
            defaultActiveKey={[...GROUP_ORDER]}
            items={collapseItems}
            bordered={false}
          />
        )}
      </Card>
      <Modal
        title={`编辑参数：${argEditor?.id ?? ''}`}
        open={argEditor !== null}
        okText="继续注册"
        cancelText="取消"
        onOk={confirmArgEditor}
        onCancel={() => closeArgEditor(null)}
      >
        <Typography.Paragraph type="secondary">
          每行一个参数。请替换所有 &lt;...&gt; 占位符，否则注册出的 server 无法启动。
        </Typography.Paragraph>
        <Input.TextArea
          className="mono"
          autoSize={{ minRows: 4, maxRows: 12 }}
          value={argEditor?.text ?? ''}
          onChange={(event) => {
            if (argEditor !== null) {
              setArgEditor({ ...argEditor, text: event.target.value, error: null });
            }
          }}
        />
        {argEditor?.error === null || argEditor?.error === undefined ? null : (
          <Typography.Text type="danger">{argEditor.error}</Typography.Text>
        )}
      </Modal>
    </div>
  );
}

/** Builds the `POST /servers` body from imported `$secret` refs plus hand-fill keys. */
function registerBody(item: Suggestion, imported?: ImportedSecrets): Record<string, unknown> {
  const body: Record<string, unknown> = { id: item.id, label: item.label, tags: [] };
  if (item.url !== null) {
    body['transport'] = 'http';
    body['url'] = item.url;
  } else {
    body['transport'] = 'stdio';
    if (item.command !== null) body['command'] = item.command;
    body['args'] = [...item.args];
  }

  const env = imported?.env ?? {};
  const headers = imported?.headers ?? {};
  if (Object.keys(env).length > 0) body['env'] = env;
  if (Object.keys(headers).length > 0) body['headers'] = headers;

  // Keys the server could not import stay as declared key names for manual entry.
  const skipped = new Set(imported?.skipped ?? []);
  const envKeys = filterDeclaredKeys(
    imported === undefined
      ? item.envKeys
      : item.envKeys.filter((key) => skipped.has(key) && env[key] === undefined),
  );
  const headerKeys = filterDeclaredKeys(
    imported === undefined
      ? item.headerKeys
      : item.headerKeys.filter((key) => skipped.has(key) && headers[key] === undefined),
  );
  if (envKeys.length > 0) body['envKeys'] = envKeys;
  if (headerKeys.length > 0) body['headerKeys'] = headerKeys;
  return body;
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
