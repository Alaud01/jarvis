interface SaveJob {
  revision: string;
  write: () => Promise<unknown>;
}

interface SaveEntry {
  pending?: SaveJob;
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  failures: number;
}

/** Coalesces pending snapshots; only successful writes acknowledge a revision. */
export class SaveQueue {
  private readonly entries = new Map<string, SaveEntry>();
  private readonly confirmed = new Map<string, string>();

  constructor(
    private readonly delayMs: number,
    private readonly onError: (key: string, error: unknown) => void,
    private readonly retryMs = 1_000,
  ) {}

  seed(key: string, revision: string): void {
    if (!this.entries.has(key)) this.confirmed.set(key, revision);
  }

  schedule(key: string, revision: string, write: () => Promise<unknown>): void {
    const existing = this.entries.get(key);
    if (existing?.pending?.revision === revision) return;
    // A newer snapshot can revert to the confirmed revision while a write is
    // in flight. It must still be written after that in-flight snapshot.
    if (!existing && this.confirmed.get(key) === revision) return;
    const entry = existing ?? { failures: 0 };
    entry.pending = { revision, write };
    this.entries.set(key, entry);
    this.arm(key, entry, this.delayMs);
  }

  cancel(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    if (entry) entry.pending = undefined;
    this.entries.delete(key);
    this.confirmed.delete(key);
  }

  hasPending(key: string): boolean {
    return this.entries.has(key);
  }

  private arm(key: string, entry: SaveEntry, delay: number): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.drain(key, entry).catch(() => undefined);
    }, delay);
  }

  private async drain(key: string, entry: SaveEntry): Promise<void> {
    if (entry.running) {
      await entry.running;
      // Another waiter may have started the next revision after this write.
      // Recheck ownership before taking a pending job.
      return this.drain(key, entry);
    }
    if (this.entries.get(key) !== entry || !entry.pending) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    const job = entry.pending;
    entry.running = Promise.resolve().then(async () => {
      try {
        if (this.entries.get(key) !== entry) return;
        await job.write();
        if (this.entries.get(key) !== entry) return;
        this.confirmed.set(key, job.revision);
        entry.failures = 0;
        if (entry.pending === job) entry.pending = undefined;
      } catch (error) {
        if (this.entries.get(key) === entry) {
          entry.failures += 1;
          this.onError(key, error);
        }
        throw error;
      } finally {
        entry.running = undefined;
        if (this.entries.get(key) === entry) {
          if (entry.pending) {
            this.arm(key, entry, entry.failures
              ? Math.min(30_000, this.retryMs * 2 ** Math.min(entry.failures - 1, 5))
              : this.delayMs);
          } else {
            this.entries.delete(key);
          }
        }
      }
    });
    await entry.running;
  }

  /** Flushes through snapshots arriving during an in-flight write. Failures stay queued. */
  async flush(): Promise<void> {
    while (this.entries.size > 0) {
      const results = await Promise.allSettled(
        [...this.entries].map(([key, entry]) => this.drain(key, entry)),
      );
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  }
}

/** Immutable snapshots make unchanged background conversations a constant-time lookup. */
export function memoizeRevision<T extends object>(calculate: (value: T) => string): (value: T) => string {
  const cache = new WeakMap<T, string>();
  return value => {
    let revision = cache.get(value);
    if (revision === undefined) {
      revision = calculate(value);
      cache.set(value, revision);
    }
    return revision;
  };
}
