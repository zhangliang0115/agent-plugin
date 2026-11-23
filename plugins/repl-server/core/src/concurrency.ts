/** Concurrency primitives: per-server RW lock and a bounded semaphore. @module */

type Waiter = { kind: 'read' | 'write'; grant: () => void };

/**
 * FIFO read/write lock.
 * - `read` takes the shared lock; a queued writer blocks new readers.
 * - `write` takes the exclusive lock and waits for all readers to drain.
 */
export class RwLock {
  private readers = 0;
  private writer = false;
  private readonly queue: Waiter[] = [];

  async read<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.writer || this.queue.some((waiter) => waiter.kind === 'write')) {
      await new Promise<void>((resolve) => {
        this.queue.push({
          kind: 'read',
          grant: () => {
            this.readers += 1;
            resolve();
          },
        });
      });
    } else {
      this.readers += 1;
    }

    try {
      return await fn();
    } finally {
      this.readers -= 1;
      this.drain();
    }
  }

  async write<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.writer || this.readers > 0) {
      await new Promise<void>((resolve) => {
        this.queue.push({
          kind: 'write',
          grant: () => {
            this.writer = true;
            resolve();
          },
        });
      });
    } else {
      this.writer = true;
    }

    try {
      return await fn();
    } finally {
      this.writer = false;
      this.drain();
    }
  }

  get activeReaders(): number {
    return this.readers;
  }

  get writing(): boolean {
    return this.writer;
  }

  /**
   * Writers queued behind the current holder. Read-only observation used to
   * explain *why* a serial call waited; it never affects scheduling.
   */
  get pendingWriters(): number {
    let count = 0;
    for (const waiter of this.queue) {
      if (waiter.kind === 'write') count += 1;
    }
    return count;
  }

  private drain(): void {
    if (this.writer) return;
    const head = this.queue[0];
    if (head === undefined) return;

    if (head.kind === 'write') {
      if (this.readers === 0) {
        this.queue.shift();
        head.grant();
      }
      return;
    }

    while (this.queue[0]?.kind === 'read') {
      const waiter = this.queue.shift();
      waiter?.grant();
    }
  }
}

/** Counts running tasks and resolves waiters in FIFO order. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    this.limit = limit;
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }

    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next === undefined) {
        this.active -= 1;
      } else {
        next();
      }
    }
  }
}
