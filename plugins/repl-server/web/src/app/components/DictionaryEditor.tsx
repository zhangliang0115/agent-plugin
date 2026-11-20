/** Shared dictionary editor: editable key/zh/en rows saved as a full replacement. */
import { App as AntApp, Button, Card, Empty, Input, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from './common.tsx';
import type { DictionaryEntry } from '../../lib/dictionary.ts';
import type { DictionaryUsage } from '../../lib/references.ts';
import { ApiError } from '../../lib/api.ts';

const DICTIONARY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const LABEL_MAX_LENGTH = 40;

export interface DictionaryPruneConfig {
  /** Button label, for example `清理未引用`. */
  label: string;
  /** Returns the rows no server or tool references; locked rows must not be returned. */
  findUnused: (rows: readonly DictionaryEntry[]) => Promise<DictionaryEntry[]>;
}

export interface DictionaryUsageConfig {
  /** Returns the servers and tools that use the given key. */
  get: (key: string) => Promise<DictionaryUsage>;
  /** Tools per key, fetched by the page; `null` while loading. */
  counts?: ReadonlyMap<string, number> | null;
}

export interface DictionaryEditorProps {
  /** Admin endpoint, for example `/tags` or `/categories`. */
  endpoint: string;
  /** Response/request field carrying the rows. */
  field: string;
  /** Display name used in titles and messages. */
  noun: string;
  description: string;
  maxEntries: number;
  sample: DictionaryEntry;
  /** Key rows the system owns: inputs disabled and no delete button. */
  isLockedKey?: (key: string) => boolean;
  /** Optional bulk cleanup of entries nothing references. */
  prune?: DictionaryPruneConfig;
  /** Optional per-row “what uses this key” lookup. */
  showUsage?: DictionaryUsageConfig;
  /** Reloads the shared dictionary cache after a save. */
  onSaved?: () => void | Promise<void>;
}

export function DictionaryEditor({
  endpoint,
  field,
  noun,
  description,
  maxEntries,
  sample,
  isLockedKey,
  prune,
  showUsage,
  onSaved,
}: DictionaryEditorProps): React.ReactElement {
  const api = useApi();
  const { message, modal } = AntApp.useApp();
  const [draft, setDraft] = useState<DictionaryEntry[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [usageKey, setUsageKey] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const response = await api.get<Record<string, unknown>>(endpoint);
      const raw = response[field];
      setDraft(Array.isArray(raw) ? (raw as DictionaryEntry[]).map((entry) => ({ ...entry })) : []);
      setRevision(typeof response['revision'] === 'number' ? response['revision'] : null);
    } catch (error) {
      setLoadFailed(true);
      message.error(failureText(error));
    } finally {
      setLoading(false);
    }
  }, [api, endpoint, field, message]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateRow(index: number, patch: Partial<DictionaryEntry>): void {
    setDraft((rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number): void {
    setDraft((rows) => rows.filter((_row, position) => position !== index));
  }

  async function persistRows(rows: DictionaryEntry[], successText: string): Promise<boolean> {
    if (revision === null) {
      message.error(`尚未读取到${noun}字典的 revision，请刷新后重试。`);
      return false;
    }
    const normalized = rows.map((entry) => ({
      key: (entry.key ?? '').trim().toLowerCase(),
      zh: (entry.zh ?? '').trim(),
      en: (entry.en ?? '').trim(),
    }));
    if (normalized.length > maxEntries) {
      message.error(`${noun}最多 ${maxEntries} 条。`);
      return false;
    }
    const seen = new Set<string>();
    for (const [index, row] of normalized.entries()) {
      if (!DICTIONARY_KEY_PATTERN.test(row.key)) {
        message.error(
          `第 ${index + 1} 行 key 不合法：需以小写字母或数字开头，只含小写字母、数字与 . _ -（≤32）。`,
        );
        return false;
      }
      if (row.zh === '' || row.en === '') {
        message.error(`第 ${index + 1} 行需要同时填写中文与 English。`);
        return false;
      }
      if (row.zh.length > LABEL_MAX_LENGTH || row.en.length > LABEL_MAX_LENGTH) {
        message.error(`第 ${index + 1} 行的标签文案最多 ${LABEL_MAX_LENGTH} 个字符。`);
        return false;
      }
      if (seen.has(row.key)) {
        message.error(`key ${row.key} 重复。`);
        return false;
      }
      seen.add(row.key);
    }

    setSaving(true);
    try {
      const response = await api.put<Record<string, unknown>>(
        endpoint,
        { [field]: normalized },
        { headers: { 'If-Match': String(revision) } },
      );
      const raw = response[field];
      setDraft(
        Array.isArray(raw) ? (raw as DictionaryEntry[]).map((entry) => ({ ...entry })) : rows,
      );
      if (typeof response['revision'] === 'number') setRevision(response['revision']);
      message.success(successText);
      await onSaved?.();
      return true;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.code.endsWith('_CONFLICT'))) {
        message.error(`${noun}字典已被他人修改，请刷新后重试。`);
      } else {
        message.error(failureText(error));
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function save(): Promise<void> {
    await persistRows(draft, `${noun}字典已保存。`);
  }

  async function showUsageFor(row: DictionaryEntry): Promise<void> {
    if (showUsage === undefined) return;
    const key = row.key.trim().toLowerCase();
    if (key === '') {
      message.info('先填写 key。');
      return;
    }
    setUsageKey(key);
    try {
      const usage = await showUsage.get(key);
      modal.info({
        title: `「${row.zh.trim() === '' ? key : row.zh.trim()}」的关联`,
        width: 640,
        content: <UsageList usage={usage} />,
        okText: '关闭',
      });
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setUsageKey(null);
    }
  }

  async function pruneUnused(): Promise<void> {
    if (prune === undefined) return;
    setPruning(true);
    try {
      const unused = await prune.findUnused(draft);
      if (unused.length === 0) {
        message.info(`没有未引用的${noun}。`);
        return;
      }
      const drop = new Set(unused.map((row) => row.key.trim().toLowerCase()));
      const preview = unused.slice(0, 10).map((row) => row.key).join('\n');
      const more = unused.length > 10 ? `\n…另有 ${unused.length - 10} 个` : '';
      modal.confirm({
        title: `删除 ${unused.length} 个未引用的${noun}？`,
        content: (
          <span className="mono" style={{ whiteSpace: 'pre-wrap' }}>
            {preview}
            {more}
          </span>
        ),
        okText: '删除',
        okButtonProps: { danger: true },
        onOk: async () => {
          const keep = draft.filter((row) => !drop.has(row.key.trim().toLowerCase()));
          const saved = await persistRows(keep, `${noun}字典已保存。`);
          if (saved) message.success(`已删除 ${unused.length} 个未引用的${noun}。`);
        },
      });
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setPruning(false);
    }
  }

  const columns: TableColumnsType<DictionaryEntry> = [
    {
      title: 'key（存储）',
      dataIndex: 'key',
      width: 220,
      render: (value: string, row, index) => {
        const locked = isLockedKey?.(row.key.trim().toLowerCase()) === true;
        return (
          <Input
            className="mono"
            value={value}
            maxLength={32}
            placeholder={sample.key}
            disabled={locked}
            onChange={(event) => updateRow(index, { key: event.target.value })}
          />
        );
      },
    },
    {
      title: '中文',
      dataIndex: 'zh',
      width: 220,
      render: (value: string, row, index) => (
        <Input
          value={value}
          maxLength={LABEL_MAX_LENGTH}
          placeholder={sample.zh}
          disabled={isLockedKey?.(row.key.trim().toLowerCase()) === true}
          onChange={(event) => updateRow(index, { zh: event.target.value })}
        />
      ),
    },
    {
      title: 'English',
      dataIndex: 'en',
      width: 220,
      render: (value: string, row, index) => (
        <Input
          value={value}
          maxLength={LABEL_MAX_LENGTH}
          placeholder={sample.en}
          disabled={isLockedKey?.(row.key.trim().toLowerCase()) === true}
          onChange={(event) => updateRow(index, { en: event.target.value })}
        />
      ),
    },
    ...(showUsage === undefined
      ? []
      : [
          {
            title: '关联',
            width: 110,
            render: (_value: unknown, row: DictionaryEntry) => {
              const count = showUsage.counts?.get(row.key.trim().toLowerCase());
              return (
                <Button
                  type="link"
                  size="small"
                  loading={usageKey === row.key.trim().toLowerCase()}
                  onClick={() => void showUsageFor(row)}
                >
                  {count === undefined ? '查看' : `查看（${count}）`}
                </Button>
              );
            },
          },
        ]),
    {
      title: '操作',
      width: 90,
      render: (_value, row, index) =>
        isLockedKey?.(row.key.trim().toLowerCase()) === true ? (
          <Tag bordered={false} title={`系统内置${noun}，不可修改或删除`}>
            内置
          </Tag>
        ) : (
          <Button danger type="text" size="small" onClick={() => removeRow(index)}>
            删除
          </Button>
        ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={noun}
        description={description}
        actions={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />
      <Card
        title={`${noun}字典`}
        size="small"
        extra={<span className="muted">保存为全量替换 · revision {revision ?? '—'}</span>}
      >
        {loadFailed ? (
          <Empty description={`没有读取到${noun}字典，检查服务端 ${endpoint} 端点。`}>
            <Button onClick={() => void load()}>重试</Button>
          </Empty>
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Table<DictionaryEntry>
              size="small"
              rowKey={(_row, index) => String(index ?? 0)}
              loading={loading}
              dataSource={draft}
              columns={columns}
              pagination={false}
              scroll={{ x: showUsage === undefined ? 760 : 870 }}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={`还没有登记${noun}。新增一行，填写 key、中文与 English，然后保存。`}
                  />
                ),
              }}
            />
            <Space wrap>
              <Button
                icon={<PlusOutlined />}
                onClick={() => setDraft((rows) => [...rows, { key: '', zh: '', en: '' }])}
              >
                新增一行
              </Button>
              <Button
                type="primary"
                loading={saving}
                disabled={loading || revision === null}
                onClick={() => void save()}
              >
                保存
              </Button>
              {prune === undefined ? null : (
                <Button loading={pruning} onClick={() => void pruneUnused()}>
                  {prune.label}
                </Button>
              )}
              <Typography.Text type="secondary">删除字典项不会清掉已有数据。</Typography.Text>
            </Space>
          </Space>
        )}
      </Card>
    </div>
  );
}

function UsageList({ usage }: { usage: DictionaryUsage }): React.ReactElement {
  if (usage.servers.length === 0 && usage.tools.length === 0) {
    return <Typography.Text type="secondary">没有 server 或工具使用它。</Typography.Text>;
  }
  return (
    <Space direction="vertical" size={8} style={{ width: '100%', maxHeight: 360, overflow: 'auto' }}>
      <div>
        <Typography.Text strong>server（{usage.servers.length}）</Typography.Text>
        <div>{usage.servers.length === 0 ? '—' : usage.servers.join('、')}</div>
      </div>
      <div>
        <Typography.Text strong>工具（{usage.tools.length}）</Typography.Text>
        <div className="mono" style={{ whiteSpace: 'pre-wrap' }}>
          {usage.tools.length === 0 ? '—' : usage.tools.join('\n')}
        </div>
      </div>
    </Space>
  );
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
