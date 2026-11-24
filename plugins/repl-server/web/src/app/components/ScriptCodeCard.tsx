/**
 * The `run_script` source code of one `tools/call` request, shown as its own block.
 *
 * Inline params are rendered at once; params over 4 KiB are externalised and
 * only carry a 2 KiB preview, so the card checks that preview names `run_script`
 * before offering to load the blob. A preview without the name renders nothing.
 */
import { Alert, Button, Card, Space, Typography } from 'antd';
import { useState } from 'react';

import type { FrameEvent } from './FramePayload.tsx';
import {
  fetchPayloadSlice,
  formatBytes,
  parseRaw,
  payloadView,
} from '../../lib/payload-view.ts';
import {
  isRunScriptParamsPreview,
  scriptCodeFromParams,
  scriptCodeFromRequest,
} from '../../lib/script-info.ts';
import { shouldRenderBody } from '../../lib/text-view.ts';

const { Text } = Typography;

export function ScriptCodeCard({
  request,
  method,
}: {
  request: FrameEvent | null | undefined;
  method?: string | null;
}): React.ReactElement | null {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (method !== 'tools/call' || request === null || request === undefined) return null;
  if (hidden) return null;
  const view = payloadView(request, 'params', 'frame');
  const inline = scriptCodeFromRequest(request);
  if (inline === null) {
    if (view.ref === null) return null;
    // Externalised params have no tool name in the row; the preview is the signal.
    if (!isRunScriptParamsPreview(view.preview)) return null;
  }
  const code = inline ?? loaded;
  // A body split at 50 MiB keeps only head/tail shards; `full` on the head ref
  // cannot parse, so the card must not offer to load it.
  const split = inline === null && view.truncated;
  const oversized = code !== null && !shouldRenderBody(view.bytes);

  const load = async (): Promise<void> => {
    if (view.ref === null) return;
    setLoading(true);
    setError(null);
    try {
      const parsed = parseRaw((await fetchPayloadSlice(view.ref, 'full')).body);
      if (!parsed.ok) {
        setError(`正文不是完整 JSON：${parsed.error}`);
        return;
      }
      const found = scriptCodeFromParams(parsed.value);
      if (found === null) {
        // run_script addressed by scriptId/args: there is no code to show.
        setHidden(true);
        return;
      }
      setLoaded(found);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card
      size="small"
      title="代码"
      extra={
        code === null ? null : (
          <Text
            type="secondary"
            copyable={{ text: code, tooltips: ['复制代码', '已复制'] }}
            style={{ fontSize: 11.5 }}
          >
            复制
          </Text>
        )
      }
    >
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        {split ? (
          <Alert
            type="warning"
            showIcon
            message={`正文已分段保存（全文 ${formatBytes(view.bytes)}）`}
            description="超过 50 MiB 的正文只保留首尾各 1 MiB，页面无法加载完整代码。"
          />
        ) : code === null ? (
          <Space size={6} wrap>
            <Button size="small" loading={loading} onClick={() => void load()}>
              {`加载代码（${formatBytes(view.bytes)}）`}
            </Button>
            <Text type="secondary" style={{ fontSize: 11.5 }}>
              params 已外置，按需读取。
            </Text>
          </Space>
        ) : oversized ? (
          <Alert
            type="info"
            showIcon
            message={`代码过大（${formatBytes(view.bytes)}），不展开显示`}
            description="超过渲染上限，不生成行号；用右上角「复制」取出完整代码。"
          />
        ) : (
          <div className="script-code-scroll">
            <div className="script-code-inner">
              <div className="script-code-gutter" aria-hidden="true">
                {code.split('\n').map((_line, index) => (
                  <div key={index}>{index + 1}</div>
                ))}
              </div>
              <pre className="code-block script-code-pre">{code}</pre>
            </div>
          </div>
        )}
        {error === null ? null : (
          <Alert type="error" showIcon message="代码读取失败" description={error} />
        )}
      </Space>
    </Card>
  );
}
