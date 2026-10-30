/**
 * Retries for model / embedding API calls: 408, 409, 429 and 5xx responses plus network errors are
 * retried with exponential backoff and jitter, honouring `Retry-After` (capped).
 */
import { sleep } from '@workflow/workflow';

export interface RetryOptions {
  maxRetries: number;
  signal?: AbortSignal;
  /** first backoff in milliseconds */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

export function httpStatusOf(error: unknown): number | undefined {
  const code = (error as { httpCode?: string | number; statusCode?: number } | null)?.httpCode;
  const status = code ?? (error as { statusCode?: number } | null)?.statusCode;
  const n = Number(status);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function isRetryable(error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== undefined) return RETRYABLE_STATUS.has(status) || status >= 500;
  const message = `${(error as Error)?.name ?? ''} ${(error as Error)?.message ?? ''}`;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|other side closed|timed out/i.test(
    message,
  );
}

export function backoffDelay(attempt: number, error: unknown, base = 500, max = 30_000): number {
  const exponential = Math.min(base * 2 ** attempt, max) * (0.8 + Math.random() * 0.4);
  const retryAfter = (error as { retryAfterMs?: number } | null)?.retryAfterMs;
  const delay = typeof retryAfter === 'number' && retryAfter > exponential ? retryAfter : exponential;
  return Math.round(Math.min(delay, max));
}

export async function withRetries<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const maxRetries = Math.max(0, Math.min(options.maxRetries, 10));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error) || options.signal?.aborted) throw error;
      await sleep(backoffDelay(attempt, error, options.baseDelayMs, options.maxDelayMs), options.signal);
    }
  }
}
