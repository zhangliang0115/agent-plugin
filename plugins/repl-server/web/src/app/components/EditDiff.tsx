/**
 * Line-level diff for the write-family tools (`09 §五`).
 *
 * `Edit` / `MultiEdit` carry both sides in their args, `Write` / `NotebookEdit`
 * only the new content (every line is an add — honest, not a guess). The args
 * may still be inline (≤ 4 KiB) or externalised behind a ref, so this component
 * reuses the same "preview now, load full" pattern as `PayloadViewer`.
 */
import { Alert, Button, Space, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { VirtualText } from './VirtualText.tsx';
import { fetchPayloadSlice, formatBytes, parseRaw, type PayloadView } from '../../lib/payload-view.ts';
import { diffFromArgs, type ToolDiff } from '../../lib/text-view.ts';

const { Text } = Typography;

export function EditDiff({
  tool,
  view,
  maxHeight = 240,
}: {
  tool: string | null;
  view: PayloadView;
  maxHeight?: number;
}): React.ReactElement | null {
  const [loaded, setLoaded] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const args = loaded ?? view.inline;
  const diff = useMemo(() => diffFromArgs(tool, args), [tool, args]);
  const changes = useMemo(
    () => ({
      del: diff?.lines.filter((line) => line.kind === 'del').length ?? 0,
      add: diff?.lines.filter((line) => line.kind === 'add').length ?? 0,
    }),
    [diff],
  );

  if (diff === null && view.ref !== null) {
    const load = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const slice = await fetchPayloadSlice(view.ref as string, 'full');
        const parsed = parseRaw(slice.body);
        if (!parsed.ok) throw new Error(parsed.error);
        setLoaded(parsed.value);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setLoading(false);
      }
    };
    return (
      <div className="proc-diff">
        <Space size={6} wrap>
          <Text strong>行级 diff</Text>
          <Tag>写入类工具</Tag>
          <Button size="small" loading={loading} onClick={() => void load()}>
            {`加载参数（${formatBytes(view.bytes)}）`}
          </Button>
        </Space>
        {error === null ? null : (
          <Alert type="error" showIcon style={{ marginTop: 6 }} message={`读取失败：${error}`} />
        )}
      </div>
    );
  }

  if (diff === null) return null;

  return (
    <div className="proc-diff">
      <Space size={6} wrap>
        <Text strong>行级 diff</Text>
        <Tag className="mono">{diff.title}</Tag>
        <span className="diff-legend">
          <span className="diff-chip diff-del">{`删 ${String(changes.del)}`}</span>
          <span className="diff-chip diff-add">{`增 ${String(changes.add)}`}</span>
        </span>
        {tool === 'Write' || tool === 'NotebookEdit' ? (
          <Text type="secondary" style={{ fontSize: 11 }}>
            没有记录旧文件，全部按新增展示
          </Text>
        ) : null}
      </Space>
      <VirtualText lines={diff.lines} maxHeight={maxHeight} />
    </div>
  );
}
