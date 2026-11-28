/**
 * Input/output body viewer for audit rows.
 *
 * Three states, in the order a reader needs them (`09 §五`):
 * 1. inline (≤ 4 KiB) — rendered immediately, no request;
 * 2. preview — shown at once, with a "加载全文" button that fetches the blob;
 * 3. dropped — the row says why the body is gone, and nothing is fetched.
 *
 * The fetched body is offered both ways on purpose: the structured tree for
 * reading, the raw text for copying or diffing against what the tool actually
 * printed (user ask: "结构化解析和原始内容都要能看").
 *
 * Bodies over `RENDER_MAX_BYTES` (5 MB) are never handed to the DOM: they are
 * download-only, and raw text goes through a windowed renderer with search
 * highlighting (`VirtualText`) once it is long enough to matter.
 */
import { Alert, Button, Input, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { JsonView } from './JsonView.tsx';
import { MediaStrip } from './MediaStrip.tsx';
import { VirtualText } from './VirtualText.tsx';
import {
  downloadSlice,
  fetchPayloadSlice,
  extractMedia,
  formatBytes,
  hasMedia,
  parseRaw,
  payloadSummary,
  type MediaSet,
  type PayloadSlice,
  type PayloadView,
} from '../../lib/payload-view.ts';
import {
  matchLineIndices,
  RENDER_MAX_BYTES,
  shouldAutoLoad,
  shouldRenderBody,
  textLines,
} from '../../lib/text-view.ts';

const { Text } = Typography;

type RawMode = 'parsed' | 'raw';
/** Above this many lines the raw pane switches to the windowed renderer. */
const VIRTUAL_MIN_LINES = 300;

function ParsedBody({
  value,
  maxHeight,
  showMedia,
}: {
  value: unknown;
  maxHeight: number | string;
  /** False when the row's own `media` already drew the thumbnails. */
  showMedia: boolean;
}): React.ReactElement {
  const media = useMemo(() => extractMedia(value), [value]);
  return (
    <>
      {showMedia ? <MediaStrip media={media} /> : null}
      <JsonView value={media.rest} maxHeight={maxHeight} />
    </>
  );
}

export function PayloadViewer({
  label,
  view,
  maxHeight = 260,
  media,
}: {
  label: string;
  view: PayloadView;
  maxHeight?: number | string;
  /** From the row's `media` field (`rowMedia`): shown at once, without loading the body. */
  media?: MediaSet;
}): React.ReactElement {
  const rowHasMedia = media !== undefined && hasMedia(media);
  const [loaded, setLoaded] = useState<PayloadSlice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RawMode>('parsed');
  const [search, setSearch] = useState('');

  const load = async (part: 'full' | 'head' | 'tail'): Promise<void> => {
    const ref = part === 'tail' ? view.tailRef : view.ref;
    if (ref === null) return;
    setLoading(true);
    setError(null);
    try {
      setLoaded(await fetchPayloadSlice(ref, part));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };

  const download = async (part: 'full' | 'head' | 'tail'): Promise<void> => {
    const ref = part === 'tail' ? view.tailRef : view.ref;
    if (ref === null) return;
    setLoading(true);
    setError(null);
    try {
      downloadSlice(await fetchPayloadSlice(ref, part));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };

  // Bodies up to AUTO_LOAD_BYTES need no click; `truncated` ones keep the manual choice.
  const autoLoad = view.ref !== null && view.dropped === null && !view.truncated && shouldAutoLoad(view.bytes);
  useEffect(() => {
    if (autoLoad) void load('full');
    // Reload only when the viewer is pointed at another body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.ref, autoLoad]);

  const header = (
    <>
      <Space size={6} wrap>
        <Text strong>{label}</Text>
        <Tag>{payloadSummary(view)}</Tag>
        {view.sha256 === null ? null : (
          <Text type="secondary" className="mono" style={{ fontSize: 11 }}>
            {view.sha256.slice(0, 12)}
          </Text>
        )}
      </Space>
      {rowHasMedia ? <MediaStrip media={media} /> : null}
    </>
  );

  if (view.dropped !== null) {
    return (
      <div>
        {header}
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 6 }}
          message={payloadSummary(view)}
          description="这一行的索引还在，但正文没写成功；重试或换一次请求才能看到内容。"
        />
        {view.preview === null ? null : (
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight, overflow: 'auto' }}>
            {view.preview}
          </pre>
        )}
      </div>
    );
  }

  if (view.ref === null) {
    return (
      <div>
        {header}
        {view.inline === undefined ? (
          <Text type="secondary">—</Text>
        ) : (
          <JsonView value={view.inline} maxHeight={maxHeight} />
        )}
      </div>
    );
  }

  // Bodies over the render cap: download-only, no DOM handoff.
  if (!shouldRenderBody(view.bytes)) {
    return (
      <div>
        {header}
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 6 }}
          message={`正文 ${formatBytes(view.bytes)} 超过 ${formatBytes(RENDER_MAX_BYTES)}，浏览器渲染会卡死，只提供下载。`}
        />
        <Space size={6} style={{ marginTop: 6 }} wrap>
          {view.truncated ? (
            <>
              <Button size="small" loading={loading} onClick={() => void download('head')}>
                下载首段（1 MB）
              </Button>
              {view.tailRef === null ? null : (
                <Button size="small" loading={loading} onClick={() => void download('tail')}>
                  下载末段（1 MB）
                </Button>
              )}
              <Text type="secondary" style={{ fontSize: 11 }}>
                超过硬顶只存了首尾，中段没有落盘
              </Text>
            </>
          ) : (
            <Button size="small" loading={loading} onClick={() => void download('full')}>
              {`下载全文（${formatBytes(view.bytes)}）`}
            </Button>
          )}
        </Space>
        {error === null ? null : (
          <Alert type="error" showIcon style={{ marginTop: 6 }} message={`下载失败：${error}`} />
        )}
        {view.preview === null ? null : (
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 120, overflow: 'auto' }}>
            {view.preview}
          </pre>
        )}
      </div>
    );
  }

  const previewText = loaded?.body ?? view.preview ?? '';
  const bodyOversized = loaded !== null && !shouldRenderBody(loaded.body.length);
  const parsed = mode === 'raw' ? null : parseRaw(previewText);
  const rawLines = useMemo(() => textLines(previewText), [previewText]);
  const virtual = rawLines.length > VIRTUAL_MIN_LINES;
  const matches = useMemo(() => matchLineIndices(rawLines, search).length, [rawLines, search]);
  const viewportMax = typeof maxHeight === 'number' ? maxHeight : 320;

  return (
    <div>
      {header}
      <Space size={6} style={{ marginTop: 6 }} wrap>
        <Button size="small" loading={loading} onClick={() => void load('full')}>
          {loaded === null ? `加载全文（${formatBytes(view.bytes)}）` : '重新加载'}
        </Button>
        {view.truncated ? (
          <>
            <Button size="small" disabled={view.ref === null} loading={loading} onClick={() => void load('head')}>
              仅首段
            </Button>
            <Button size="small" disabled={view.tailRef === null} loading={loading} onClick={() => void load('tail')}>
              仅末段
            </Button>
          </>
        ) : null}
        <Segmented<RawMode>
          size="small"
          value={mode}
          onChange={(value) => {
            setMode(value);
          }}
          options={[
            { label: '结构化', value: 'parsed' },
            { label: '原始报文', value: 'raw' },
          ]}
        />
        {loaded === null ? null : (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {`${formatBytes(loaded.body.length)} / ${formatBytes(loaded.total)}`}
            {loaded.truncated ? '（已截断）' : ''}
          </Text>
        )}
      </Space>
      {error === null ? null : (
        <Alert type="error" showIcon style={{ marginTop: 6 }} message={`读取失败：${error}`} />
      )}
      {loading && loaded === null ? (
        <div style={{ marginTop: 8, textAlign: 'center' }}>
          <Spin size="small" />
        </div>
      ) : null}
      {bodyOversized ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 6 }}
          message={`正文 ${formatBytes(loaded?.body.length ?? null)} 超过渲染上限，不在页面里显示。`}
          action={
            <Button size="small" loading={loading} onClick={() => void download('full')}>
              下载
            </Button>
          }
        />
      ) : parsed !== null && parsed.ok ? (
        <ParsedBody value={parsed.value} maxHeight={maxHeight} showMedia={!rowHasMedia} />
      ) : (
        <>
          {parsed !== null && !parsed.ok && loaded !== null ? (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 6 }}
              message={`正文不是完整 JSON（${parsed.error}），按原文展示`}
            />
          ) : null}
          {virtual ? (
            <>
              <div className="vtext-bar">
                <Input
                  size="small"
                  allowClear
                  placeholder="搜索高亮…"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                  }}
                />
                {search === '' ? null : (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {`${String(matches)} 行命中`}
                  </Text>
                )}
              </div>
              <VirtualText lines={rawLines} maxHeight={viewportMax} search={search} />
            </>
          ) : (
            <pre
              className="mono"
              style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight, overflow: 'auto' }}
            >
              {previewText === '' ? '—' : previewText}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
