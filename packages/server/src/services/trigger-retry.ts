/**
 * What keeps event triggers alive (P4-21, as n8n's activation queue): a workflow whose trigger failed
 * is started again after 1 s, doubling up to 1 day; and a close function can never hold a stop for
 * longer than 10 s.
 */
export const TRIGGER_RETRY_FIRST_MS = 1_000;
export const TRIGGER_RETRY_MAX_MS = 86_400_000;
export const TRIGGER_CLOSE_TIMEOUT_MS = 10_000;

interface QueuedRetry {
  delayMs: number;
  timer: NodeJS.Timeout;
}

/** one retry timer per workflow; only `clear` starts the delay over */
export class TriggerRetryQueue {
  private readonly queued = new Map<string, QueuedRetry>();

  /** arm the next attempt, replacing a timer still waiting; returns the delay it waits */
  schedule(workflowId: string, retry: () => void): number {
    const previous = this.queued.get(workflowId);
    if (previous) clearTimeout(previous.timer);
    const delayMs = previous ? Math.min(previous.delayMs * 2, TRIGGER_RETRY_MAX_MS) : TRIGGER_RETRY_FIRST_MS;
    const timer = setTimeout(retry, delayMs);
    timer.unref();
    this.queued.set(workflowId, { delayMs, timer });
    return delayMs;
  }

  /** still queued: its timer waits, or its attempt runs and has not reported back */
  has(workflowId: string): boolean {
    return this.queued.has(workflowId);
  }

  clear(workflowId: string): void {
    const queued = this.queued.get(workflowId);
    if (!queued) return;
    clearTimeout(queued.timer);
    this.queued.delete(workflowId);
  }

  clearAll(): void {
    for (const workflowId of [...this.queued.keys()]) this.clear(workflowId);
  }
}

/** run a trigger's close function; rejects when it fails or has not finished within the bound */
export function closeBounded(
  close: () => Promise<void> | void,
  timeoutMs = TRIGGER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The trigger did not close within ${timeoutMs / 1000} seconds`)),
      timeoutMs,
    );
    timer.unref();
    Promise.resolve()
      .then(close)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
