/** Gantt-style view of one request: markers and bars on a shared time axis. */
import { Alert, Empty, Space, Spin, Tooltip, Typography } from 'antd';
import { useMemo } from 'react';

import { formatDuration } from '../../lib/format.ts';
import {
  buildRequestTimeline,
  type TimelineEventLike,
  type TimelineFrameLike,
} from '../../lib/request-timeline.ts';

export function RequestTimeline({
  request,
  response,
  events,
  loading,
  error,
}: {
  request: TimelineFrameLike | null;
  response: TimelineFrameLike | null;
  events: readonly TimelineEventLike[] | null;
  loading: boolean;
  error: string | null;
}): React.ReactElement {
  const timeline = useMemo(
    () => buildRequestTimeline(request, response, events ?? []),
    [request, response, events],
  );
  if (loading) return <Spin size="small" />;
  if (error !== null) return <Alert type="error" showIcon message="过程读取失败" description={error} />;
  if (timeline === null) {
    return <Empty description="本次请求没有可展示的过程事件。" />;
  }
  const span = timeline.to - timeline.from;
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
        从请求到响应的全过程；横轴 {formatDuration(span)}，共 {timeline.items.length} 个节点。悬停查看时间与用时。
      </Typography.Text>
      <div className="timeline">
        <div className="timeline-axis">
          <span>0</span>
          <span>{formatDuration(span / 2)}</span>
          <span>{formatDuration(span)}</span>
        </div>
        {timeline.items.map((item) => {
          const left = Math.min(((item.start - timeline.from) / span) * 100, 99.6);
          const width = Math.max(((item.end - item.start) / span) * 100, 0.4);
          return (
            <div className="timeline-row" key={item.key}>
              <div className="timeline-label" title={item.detail}>
                {item.label}
              </div>
              <div className="timeline-track">
                <Tooltip title={item.detail}>
                  {item.kind === 'marker' ? (
                    <span
                      className="timeline-marker"
                      style={{ left: `${left}%`, background: item.color }}
                    />
                  ) : (
                    <span
                      className="timeline-bar"
                      style={{ left: `${left}%`, width: `${width}%`, background: item.color }}
                    />
                  )}
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    </Space>
  );
}
