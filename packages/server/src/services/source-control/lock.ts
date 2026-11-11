/**
 * P6-73 (L2): the per-tenant Git lease (`source_control_settings.locked_until`, 5 minutes, whole milliseconds). A
 * second caller gets 409. `extend()` moves the lease 5 minutes on while the caller still holds its own `until`,
 * else `GitLeaseLostError` (409); `release()` clears only the caller's own lease. Status, push and pull (L4) hold
 * it and extend it between steps.
 * stub (L2): `acquireLease` throws; `GitLeaseLostError` is final.
 */
import type { ServiceDeps } from '../../context';
import { ApiError } from '../../http/errors';

/** the lease length */
export const SOURCE_CONTROL_LEASE_MS = 5 * 60_000;

export interface SourceControlLease {
  extend(): Promise<void>;
  release(): Promise<void>;
}

/** the lease expired and another caller took it: the operation stops (409) */
export class GitLeaseLostError extends ApiError {
  constructor() {
    super(
      409,
      'source_control_lease_lost',
      'Another source control operation took over this workspace. Try again.',
    );
    this.name = 'GitLeaseLostError';
  }
}

/** stub (L2): throws until L2 writes the lease */
export function acquireLease(_deps: ServiceDeps, _tenantId: string): Promise<SourceControlLease> {
  throw new Error('not implemented (L2)');
}
