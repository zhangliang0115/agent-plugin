/**
 * Soft and hard walls for one eval.
 *
 * L2 (soft) is cooperative: mark the eval non-accepting, abort the eval signal
 * and every in-flight tool call, then ask the worker to reject its pending
 * calls. The worker stays alive for the observation window.
 *
 * L3 (hard) is session-wide: bump the epoch so late messages become invalid,
 * terminate the worker, settle **every** active eval with
 * `WorkerKilledError` / `outcome: "worker_dead"`, and restart the serve only
 * when the session-level rules say so (`hadInflight || !terminated ||
 * !serveHealthy`). Settlement is idempotent, so an eval that already returned
 * during the grace window is not settled twice.
 *
 * Contract: learn-ai `claude-code/自建设计/02-执行体与进程治理.md` §1.4–1.5.
 * @module
 */
import { EvalTimeoutError, WorkerKilledError } from '../errors.ts';
import type { TimeoutLayer } from '../types.ts';
import type { ActiveEval, ExecSession } from './exec-session.ts';

/** What one hard stop did; also the `worker_reset` audit payload in waiting. */
export interface HardStopReport {
  layer: TimeoutLayer;
  /** Worker epoch after the bump. */
  epoch: number;
  /** Evals settled by this reset. */
  killedEvals: number[];
  /** False when `worker.terminate()` did not finish within its budget. */
  terminated: boolean;
  /** Any eval had accepted tool calls that had not completed yet. */
  hadInflight: boolean;
  serveRestarted: boolean;
  /** `hadInflight || !terminated || !serveHealthy` before the restart attempt. */
  needRestart: boolean;
}

function emptyReport(layer: TimeoutLayer, terminated = true): HardStopReport {
  return {
    layer,
    epoch: 0,
    killedEvals: [],
    terminated,
    hadInflight: false,
    serveRestarted: false,
    needRestart: false,
  };
}

/**
 * L2 soft wall. Returns false when it was a no-op (eval already settled, hard
 * stopped, or soft stopped earlier).
 *
 * Aborting the in-flight controllers is what the tool bridge observes; the
 * `cancel` message makes the worker reject calls it is still awaiting. Neither
 * guarantees the script stops — only the hard wall does.
 */
export function softStop(session: ExecSession, ev: ActiveEval, layer: TimeoutLayer = 'soft'): boolean {
  if (ev.settled || ev.stopped) return false;
  if (ev.stopLayer !== undefined) return false;

  ev.stopLayer = layer;
  ev.accepting = false;
  const reason = new EvalTimeoutError(layer);
  try {
    ev.abort.abort(reason);
  } catch {
    // An already-aborted controller is fine.
  }
  for (const call of ev.inflight.values()) {
    try {
      call.controller.abort(reason);
    } catch {
      // Same as above: the call is on its way out anyway.
    }
  }
  session.cancelExecutorEval(ev.evalId);
  return true;
}

/**
 * L3 hard wall. Every concurrent call for the same session joins the first
 * reset instead of terminating the worker twice.
 */
export async function hardStop(
  session: ExecSession,
  ev: ActiveEval,
  layer: TimeoutLayer = 'wall',
): Promise<HardStopReport> {
  if (ev.stopped) {
    // A reset may still be running; callers use the report to know when the
    // worker is really gone, so wait it out instead of returning early.
    const running = session.resetting;
    if (running !== null) {
      try {
        await running;
      } catch {
        // The reset owner already observed the failure.
      }
    }
    return session.lastWorkerReset ?? emptyReport(layer);
  }

  const running = session.resetting;
  if (running !== null) {
    const report = (await running) as HardStopReport;
    if (ev.settled) return report;
    // The eval was registered after the reset snapshotted its victims; it has
    // no worker to talk to, so settle it with a fresh reset.
    return session.runWorkerReset(() => performHardStop(session, ev, layer));
  }

  return session.runWorkerReset(() => performHardStop(session, ev, layer));
}

async function performHardStop(
  session: ExecSession,
  trigger: ActiveEval,
  layer: TimeoutLayer,
): Promise<HardStopReport> {
  const doomed = [...session.activeEvals.values()];
  trigger.stopped = true;
  for (const ev of doomed) {
    ev.stopped = true;
    // The hard wall is the actual cause for every evals it destroys, even when
    // a soft wall fired earlier. Settlements and later failure hooks agree.
    ev.stopLayer = layer;
  }

  const hadInflight = doomed.some((ev) => ev.inflight.size > 0);
  const epoch = session.bumpWorkerEpoch();
  const killError = new WorkerKilledError();
  for (const ev of doomed) {
    try {
      ev.abort.abort(killError);
    } catch {
      // Ignore.
    }
    for (const call of ev.inflight.values()) {
      try {
        call.controller.abort(killError);
      } catch {
        // Ignore; the call may have completed between the snapshot and here.
      }
    }
  }

  const executor = session.detachExecutor();
  let terminated = true;
  if (executor !== null) {
    try {
      terminated = await executor.terminate(session.limits.terminateMs);
    } catch {
      terminated = false;
    }
  }

  // Include evals registered while `terminate()` was awaited; they have no
  // usable worker either.
  const targets = new Map<number, ActiveEval>();
  for (const ev of doomed) targets.set(ev.evalId, ev);
  for (const ev of session.activeEvals.values()) targets.set(ev.evalId, ev);

  const killedEvals: number[] = [];
  for (const ev of targets.values()) {
    const settlement = session.settleEval(ev, {
      ok: false,
      outcome: 'worker_dead',
      error: killError.message,
      layer,
    });
    if (settlement.outcome === 'worker_dead') killedEvals.push(ev.evalId);
  }

  const needRestart = hadInflight || !terminated || !session.serveHealthy();
  const serveRestarted = needRestart ? await session.restartServe() : false;

  const report: HardStopReport = {
    layer,
    epoch,
    killedEvals,
    terminated,
    hadInflight,
    serveRestarted,
    needRestart,
  };
  session.notifyWorkerReset(report);
  return report;
}
