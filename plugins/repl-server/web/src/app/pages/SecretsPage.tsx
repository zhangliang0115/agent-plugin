/** Secrets page: write-only list, plus an explicit per-key reveal. */
import { App as AntApp, Button, Card, Empty, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from '../components/common.tsx';
import { ApiError } from '../../lib/api.ts';

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
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<SecretFormValues>();
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
      const response = await api.get<{ name: string; value: string }>(
        `/secrets/${encodeURIComponent(name)}`,
      );
      setRevealed({ name: response.name ?? name, value: response.value });
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setRevealing(null);
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
      width: 190,
      render: (_value, record) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<EyeOutlined />}
            disabled={!record.configured}
            loading={revealing === record.name}
            onClick={() => void reveal(record.name)}
          >
            查看
          </Button>
          <Button size="small" onClick={() => rotate(record.name)}>
            写入/轮换
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
        description="写入 env / header 引用的密钥值。列表只返回键名与是否已设置；需要核对当前值时，点单个键名的「查看」回读，响应不缓存。"
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
            <Input.Password placeholder="值保存在本机密钥库，可按单个键名查看" autoComplete="new-password" />
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
        title="已声明的密钥"
        size="small"
        extra={
          <span className="muted">
            {secrets.length} 个键名 · {configured} 个已设置
          </span>
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
        title={revealed === null ? '查看密钥' : `密钥 · ${revealed.name}`}
        footer={null}
        destroyOnHidden
        onCancel={() => setRevealed(null)}
      >
        {revealed === null ? null : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Typography.Paragraph
              className="mono"
              copyable={{ text: revealed.value }}
              style={{ marginBottom: 0, wordBreak: 'break-all' }}
            >
              {revealed.value}
            </Typography.Paragraph>
            <Typography.Text type="secondary">
              值来自本机密钥库，仅在本次弹窗显示；关闭后不保留在页面状态里。
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
