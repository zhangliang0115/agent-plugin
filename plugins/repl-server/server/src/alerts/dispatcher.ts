/** Serial alert outbox dispatcher: claim, rules, send, retry and cooldown (06 §4.2). @module */

import { systemClock, type Clock } from '../ports.ts';
import {
  ALERT_CLAIM_LIMIT,
  ALERT_RETRY_DELAY_MS,
  ALERT_SEND_TIMEOUT_MS,
  ALERT_STALE_PENDING_MS,
  ALERT_STALE_SENDING_MS,
  ALERT_TEST_THROTTLE_MS,
  ALERT_TICK_MS,
  MAX_ALERT_ERROR_CHARS,
  MIN_SEND_INTERVAL_MS,
  WECOM_RATE_LIMIT_BACKOFF_MS,
} from '../reports/constants.ts';
import { loopbackWebhookAllowed, validateWebhookUrl } from '../reports/config.ts';
import { buildWecomMarkdown, sendWecomMarkdown, type WecomSendDeps } from '../reports/wecom.ts';
import {
  SEVERITY_RANK,
  type AlertConfig,
  type ReportAuditSink,
  type ReportStore,
  type SendOutcome,
  type StoredReport,
} from '../reports/types.ts';
import type { AlertConfigStore } from './config-store.ts';
import {
  AlertTestThrottledError,
  buildTestMarkdown,
  WebhookNotConfiguredError,
  WebhookUrlInvalidError,
} from './errors.ts';

export interface AlertTestResult {
  ok: boolean;
  attempts: number;
  elapsedMs: number;
  outcome: SendOutcome;
}

export interface AlertDispatcher {
  /** Recovers `sending`, fails 24h-stale `pending`, starts the 30 s tick and kicks. */
  start(): void;
  kick(): void;
  /** Test entry: processes one synchronous batch and returns how many rows it handled. */
  runOnce(limit?: number): Promise<number>;
  /** Serial with the drain and subject to the same min-interval/cooldown rules. */
  sendTest(): Promise<AlertTestResult>;
  close(): Promise<void>;
}

export interface AlertDispatcherDeps {
  store: ReportStore;
  config: AlertConfigStore;
  audit?: ReportAuditSink;
  clock?: Clock;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  timeoutMs?: number;
  retryDelayMs?: number;
  minSendIntervalMs?: number;
  rateLimitBackoffMs?: number;
  tickMs?: number;
  staleSendingMs?: number;
  stalePendingMs?: number;
  claimLimit?: number;
  testThrottleMs?: number;
}

type TerminalState = 'skipped' | 'no_webhook' | 'failed';

interface TerminalDecision {
  state: TerminalState;
  error: string;
}

const SENDABLE_EVENT = 'report';

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Builds the only sender for report alerts. It is independent of HTTP so it can
 * be unit tested with injected `fetch` / `sleep` and driven by `runOnce`.
 */
export function createAlertDispatcher(deps: AlertDispatcherDeps): AlertDispatcher {
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? ((): void => undefined);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;

  const timeoutMs = deps.timeoutMs ?? ALERT_SEND_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? ALERT_RETRY_DELAY_MS;
  const minSendIntervalMs = deps.minSendIntervalMs ?? MIN_SEND_INTERVAL_MS;
  const rateLimitBackoffMs = deps.rateLimitBackoffMs ?? WECOM_RATE_LIMIT_BACKOFF_MS;
  const tickMs = deps.tickMs ?? ALERT_TICK_MS;
  const staleSendingMs = deps.staleSendingMs ?? ALERT_STALE_SENDING_MS;
  const stalePendingMs = deps.stalePendingMs ?? ALERT_STALE_PENDING_MS;
  const claimLimit = deps.claimLimit ?? ALERT_CLAIM_LIMIT;
  const testThrottleMs = deps.testThrottleMs ?? ALERT_TEST_THROTTLE_MS;

  let started = false;
  let closed = false;
  let draining = false;
  let recheck = false;
  let drainPromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeAt = 0;
  let cooldownUntil = 0;
  let lastSendAt = Number.NEGATIVE_INFINITY;
  let lastTestAt = Number.NEGATIVE_INFINITY;
  const currentSending = new Set<string>();
  const abortController = new AbortController();

  let sendChain: Promise<void> = Promise.resolve();

  function nowIso(): string {
    return new Date(clock.now()).toISOString();
  }

  function recordAudit(fields: { event: string; [key: string]: unknown }): void {
    if (deps.audit === undefined) return;
    try {
      deps.audit.write({ ts: nowIso(), ...fields });
    } catch (error) {
      log(`repl-server: alert audit write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function sendDeps(): WecomSendDeps {
    const base: WecomSendDeps = {
      fetch: fetchImpl,
      timeoutMs,
      retryDelayMs,
      rateLimitBackoffMs,
      env,
      signal: abortController.signal,
    };
    if (deps.sleep !== undefined) base.sleep = deps.sleep;
    return base;
  }

  async function sleepOnce(ms: number): Promise<void> {
    if (closed) throw new DOMException('dispatcher closed', 'AbortError');
    const sleep =
      deps.sleep ??
      ((delayMs: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
            return;
          }
          const handle = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, delayMs);
          handle.unref?.();
          const onAbort = (): void => {
            clearTimeout(handle);
            reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        }));
    await sleep(ms, abortController.signal);
    if (closed) throw new DOMException('dispatcher closed', 'AbortError');
  }

  /**
   * Serializes every outbound send (drain and `sendTest`) and enforces the
   * 3 s start-to-start gap plus any active 45009 cooldown.
   */
  async function withSendSlot<T>(run: () => Promise<T>): Promise<T> {
    const previous = sendChain;
    let release = (): void => undefined;
    sendChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const cooldownLeft = cooldownUntil - clock.now();
      if (cooldownLeft > 0) await sleepOnce(cooldownLeft);
      const gap = lastSendAt + minSendIntervalMs - clock.now();
      if (gap > 0) await sleepOnce(gap);
      lastSendAt = clock.now();
      return await run();
    } finally {
      release();
    }
  }

  function scheduleWake(): void {
    if (closed) return;
    const delay = Math.max(0, cooldownUntil - clock.now());
    if (wakeTimer !== null) {
      if (wakeAt <= clock.now() + delay) return;
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    wakeAt = clock.now() + delay;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      kick();
    }, delay);
    wakeTimer.unref?.();
  }

  function evaluate(config: AlertConfig, report: StoredReport): TerminalDecision | null {
    // Fixed order from 06 §4.2; tests assert this matrix.
    if (!config.enabled) return { state: 'skipped', error: 'ALERTS_DISABLED' };
    if (!config.events.includes(SENDABLE_EVENT)) {
      return { state: 'skipped', error: 'EVENT_DISABLED' };
    }
    if (SEVERITY_RANK[report.severity] < SEVERITY_RANK[config.minSeverity]) {
      return { state: 'skipped', error: 'BELOW_MIN_SEVERITY' };
    }
    return null;
  }

  function patchTerminal(report: StoredReport, decision: TerminalDecision): void {
    if (closed) return;
    const at = nowIso();
    const patched = deps.store.patchAlert(report.id, 'sending', {
      state: decision.state,
      error: decision.error,
      updatedAt: at,
    });
    if (!patched) return;
    recordAudit({
      event: 'report_alert',
      reportId: report.id,
      state: decision.state,
      attempts: report.alertAttempts,
      errorCode: decision.error,
    });
  }

  async function processReport(report: StoredReport, config: AlertConfig): Promise<void> {
    if (closed) return;
    const decision = evaluate(config, report);
    if (decision !== null) {
      patchTerminal(report, decision);
      return;
    }

    let url: string | undefined;
    try {
      url = await deps.config.getWebhook();
    } catch {
      // Leave the row in `sending`; the 30 s tick returns it to `pending`.
      // Never log the SecretStore error text: it may carry a file path.
      log('repl-server: alert webhook read failed');
      return;
    }
    if (url === undefined || url === '') {
      patchTerminal(report, { state: 'no_webhook', error: 'WEBHOOK_NOT_CONFIGURED' });
      return;
    }

    const validation = validateWebhookUrl(url, env);
    if (!validation.ok) {
      const at = nowIso();
      const patched = deps.store.patchAlert(report.id, 'sending', {
        state: 'failed',
        error: 'WEBHOOK_URL_INVALID',
        attempts: 0,
        updatedAt: at,
      });
      if (patched) {
        recordAudit({
          event: 'report_alert',
          reportId: report.id,
          state: 'failed',
          attempts: 0,
          errorCode: 'WEBHOOK_URL_INVALID',
        });
      }
      return;
    }

    currentSending.add(report.id);
    let outcome: SendOutcome;
    try {
      outcome = await withSendSlot(() =>
        sendWecomMarkdown(url, buildWecomMarkdown(report), sendDeps()),
      );
    } finally {
      currentSending.delete(report.id);
    }

    // `close()` already moved the row back to `pending`; do not overwrite it.
    if (closed) return;

    const at = nowIso();
    if (outcome.ok) {
      const patched = deps.store.patchAlert(report.id, 'sending', {
        state: 'sent',
        error: null,
        attempts: outcome.attempts,
        alertedAt: at,
        updatedAt: at,
      });
      if (patched) {
        recordAudit({
          event: 'report_alert',
          reportId: report.id,
          state: 'sent',
          attempts: outcome.attempts,
        });
      }
      return;
    }

    if (outcome.code === 'ALERT_WECOM_45009') {
      // 06 §4.2: return to pending and pause the drain for one minute.
      cooldownUntil = clock.now() + (outcome.retryAfterMs ?? rateLimitBackoffMs);
      const patched = deps.store.patchAlert(report.id, 'sending', {
        state: 'pending',
        error: 'ALERT_WECOM_45009',
        updatedAt: at,
      });
      if (patched) scheduleWake();
      return;
    }

    const error = truncate(`${outcome.code}: ${outcome.message}`, MAX_ALERT_ERROR_CHARS);
    const patched = deps.store.patchAlert(report.id, 'sending', {
      state: 'failed',
      error,
      attempts: outcome.attempts,
      updatedAt: at,
    });
    if (patched) {
      recordAudit({
        event: 'report_alert',
        reportId: report.id,
        state: 'failed',
        attempts: outcome.attempts,
        errorCode: outcome.code,
      });
    }
  }

  async function readConfig(): Promise<AlertConfig | null> {
    try {
      return (await deps.config.read()).config;
    } catch (error) {
      log(`repl-server: alert config read failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function drain(): Promise<void> {
    const config = await readConfig();
    if (config === null) return;

    for (;;) {
      if (closed) return;
      if (clock.now() < cooldownUntil) {
        scheduleWake();
        return;
      }
      const rows = deps.store.claimPendingAlerts(nowIso(), claimLimit);
      if (rows.length === 0) return;
      for (const row of rows) {
        if (closed) return;
        await processReport(row, config);
        if (clock.now() < cooldownUntil) {
          scheduleWake();
          return;
        }
      }
    }
  }

  function kick(): void {
    if (closed) return;
    if (draining) {
      recheck = true;
      return;
    }
    if (clock.now() < cooldownUntil) {
      scheduleWake();
      return;
    }

    draining = true;
    recheck = false;
    drainPromise = (async () => {
      try {
        do {
          recheck = false;
          await drain();
        } while (recheck && !closed && clock.now() >= cooldownUntil);
      } catch (error) {
        if (!closed) {
          log(`repl-server: alert drain failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        draining = false;
        if (recheck && !closed) {
          recheck = false;
          kick();
        }
      }
    })();
    void drainPromise;
  }

  async function tick(): Promise<void> {
    if (closed) return;
    try {
      deps.store.resetStaleSending(new Date(clock.now() - staleSendingMs).toISOString());
    } catch (error) {
      log(`repl-server: alert stale reset failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (clock.now() < cooldownUntil) {
      scheduleWake();
      return;
    }
    kick();
  }

  return {
    start() {
      if (started || closed) return;
      started = true;
      const now = nowIso();
      try {
        const reset = deps.store.resetAllSending(now);
        if (reset > 0) log(`repl-server: recovered ${reset} sending alert row(s)`);
      } catch (error) {
        log(`repl-server: alert recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const failed = deps.store.failStalePending(
          new Date(clock.now() - stalePendingMs).toISOString(),
          now,
        );
        if (failed > 0) log(`repl-server: failed ${failed} stale pending alert row(s)`);
      } catch (error) {
        log(`repl-server: stale pending sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (loopbackWebhookAllowed(env)) {
        log('repl-server: warning: loopback alert webhooks are allowed (test hook active)');
      }
      timer = setInterval(() => {
        void tick();
      }, tickMs);
      timer.unref?.();
      kick();
    },

    kick,

    async runOnce(limit = claimLimit) {
      if (closed) return 0;
      if (clock.now() < cooldownUntil) return 0;
      const config = await readConfig();
      if (config === null) return 0;

      const rows = deps.store.claimPendingAlerts(nowIso(), limit);
      let processed = 0;
      for (const row of rows) {
        if (closed) break;
        await processReport(row, config);
        processed += 1;
        if (clock.now() < cooldownUntil) break;
      }
      return processed;
    },

    async sendTest() {
      if (closed) throw new Error('alert dispatcher is closed');
      const now = clock.now();
      const sinceLast = now - lastTestAt;
      if (sinceLast >= 0 && sinceLast < testThrottleMs) {
        throw new AlertTestThrottledError(testThrottleMs - sinceLast);
      }
      lastTestAt = now;

      const url = await deps.config.getWebhook();
      if (url === undefined || url === '') throw new WebhookNotConfiguredError();
      const validation = validateWebhookUrl(url, env);
      if (!validation.ok) throw new WebhookUrlInvalidError(validation.rule);

      const startedAt = clock.now();
      const outcome = await withSendSlot(() =>
        sendWecomMarkdown(url, buildTestMarkdown(nowIso()), sendDeps()),
      );
      const elapsedMs = Math.max(0, clock.now() - startedAt);
      recordAudit({
        event: 'alert_test',
        ok: outcome.ok,
        attempts: outcome.attempts,
        ...(outcome.ok ? {} : { errorCode: outcome.code }),
      });
      return { ok: outcome.ok, attempts: outcome.attempts, elapsedMs, outcome };
    },

    async close() {
      if (closed) return;
      closed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (wakeTimer !== null) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
      }
      abortController.abort();

      const pending = drainPromise;
      if (pending !== null) {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const cap = new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1_000);
          timeout.unref?.();
        });
        try {
          await Promise.race([pending.catch(() => undefined), cap]);
        } finally {
          if (timeout !== null) clearTimeout(timeout);
        }
      }

      // Single-process outbox: at this point every `sending` row belongs to this
      // dispatcher, so the bulk reset also covers a send that finished between
      // the abort and the per-row bookkeeping. The next process reclaims them.
      try {
        deps.store.resetAllSending(nowIso());
      } catch {
        log('repl-server: alert close reset failed');
      }
      currentSending.clear();
    },
  };
}
