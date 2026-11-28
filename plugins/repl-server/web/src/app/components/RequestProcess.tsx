/** Diagnostic view of one request: summary numbers, time composition, waterfall. */
import { Alert, Empty, Spin, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { formatBytes, formatDurationFine, formatPercent } from '../../lib/format.ts';
import { payloadView, rowMedia } from '../../lib/payload-view.ts';
import {
  buildRequestProcess,
  type ProcessComposition,
  type ProcessEventLike,
  type ProcessFrameLike,
  type ProcessRow,
  type ProcessSummary,
  type ProcessToolDetail,
} from '../../lib/request-process.ts';
import { PayloadViewer } from './PayloadViewer.tsx';
import { EditDiff } from './EditDiff.tsx';

const { Text } = Typography;

/** `waitReason` in words; the enum is frozen in `02 §2.4`. */
const WAIT_LABELS: Readonly<Record<string, string>> = {
  'binding-quota': '等配额',
  'server-write-lock': '等写锁',
  'exclusive-gate': '等独占门',
  'keyed-gate': '等资源道',
};

export function RequestProcess({
  request,
  response,
  events,
  loading,
  error,
}: {
  request: ProcessFrameLike | null;
  response: ProcessFrameLike | null;
  events: readonly ProcessEventLike[] | null;
  loading: boolean;
  error: string | null;
}): React.ReactElement {
  const process = useMemo(
    () => buildRequestProcess(request, response, events ?? []),
    [request, response, events],
  );
  // One card at a time: the waterfall stays readable while a step is open.
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Spin only before the first payload arrives; a refresh keeps the previous process mounted.
  if (loading && events === null) return <Spin size="small" />;
  if (error !== null) return <Alert type="error" showIcon message="过程读取失败" description={error} />;
  if (process === null) return <Empty description="本次请求没有可展示的过程数据。" />;

  const { summary, composition, rows, from, to } = process;
  const spanMs = to - from;
  const position = (value: number): number => ((value - from) / spanMs) * 100;

  return (
    <div className="proc">
      {summary.coverage === 'frame' ? (
        <Alert
          type="info"
          showIcon
          message={`本次请求不执行脚本（${process.method ?? '未知方法'}），只有协议往返 ${formatDurationFine(summary.totalMs)}`}
          description={`请求 ${formatBytes(asNumber(request?.['bytes']))} → 响应 ${formatBytes(
            asNumber(response?.['bytes']),
          )}。连接、server/discover、tools/list、search_tools、describe_tools 这类请求没有 eval 事件，因此没有工具调用与脚本耗时可以拆分。`}
        />
      ) : null}

      {summary.coverage === 'exec' ? (
        <div className="proc-stats">
          <Stat
            label="总耗时"
            value={formatDurationFine(summary.totalMs)}
            hint={summary.mode === 'async' ? '异步投递，响应先返回' : '请求 → 响应'}
          />
          <Stat
            label="工具"
            value={formatDurationFine(summary.toolMs)}
            share={shareOf(summary.toolMs, spanMs)}
            hint={`${summary.toolCalls} 次${summary.toolFailures > 0 ? ` · 失败 ${summary.toolFailures}` : ''}${
              summary.toolDenials > 0 ? ` · 拒绝 ${summary.toolDenials}` : ''
            }`}
          />
          <Stat
            label="脚本自身"
            value={formatDurationFine(summary.scriptMs)}
            share={shareOf(summary.scriptMs, spanMs)}
            hint={summary.toolCalls === 0 ? '没有工具调用' : '工具调用之外的运行时间'}
          />
          <Stat
            label="网关"
            value={formatDurationFine(summary.ingressMs + summary.egressMs)}
            share={shareOf(summary.ingressMs + summary.egressMs, spanMs)}
            hint={`入 ${formatDurationFine(summary.ingressMs)} / 出 ${formatDurationFine(summary.egressMs)}`}
          />
          <Stat
            label="最慢一步"
            value={summary.slowest === null ? '—' : formatDurationFine(summary.slowest.ms)}
            share={summary.slowest === null ? null : shareOf(summary.slowest.ms, spanMs)}
            hint={summary.slowest === null ? '没有工具调用' : summary.slowest.label}
          />
          {summary.queueWaits === 0 ? null : (
            <Stat
              label="排队"
              value={formatDurationFine(summary.queueTotalMs)}
              share={shareOf(summary.queueTotalMs, spanMs)}
              hint={`${summary.queueWaits} 次调用 · 等闸门，不是工具慢`}
            />
          )}
        </div>
      ) : null}

      <Composition parts={composition} summary={summary} spanMs={spanMs} />

      <div className="proc-wf">
        <div className="proc-axis">
          <span>阶段</span>
          <span className="proc-ticks">
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
              <span key={fraction}>{fraction === 0 ? '0' : formatDurationFine(spanMs * fraction)}</span>
            ))}
          </span>
          <span className="proc-num">耗时</span>
          <span className="proc-num">占比</span>
        </div>
        {rows.map((row) => (
          <WaterfallRow
            key={row.key}
            row={row}
            position={position}
            open={openKey === row.key}
            onToggle={
              row.detail === undefined
                ? undefined
                : () => {
                    setOpenKey(openKey === row.key ? null : row.key);
                  }
            }
          />
        ))}
      </div>

      <div className="proc-legend">
        <Swatch color="#1677ff" label="网关" />
        <Swatch color="#8b93a3" label="脚本自身" />
        <Swatch color="#13c2c2" label="工具成功" />
        <Swatch color="#ff4d4f" label="工具失败" />
        <Swatch color="#faad14" label="工具被拒绝" />
      </div>

      {summary.notes.length === 0 ? null : (
        <ul className="proc-notes">
          {summary.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  share = null,
  hint,
}: {
  label: string;
  value: string;
  share?: number | null;
  hint: string | null;
}): React.ReactElement {
  return (
    <div className="proc-stat">
      <div className="proc-stat-label">{label}</div>
      <div className="proc-stat-value">
        {value}
        {share === null || share <= 0 ? null : (
          <span className="proc-stat-share">{percentLabel(share)}</span>
        )}
      </div>
      {hint === null ? null : <div className="proc-stat-hint">{hint}</div>}
    </div>
  );
}

function shareOf(part: number, whole: number): number {
  return whole > 0 ? Math.min(1, part / whole) : 0;
}

/** Small shares keep one decimal, otherwise `1.4%` would read as `1%` and `0.8%` as `0%`. */
function percentLabel(part: number): string {
  return formatPercent(part, part > 0 && part < 0.1 ? 1 : 0);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Stacked bar: the first answer to "where did the time go". */
function Composition({
  parts,
  summary,
  spanMs,
}: {
  parts: readonly ProcessComposition[];
  summary: ProcessSummary;
  spanMs: number;
}): React.ReactElement | null {
  if (parts.length === 0 || spanMs <= 0) return null;
  return (
    <div className="proc-compose-wrap">
      <div className="proc-compose-head">
        <Text type="secondary" style={{ fontSize: 11.5 }}>
          耗时构成，分母为过程跨度 {formatDurationFine(spanMs)}
          {summary.totalMs !== spanMs ? `（响应耗时 ${formatDurationFine(summary.totalMs)}）` : ''}
        </Text>
      </div>
      <div className="proc-compose">
        {parts.map((part) => (
          <span
            key={part.key}
            className={`proc-compose-seg proc-seg-${part.key}`}
            style={{ width: `${Math.max(part.share * 100, 0.4)}%` }}
            title={`${part.label} ${formatDurationFine(part.ms)} · ${formatPercent(part.share, 1)}`}
          />
        ))}
      </div>
      <div className="proc-compose-legend">
        {parts.map((part) => (
          <span key={part.key}>
            <span className={`proc-dot proc-seg-${part.key}`} />
            {part.label} {formatDurationFine(part.ms)}（{percentLabel(part.share)}）
          </span>
        ))}
      </div>
    </div>
  );
}

function WaterfallRow({
  row,
  position,
  open,
  onToggle,
}: {
  row: ProcessRow;
  position: (value: number) => number;
  open: boolean;
  onToggle: (() => void) | undefined;
}): React.ReactElement {
  const marker = row.start === row.end || row.durMs === 0;
  const left = marker ? Math.min(Math.max(position(row.start), 0), 100) : Math.min(Math.max(position(row.start), 0), 99.6);
  const width = marker ? 0 : Math.max(position(row.end) - position(row.start), 0.4);
  // The wait is drawn as a thin band so "queued" never reads as "slow tool".
  const startedAt = row.detail?.startedAt ?? null;
  const queued =
    startedAt !== null && startedAt > row.start && position(startedAt) > left
      ? { left, width: position(startedAt) - left }
      : null;
  const clickable = onToggle !== undefined;
  return (
    <div className={`proc-item${open ? ' proc-item--open' : ''}`}>
      <div
        className={`proc-row proc-row--${row.kind} proc-tone-${row.tone}${clickable ? ' proc-row--clickable' : ''}${open ? ' proc-row--open' : ''}`}
        onClick={onToggle}
        onKeyDown={
          clickable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-expanded={clickable ? open : undefined}
      >
        <div
          className="proc-label"
          style={{ paddingLeft: row.indent === 0 ? 0 : 20 }}
          title={row.title}
        >
          {clickable ? <span className="proc-caret">{open ? '▾' : '▸'}</span> : null}
          <span className="proc-label-text">{row.label}</span>
          {row.hint === null ? null : <span className="proc-hint">{row.hint}</span>}
        </div>
        <div className="proc-track">
          {queued === null ? null : (
            <span className="wf-queue" style={{ left: `${queued.left}%`, width: `${Math.max(queued.width, 0.15)}%` }} />
          )}
          {marker ? (
            <span
              className="wf-mark"
              style={{ left: `${left}%`, ...(left >= 100 ? { transform: 'translateX(-100%)' } : {}) }}
            />
          ) : (
            <span
              className={`wf-bar${row.detail?.open === true ? ' wf-bar--open' : ''}`}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          )}
        </div>
        <div className="proc-num mono">{row.durMs > 0 ? formatDurationFine(row.durMs) : '—'}</div>
        <div className="proc-num proc-share">
          {row.durMs > 0 ? formatPercent(row.share, 1) : '—'}
        </div>
      </div>
      {open && row.detail !== undefined ? <StepCard detail={row.detail} /> : null}
    </div>
  );
}

/** Step card: what this call sent, what it got back, and what the gate did. */
function StepCard({ detail }: { detail: ProcessToolDetail }): React.ReactElement {
  const input = payloadView(detail.call ?? {}, 'args');
  const output = payloadView(detail.result ?? {}, 'result');
  const tool = typeof detail.call?.['tool'] === 'string' ? detail.call['tool'] : null;
  const diffTool = tool !== null && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool) ? tool : null;
  return (
    <div className="proc-detail">
      <div className="proc-detail-meta">
        {detail.mode === null ? null : <Tag>{detail.mode}</Tag>}
        {detail.waitReason === null ? null : (
          <Tag color="orange">
            {`排队 ${formatDurationFine(detail.queueMs ?? 0)} · ${WAIT_LABELS[detail.waitReason] ?? detail.waitReason}`}
          </Tag>
        )}
        {detail.execMs === null ? null : <Tag>{`执行 ${formatDurationFine(detail.execMs)}`}</Tag>}
        {detail.errorCode === null ? null : <Tag color="red">{detail.errorCode}</Tag>}
        {detail.open ? <Tag color="processing">尚未返回</Tag> : null}
      </div>
      {diffTool === null ? null : <EditDiff tool={diffTool} view={input} maxHeight={220} />}
      <div className="proc-detail-io">
        <div className="proc-detail-col">
          <PayloadViewer label="输入" view={input} maxHeight={200} />
        </div>
        <div className="proc-detail-col">
          {detail.result === null ? (
            <>
              <Text strong>输出</Text>
              <div>
                <Text type="secondary">还没有返回。</Text>
              </div>
            </>
          ) : (
            <PayloadViewer label="输出" view={output} maxHeight={200} media={rowMedia(detail.result)} />
          )}
        </div>
      </div>
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }): React.ReactElement {
  return (
    <span className="proc-swatch">
      <span className="proc-swatch-dot" style={{ background: color }} />
      {label}
    </span>
  );
}
