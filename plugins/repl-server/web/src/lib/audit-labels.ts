/** Chinese labels for audit event names, `ai_run` fields and the subject cell. */

const EVENT_LABELS: Readonly<Record<string, string>> = {
  tool_call: '工具调用',
  tool_result: '工具结果',
  tool_denied: '工具拒绝',
  eval_start: '执行开始',
  eval_end: '执行结束',
  eval_cancel: '执行取消',
  exec_start: '会话开始',
  exec_end: '会话结束',
  exec_hibernate: '会话休眠',
  ai_run: 'AI 运行',
  error: '错误',
  exit: '退出',
  message: '消息',
  pool_stderr: '进程错误输出',
  protocol_dropped: '协议帧丢弃',
  discovery_preview: '发现预览',
  discovery_prepare: '发现准备',
  discovery_apply: '发现注册',
  report_created: '报告创建',
  report_status: '报告状态',
  report_alert: '报告告警',
  alert_test: '告警测试',
};

/** Every event name with a Chinese label; dropdown options use this order. */
export const AUDIT_EVENT_NAMES: readonly string[] = Object.keys(EVENT_LABELS);

const AI_RUN_KIND_LABELS: Readonly<Record<string, string>> = {
  annotate: '生成标注',
  propose: '生成配置草稿',
};

const AI_RUN_TRIGGER_LABELS: Readonly<Record<string, string>> = {
  manual: '手动',
  auto: '自动',
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Chinese event name; unknown names pass through so new events stay visible. */
export function eventLabel(name: unknown): string {
  const raw = text(name);
  if (raw === null) return '—';
  return EVENT_LABELS[raw] ?? raw;
}

/** `annotate` / `propose` in Chinese; unknown kinds pass through. */
export function aiRunKindLabel(kind: unknown): string {
  const raw = text(kind);
  if (raw === null) return '—';
  return AI_RUN_KIND_LABELS[raw] ?? raw;
}

/** `manual` / `auto` in Chinese; unknown triggers pass through. */
export function aiRunTriggerLabel(trigger: unknown): string {
  const raw = text(trigger);
  if (raw === null) return '—';
  return AI_RUN_TRIGGER_LABELS[raw] ?? raw;
}

export interface AuditSubjectEvent {
  event?: unknown;
  tool?: unknown;
  method?: unknown;
  kind?: unknown;
  server?: unknown;
  [key: string]: unknown;
}

/** Tool for calls; the Chinese `kind` for `ai_run`; the event name as the last resort. */
export function eventSubject(event: AuditSubjectEvent): string {
  const kind = text(event['kind']);
  if (event['event'] === 'ai_run' && kind !== null) return aiRunKindLabel(kind);
  return (
    text(event['tool']) ??
    text(event['method']) ??
    kind ??
    text(event['server']) ??
    eventLabel(event['event'])
  );
}
