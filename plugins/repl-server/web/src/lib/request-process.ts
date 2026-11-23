/** Analysis of one request's process: where the time went and why. @module
 *
 * The waterfall has three kinds of span that the raw audit events do not label:
 * ingress (request → `eval_start`), egress (`eval_end` → response) and the
 * script's own time (the gaps between tool calls). Splitting them out is what
 * turns the view from "a few bars" into an answer to "what was slow".
 */

import { formatBytes, formatDurationFine, formatPercent, formatTimestamp } from './format.ts';

export interface ProcessFrameLike {
  ts?: unknown;
  method?: unknown;
  ok?: unknown;
  bytes?: unknown;
  [key: string]: unknown;
}

export interface ProcessEventLike {
  ts?: unknown;
  event?: unknown;
  [key: string]: unknown;
}

export type ProcessTone = 'info' | 'ok' | 'error' | 'warn' | 'neutral';

export type ProcessRowKind = 'request' | 'response' | 'gateway' | 'eval' | 'tool' | 'script' | 'denied';

/**
 * Everything the step card needs for one tool row. The raw events are kept so
 * the card can hand them to `payloadView`, which already knows how to render an
 * inline value, a ref plus preview, or a truncated head/tail pair.
 */
export interface ProcessToolDetail {
  call: ProcessEventLike | null;
  result: ProcessEventLike | null;
  argsBytes: number | null;
  resultBytes: number | null;
  mode: string | null;
  /** Only set when the call actually queued; see `02 §2.4`. */
  waitReason: string | null;
  queueMs: number | null;
  execMs: number | null;
  errorCode: string | null;
  /** Set when the call queued, so the waterfall can draw the wait separately. */
  startedAt: number | null;
  /** No result yet: the eval is still running or the call was cut off. */
  open: boolean;
}

export interface ProcessRow {
  key: string;
  kind: ProcessRowKind;
  label: string;
  /** Secondary text after the label: tool arguments, mode, error code. */
  hint: string | null;
  /** Full text for the hover title. */
  title: string;
  start: number;
  end: number;
  durMs: number;
  /** Nesting level inside the eval group. */
  indent: 0 | 1;
  tone: ProcessTone;
  /** Share of the whole span, `0..1`. */
  share: number;
  order: number;
  /** Tool rows only: the clickable step card behind this bar. */
  detail?: ProcessToolDetail;
}

export interface ProcessComposition {
  key: 'ingress' | 'script' | 'tool' | 'egress';
  label: string;
  ms: number;
  share: number;
}

export interface ProcessSummary {
  /** Client-visible latency when both frames exist, else the whole span. */
  totalMs: number;
  /** Axis length; longer than `totalMs` for async evals that end after the response. */
  spanMs: number;
  ingressMs: number;
  egressMs: number;
  execMs: number;
  toolMs: number;
  /** Sum of tool durations; exceeds `toolMs` when calls overlap. */
  toolSumMs: number;
  scriptMs: number;
  toolCalls: number;
  toolFailures: number;
  toolDenials: number;
  /** Tool calls with no result yet (still running, or the record was cut off). */
  openCalls: number;
  /** Calls that actually queued on a gate, and the time they spent there. */
  queueWaits: number;
  queueTotalMs: number;
  slowest: { label: string; ms: number } | null;
  mode: 'sync' | 'async' | null;
  outcome: string | null;
  ok: boolean | null;
  error: string | null;
  codeBytes: number | null;
  resultBytes: number | null;
  /** One-line conclusions, ordered by importance. */
  notes: string[];
  /** `exec` when the eval events are present, `frame` for a bare protocol pair. */
  coverage: 'exec' | 'frame';
}

export interface RequestProcess {
  from: number;
  to: number;
  method: string | null;
  summary: ProcessSummary;
  composition: ProcessComposition[];
  rows: ProcessRow[];
}

/** Parses an ISO timestamp; `null` when the value cannot be placed on the axis. */
export function processTime(ts: unknown): number | null {
  if (typeof ts !== 'string' || ts === '') return null;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function errorText(event: ProcessEventLike): string | null {
  const error = event['error'];
  if (typeof error === 'string' && error !== '') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return null;
}

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  ok: '成功',
  error: '脚本报错',
  timeout: '超时',
  cancelled: '已取消',
  worker_dead: '工作进程退出',
};

const LAYER_LABELS: Readonly<Record<string, string>> = {
  sync: '同步上限',
  tool: '单次工具上限',
  soft: '软上限',
  wall: '墙钟上限',
  budget: '调用预算',
  output: '输出上限',
};

/** One paired tool call: `tool_call` + its `tool_result`, or a `tool_denied`. */
interface ToolRecord {
  key: string;
  call: ProcessEventLike | null;
  result: ProcessEventLike | null;
  denied: ProcessEventLike | null;
}

/**
 * Pairs call/result events by `evalId:seq`; a result without a sequence falls
 * back to the oldest open call of the same tool, which keeps pre-seq records usable.
 */
function pairTools(events: readonly ProcessEventLike[]): ToolRecord[] {
  const byKey = new Map<string, ToolRecord>();
  const records: ToolRecord[] = [];
  for (const event of events) {
    const name = str(event['event']);
    if (name !== 'tool_call' && name !== 'tool_result' && name !== 'tool_denied') continue;
    const evalKey = str(event['evalId']) ?? str(event['runId']) ?? '';
    const seq = num(event['seq']);
    let record: ToolRecord | undefined;
    if (seq !== null) {
      const key = `${evalKey}|${seq}`;
      record = byKey.get(key);
      if (record === undefined) {
        record = { key, call: null, result: null, denied: null };
        byKey.set(key, record);
        records.push(record);
      }
    } else if (name === 'tool_result' || name === 'tool_denied') {
      const tool = str(event['tool']);
      record = records.find(
        (candidate) =>
          candidate.call !== null
          && candidate.result === null
          && candidate.denied === null
          && (tool === null || str(candidate.call['tool']) === tool),
      );
    }
    if (record === undefined) {
      record = { key: `${evalKey}|#${records.length}`, call: null, result: null, denied: null };
      records.push(record);
    }
    if (name === 'tool_call') record.call = event;
    else if (name === 'tool_result') record.result = event;
    else record.denied = event;
  }
  return records;
}

function toolStart(record: ToolRecord): number | null {
  const call = record.call ?? record.denied;
  if (call !== null) {
    const direct = num(call['queuedAt']) ?? num(call['startedAt']) ?? processTime(call['ts']);
    if (direct !== null) return direct;
  }
  return null;
}

function toolEnd(record: ToolRecord): number | null {
  const result = record.result ?? record.denied;
  if (result === null) return null;
  return num(result['endedAt']) ?? processTime(result['ts']);
}

function toolDuration(record: ToolRecord): number {
  const raw = num(record.result?.['ms']) ?? num(record.result?.['durMs']);
  if (raw !== null) return raw;
  const start = toolStart(record);
  const end = toolEnd(record);
  return start !== null && end !== null ? Math.max(0, end - start) : 0;
}

/** Merges overlapping intervals so parallel calls do not double-count wall time. */
export function mergeIntervals(intervals: ReadonlyArray<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...intervals]
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }
  return merged;
}

/** Parts of `span` not covered by any interval, in order. */
export function gapsWithin(
  span: { start: number; end: number },
  intervals: ReadonlyArray<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const merged = mergeIntervals(intervals);
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = span.start;
  for (const block of merged) {
    if (block.start > cursor) gaps.push({ start: cursor, end: Math.min(block.start, span.end) });
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < span.end) gaps.push({ start: cursor, end: span.end });
  return gaps.filter((gap) => gap.end > gap.start);
}

/**
 * One-line description of a tool call from the whitelisted audit summary, so the
 * row says what actually ran (`Bash pnpm test`) instead of only the tool name.
 */
export function describeToolArgs(args: unknown): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const fields = args as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return null;
  };
  if (fields['truncated'] === true) return `参数过大（${formatBytes(num(fields['bytes']))}）`;
  const primary = pick('command', 'file_path', 'path', 'pattern', 'query', 'url', 'name');
  if (primary !== null) return clip(primary.replace(/\s+/gu, ' '), 96);
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    pairs.push(`${key}=${String(value)}`);
    if (pairs.length === 2) break;
  }
  if (pairs.length === 0) return null;
  return clip(pairs.join(' · '), 96);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function share(part: number, whole: number): number {
  return whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
}

/**
 * Full process of one request: summary numbers, composition and waterfall rows.
 * Returns `null` only when there is no timestamp to anchor anything on.
 */
export function buildRequestProcess(
  request: ProcessFrameLike | null,
  response: ProcessFrameLike | null,
  events: readonly ProcessEventLike[],
): RequestProcess | null {
  const requestTs = processTime(request?.ts);
  const responseTs = processTime(response?.ts);
  const method = str(request?.method);

  const ordered = [...events].sort((left, right) => (processTime(left.ts) ?? 0) - (processTime(right.ts) ?? 0));
  const start = ordered.find((event) => str(event['event']) === 'eval_start') ?? null;
  const end = ordered.find((event) => str(event['event']) === 'eval_end') ?? null;
  const evalStartTs = processTime(start?.ts);
  const evalEndTs = processTime(end?.ts);

  const tools = pairTools(ordered);
  /** A call with no result is drawn up to the last event we saw, marked open. */
  const lastSeenTs = ordered.reduce<number | null>((max, event) => {
    const ts = processTime(event.ts);
    if (ts === null) return max;
    return max === null ? ts : Math.max(max, ts);
  }, null);
  const toolSpans: Array<{ start: number; end: number }> = [];
  const toolRows: ProcessRow[] = [];
  const failures: string[] = [];
  const denials: string[] = [];
  let openCalls = 0;
  let queueWaits = 0;
  let queueTotalMs = 0;
  let toolSumMs = 0;
  let slowest: { label: string; ms: number } | null = null;
  let order = 0;

  for (const record of tools) {
    const source = record.call ?? record.result ?? record.denied;
    const tool = str(source?.['tool']) ?? '未知工具';
    const seq = num(source?.['seq']);
    const badge = seq === null ? tool : `#${seq} ${tool}`;
    const isDenied = record.denied !== null;
    const failed = isDenied || record.result?.['ok'] === false;
    const args = describeToolArgs(record.call?.['args']);
    const errorCode = str(record.result?.['errorCode']) ?? str(record.denied?.['reason']);
    const error = errorText(record.result ?? record.denied ?? {});
    const server = str(record.call?.['server']);

    const begin = toolStart(record) ?? (record.denied === null ? null : processTime(record.denied.ts));
    if (begin === null) continue;
    const closed = toolEnd(record);
    // Unfinished calls still deserve a row: the reader wants to see that the
    // script is stuck in a tool, not that the tool vanished from the chart.
    const open = closed === null && !isDenied;
    const finish = closed ?? Math.max(begin, lastSeenTs ?? begin);
    const duration = closed === null ? Math.max(0, finish - begin) : toolDuration(record);
    if (open) openCalls += 1;

    const argsBytes = num(record.call?.['argsBytes']);
    const resultBytes = num(record.result?.['outBytes']);
    const queueMs = num(record.result?.['queueMs']);
    const startedAt = num(record.result?.['startedAt']);
    const waitReason = str(record.result?.['waitReason']);
    if ((queueMs ?? 0) >= 1) {
      queueWaits += 1;
      queueTotalMs += queueMs ?? 0;
    }
    const io =
      argsBytes === null && resultBytes === null
        ? null
        : `入 ${formatBytes(argsBytes)} / 出 ${open ? '…' : formatBytes(resultBytes)}`;

    // The error code leads a failed row: it survives truncation, the arguments follow it.
    const cause = isDenied
      ? errorCode === null
        ? '被拒绝'
        : `被拒绝 · ${errorCode}`
      : failed && errorCode !== null
        ? args === null
          ? errorCode
          : `${errorCode} · ${args}`
        : args;
    const hint = [cause, open ? '尚未返回' : null, io].filter((part) => part !== null && part !== '').join(' · ') || null;

    toolRows.push({
      key: `tool-${record.key}`,
      kind: isDenied ? 'denied' : 'tool',
      label: badge,
      hint,
      title: [
        badge,
        server,
        args,
        errorCode,
        error,
        waitReason === null ? null : `排队 ${formatDurationFine(queueMs ?? 0)}（${waitReason}）`,
        `用时 ${formatDurationFine(duration)}`,
        open ? '尚未返回（执行中或被截断）' : null,
        formatTimestamp(begin),
      ]
        .filter((part) => part !== null && part !== '')
        .join(' · '),
      start: begin,
      end: finish,
      durMs: duration,
      indent: 1,
      tone: isDenied ? 'warn' : failed ? 'error' : open ? 'neutral' : 'ok',
      share: 0,
      order: order++,
      detail: {
        call: record.call,
        result: record.result,
        argsBytes,
        resultBytes,
        mode: str(record.call?.['mode']),
        waitReason,
        queueMs,
        execMs: num(record.result?.['durMs']),
        errorCode,
        startedAt,
        open,
      },
    });
    toolSpans.push({ start: begin, end: finish });
    toolSumMs += duration;
    if (failed) {
      const name = errorCode === null ? tool : `${tool}（${errorCode}）`;
      if (isDenied) denials.push(name);
      else failures.push(name);
    }
    if (!isDenied && !open && (slowest === null || duration > slowest.ms)) {
      slowest = { label: args === null ? badge : `${badge} ${args}`, ms: duration };
    }
  }

  const ingress =
    requestTs !== null && evalStartTs !== null && evalStartTs > requestTs
      ? { start: requestTs, end: evalStartTs }
      : null;
  const egress =
    responseTs !== null && evalEndTs !== null && responseTs > evalEndTs
      ? { start: evalEndTs, end: responseTs }
      : null;

  const execSpan =
    evalStartTs === null
      ? null
      : { start: evalStartTs, end: evalEndTs ?? Math.max(...[responseTs ?? evalStartTs, ...toolSpans.map((span) => span.end)]) };

  const scriptGaps = execSpan === null ? [] : gapsWithin(execSpan, toolSpans);
  const scriptMs = scriptGaps.reduce((total, gap) => total + (gap.end - gap.start), 0);
  const toolMs = mergeIntervals(toolSpans).reduce((total, span) => total + (span.end - span.start), 0);

  const candidates = [
    requestTs,
    responseTs,
    evalStartTs,
    evalEndTs,
    ...toolSpans.map((span) => span.start),
    ...toolSpans.map((span) => span.end),
  ].filter((value): value is number => value !== null);
  if (candidates.length === 0) return null;
  const from = Math.min(...candidates);
  const to = Math.max(...candidates);
  const spanMs = to > from ? to - from : 1;
  const totalMs = requestTs !== null && responseTs !== null && responseTs >= requestTs ? responseTs - requestTs : spanMs;

  const rows: ProcessRow[] = [];
  let rowOrder = 0;
  if (requestTs !== null) {
    rows.push({
      key: 'request',
      kind: 'request',
      label: '请求进入',
      hint: formatBytes(num(request?.['bytes'])),
      title: `${method ?? '请求'} · ${formatTimestamp(requestTs)} · ${formatBytes(num(request?.['bytes']))}`,
      start: requestTs,
      end: requestTs,
      durMs: 0,
      indent: 0,
      tone: 'info',
      share: 0,
      order: rowOrder++,
    });
  }
  if (ingress !== null) {
    rows.push({
      key: 'ingress',
      kind: 'gateway',
      label: '网关 · 入站解析',
      hint: '请求 → 执行开始',
      title: `请求帧到 eval_start：${formatDurationFine(ingress.end - ingress.start)}`,
      start: ingress.start,
      end: ingress.end,
      durMs: ingress.end - ingress.start,
      indent: 0,
      tone: 'info',
      share: share(ingress.end - ingress.start, spanMs),
      order: rowOrder++,
    });
  }
  if (execSpan !== null) {
    const outcome = str(end?.['outcome']);
    rows.push({
      key: 'eval',
      kind: 'eval',
      label: '脚本执行',
      hint: [
        num(start?.['evalId']) === null ? null : `#${String(start?.['evalId'])}`,
        str(start?.['mode']),
        num(start?.['codeBytes']) === null ? null : formatBytes(num(start?.['codeBytes'])),
      ]
        .filter((part) => part !== null)
        .join(' · '),
      title: [str(start?.['codePrefix']), `执行 ${formatDurationFine(execSpan.end - execSpan.start)}`]
        .filter((part) => part !== null)
        .join('\n'),
      start: execSpan.start,
      end: execSpan.end,
      durMs: execSpan.end - execSpan.start,
      indent: 0,
      tone: end === null ? 'neutral' : end['ok'] === false ? 'error' : 'ok',
      share: share(execSpan.end - execSpan.start, spanMs),
      order: rowOrder++,
    });
  }

  const firstToolStart = toolSpans.length === 0 ? null : Math.min(...toolSpans.map((span) => span.start));
  const lastToolEnd = toolSpans.length === 0 ? null : Math.max(...toolSpans.map((span) => span.end));
  for (const gap of scriptGaps) {
    const durMs = gap.end - gap.start;
    if (durMs < 1) continue;
    const phase =
      firstToolStart === null
        ? '脚本自身'
        : gap.end <= firstToolStart
          ? '脚本 · 准备'
          : lastToolEnd !== null && gap.start >= lastToolEnd
            ? '脚本 · 收尾'
            : '脚本 · 决策/组装';
    rows.push({
      key: `script-${gap.start}-${gap.end}`,
      kind: 'script',
      label: phase,
      hint: null,
      title: `${phase}：脚本在两次工具调用之间运行 ${formatDurationFine(durMs)}`,
      start: gap.start,
      end: gap.end,
      durMs,
      indent: 1,
      tone: 'neutral',
      share: share(durMs, spanMs),
      order: rowOrder++,
    });
  }
  rows.push(...toolRows.map((row) => ({ ...row, share: share(row.durMs, spanMs), order: rowOrder++ })));

  if (egress !== null) {
    rows.push({
      key: 'egress',
      kind: 'gateway',
      label: '网关 · 出站序列化',
      hint: '执行结束 → 响应',
      title: `eval_end 到响应帧：${formatDurationFine(egress.end - egress.start)}`,
      start: egress.start,
      end: egress.end,
      durMs: egress.end - egress.start,
      indent: 0,
      tone: 'info',
      share: share(egress.end - egress.start, spanMs),
      order: rowOrder++,
    });
  }
  if (responseTs !== null) {
    rows.push({
      key: 'response',
      kind: 'response',
      label: '响应返回',
      hint: formatBytes(num(response?.['bytes'])),
      title: `响应 · ${formatTimestamp(responseTs)} · ${formatBytes(num(response?.['bytes']))}`,
      start: responseTs,
      end: responseTs,
      durMs: 0,
      indent: 0,
      tone: response?.['ok'] === false ? 'error' : 'ok',
      share: 0,
      order: rowOrder++,
    });
  }

  rows.sort((left, right) => left.start - right.start || left.order - right.order);

  const ingressMs = ingress === null ? 0 : ingress.end - ingress.start;
  const egressMs = egress === null ? 0 : egress.end - egress.start;
  const execMs = execSpan === null ? 0 : execSpan.end - execSpan.start;
  const gatewayMs = ingressMs + egressMs;
  const mode = str(start?.['mode']) === 'async' ? 'async' : str(start?.['mode']) === 'sync' ? 'sync' : null;
  const outcome = str(end?.['outcome']);
  const evalError = errorText(end ?? {});

  const parts: Array<Pick<ProcessComposition, 'key' | 'label' | 'ms'>> = [
    { key: 'ingress', label: '入站网关', ms: ingressMs },
    { key: 'script', label: '脚本自身', ms: scriptMs },
    { key: 'tool', label: '工具', ms: toolMs },
    { key: 'egress', label: '出站网关', ms: egressMs },
  ];
  const composition: ProcessComposition[] = parts
    .filter((part) => part.ms > 0)
    .map((part) => ({ ...part, share: share(part.ms, spanMs) }));

  const notes = buildNotes({
    spanMs,
    totalMs,
    toolMs,
    toolSumMs,
    scriptMs,
    gatewayMs,
    toolCalls: tools.length,
    openCalls,
    queueWaits,
    queueTotalMs,
    failures,
    denials,
    slowest,
    mode,
    outcome,
    evalError,
    layer: str(end?.['layer']),
    hasResponse: responseTs !== null,
    hasEval: start !== null,
    spanBeyondResponse: responseTs !== null && evalEndTs !== null && evalEndTs > responseTs,
    evalEndMissing: start !== null && end === null,
    toolNames: tools.map((record) => str(record.call?.['tool']) ?? str(record.result?.['tool'])),
  });

  return {
    from,
    to,
    method,
    summary: {
      totalMs,
      spanMs,
      ingressMs,
      egressMs,
      execMs,
      toolMs,
      toolSumMs,
      scriptMs,
      toolCalls: tools.length,
      toolFailures: failures.length,
      toolDenials: denials.length,
      openCalls,
      queueWaits,
      queueTotalMs,
      slowest,
      mode,
      outcome,
      ok: typeof end?.['ok'] === 'boolean' ? end['ok'] : null,
      error: evalError,
      codeBytes: num(start?.['codeBytes']),
      resultBytes: num(end?.['resultBytes']),
      notes,
      coverage: start === null ? 'frame' : 'exec',
    },
    composition,
    rows,
  };
}

interface NoteInput {
  spanMs: number;
  totalMs: number;
  toolMs: number;
  toolSumMs: number;
  scriptMs: number;
  gatewayMs: number;
  toolCalls: number;
  openCalls: number;
  queueWaits: number;
  queueTotalMs: number;
  failures: string[];
  denials: string[];
  slowest: { label: string; ms: number } | null;
  mode: 'sync' | 'async' | null;
  outcome: string | null;
  evalError: string | null;
  layer: string | null;
  hasResponse: boolean;
  hasEval: boolean;
  spanBeyondResponse: boolean;
  evalEndMissing: boolean;
  toolNames: Array<string | null>;
}

/** Ordered conclusions: composition first, then the specific cause of the slow path. */
function buildNotes(input: NoteInput): string[] {
  const notes: string[] = [];
  // A request without an eval has nothing to break down; the view says so instead.
  if (!input.hasEval) return notes;
  if (input.toolCalls === 0) {
    notes.push(
      `没有工具调用，${formatDurationFine(input.spanMs)} 全部是脚本自身运行${input.mode === 'async' ? '（异步投递）' : '（纯计算请求）'}`,
    );
  } else {
    const parts = [
      input.toolMs > 0 ? `工具 ${formatDurationFine(input.toolMs)}（${formatPercent(share(input.toolMs, input.spanMs), 0)}）` : null,
      input.scriptMs > 0 ? `脚本自身 ${formatDurationFine(input.scriptMs)}（${formatPercent(share(input.scriptMs, input.spanMs), 0)}）` : null,
      input.gatewayMs > 0 ? `网关 ${formatDurationFine(input.gatewayMs)}（${formatPercent(share(input.gatewayMs, input.spanMs), 0)}）` : null,
    ].filter((part) => part !== null);
    notes.push(`共 ${formatDurationFine(input.spanMs)}：${parts.join('、')}`);
    if (input.slowest !== null && share(input.slowest.ms, input.spanMs) >= 0.15) {
      notes.push(
        `最慢一步 ${input.slowest.label} ${formatDurationFine(input.slowest.ms)}，占 ${formatPercent(share(input.slowest.ms, input.spanMs), 0)}`,
      );
    }
    if (input.toolSumMs > input.toolMs * 1.15 && input.toolMs > 0) {
      notes.push(
        `工具并行执行：累计 ${formatDurationFine(input.toolSumMs)}，墙钟 ${formatDurationFine(input.toolMs)}`,
      );
    }
    if (input.queueWaits > 0) {
      notes.push(
        `${input.queueWaits} 次调用在闸门上排队合计 ${formatDurationFine(input.queueTotalMs)}，这段时间不是工具本身慢`,
      );
    }
  }
  if (input.openCalls > 0) {
    notes.push(`${input.openCalls} 个工具调用还没有返回，条形画到最后一条事件为止，不代表它已经结束`);
  }

  if (input.failures.length > 0) {
    notes.push(`${input.failures.length} 次工具失败：${input.failures.slice(0, 3).join('、')}`);
  }
  if (input.denials.length > 0) {
    notes.push(`${input.denials.length} 次工具被可见性规则拒绝：${input.denials.slice(0, 3).join('、')}`);
  }

  const repeated = new Map<string, number>();
  for (const name of input.toolNames) {
    if (name === null) continue;
    repeated.set(name, (repeated.get(name) ?? 0) + 1);
  }
  for (const [name, count] of repeated) {
    const failed = input.failures.some((entry) => entry.startsWith(name));
    if (count > 1 && failed) {
      notes.push(`${name} 调用 ${count} 次且出现失败，注意是否在重试`);
      break;
    }
  }

  if (input.outcome !== null && input.outcome !== 'ok') {
    const label = OUTCOME_LABELS[input.outcome] ?? input.outcome;
    const layer = input.layer === null ? null : LAYER_LABELS[input.layer] ?? input.layer;
    notes.push(`执行结果：${label}${layer === null ? '' : `（${layer}）`}${input.evalError === null ? '' : `：${clip(input.evalError, 120)}`}`);
  }
  if (input.mode === 'async') {
    notes.push(
      input.spanBeyondResponse
        ? `异步执行：响应只返回任务号，后台执行在响应之后又跑了 ${formatDurationFine(input.spanMs - input.totalMs)}`
        : input.evalEndMissing
          ? '异步执行：后台任务在本窗口内还没有结束，后续事件可能不完整'
          : '异步执行：响应先返回任务号，执行结果通过 wait_tasks 或 tasks/get 取回',
    );
  }
  if (!input.hasResponse) notes.push('没有响应帧：连接可能中断或请求仍挂起');
  return notes;
}
