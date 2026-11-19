/** Import/export page: sanitized export on the left, paste + dry-run + import on the right. */
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Row,
  Space,
  Tag,
  Typography,
} from 'antd';
import { CopyOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader } from '../components/common.tsx';
import { ApiError } from '../../lib/api.ts';

interface ConfigDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

interface DryRunReport {
  valid: boolean;
  diff: ConfigDiff;
  errors?: string[];
  missingSecrets?: string[];
}

interface OperationView {
  operationId: string;
  state: 'running' | 'ok' | 'error';
  error?: { code: string; message: string };
}

type ImportOperation =
  | { kind: 'running' | 'ok' | 'unknown' | 'timeout'; operationId: string }
  | { kind: 'error'; operationId: string; reason: string };

const POLL_INTERVAL_MS = 800;
const POLL_BUDGET_MS = 15_000;

export function ConfigPage(): React.ReactElement {
  const api = useApi();
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm<{ document: string }>();
  const [exportText, setExportText] = useState('');
  const [exportBytes, setExportBytes] = useState(0);
  const [exportLoading, setExportLoading] = useState(true);
  const [dryRun, setDryRun] = useState<DryRunReport | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [operation, setOperation] = useState<ImportOperation | null>(null);
  const pollRef = useRef<AbortController | null>(null);
  const importing = operation?.kind === 'running';

  const loadExport = useCallback(async (): Promise<void> => {
    setExportLoading(true);
    try {
      const document = await api.get<unknown>('/config/export');
      const text = JSON.stringify(document, null, 2) ?? '';
      setExportText(text);
      setExportBytes(new TextEncoder().encode(text).length);
    } catch (error) {
      message.error(failureText(error));
    } finally {
      setExportLoading(false);
    }
  }, [api, message]);

  useEffect(() => {
    void loadExport();
    const onRefresh = (): void => void loadExport();
    window.addEventListener('repl:refresh', onRefresh);
    return () => window.removeEventListener('repl:refresh', onRefresh);
  }, [loadExport]);

  useEffect(() => () => pollRef.current?.abort(), []);

  async function copyExport(): Promise<void> {
    try {
      await navigator.clipboard.writeText(exportText);
      message.success('已复制导出 JSON');
    } catch {
      message.warning('复制失败，请手动选中导出文本复制。');
    }
  }

  function currentText(): string {
    const value: unknown = form.getFieldValue('document');
    return typeof value === 'string' ? value : '';
  }

  function showFormError(text: string): void {
    form.setFields([{ name: 'document', errors: [text] }]);
  }

  function readDocument(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
    if (text.trim() === '') return { ok: false, error: '请粘贴要导入的 JSON。' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { ok: false, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: '顶层必须是 JSON 对象，包含 version 与 servers。' };
    }
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== undefined && record['version'] !== 1) {
      return { ok: false, error: 'version 只支持 1。' };
    }
    const servers = record['servers'];
    if (servers === undefined || typeof servers !== 'object' || servers === null) {
      return { ok: false, error: 'servers 必须是数组，或按 server id 键控的对象。' };
    }
    return { ok: true, value: parsed };
  }

  async function runDryRun(text: string): Promise<DryRunReport | null> {
    const check = readDocument(text);
    if (!check.ok) {
      showFormError(check.error);
      return null;
    }
    setDryRunLoading(true);
    try {
      const report = await api.post<DryRunReport>('/config/import', check.value, {
        query: { 'dry-run': 'true' },
      });
      setDryRun(report);
      return report;
    } catch (error) {
      message.error(failureText(error));
      return null;
    } finally {
      setDryRunLoading(false);
    }
  }

  async function startImport(): Promise<void> {
    const text = currentText();
    const report = await runDryRun(text);
    if (report === null) return;
    if (!report.valid) {
      message.error('dry-run 校验未通过，请先按报告修正 JSON。');
      return;
    }
    const diff = report.diff;
    modal.confirm({
      title: '确认导入配置',
      content: `将新增 ${diff.added.length} 个、修改 ${diff.changed.length} 个、删除 ${diff.removed.length} 个 server。导入会修改并删除现有配置，已有连接可能被重建。`,
      okText: '执行导入',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const checked = readDocument(text);
        if (!checked.ok) {
          showFormError(checked.error);
          return;
        }
        try {
          const result = await api.post<{ operationId?: string }>('/config/import', checked.value);
          if (result.operationId === undefined || result.operationId === '') {
            message.warning('导入已提交，但服务端没有返回 operationId；稍后刷新查看结果。');
            void loadExport();
            return;
          }
          setOperation({ kind: 'running', operationId: result.operationId });
          message.success(`导入已排队：${result.operationId}`);
          void followOperation(result.operationId);
        } catch (error) {
          message.error(`导入失败：${failureText(error)}`);
        }
      },
    });
  }

  async function followOperation(operationId: string): Promise<void> {
    pollRef.current?.abort();
    const controller = new AbortController();
    pollRef.current = controller;
    const started = Date.now();
    const path = `/operations/${encodeURIComponent(operationId)}`;
    while (!controller.signal.aborted) {
      try {
        const current = await api.get<OperationView>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (current.state === 'ok') {
          setOperation({ kind: 'ok', operationId });
          message.success('导入完成，配置已写入。');
          void loadExport();
          return;
        }
        if (current.state === 'error') {
          const reason = current.error?.message ?? current.error?.code ?? '未知错误';
          setOperation({ kind: 'error', operationId, reason });
          message.error(`导入失败：${reason}`);
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        // `/operations/:id` is optional in the admin base; the import was already queued.
        if (error instanceof ApiError && error.status === 404) {
          setOperation({ kind: 'unknown', operationId });
          message.info('服务端不提供操作详情；导入已提交，稍后刷新查看配置。');
          void loadExport();
          return;
        }
      }
      if (Date.now() - started > POLL_BUDGET_MS) {
        setOperation({ kind: 'timeout', operationId });
        message.warning('导入仍在运行，稍后刷新查看结果。');
        return;
      }
      await wait(POLL_INTERVAL_MS, controller.signal);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="导入导出"
        description="导出脱敏的声明式 server 配置；导入先 dry-run 核对 diff，再由操作队列写回。"
        actions={
          <Button icon={<ReloadOutlined />} onClick={() => void loadExport()} loading={exportLoading}>
            重新导出
          </Button>
        }
      />
      <Row gutter={16} align="top">
        <Col xs={24} xl={12}>
          <Card
            title="导出声明式配置"
            loading={exportLoading}
            extra={
              <Space wrap>
                <Typography.Text type="secondary">{exportBytes} 字节</Typography.Text>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  disabled={exportText === ''}
                  onClick={() => void copyExport()}
                >
                  复制 JSON
                </Button>
              </Space>
            }
          >
            {exportText === '' ? (
              <Typography.Paragraph type="secondary">还没有读取到导出内容。</Typography.Paragraph>
            ) : (
              <pre className="code-block" style={{ maxHeight: 520, overflow: 'auto' }}>
                {exportText}
              </pre>
            )}
            <Typography.Text type="secondary">导出不包含 secret 引用或明文值。</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="导入配置" extra={<Typography.Text type="secondary">dry-run 不写入</Typography.Text>}>
            <Form form={form} layout="vertical">
              <Form.Item
                name="document"
                label="配置文档（JSON）"
                extra="粘贴 GET /config/export 的返回，或按 server id 键控的 servers 对象。"
              >
                <Input.TextArea
                  rows={16}
                  className="mono"
                  placeholder='{ "version": 1, "servers": [] }'
                  disabled={importing}
                  onChange={() => form.setFields([{ name: 'document', errors: [] }])}
                />
              </Form.Item>
              <Space wrap>
                <Button
                  loading={dryRunLoading}
                  disabled={importing}
                  onClick={() => void runDryRun(currentText())}
                >
                  Dry-run
                </Button>
                <Button
                  type="primary"
                  danger
                  icon={<UploadOutlined />}
                  loading={importing}
                  onClick={() => void startImport()}
                >
                  执行导入
                </Button>
              </Space>
            </Form>
            {operation === null ? null : (
              <Alert
                style={{ marginTop: 16 }}
                showIcon
                {...operationAlert(operation)}
              />
            )}
            {dryRun === null ? null : (
              <Card
                size="small"
                style={{ marginTop: 16 }}
                title="Dry-run 报告"
                extra={<Tag color={dryRun.valid ? 'success' : 'error'}>{dryRun.valid ? '校验通过' : '校验失败'}</Tag>}
              >
                <Descriptions column={1} size="small">
                  <Descriptions.Item label={`新增 ${dryRun.diff.added.length}`}>
                    {diffTags(dryRun.diff.added)}
                  </Descriptions.Item>
                  <Descriptions.Item label={`修改 ${dryRun.diff.changed.length}`}>
                    {diffTags(dryRun.diff.changed)}
                  </Descriptions.Item>
                  <Descriptions.Item label={`删除 ${dryRun.diff.removed.length}`}>
                    {diffTags(dryRun.diff.removed)}
                  </Descriptions.Item>
                </Descriptions>
                {dryRun.errors === undefined || dryRun.errors.length === 0 ? null : (
                  <Alert
                    style={{ marginTop: 12 }}
                    type="error"
                    showIcon
                    message="校验错误"
                    description={dryRun.errors.map((error, index) => (
                      <div key={`${index}-${error}`}>{error}</div>
                    ))}
                  />
                )}
                {dryRun.missingSecrets === undefined || dryRun.missingSecrets.length === 0 ? null : (
                  <Alert
                    style={{ marginTop: 12 }}
                    type="warning"
                    showIcon
                    message="缺失密钥（警告）"
                    description={dryRun.missingSecrets.join('、')}
                  />
                )}
              </Card>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}

function diffTags(ids: string[]): React.ReactNode {
  if (ids.length === 0) return <Typography.Text type="secondary">无</Typography.Text>;
  return (
    <Space wrap size={[4, 4]}>
      {ids.map((id) => (
        <Tag key={id} bordered={false}>
          {id}
        </Tag>
      ))}
    </Space>
  );
}

function operationAlert(operation: ImportOperation): {
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  description?: string;
} {
  switch (operation.kind) {
    case 'running':
      return {
        type: 'info',
        message: `导入中：${operation.operationId}`,
        description: '正在轮询 /operations/:id 等待写入完成。',
      };
    case 'ok':
      return { type: 'success', message: `导入完成：${operation.operationId}` };
    case 'error':
      return { type: 'error', message: `导入失败：${operation.operationId}`, description: operation.reason };
    case 'unknown':
      return {
        type: 'warning',
        message: `已提交：${operation.operationId}`,
        description: '服务端不提供操作详情，稍后刷新确认写入结果。',
      };
    case 'timeout':
      return {
        type: 'warning',
        message: `仍在运行：${operation.operationId}`,
        description: '超过 15 秒未完成，稍后刷新查看结果。',
      };
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      window.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
