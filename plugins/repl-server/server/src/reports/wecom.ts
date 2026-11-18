/** WeCom markdown construction and the injectable webhook sender (06 §4.3–§4.5). @module */

import { redactValue } from '@zhangliang0115/repl-server-core';

import {
  ALERT_MAX_ATTEMPTS,
  ALERT_RETRY_DELAY_MS,
  ALERT_SEND_TIMEOUT_MS,
  MAX_TITLE_CODE_POINTS,
  WECOM_MARKDOWN_MAX_BYTES,
  WECOM_RATE_LIMIT_BACKOFF_MS,
} from './constants.ts';
import { validateWebhookUrl } from './config.ts';
import type { SendOutcome, Severity, StoredReport } from './types.ts';

/** Chinese label plus the machine code stays visible in the message. */
export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = Object.freeze({
  low: '低',
  medium: '中',
  high: '高',
  critical: '严重',
});

const MARKDOWN_CONTROL = /[`*_\[\]()#>|\\]/g;

/**
 * Redacts credentials, flattens whitespace, strips markdown control characters
 * and truncates to 200 code points (06 §4.3). The title is the only free text
 * that leaves the process in an alert.
 */
export function sanitizeAlertTitle(title: string): string {
  let text = redactValue(title);
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(MARKDOWN_CONTROL, '');
  const points = [...text];
  if (points.length > MAX_TITLE_CODE_POINTS) {
    text = points.slice(0, MAX_TITLE_CODE_POINTS).join('');
  }
  return text === '' ? '(untitled)' : text;
}

/**
 * Pure builder for the WeCom robot markdown payload (06 §4.3). It never sees
 * `detail` or `context`: those stay local by design.
 */
export function buildWecomMarkdown(
  report: Pick<StoredReport, 'id' | 'severity' | 'source' | 'createdAt' | 'title'>,
): string {
  const title = sanitizeAlertTitle(report.title);
  const content = [
    '## REPL 问题报告',
    `> 严重级：${SEVERITY_LABELS[report.severity]}（${report.severity}）`,
    `> 来源：${report.source}`,
    `> 时间：${report.createdAt}`,
    `> 报告 ID：${report.id}`,
    '',
    `**${title}**`,
  ].join('\n');

  if (Buffer.byteLength(content, 'utf8') < WECOM_MARKDOWN_MAX_BYTES) return content;

  // Defensive: the 200-code-point title makes this unreachable, but the byte
  // ceiling is a hard WeCom limit, so degrade the title rather than the call.
  const points = [...title];
  while (points.length > 0) {
    points.pop();
    const candidate = [
      '## REPL 问题报告',
      `> 严重级：${SEVERITY_LABELS[report.severity]}（${report.severity}）`,
      `> 来源：${report.source}`,
      `> 时间：${report.createdAt}`,
      `> 报告 ID：${report.id}`,
      '',
      `**${points.join('')}**`,
    ].join('\n');
    if (Buffer.byteLength(candidate, 'utf8') < WECOM_MARKDOWN_MAX_BYTES) return candidate;
  }
  return [
    '## REPL 问题报告',
    `> 严重级：${SEVERITY_LABELS[report.severity]}（${report.severity}）`,
    `> 来源：${report.source}`,
    `> 时间：${report.createdAt}`,
    `> 报告 ID：${report.id}`,
  ].join('\n');
}

export interface WecomSendDeps {
  fetch: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  rateLimitBackoffMs?: number;
  /** Injected so tests never wait; receives the abort signal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Environment used by the loopback test hook; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Outer abort (dispatcher close); aborting it stops retries and the fetch. */
  signal?: AbortSignal;
}

type AttemptFailure = Extract<SendOutcome, { ok: false }> & { attempts?: number };

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRedirectError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && message.toLowerCase().includes('redirect')) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && isRedirectError(cause);
}

function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError';
}

function truncateMessage(message: string, max = 200): string {
  return message.length > max ? message.slice(0, max) : message;
}

async function attemptOnce(
  url: string,
  body: string,
  deps: WecomSendDeps,
  timeoutMs: number,
): Promise<AttemptFailure | { ok: true; httpStatus: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const signal =
    deps.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, deps.signal]);

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // 06 §4.5: any 3xx is a failure, never followed.
      redirect: 'error',
      signal,
    });
  } catch (error) {
    const timedOut = controller.signal.aborted || isAbortError(error);
    const redirected = !timedOut && isRedirectError(error);
    if (timedOut) {
      return {
        ok: false,
        attempts: 1,
        code: 'ALERT_TIMEOUT',
        message: 'timeout',
        retryable: true,
      };
    }
    if (redirected) {
      return {
        ok: false,
        attempts: 1,
        code: 'ALERT_REDIRECT',
        message: 'upstream redirected',
        retryable: false,
      };
    }
    return {
      ok: false,
      attempts: 1,
      code: 'ALERT_NETWORK',
      message: 'network error',
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  if (status >= 300 && status < 400) {
    return {
      ok: false,
      attempts: 1,
      code: 'ALERT_REDIRECT',
      message: 'upstream redirected',
      httpStatus: status,
      retryable: false,
    };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      attempts: 1,
      code: `ALERT_HTTP_${status}`,
      message: truncateMessage(`upstream returned HTTP ${status}`),
      httpStatus: status,
      retryable: status >= 500 || status === 429,
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      attempts: 1,
      code: 'ALERT_BAD_RESPONSE',
      message: 'invalid response body',
      httpStatus: status,
      retryable: false,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      attempts: 1,
      code: 'ALERT_BAD_RESPONSE',
      message: 'invalid response body',
      httpStatus: status,
      retryable: false,
    };
  }
  const errcode = (parsed as { errcode?: unknown }).errcode;
  if (typeof errcode !== 'number') {
    return {
      ok: false,
      attempts: 1,
      code: 'ALERT_BAD_RESPONSE',
      message: 'invalid response body',
      httpStatus: status,
      retryable: false,
    };
  }
  if (errcode === 0) {
    return { ok: true, httpStatus: status };
  }

  const rateLimited = errcode === 45009;
  const failure: AttemptFailure = {
    ok: false,
    attempts: 1,
    code: `ALERT_WECOM_${errcode}`,
    message: truncateMessage(`wecom errcode ${errcode}`),
    httpStatus: status,
    errcode,
    // 45009 is handled by the dispatcher with a 60 s cooldown, never in-send.
    retryable: errcode === -1,
  };
  if (rateLimited) failure.retryAfterMs = deps.rateLimitBackoffMs ?? WECOM_RATE_LIMIT_BACKOFF_MS;
  return failure;
}

/**
 * Sends one markdown message, retrying once for timeout/network/5xx/429/`-1`.
 * The response body is never retained and exception messages never leak into
 * the returned text (06 §4.4).
 */
export async function sendWecomMarkdown(
  url: string,
  content: string,
  deps: WecomSendDeps,
): Promise<SendOutcome> {
  const validation = validateWebhookUrl(url, deps.env ?? process.env);
  if (!validation.ok) {
    return {
      ok: false,
      attempts: 0,
      code: 'WEBHOOK_URL_INVALID',
      message: 'webhook URL is invalid',
      retryable: false,
    };
  }

  const timeoutMs = deps.timeoutMs ?? ALERT_SEND_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? ALERT_RETRY_DELAY_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const body = JSON.stringify({ msgtype: 'markdown', markdown: { content } });

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const outcome = await attemptOnce(url, body, deps, timeoutMs);
    if (outcome.ok) {
      return { ok: true, attempts, httpStatus: outcome.httpStatus, errcode: 0 };
    }
    if (!outcome.retryable || attempts >= ALERT_MAX_ATTEMPTS) {
      const { attempts: _ignored, ...rest } = outcome;
      return { ...rest, attempts };
    }
    try {
      await sleep(retryDelayMs, deps.signal);
    } catch {
      return {
        ok: false,
        attempts,
        code: 'ALERT_TIMEOUT',
        message: 'timeout',
        retryable: false,
      };
    }
  }
}
