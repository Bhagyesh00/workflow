/**
 * P6-48 (L1): every tenant's policies in memory, loaded on first use, reloaded after a write commits
 * (`invalidate`, then the bus channel `type-policies` tells the other mains and workers, the pattern of
 * services/secrets/manager.ts RELOAD_CHANNEL) and after a 30 s TTL. Every role starts and stops it.
 * Stub from C0: `start`, `stop` and `invalidate` PASS; `forTenant` throws until L1.
 */
import type { ServiceDeps } from '../../context';
import type { PackageIndex } from './package-index';
import type { TenantPolicySnapshot } from './types';

/** the bus channel of a policy write */
export const TYPE_POLICIES_CHANNEL = 'type-policies';
/** a snapshot older than this is reloaded on its next read */
export const POLICY_SNAPSHOT_TTL_MS = 30_000;

export class PolicySnapshots {
  constructor(
    readonly deps: ServiceDeps,
    /** built once from the loaded packages (context.ts) */
    readonly packageIndex: PackageIndex,
  ) {}

  async forTenant(_tenantId: string): Promise<TenantPolicySnapshot> {
    // stub (L1)
    throw new Error('not implemented (L1)');
  }

  /** drops the tenant's snapshot here and on every other process (after the write committed) */
  async invalidate(_tenantId: string): Promise<void> {
    // stub (L1): PASSES, nothing is cached yet
  }

  /** subscribes to `type-policies` */
  async start(): Promise<void> {
    // stub (L1): PASSES
  }

  async stop(): Promise<void> {
    // stub (L1): PASSES
  }
}
