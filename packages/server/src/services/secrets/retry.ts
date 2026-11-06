/** Backoff and time limits of vault calls (P4-07), as n8n: 10 s doubling to 5 min, jittered to 50-100 percent. */

const BASE_MS = 10_000;
const MAX_MS = 5 * 60_000;

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_MS, BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** `message` is a fixed text: it ends up in lastError. The work is not stopped, only no longer waited for. */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    timer.unref();
  });
  // a call that fails after the limit must not become an unhandled rejection
  work.catch(() => {});
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export class TimeoutError extends Error {
  override name = 'TimeoutError';
}
