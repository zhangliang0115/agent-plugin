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
 */
import { Alert, Button, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { useState } from 'react';

import { JsonView } from './JsonView.tsx';
import {
  formatBytes,
  parseRaw,
  payloadSummary,
  payloadUrl,
  type PayloadSlice,
  type PayloadView,
} from '../../lib/payload-view.ts';

const { Text } = Typography;

type RawMode = 'parsed' | 'raw';

async function fetchSlice(ref: string, mode: 'full' | 'head' | 'tail'): Promise<PayloadSlice> {
  const response = await fetch(payloadUrl(ref, { mode }), {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  return (await response.json()) as PayloadSlice;
}

export function PayloadViewer({
  label,
  view,
  maxHeight = 260,
}: {
  label: string;
  view: PayloadView;
  maxHeight?: number | string;
}): React.ReactElement {
  const [loaded, setLoaded] = useState<PayloadSlice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RawMode>('parsed');

  const load = async (part: 'full' | 'head' | 'tail'): Promise<void> => {
    const ref = part === 'tail' ? view.tailRef : view.ref;
    if (ref === null) return;
    setLoading(true);
    setError(null);
    try {
      setLoaded(await fetchSlice(ref, part));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };

  const header = (
    <Space size={6} wrap>
      <Text strong>{label}</Text>
      <Tag>{payloadSummary(view)}</Tag>
      {view.sha256 === null ? null : (
        <Text type="secondary" className="mono" style={{ fontSize: 11 }}>
          {view.sha256.slice(0, 12)}
        </Text>
      )}
    </Space>
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

  const previewText = loaded?.body ?? view.preview ?? '';
  const parsed = mode === 'raw' ? null : parseRaw(previewText);

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
      {parsed !== null && parsed.ok ? (
        <JsonView value={parsed.value} maxHeight={maxHeight} />
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
          <pre
            className="mono"
            style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight, overflow: 'auto' }}
          >
            {previewText === '' ? '—' : previewText}
          </pre>
        </>
      )}
    </div>
  );
}
