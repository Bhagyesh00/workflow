/** Polling for vendor jobs (video, async image tasks). */

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Call `check` every `intervalMs` until `done` holds for its value, which is returned. Stops on `signal`;
 * after `timeoutMs` fails with `timeoutText`.
 */
export async function pollUntil<T>(
  check: () => Promise<T>,
  done: (value: T) => boolean,
  options: { intervalMs: number; timeoutMs: number; signal?: AbortSignal; timeoutText: string },
): Promise<T> {
  const { intervalMs, timeoutMs, signal, timeoutText } = options;
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    const value = await check();
    if (done(value)) return value;
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) throw new Error(timeoutText);
    await sleep(Math.min(Math.max(intervalMs, 1), left), signal);
  }
}
