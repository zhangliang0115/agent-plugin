/** Secrets page: write-only values for keys declared by server env/header references. */
import { App as AntApp, Button, Card, Empty, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from '../components/common.tsx';
import { ApiError } from '../../lib/api.ts';
import { referencedNames, type ReferencedServer } from '../../lib/secrets.ts';

interface SecretStatus {
  name: string;
  configured: boolean;
}

interface SecretFormValues {
  name: string;
  value: string;
}

const SECRET_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;

export function SecretsPage(): React.ReactElement {
  const api = useApi();
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm<SecretFormValues>();
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; value: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await api.get<{ secrets?: SecretStatus[] }>('/secrets');
      setSecrets(Array.isArray(response.secrets) ? response.secrets : []);
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setLoading(false);
    }
  }, [api, message]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  function rotate(name: string): void {
    form.setFieldsValue({ name });
    const field = form.getFieldInstance('value') as { focus?: () => void } | undefined;
    field?.focus?.();
  }

  async function reveal(name: string): Promise<void> {
    setRevealing(name);
    try {
      const response = await api.post<{ name: string; value: string }>(
        `/secrets/${encodeURIComponent(name)}/reveal`,
      );
      setRevealed({ name: response.name, value: response.value });
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setRevealing(null);
    }
  }

  function remove(name: string): void {
    modal.confirm({
      title: `删除密钥 ${name}？`,
      content: '如果仍被 server 引用，删除后该 server 连接会失败（缺失密钥）。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.delete(`/secrets/${encodeURIComponent(name)}`);
          if (revealed?.name === name) setRevealed(null);
          message.success(`已删除密钥 ${name}。`);
          await load();
        } catch (error) {
          message.error(failureText(error));
          throw error;
        }
      },
    });
  }

  async function prune(): Promise<void> {
    setPruning(true);
    try {
      const [serversResponse, alertsResponse] = await Promise.all([
        api.get<{ servers?: ReferencedServer[] }>('/servers'),
        api
          .get<{ webhook?: { secretName?: string } }>('/alerts/config')
          .catch(() => ({ webhook: undefined })),
      ]);
      const referenced = referencedNames(serversResponse.servers ?? []);
      const webhook = alertsResponse.webhook?.secretName;
      if (typeof webhook === 'string' && webhook !== '') referenced.add(webhook);
      const orphans = secrets
        .filter((secret) => secret.configured && !referenced.has(secret.name))
        .map((secret) => secret.name);
      if (orphans.length === 0) {
        message.info('没有未被任何 server 或告警引用的密钥。');
        return;
      }
      const preview = orphans.slice(0, 10).join('\n');
      const more = orphans.length > 10 ? `\n…另有 ${orphans.length - 10} 个` : '';
      modal.confirm({
        title: `删除 ${orphans.length} 个未引用的密钥？`,
        content: <span className="mono" style={{ whiteSpace: 'pre-wrap' }}>{preview}{more}</span>,
        okText: '删除',
        okButtonProps: { danger: true },
        onOk: async () => {
          let failed = 0;
          for (const name of orphans) {
            try {
              await api.delete(`/secrets/${encodeURIComponent(name)}`);
            } catch {
              failed += 1;
            }
          }
          if (failed === 0) message.success(`已删除 ${orphans.length} 个未引用的密钥。`);
          else message.warning(`已删除 ${orphans.length - failed} 个，${failed} 个删除失败。`);
          if (revealed !== null && orphans.includes(revealed.name)) setRevealed(null);
          await load();
        },
      });
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setPruning(false);
    }
  }

  async function submit(values: SecretFormValues): Promise<void> {
    const name = values.name.trim();
    setSaving(true);
    try {
      await api.put(`/secrets/${encodeURIComponent(name)}`, { value: values.value });
      form.resetFields(['value']);
      message.success(`已写入密钥 ${name}。`);
      await load();
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setSaving(false);
    }
  }

  const columns: TableColumnsType<SecretStatus> = [
    {
      title: '键名',
      dataIndex: 'name',
      render: (value: string) => <span className="mono">{value}</span>,
    },
    {
      title: '状态',
      dataIndex: 'configured',
      width: 120,
      render: (value: boolean) => (
        <Tag color={value ? 'success' : 'error'} bordered={false}>
          {value ? '已设置' : '缺失'}
        </Tag>
      ),
    },
    {
      title: '操作',
      width: 260,
      render: (_value, record) => (
        <Space size={4}>
          <Button
            size="small"
            disabled={!record.configured}
            loading={revealing === record.name}
            onClick={() => void reveal(record.name)}
          >
            查看
          </Button>
          <Button size="small" onClick={() => rotate(record.name)}>
            写入/轮换
          </Button>
          <Button size="small" danger disabled={!record.configured} onClick={() => remove(record.name)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const configured = secrets.filter((secret) => secret.configured).length;

  return (
    <div className="page">
      <PageHeader
        title="密钥"
        description="写入 env / header 引用的密钥值。列表只返回键名与是否已设置；点击“查看”会单独请求一次明文，响应不缓存，关闭窗口即从页面移除。删除只按你确认的范围执行，server 删除不会自动清理它导入的密钥。"
        actions={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />
      <Card title="写入密钥" size="small">
        <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
          <Form.Item
            name="name"
            label="键名"
            rules={[
              { required: true, whitespace: true, message: '键名不能为空' },
              { pattern: SECRET_NAME_PATTERN, message: '键名需以字母、数字或下划线开头，只含字母、数字、_、. 与 -' },
            ]}
          >
            <Input className="mono" placeholder="DATABASE_URL" autoComplete="off" />
          </Form.Item>
          <Form.Item name="value" label="值" rules={[{ required: true, whitespace: true, message: '值不能为空' }]}>
            <Input.Password placeholder="值只在写入时发送；需要时可点“查看”" autoComplete="new-password" />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={saving}>
              写入密钥
            </Button>
            <Typography.Text type="secondary">写入已有键名即轮换。</Typography.Text>
          </Space>
        </Form>
      </Card>
      <Card
        title="密钥"
        size="small"
        extra={
          <Space size={10}>
            <span className="muted">
              {secrets.length} 个键名 · {configured} 个已设置
            </span>
            <Button size="small" loading={pruning} onClick={() => void prune()}>
              清理未引用
            </Button>
          </Space>
        }
      >
        <Table<SecretStatus>
          size="small"
          rowKey="name"
          loading={loading}
          dataSource={secrets}
          columns={columns}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有被引用的密钥。先注册 server 并在 env/header 中声明键名。"
              />
            ),
          }}
        />
      </Card>

      <Modal
        open={revealed !== null}
        title={revealed === null ? '查看密钥' : `查看密钥 ${revealed.name}`}
        footer={<Button onClick={() => setRevealed(null)}>关闭</Button>}
        onCancel={() => setRevealed(null)}
        destroyOnHidden
      >
        {revealed === null ? null : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Input.Password value={revealed.value} readOnly autoComplete="off" />
            <Typography.Text type="secondary" copyable={{ text: revealed.value }}>
              复制明文
            </Typography.Text>
            <Typography.Text type="secondary">
              明文只在本次请求中返回；不要把密钥粘贴到报告或聊天里。
            </Typography.Text>
          </Space>
        )}
      </Modal>
    </div>
  );
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
