/** One side of a protocol frame pair: request or response payload, bounded by the recorder. */
import { Space, Tag, Typography } from 'antd';

import { formatBytes, formatJson } from '../../lib/format.ts';

const { Text } = Typography;

export interface FrameEvent {
  ts?: string;
  event?: string;
  [key: string]: unknown;
}

export function FrameColumn({
  label,
  event,
}: {
  label: string;
  event: FrameEvent | null;
}): React.ReactElement {
  if (event === null) {
    return (
      <div>
        <Text type="secondary" style={{ fontSize: 11.5, fontWeight: 550 }}>
          {label}
        </Text>
        <div className="muted" style={{ fontSize: 12 }}>
          （缺少这一侧）
        </div>
      </div>
    );
  }
  const eventTruncation = frameTruncationLabel(event);
  const payload = framePayload(event);
  const payloadTruncation = payloadTruncationLabel(payload);
  const head = truncatedHead(payload);
  return (
    <div style={{ minWidth: 0 }}>
      <Text type="secondary" style={{ fontSize: 11.5, fontWeight: 550 }}>
        {label}
      </Text>
      {eventTruncation === null && payloadTruncation === null ? null : (
        <Space size={4} wrap>
          {eventTruncation === null ? null : <Tag color="gold">{eventTruncation}</Tag>}
          {payloadTruncation === null ? null : <Tag color="gold">{payloadTruncation}</Tag>}
        </Space>
      )}
      <pre className="code-block" style={{ maxHeight: 240, overflow: 'auto' }}>
        {head === null ? formatJson(payload, 2) : `${head}\n…（已截断）`}
      </pre>
    </div>
  );
}

function framePayload(event: FrameEvent): unknown {
  if (event['params'] !== undefined) return event['params'];
  if (event['result'] !== undefined) return event['result'];
  if (event['error'] !== undefined) return event['error'];
  return event;
}

function frameTruncationLabel(event: FrameEvent): string | null {
  const truncated = event['truncated'] === true || event['payloadTruncated'] === true;
  if (!truncated) return null;
  const bytes =
    asNumber(event['bytes']) ??
    asNumber(event['truncatedBytes']) ??
    asNumber(event['originalBytes']);
  const sha = typeof event['sha256'] === 'string' ? event['sha256'] : null;
  return `已截断${bytes === null ? '' : ` ${formatBytes(bytes)}`}${
    sha === null ? '' : ` · sha256 ${sha.slice(0, 12)}…`
  }`;
}

function payloadTruncationLabel(payload: unknown): string | null {
  if (!isRecord(payload) || payload['truncated'] !== true) return null;
  const bytes = asNumber(payload['bytes']);
  const sha = typeof payload['sha256'] === 'string' ? payload['sha256'] : null;
  return `已截断${bytes === null ? '' : ` ${formatBytes(bytes)}`}${
    sha === null ? '' : ` · sha256 ${sha.slice(0, 12)}…`
  }`;
}

function truncatedHead(payload: unknown): string | null {
  if (!isRecord(payload) || payload['truncated'] !== true) return null;
  return typeof payload['head'] === 'string' ? payload['head'] : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
