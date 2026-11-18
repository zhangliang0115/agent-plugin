/**
 * `runEval`: the per-eval orchestration for one execution session.
 *
 * Responsibilities (learn-ai `claude-code/自建设计/02-执行体与进程治理.md` §1.4,
 * §4.2, §4.4; plan task C07):
 *
 * - **Locking.** A synchronous eval holds `session.lock` until its settlement
 *   (and until any required worker reset finishes). An asynchronous eval holds
 *   it only while it registers and dispatches, then returns the receipt
 *   immediately; the result is delivered through `onSettled`.
 * - **Capacity.** Registration throws `CAPACITY_EXCEEDED` when the session
 *   already has `limits.inFlightLimit` evals in flight.
 * - **Timeouts.** Sync defaults to 30s / caps at 600s; async defaults to and
 *   caps at 7200s. Values below 1000ms are clamped up, values above the cap are
 *   `INVALID_ARGUMENT` (protocol §4: never silently truncate).
 * - **Walls.** The soft timer fires at the deadline (L2), the hard timer
 *   `graceMs` later (L3). Both are implemented in `stop.ts`.
 *
 * The module deliberately has no audit/process code; settlements are plain data
 * that the assembly layer renders and records.
 * @module
 */
import { EvalTimeoutError, ReplError, WorkerKilledError } from '../errors.ts';
import type { TimeoutLayer } from '../types.ts';
import {
  DEFAULT_EXEC_SESSION_LIMITS,
  type ActiveEval,
  type EvalExecutorOutcome,
  type EvalSettlement,
  type EvalSettlementFields,
  type ExecSession,
  type ExecSessionLimits,
} from './exec-session.ts';
import { hardStop, softStop } from './stop.ts';

/** Subset of the session limits that decides an eval's timeout. */
export type EvalTimeoutLimits = Pick<
  ExecSessionLimits,
  'minTimeoutMs' | 'syncDefaultMs' | 'syncMaxMs' | 'asyncDefaultMs' | 'asyncMaxMs'
>;

export interface RunEvalOptions {
  /** Async dispatch: return a receipt at once and deliver the result to `onSettled`. */
  async?: boolean;
  /**
   * Explicit timeout in ms. Omitted: 30000 for sync, 7200000 for async.
   * Below the 1000ms floor it is clamped up; above the mode's cap it rejects
   * with `INVALID_ARGUMENT`.
   */
  timeoutMs?: number;
  /** Task-store id allocated by C08; echoed on the receipt and the settlement. */
  evalTaskId?: string;
  /**
   * Called exactly once when the eval settles, sync or async. Observer errors
   * are swallowed so a task-store failure cannot poison an eval.
   */
  onSettled?: (settlement: EvalSettlement) => void;
}

/**
 * Resolves the eval deadline. Separated out because the table in protocol §4 is
 * a hard contract: async omitted means the 7200s cap, not 30s.
 */
export function resolveEvalTimeout(
  asyncMode: boolean,
  timeoutMs?: number,
  limits: EvalTimeoutLimits = DEFAULT_EXEC_SESSION_LIMITS,
): number {
  const fallback = asyncMode ? limits.asyncDefaultMs : limits.syncDefaultMs;
  const maximum = asyncMode ? limits.asyncMaxMs : limits.syncMaxMs;
  if (timeoutMs === undefined) return fallback;

  if (!Number.isFinite(timeoutMs)) {
    throw new ReplError('INVALID_ARGUMENT', `timeout must be a finite number, got ${String(timeoutMs)}`);
  }
  if (timeoutMs > maximum) {
    throw new ReplError(
      'INVALID_ARGUMENT',
      `${asyncMode ? 'async' : 'sync'} timeout ${timeoutMs}ms exceeds the ${maximum}ms limit`,
    );
  }
  const floored = Math.floor(timeoutMs);
  if (floored < limits.minTimeoutMs) return limits.minTimeoutMs;
  return floored;
}

/**
 * Starts one eval.
 *
 * - Sync: resolves with the final settlement once the script, its workers and
 *   any required reset are done.
 * - Async: resolves with an `asyncDispatched` receipt as soon as the executor
 *   has been handed the eval; `onSettled` receives the final settlement.
 *
 * Rejections here are dispatch failures (capacity, invalid timeout, worker
 * creation); script failures are settlements.
 */
export async function runEval(
  session: ExecSession,
  code: string,
  options: RunEvalOptions = {},
): Promise<EvalSettlement> {
  const asyncMode = options.async === true;
  const timeoutMs = resolveEvalTimeout(asyncMode, options.timeoutMs, session.limits);

  if (asyncMode) {
    return await session.lock.run(() => dispatchEval(session, code, timeoutMs, options));
  }
  return await session.lock.run(() => executeEval(session, code, timeoutMs, options));
}

function dispatchReceipt(ev: ActiveEval): EvalSettlement {
  const receipt: EvalSettlement = {
    evalId: ev.evalId,
    epoch: ev.epoch,
    async: true,
    ok: true,
    outcome: 'ok',
    stdout: '',
    stderr: '',
    ms: 0,
    truncated: {},
    contextReset: false,
    stateRestored: 'none',
    budget: { calls: 0, callsLimit: ev.callsLimit },
    asyncDispatched: true,
  };
  if (ev.evalTaskId !== undefined) receipt.evalTaskId = ev.evalTaskId;
  return receipt;
}

/** Async path: register, hand the code to the executor, release the lock. */
async function dispatchEval(
  session: ExecSession,
  code: string,
  timeoutMs: number,
  options: RunEvalOptions,
): Promise<EvalSettlement> {
  const ev = await session.beginEval({
    async: true,
    timeoutMs,
    ...(options.evalTaskId === undefined ? {} : { evalTaskId: options.evalTaskId }),
  });
  const executor = session.executor;
  if (executor === null) {
    const settlement = session.settleEval(ev, {
      ok: false,
      outcome: 'error',
      error: 'executor unavailable during dispatch',
    });
    try {
      options.onSettled?.(settlement);
    } catch {
      // Observer errors must not change the dispatch result.
    }
    return dispatchReceipt(ev);
  }

  let execution: Promise<EvalExecutorOutcome>;
  try {
    execution = Promise.resolve(executor.eval(code, { evalId: ev.evalId, syncMs: session.limits.syncMs }));
  } catch (error) {
    execution = Promise.reject(error);
  }

  armTimers(session, ev);
  // `driveEval` always resolves; the catch is only a guard against a throw in
  // settlement bookkeeping, which must not surface as an unhandled rejection.
  void driveEval(session, ev, execution, options.onSettled).catch(() => {});
  return dispatchReceipt(ev);
}

/** Sync path: hold the session lock until settlement and any reset is done. */
async function executeEval(
  session: ExecSession,
  code: string,
  timeoutMs: number,
  options: RunEvalOptions,
): Promise<EvalSettlement> {
  const ev = await session.beginEval({
    async: false,
    timeoutMs,
    ...(options.evalTaskId === undefined ? {} : { evalTaskId: options.evalTaskId }),
  });
  const executor = session.executor;
  if (executor === null) {
    return session.settleEval(ev, {
      ok: false,
      outcome: 'error',
      error: 'executor unavailable during dispatch',
    });
  }

  const execution = Promise.resolve().then(() =>
    executor.eval(code, { evalId: ev.evalId, syncMs: session.limits.syncMs }),
  );
  armTimers(session, ev);
  return driveEval(session, ev, execution, options.onSettled);
}

function armTimers(session: ExecSession, ev: ActiveEval): void {
  const softDelay = Math.max(0, ev.deadline - session.now());
  ev.softTimer = setTimeout(() => {
    softStop(session, ev, 'soft');
  }, softDelay);
  ev.softTimer.unref?.();

  const hardDelay = softDelay + session.limits.graceMs;
  ev.hardTimer = setTimeout(() => {
    void hardStop(session, ev, 'wall');
  }, hardDelay);
  ev.hardTimer.unref?.();
}

/** Waits for whichever happens first: executor outcome or session-level settlement. */
async function driveEval(
  session: ExecSession,
  ev: ActiveEval,
  execution: Promise<EvalExecutorOutcome>,
  onSettled?: (settlement: EvalSettlement) => void,
): Promise<EvalSettlement> {
  let settlement: EvalSettlement;

  try {
    const raced = await Promise.race([
      execution.then(
        (outcome) => ({ kind: 'outcome' as const, outcome }),
        (error: unknown) => ({ kind: 'failure' as const, error }),
      ),
      ev.completed.then((value) => ({ kind: 'settled' as const, settlement: value })),
    ]);

    if (raced.kind === 'settled') {
      settlement = raced.settlement;
    } else if (raced.kind === 'failure') {
      settlement = session.settleEval(ev, failureFields(raced.error, ev));
    } else {
      settlement = session.settleEval(ev, outcomeFields(raced.outcome, ev));
    }
  } catch (error) {
    settlement = session.settleEval(ev, failureFields(error, ev));
  }

  session.clearTimers(ev);

  // L2 always escalates: even when the script returned during the observation
  // window, the worker that saw the timeout is destroyed and rebuilt.
  if (ev.stopLayer !== undefined && !ev.stopped) {
    try {
      await hardStop(session, ev, ev.stopLayer);
    } catch {
      // The settlement stands even if the reset failed; the next eval retries.
    }
  }

  // A collateral hard wall may have settled this eval while another reset is
  // still terminating the worker. Do not release the sync lock (and do not
  // report completion) until that reset is done.
  const resetting = session.resetting;
  if (resetting !== null) {
    try {
      await resetting;
    } catch {
      // Already reported by the reset owner.
    }
  }

  if (onSettled !== undefined) {
    try {
      onSettled(settlement);
    } catch {
      // Observer errors must not change the eval result.
    }
  }
  return settlement;
}

function outcomeFields(outcome: EvalExecutorOutcome, ev: ActiveEval): EvalSettlementFields {
  const layer = ev.stopLayer ?? outcome.layer;
  const fields: EvalSettlementFields = {
    ok: outcome.ok,
    outcome: classifyOutcome(outcome, ev, layer),
    stdout: outcome.stdout ?? '',
    stderr: outcome.stderr ?? '',
    truncated: outcome.truncated ?? {},
    contextReset: outcome.contextReset ?? false,
    stateRestored: outcome.stateRestored ?? 'none',
  };
  if (outcome.ms !== undefined) fields.ms = outcome.ms;
  if (outcome.result !== undefined) fields.result = outcome.result;
  if (outcome.error !== undefined) fields.error = outcome.error;
  if (outcome.stack !== undefined) fields.stack = outcome.stack;
  if (outcome.stateSnapshot !== undefined) fields.stateSnapshot = outcome.stateSnapshot;
  if (layer !== undefined) fields.layer = layer;
  return fields;
}

function classifyOutcome(
  outcome: EvalExecutorOutcome,
  ev: ActiveEval,
  layer: TimeoutLayer | undefined,
): 'ok' | 'timeout' | 'error' {
  if (ev.stopLayer !== undefined) return 'timeout';
  if (outcome.ok) return 'ok';
  if (layer === 'sync' || layer === 'soft' || layer === 'wall') return 'timeout';
  return 'error';
}

function failureFields(error: unknown, ev: ActiveEval): EvalSettlementFields {
  const timeoutLayer = error instanceof EvalTimeoutError ? (error.layer as TimeoutLayer) : undefined;
  const layer = ev.stopLayer ?? timeoutLayer;
  const workerDead = error instanceof WorkerKilledError;
  const fields: EvalSettlementFields = {
    ok: false,
    outcome: workerDead ? 'worker_dead' : layer !== undefined ? 'timeout' : 'error',
    error: errorText(error),
  };
  if (error instanceof Error && error.stack !== undefined) fields.stack = error.stack;
  if (layer !== undefined) fields.layer = layer;
  return fields;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
