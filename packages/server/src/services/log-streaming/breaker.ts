/**
 * P6-06 (S5 C0 stub, L3 fills it): the circuit breaker of one destination, n8n's defaults: 5 failures in 60 s open
 * it for 3 minutes, then 2 half-open requests, 1 at a time. The constructor passes; the methods throw until L3.
 */
import { type CircuitBreakerSettings, DEFAULT_CIRCUIT_BREAKER } from '@workflow/workflow';

export type BreakerState = 'closed' | 'open' | 'half-open';

/** how long an open breaker waits before it half-opens (n8n's default) */
export const BREAKER_OPEN_MS = 180_000;
/** the requests a half-open breaker lets through before it closes (n8n's default) */
export const BREAKER_HALF_OPEN_REQUESTS = 2;

export class CircuitBreaker {
  constructor(
    readonly settings: CircuitBreakerSettings = DEFAULT_CIRCUIT_BREAKER,
    readonly now: () => number = Date.now,
  ) {}

  /** stub (L3) */
  get state(): BreakerState {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): true when a send may go out now */
  canSend(): boolean {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3) */
  recordSuccess(): void {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): returns true when this failure opened the breaker */
  recordFailure(): boolean {
    throw new Error('not implemented (L3)');
  }
}
