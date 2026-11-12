/**
 * P6-63 (L7): events a destination could not take (`log_stream_failed`), kept per destination for a replay in
 * id order and pruned by age (7 days). The event is stored as sent (already anonymized), never with a secret.
 * stub (L7): the constructor passes, every method throws.
 */
import type { DbOrTx } from '../db/client';
import type { LogStreamFailedRow } from '../db/schema';

export class LogStreamFailedRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** stub (L7): stores one failed event of the tenant's destination */
  add(
    _tenantId: string,
    _destinationId: string,
    _eventId: string,
    _event: Record<string, unknown>,
    _lastError?: string | null,
  ): Promise<void> {
    throw new Error('not implemented (L7)');
  }

  /** stub (L7): the oldest `limit` failed events of a destination, in id order */
  listOldest(_tenantId: string, _destinationId: string, _limit: number): Promise<LogStreamFailedRow[]> {
    throw new Error('not implemented (L7)');
  }

  /** stub (L7): removes the given rows of the tenant (after a successful resend); returns how many */
  remove(_tenantId: string, _ids: number[]): Promise<number> {
    throw new Error('not implemented (L7)');
  }

  /** stub (L7): removes every row created before `before` (the Pruner's 7 day rule); returns how many */
  pruneBefore(_before: Date): Promise<number> {
    throw new Error('not implemented (L7)');
  }
}
