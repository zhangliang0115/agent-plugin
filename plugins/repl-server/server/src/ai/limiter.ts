/** In-process AI run limiter: 2 running, 4 queued, 30s maximum wait (08 §2.4). @module */

import {
  AI_LIMITER_QUEUED,
  AI_LIMITER_RUNNING,
  AI_LIMITER_WAIT_MS,
} from './constants.ts';
import { AiRunnerError } from './errors.ts';

export interface AiLimiterSnapshot {
  running: number;
  queued: number;
}

export interface AiLimiterOptions {
  maxRunning?: number;
  maxQueued?: number;
  maxWaitMs?: number;
}

export interface AiLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  snapshot(): AiLimiterSnapshot;
}

interface Waiter {
  enqueuedAt: number;
  start: () => void;
  reject: (error: AiRunnerError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Bounds concurrent `claude` processes for the whole process. A caller that cannot
 * start within `maxWaitMs` is rejected with `AI_BUSY` instead of being left queued
 * until Node's HTTP request timeout closes the socket.
 */
export function createAiLimiter(options: AiLimiterOptions = {}): AiLimiter {
  const maxRunning = options.maxRunning ?? AI_LIMITER_RUNNING;
  const maxQueued = options.maxQueued ?? AI_LIMITER_QUEUED;
  const maxWaitMs = options.maxWaitMs ?? AI_LIMITER_WAIT_MS;

  let running = 0;
  const queue: Waiter[] = [];

  function busy(waitedMs?: number): AiRunnerError {
    const details: Record<string, unknown> = { running, queued: queue.length };
    if (waitedMs !== undefined) details['waitedMs'] = waitedMs;
    return new AiRunnerError(
      'AI_BUSY',
      429,
      'too many AI runs are in flight; retry shortly',
      details,
    );
  }

  function pump(): void {
    while (running < maxRunning && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      clearTimeout(next.timer);
      running += 1;
      next.start();
    }
  }

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (running < maxRunning) {
          running += 1;
          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              running -= 1;
              pump();
            });
          return;
        }

        if (queue.length >= maxQueued) {
          reject(busy());
          return;
        }

        const enqueuedAt = Date.now();
        const waiter: Waiter = {
          enqueuedAt,
          start: () => {
            void Promise.resolve()
              .then(task)
              .then(resolve, reject)
              .finally(() => {
                running -= 1;
                pump();
              });
          },
          reject,
          timer: setTimeout(() => {
            const index = queue.indexOf(waiter);
            if (index === -1) return;
            queue.splice(index, 1);
            reject(busy(Date.now() - enqueuedAt));
          }, maxWaitMs),
        };
        queue.push(waiter);
      });
    },
    snapshot(): AiLimiterSnapshot {
      return { running, queued: queue.length };
    },
  };
}
