/** Shared dictionary editor: editable key/zh/en rows saved as a full replacement. */
import { App as AntApp, Button, Card, Empty, Input, Space, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from './common.tsx';
import type { DictionaryEntry } from '../../lib/dictionary.ts';
import { ApiError } from '../../lib/api.ts';

const DICTIONARY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const LABEL_MAX_LENGTH = 40;

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
  onSaved,
}: DictionaryEditorProps): React.ReactElement {
  const api = useApi();
  const { message } = AntApp.useApp();
  const [draft, setDraft] = useState<DictionaryEntry[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

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

  async function save(): Promise<void> {
    if (revision === null) {
      message.error(`尚未读取到${noun}字典的 revision，请刷新后重试。`);
      return;
    }
    const rows = draft.map((entry) => ({
      key: (entry.key ?? '').trim().toLowerCase(),
      zh: (entry.zh ?? '').trim(),
      en: (entry.en ?? '').trim(),
    }));
    if (rows.length > maxEntries) {
      message.error(`${noun}最多 ${maxEntries} 条。`);
      return;
    }
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      if (!DICTIONARY_KEY_PATTERN.test(row.key)) {
        message.error(
          `第 ${index + 1} 行 key 不合法：需以小写字母或数字开头，只含小写字母、数字与 . _ -（≤32）。`,
        );
        return;
      }
      if (row.zh === '' || row.en === '') {
        message.error(`第 ${index + 1} 行需要同时填写中文与 English。`);
        return;
      }
      if (row.zh.length > LABEL_MAX_LENGTH || row.en.length > LABEL_MAX_LENGTH) {
        message.error(`第 ${index + 1} 行的标签文案最多 ${LABEL_MAX_LENGTH} 个字符。`);
        return;
      }
      if (seen.has(row.key)) {
        message.error(`key ${row.key} 重复。`);
        return;
      }
      seen.add(row.key);
    }

    setSaving(true);
    try {
      const response = await api.put<Record<string, unknown>>(
        endpoint,
        { [field]: rows },
        { headers: { 'If-Match': String(revision) } },
      );
      const raw = response[field];
      setDraft(Array.isArray(raw) ? (raw as DictionaryEntry[]).map((entry) => ({ ...entry })) : rows);
      if (typeof response['revision'] === 'number') setRevision(response['revision']);
      message.success(`${noun}字典已保存。`);
      await onSaved?.();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.code.endsWith('_CONFLICT'))) {
        message.error(`${noun}字典已被他人修改，请刷新后重试。`);
      } else {
        message.error(failureText(error));
      }
    } finally {
      setSaving(false);
    }
  }

  const columns: TableColumnsType<DictionaryEntry> = [
    {
      title: 'key（存储）',
      dataIndex: 'key',
      width: 220,
      render: (value: string, _row, index) => (
        <Input
          className="mono"
          value={value}
          maxLength={32}
          placeholder={sample.key}
          onChange={(event) => updateRow(index, { key: event.target.value })}
        />
      ),
    },
    {
      title: '中文',
      dataIndex: 'zh',
      width: 220,
      render: (value: string, _row, index) => (
        <Input
          value={value}
          maxLength={LABEL_MAX_LENGTH}
          placeholder={sample.zh}
          onChange={(event) => updateRow(index, { zh: event.target.value })}
        />
      ),
    },
    {
      title: 'English',
      dataIndex: 'en',
      width: 220,
      render: (value: string, _row, index) => (
        <Input
          value={value}
          maxLength={LABEL_MAX_LENGTH}
          placeholder={sample.en}
          onChange={(event) => updateRow(index, { en: event.target.value })}
        />
      ),
    },
    {
      title: '操作',
      width: 90,
      render: (_value, _row, index) => (
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
              scroll={{ x: 760 }}
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
              <Typography.Text type="secondary">删除字典项不会清掉已有数据。</Typography.Text>
            </Space>
          </Space>
        )}
      </Card>
    </div>
  );
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
