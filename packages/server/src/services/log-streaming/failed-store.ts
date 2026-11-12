/**
 * P6-63 (S5 C0 stub, L7 fills it): events a destination could not take (a failed send or an open breaker), kept in
 * `log_stream_failed` and replayed when the breaker closes or the destination reloads; the Pruner drops old rows.
 * stub (L7): PASSES: `add` keeps nothing, `replay` and `prune` return 0.
 */
import type { ServiceDeps } from '../../context';
import type { StreamEvent } from '../events/stream';

export class FailedEventStore {
  constructor(readonly deps: ServiceDeps) {}

  /** stub (L7): PASSES (keeps nothing) */
  async add(_tenantId: string, _destinationId: string, _event: StreamEvent, _error: string): Promise<void> {}

  /** stub (L7): PASSES (replays nothing): sends the kept events oldest first, returns how many went out */
  async replay(
    _tenantId: string,
    _destinationId: string,
    _send: (event: StreamEvent) => Promise<void>,
  ): Promise<number> {
    return 0;
  }

  /** stub (L7): PASSES (drops nothing): removes rows older than the retention, returns how many */
  async prune(_now: Date): Promise<number> {
    return 0;
  }
}
