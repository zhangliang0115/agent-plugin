/**
 * Admission control for the tool calls of one run_code program. Calls start in
 * submission order. A parallel call starts unless an exclusive call is running;
 * an exclusive call starts only when nothing else is running. Nothing is shared
 * across runs, agents or sessions, and nothing is held while a call waits for a
 * user answer, because only running calls count. @module
 */
import { ToolCallError } from '@agent-plugin/code-mode-core';

/** How a call may overlap with the others of its run. */
export type CallMode = 'parallel' | 'exclusive';

interface Waiter {
  readonly classify: () => CallMode;
  readonly signal: AbortSignal;
  readonly start: (release: () => void) => void;
  readonly onAbort: () => void;
}

/** Raised for a call that was still queued when its run ended. */
function abortedBeforeDispatch(): Error {
  return new ToolCallError('the run ended before this tool call started', { code: 'ABORTED_BEFORE_DISPATCH', name: 'AbortError' });
}

export class RunScheduler {
  private readonly queue: Waiter[] = [];
  private running = 0;
  private exclusiveRunning = false;

  /**
   * Wait for a turn. Resolves with the function that gives the turn back; it is safe to call twice.
   * The call is queued before this method returns, so submission order is the order of `acquire` calls.
   * `classify` is read again each time the call reaches the head of the queue.
   */
  acquire(classify: () => CallMode, signal: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortedBeforeDispatch());
        return;
      }
      const waiter: Waiter = {
        classify,
        signal,
        start: (release) => resolve(release),
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(abortedBeforeDispatch());
          this.admit();
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
      this.admit();
    });
  }

  private admit(): void {
    for (;;) {
      const head = this.queue[0];
      if (head === undefined) return;
      const mode = this.modeOf(head);
      if (mode === 'exclusive' ? this.running > 0 : this.exclusiveRunning) return;
      this.queue.shift();
      head.signal.removeEventListener('abort', head.onAbort);
      this.running++;
      if (mode === 'exclusive') this.exclusiveRunning = true;
      let released = false;
      head.start(() => {
        if (released) return;
        released = true;
        this.running--;
        if (mode === 'exclusive') this.exclusiveRunning = false;
        this.admit();
      });
    }
  }

  /** A classifier that throws is treated as exclusive, the safe choice. */
  private modeOf(waiter: Waiter): CallMode {
    try {
      return waiter.classify();
    } catch {
      return 'exclusive';
    }
  }
}
