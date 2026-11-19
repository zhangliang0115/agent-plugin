/** Shared presentational pieces for the React admin pages. */
import { CheckCircleFilled, CloseCircleFilled, MinusCircleFilled, SyncOutlined } from '@ant-design/icons';
import { Tag, Typography } from 'antd';
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): React.ReactElement {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <Typography.Title level={3}>{title}</Typography.Title>
        {description === undefined ? null : (
          <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
        )}
      </div>
      {actions === undefined ? null : <div className="page-header-actions">{actions}</div>}
    </div>
  );
}

const STATE_MAP: Record<string, { color: string; label: string }> = {
  ready: { color: 'success', label: '就绪' },
  idle: { color: 'default', label: '空闲' },
  connecting: { color: 'processing', label: '连接中' },
  starting: { color: 'processing', label: '启动中' },
  degraded: { color: 'warning', label: '降级' },
  reconnecting: { color: 'warning', label: '重连中' },
  failed: { color: 'error', label: '失败' },
  disabled: { color: 'default', label: '已停用' },
  open: { color: 'blue', label: 'open' },
  ack: { color: 'gold', label: 'ack' },
  closed: { color: 'green', label: 'closed' },
  pending: { color: 'blue', label: '待发送' },
  sending: { color: 'processing', label: '发送中' },
  sent: { color: 'success', label: '已送达' },
  skipped: { color: 'gold', label: '已跳过' },
  no_webhook: { color: 'error', label: '未配置' },
  ok: { color: 'success', label: 'ok' },
  error: { color: 'error', label: 'error' },
};

export function StateTag({ state }: { state: string | null | undefined }): React.ReactElement {
  const key = state ?? '';
  const entry = STATE_MAP[key];
  const icon =
    key === 'failed' || key === 'error' ? (
      <CloseCircleFilled />
    ) : key === 'ready' || key === 'sent' || key === 'closed' || key === 'ok' ? (
      <CheckCircleFilled />
    ) : key === 'connecting' || key === 'starting' || key === 'reconnecting' || key === 'sending' ? (
      <SyncOutlined spin />
    ) : key === 'degraded' || key === 'skipped' ? (
      <MinusCircleFilled />
    ) : undefined;
  return (
    <Tag color={entry?.color} icon={icon} bordered={false}>
      {entry?.label ?? key ?? '—'}
    </Tag>
  );
}

export function Mono({ children }: { children: ReactNode }): React.ReactElement {
  return <span className="mono">{children}</span>;
}
