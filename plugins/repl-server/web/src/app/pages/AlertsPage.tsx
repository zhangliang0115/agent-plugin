/** Alerts page: WeCom webhook, minimum severity, preview and test send. */
import { App as AntApp, Alert, Button, Card, Empty, Form, Input, Select, Space, Switch, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from '../components/common.tsx';
import { ApiError } from '../../lib/api.ts';
import { formatBytes, formatDuration, formatNumber } from '../../lib/format.ts';

type Severity = 'low' | 'medium' | 'high' | 'critical';

interface AlertConfigView {
  enabled: boolean;
  minSeverity: Severity;
  events: string[];
  webhook: { configured: boolean; secretName: string };
  revision: number;
}

interface AlertPreviewResponse {
  content: string;
  bytes: number;
}

interface AlertTestResponse {
  ok: boolean;
  attempts: number;
  elapsedMs: number;
  error?: { code: string; message: string };
  details?: Record<string, unknown>;
}

const SEVERITY_OPTIONS: Array<{ value: Severity; label: string }> = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'critical', label: 'critical' },
];

export function AlertsPage(): React.ReactElement {
  const api = useApi();
  const { message, modal } = AntApp.useApp();
  const [config, setConfig] = useState<AlertConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [minSeverity, setMinSeverity] = useState<Severity>('high');
  const [webhookValue, setWebhookValue] = useState('');
  const [showWebhook, setShowWebhook] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<AlertPreviewResponse | null>(null);
  const [testResult, setTestResult] = useState<AlertTestResponse | null>(null);

  const applyConfig = useCallback((next: AlertConfigView): void => {
    setConfig(next);
    setEnabled(next.enabled);
    setMinSeverity(next.minSeverity);
    setWebhookValue('');
    setShowWebhook(false);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await api.get<AlertConfigView>('/alerts/config');
      applyConfig(response);
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setLoading(false);
    }
  }, [api, applyConfig, message]);

  useEffect(() => {
    void load();
  }, [load]);

  function confirm(title: string, content: string, okText: string, danger = false): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      modal.confirm({
        title,
        content,
        okText,
        cancelText: '取消',
        ...(danger ? { okButtonProps: { danger: true } } : {}),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  async function save(): Promise<void> {
    if (config === null) return;
    const enabling = !config.enabled && enabled;
    if (enabling) {
      const target = config.webhook.configured
        ? `${config.webhook.secretName}（已配置）`
        : '尚未配置的 webhook';
      const ok = await confirm(
        '启用告警',
        `启用后 severity ≥ ${minSeverity} 的报告会发送到 ${target}。继续？`,
        '启用',
      );
      if (!ok) return;
    }
    const body: Record<string, unknown> = { enabled, minSeverity };
    const webhook = webhookValue.trim();
    if (webhook !== '') body['webhook'] = webhook;
    setSaving(true);
    try {
      const response = await api.put<AlertConfigView>('/alerts/config', body, {
        headers: { 'If-Match': String(config.revision) },
      });
      applyConfig(response);
      message.success('已保存告警配置。');
    } catch (error) {
      message.error(saveErrorText(error));
    } finally {
      setSaving(false);
    }
  }

  async function clearWebhook(): Promise<void> {
    if (config === null) return;
    const ok = await confirm(
      '清除 webhook',
      '清除已保存的企业微信 webhook？告警将停止发送，开关不会被关闭。',
      '清除',
      true,
    );
    if (!ok) return;
    setSaving(true);
    try {
      const response = await api.put<AlertConfigView>(
        '/alerts/config',
        { webhook: null },
        { headers: { 'If-Match': String(config.revision) } },
      );
      applyConfig(response);
      message.success('已清除 webhook。');
    } catch (error) {
      message.error(saveErrorText(error));
    } finally {
      setSaving(false);
    }
  }

  async function runPreview(): Promise<void> {
    setPreviewing(true);
    try {
      const response = await api.post<AlertPreviewResponse>('/alerts/preview', { severity: minSeverity });
      setPreview(response);
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setPreviewing(false);
    }
  }

  async function runTest(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await api.post<AlertTestResponse>('/alerts/test');
      setTestResult(response);
      if (!response.ok) {
        message.error(`测试消息未送达：${response.error?.code ?? 'ALERT_FAILED'}`);
      }
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="告警"
        description="配置企业微信 webhook 与最低严重级，预览内容并发送测试消息。webhook 只写不读；报告数据在“报告”页查看。"
        actions={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />
      <Card title="告警配置" size="small" loading={loading}>
        {config === null ? (
          <Empty description="没有读取到告警配置，检查服务端 /alerts/config 端点。">
            <Button onClick={() => void load()}>重试</Button>
          </Empty>
        ) : (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color={config.enabled ? 'success' : 'default'} bordered={false}>
                {config.enabled ? '已启用' : '已关闭'}
              </Tag>
              <Tag color={config.webhook.configured ? 'success' : 'error'} bordered={false}>
                {config.webhook.configured ? 'Webhook 已配置' : 'Webhook 未配置'}
              </Tag>
              <Tag bordered={false}>revision {config.revision}</Tag>
            </Space>
            <Form layout="vertical">
              <Form.Item label="启用告警">
                <Switch checked={enabled} onChange={setEnabled} />
              </Form.Item>
              <Form.Item label="最低严重级">
                <Select<Severity>
                  style={{ width: 160 }}
                  value={minSeverity}
                  onChange={(value) => setMinSeverity(value)}
                  options={SEVERITY_OPTIONS}
                />
              </Form.Item>
              {config.webhook.configured && !showWebhook ? (
                <Form.Item label="企业微信 webhook">
                  <Space wrap>
                    <Typography.Text className="mono">{config.webhook.secretName}（已配置）</Typography.Text>
                    <Button size="small" onClick={() => setShowWebhook(true)}>
                      更换
                    </Button>
                  </Space>
                </Form.Item>
              ) : (
                <Form.Item
                  label="企业微信 webhook"
                  extra={config.webhook.configured ? '输入新值可替换（留空保持不变）。' : '值只写不读。'}
                >
                  <Input.Password
                    value={webhookValue}
                    onChange={(event) => setWebhookValue(event.target.value)}
                    placeholder={
                      config.webhook.configured
                        ? '输入新值可替换（留空保持不变）'
                        : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'
                    }
                    autoComplete="off"
                  />
                </Form.Item>
              )}
            </Form>
            <Space wrap>
              <Button type="primary" onClick={() => void save()} loading={saving}>
                保存
              </Button>
              <Button danger disabled={!config.webhook.configured || saving} onClick={() => void clearWebhook()}>
                清除 webhook
              </Button>
              <Button onClick={() => void runPreview()} loading={previewing}>
                预览
              </Button>
              <Button onClick={() => void runTest()} loading={testing}>
                发送测试
              </Button>
            </Space>
            {preview === null ? null : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  预览内容 {formatBytes(preview.bytes)}（上限 4096 字节）
                </Typography.Text>
                <pre className="code-block">{preview.content}</pre>
              </Space>
            )}
            {testResult === null ? null : (
              <Alert
                type={testResult.ok ? 'success' : 'error'}
                showIcon
                message={testResult.ok ? '测试消息已送达' : '测试消息未送达'}
                description={
                  testResult.ok
                    ? `attempts ${formatNumber(testResult.attempts)}，耗时 ${formatDuration(testResult.elapsedMs)}。`
                    : `${testResult.error?.code ?? 'ALERT_FAILED'} · ${testResult.error?.message ?? '未知错误'}（attempts ${formatNumber(testResult.attempts)}，耗时 ${formatDuration(testResult.elapsedMs)}）。`
                }
              />
            )}
          </Space>
        )}
      </Card>
    </div>
  );
}

function saveErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return '告警配置已被他人修改，请刷新后重试。';
  }
  return failureText(error);
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
