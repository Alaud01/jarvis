export type QuitChoice = 'retry' | 'cancel' | 'quit';

interface QuitDependencies {
  flushRenderer: () => Promise<void>;
  flushStorage: () => Promise<void>;
  confirm: (error: unknown, signal: AbortSignal) => Promise<QuitChoice>;
  beginShutdown: () => void;
  stopServices: () => Promise<void>;
  exit: (forced: boolean) => void;
  report: (error: unknown) => void;
}

function bounded(work: () => Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (failed: boolean, error?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (failed) reject(error);
      else resolve();
    };
    const aborted = () => finish(true, new Error('Termination requested.'));
    const timer = setTimeout(() => finish(true, new Error('Shutdown deadline exceeded.')), timeoutMs);
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    void Promise.resolve().then(work).then(() => finish(false), error => finish(true, error));
  });
}

/** One quit attempt at a time; termination signals can escalate an open dialog. */
export class QuitCoordinator {
  private pending?: Promise<void>;
  private forced = false;
  private readonly termination = new AbortController();

  constructor(
    private readonly dependencies: QuitDependencies,
    private readonly saveTimeoutMs = 10_000,
    private readonly cleanupTimeoutMs = 10_000,
  ) {}

  request(terminate = false): Promise<void> {
    if (terminate) {
      this.forced = true;
      this.termination.abort();
    }
    if (!this.pending) {
      this.pending = this.run().finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  private async run(): Promise<void> {
    const d = this.dependencies;
    while (!this.forced) {
      try {
        await bounded(d.flushRenderer, this.saveTimeoutMs, this.termination.signal);
        await bounded(d.flushStorage, this.cleanupTimeoutMs, this.termination.signal);
        break;
      } catch (error) {
        if (this.forced) break;
        let choice: QuitChoice;
        try {
          choice = await d.confirm(error, this.termination.signal);
        } catch (dialogError) {
          d.report(dialogError);
          if (!this.forced) return;
          break;
        }
        if (this.forced) break;
        if (choice === 'cancel') return;
        if (choice === 'quit') { this.forced = true; break; }
      }
    }

    d.beginShutdown();
    // Even when the renderer is lost, attempt writes already received by main.
    // Start service cleanup immediately even when a storage write is stuck.
    const cleanup = await Promise.allSettled([
      bounded(d.flushStorage, this.cleanupTimeoutMs),
      bounded(d.stopServices, this.cleanupTimeoutMs),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') {
        d.report(result.reason);
        this.forced = true;
      }
    }
    d.exit(this.forced);
  }
}
