/** Polling for vendor jobs (video, async image tasks). L1 fills it; the signature is final. */

/**
 * Call `check` every `intervalMs` until `done` holds for its value, which is returned. Stops on `signal`;
 * after `timeoutMs` fails with `timeoutText`.
 */
export async function pollUntil<T>(
  _check: () => Promise<T>,
  _done: (value: T) => boolean,
  _options: { intervalMs: number; timeoutMs: number; signal?: AbortSignal; timeoutText: string },
): Promise<T> {
  throw new Error('not implemented (L1)');
}
