/**
 * P6-73 (L2): the per-tenant Git lease (`source_control_settings.locked_until`, 5 minutes, whole milliseconds). A
 * second caller gets 409. `extend()` moves the lease 5 minutes on while the caller still holds its own `until`,
 * else `GitLeaseLostError` (409); `release()` clears only the caller's own lease. Status, push and pull (L4) hold
 * it and extend it between steps. The lease is one conditional update (`tryLock`); no transaction is held over a
 * network call.
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

/** a lease end in whole milliseconds, so the equality in `extendLock` and `unlock` holds after the round trip */
function leaseEnd(): Date {
  return new Date(Math.floor(Date.now()) + SOURCE_CONTROL_LEASE_MS);
}

const busy = () =>
  new ApiError(
    409,
    'source_control_busy',
    'Another source control operation is running in this workspace. Try again in a moment.',
  );

function leaseOf(deps: ServiceDeps, tenantId: string, first: Date): SourceControlLease {
  const repo = deps.repos.sourceControl;
  let held: Date | null = first;
  return {
    async extend() {
      if (!held) throw new GitLeaseLostError();
      const next = leaseEnd();
      if (!(await repo.extendLock(tenantId, held, next))) throw new GitLeaseLostError();
      held = next;
    },
    async release() {
      if (!held) return;
      const current = held;
      held = null;
      await repo.unlock(tenantId, current);
    },
  };
}

/**
 * takes the workspace's lease: 412 when source control is not connected, 409 `source_control_busy` while another
 * operation holds it
 */
export async function acquireLease(deps: ServiceDeps, tenantId: string): Promise<SourceControlLease> {
  const context = deps.context();
  await context.sourceControl.requireConnected(tenantId);
  const first = await deps.repos.sourceControl.tryLock(tenantId, leaseEnd());
  if (!first) throw busy();
  return leaseOf(deps, tenantId, first);
}

/**
 * the lease for a settings change (a disconnect, a branch change): taken whether or not the workspace is connected,
 * 409 `source_control_busy` while a status, push or pull holds it. A workspace with no settings row has no operation
 * to wait for, so it answers null.
 */
export async function acquireSettingsLease(
  deps: ServiceDeps,
  tenantId: string,
): Promise<SourceControlLease | null> {
  if (!(await deps.repos.sourceControl.get(tenantId))) return null;
  const first = await deps.repos.sourceControl.tryLock(tenantId, leaseEnd());
  if (!first) throw busy();
  return leaseOf(deps, tenantId, first);
}
