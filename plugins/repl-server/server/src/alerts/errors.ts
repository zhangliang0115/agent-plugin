/** Coded errors raised by the alert dispatcher and mapped by the admin API. @module */

export class AlertTestThrottledError extends Error {
  readonly code = 'ALERT_TEST_THROTTLED';
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`alert test is throttled; retry in ${retryAfterMs} ms`);
    this.name = 'AlertTestThrottledError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class WebhookNotConfiguredError extends Error {
  readonly code = 'WEBHOOK_NOT_CONFIGURED';

  constructor() {
    super('no WeCom webhook is configured');
    this.name = 'WebhookNotConfiguredError';
  }
}

export class WebhookUrlInvalidError extends Error {
  readonly code = 'WEBHOOK_URL_INVALID';
  readonly rule: string;

  constructor(rule: string) {
    super('the stored webhook URL is not a valid WeCom robot URL');
    this.name = 'WebhookUrlInvalidError';
    this.rule = rule;
  }
}

/** Fixed message sent by `POST /admin/api/alerts/test` (06 §5.3). */
export function buildTestMarkdown(at: string): string {
  return [
    '## REPL Server 告警测试',
    `> 时间：${at}`,
    '> 说明：这条消息由管理端“发送测试”触发。',
  ].join('\n');
}
