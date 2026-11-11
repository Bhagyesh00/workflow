/**
 * P6-48 (L1): every tenant's policies in memory, loaded on first use, reloaded after a write commits
 * (`invalidate`, then the bus channel `type-policies` tells the other mains and workers, the pattern of
 * services/secrets/manager.ts RELOAD_CHANNEL) and after a 30 s TTL. Every role starts and stops it.
 * A load that an invalidation overtook is not kept (the next read loads again), so a stale picture never
 * outlives the write that made it stale. A load that fails throws: callers fail closed.
 */
import { randomUUID } from 'node:crypto';
import type { ServiceDeps } from '../../context';
import type { TenantTypePolicyRows } from '../../repositories/type-policies';
import type { EvaluationFacts } from './evaluator';
import { type PackageIndex, typeFactsOf } from './package-index';
import { documentFromRow, scopeFromRow, unwrittenScope } from './store';
import type { PolicyDocument, PolicyKind, PolicyScope, TenantPolicySnapshot } from './types';

/** the bus channel of a policy write */
export const TYPE_POLICIES_CHANNEL = 'type-policies';
/** a snapshot older than this is reloaded on its next read */
export const POLICY_SNAPSHOT_TTL_MS = 30_000;

/** the tenant's rows as one snapshot: a workspace scope per kind (unwritten: allow, version 0) and the project scopes */
function buildSnapshot(tenantId: string, rows: TenantTypePolicyRows, loadedAt: number): TenantPolicySnapshot {
  const attachments = new Map<string, TenantTypePolicyRows['attachments']>();
  for (const row of rows.attachments) {
    const list = attachments.get(row.scopeId) ?? [];
    list.push(row);
    attachments.set(row.scopeId, list);
  }
  const workspace = {
    node: unwrittenScope(tenantId, 'node', null),
    credential: unwrittenScope(tenantId, 'credential', null),
  } satisfies Record<PolicyKind, PolicyScope>;
  const projects: Record<PolicyKind, Map<string, PolicyScope>> = { node: new Map(), credential: new Map() };
  for (const row of rows.scopes) {
    const scope = scopeFromRow(row, attachments.get(row.id) ?? []);
    if (row.projectId === null) workspace[row.kind] = scope;
    else projects[row.kind].set(row.projectId, scope);
  }
  const policies = new Map<string, PolicyDocument>();
  for (const row of rows.policies) policies.set(row.id, documentFromRow(row));
  return { tenantId, workspace, projects, policies, loadedAt };
}

export class PolicySnapshots {
  private readonly cache = new Map<string, TenantPolicySnapshot>();
  private readonly loading = new Map<string, Promise<TenantPolicySnapshot>>();
  /** per tenant, raised by every invalidation: a load that started before it is not kept */
  private readonly generation = new Map<string, number>();
  private readonly instanceId = randomUUID();
  private unsubscribe: (() => void) | undefined;

  constructor(
    readonly deps: ServiceDeps,
    /** built once from the loaded packages (context.ts) */
    readonly packageIndex: PackageIndex,
  ) {}

  /** the evaluator's facts for one type: package and base from the index, the tenant's documents from `snapshot` */
  factsFor(
    snapshot: TenantPolicySnapshot,
    kind: PolicyKind,
    type: string,
    ancestors?: string[],
  ): EvaluationFacts {
    return { ...typeFactsOf(this.packageIndex, kind, type, ancestors), policies: snapshot.policies };
  }

  async forTenant(tenantId: string): Promise<TenantPolicySnapshot> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.loadedAt < POLICY_SNAPSHOT_TTL_MS) return cached;
    const running = this.loading.get(tenantId);
    if (running) return running;
    const load: Promise<TenantPolicySnapshot> = this.load(tenantId).finally(() => {
      if (this.loading.get(tenantId) === load) this.loading.delete(tenantId);
    });
    this.loading.set(tenantId, load);
    return load;
  }

  private async load(tenantId: string): Promise<TenantPolicySnapshot> {
    const before = this.generation.get(tenantId) ?? 0;
    const rows = await this.deps.repos.typePolicies.loadTenant(tenantId);
    const snapshot = buildSnapshot(tenantId, rows, Date.now());
    if ((this.generation.get(tenantId) ?? 0) === before) this.cache.set(tenantId, snapshot);
    return snapshot;
  }

  /** drops the tenant's snapshot here and on every other process (after the write committed) */
  async invalidate(tenantId: string): Promise<void> {
    this.drop(tenantId);
    // a bus that fails leaves the other processes to their 30 s TTL
    await this.deps
      .context()
      .bus.publish(TYPE_POLICIES_CHANNEL, { tenantId, origin: this.instanceId })
      .catch(() => {});
  }

  private drop(tenantId: string): void {
    this.generation.set(tenantId, (this.generation.get(tenantId) ?? 0) + 1);
    this.cache.delete(tenantId);
    this.loading.delete(tenantId);
  }

  /** subscribes to `type-policies` */
  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = await this.deps.context().bus.subscribe(TYPE_POLICIES_CHANNEL, (message) => {
      const { tenantId, origin } = (message ?? {}) as Record<string, unknown>;
      if (typeof tenantId !== 'string' || origin === this.instanceId) return;
      this.drop(tenantId);
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cache.clear();
    this.loading.clear();
  }
}
