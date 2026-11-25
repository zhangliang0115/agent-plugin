/** Copyable locator summary at the top of the request detail drawer. */
import { Card, Descriptions, Typography } from 'antd';

import type { DetailAuditEvent, RequestFramePair } from './RequestDetailDrawer.tsx';
import { mcpSessionText, requestLocatorFields } from '../../lib/request-meta.ts';

const { Text } = Typography;

/** Internal locators worth copying on their own; ordinary display fields stay plain text. */
const COPYABLE_FIELD_KEYS = new Set(['exec', 'runId', 'evalId', 'evalTaskId', 'scriptId']);

export function RequestMetaCard({
  pair,
  events,
}: {
  pair: RequestFramePair;
  events: DetailAuditEvent[] | null;
}): React.ReactElement {
  const fields = requestLocatorFields(pair, events);
  return (
    <Card
      size="small"
      title="请求信息"
      extra={
        <Text
          type="secondary"
          copyable={{ text: mcpSessionText(fields), tooltips: ['复制 MCP 会话', '已复制'] }}
          style={{ fontSize: 11.5 }}
        >
          复制 MCP 会话
        </Text>
      }
    >
      <Descriptions size="small" column={3}>
        {fields.map((field) => (
          <Descriptions.Item key={field.key} label={field.label}>
            {COPYABLE_FIELD_KEYS.has(field.key) ? (
              <Text
                className="mono"
                style={{ wordBreak: 'break-all' }}
                copyable={{ text: field.value, tooltips: ['复制', '已复制'] }}
              >
                {field.value}
              </Text>
            ) : (
              <span className="mono" style={{ wordBreak: 'break-all' }}>
                {field.value}
              </span>
            )}
          </Descriptions.Item>
        ))}
      </Descriptions>
      <Text type="secondary" style={{ fontSize: 11.5 }}>
        JSON-RPC ID 在同一 MCP 会话内可能复用，定位请同时使用 MCP 会话与请求时间。
      </Text>
    </Card>
  );
}
