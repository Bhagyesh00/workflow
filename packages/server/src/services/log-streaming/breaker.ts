/**
 * P6-06 (S5 L3): the circuit breaker of one destination, n8n's defaults: 5 failures in 60 s open it for 3
 * minutes, then it half-opens and lets 2 requests through, one at a time; both good and it closes, one bad and it
 * opens again. One breaker per destination, driven by that destination's single sender loop.
 */
import { type CircuitBreakerSettings, DEFAULT_CIRCUIT_BREAKER } from '@workflow/workflow';

export type BreakerState = 'closed' | 'open' | 'half-open';

/** how long an open breaker waits before it half-opens (n8n's default) */
export const BREAKER_OPEN_MS = 180_000;
/** the requests a half-open breaker lets through before it closes (n8n's default) */
export const BREAKER_HALF_OPEN_REQUESTS = 2;

export class CircuitBreaker {
  private current: BreakerState = 'closed';
  private failures: number[] = [];
  private openedAt = 0;
  private halfOpenGood = 0;
  private inFlight = false;

  constructor(
    readonly settings: CircuitBreakerSettings = DEFAULT_CIRCUIT_BREAKER,
    readonly now: () => number = Date.now,
  ) {}

  /** the state now: an open breaker whose time is up reads as half-open */
  get state(): BreakerState {
    if (this.current === 'open' && this.now() - this.openedAt >= BREAKER_OPEN_MS) {
      this.current = 'half-open';
      this.halfOpenGood = 0;
      this.inFlight = false;
    }
    return this.current;
  }

  /** true when a send may go out now; a half-open breaker lets one request through at a time */
  canSend(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.inFlight) return false;
    this.inFlight = true;
    return true;
  }

  recordSuccess(): void {
    if (this.state !== 'half-open') return;
    this.inFlight = false;
    this.halfOpenGood += 1;
    if (this.halfOpenGood >= BREAKER_HALF_OPEN_REQUESTS) {
      this.current = 'closed';
      this.failures = [];
      this.halfOpenGood = 0;
    }
  }

  /** returns true when this failure opened the breaker */
  recordFailure(): boolean {
    const at = this.now();
    const state = this.state;
    if (state === 'half-open') {
      this.open(at);
      return true;
    }
    if (state === 'open') return false;
    this.failures = this.failures.filter((time) => at - time < this.settings.failureWindowMs);
    this.failures.push(at);
    if (this.failures.length >= this.settings.maxFailures) {
      this.open(at);
      return true;
    }
    return false;
  }

  private open(at: number): void {
    this.current = 'open';
    this.openedAt = at;
    this.failures = [];
    this.halfOpenGood = 0;
    this.inFlight = false;
  }
}
