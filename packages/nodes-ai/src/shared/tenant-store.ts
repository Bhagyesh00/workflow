/**
 * Bounded in-process stores keyed by tenant. Used by the window buffer memory and the in-memory
 * vector store: one tenant can never read another tenant's keys, and size caps keep a single
 * tenant from exhausting a worker's heap. Caps are on keys and, optionally, on bytes: when a
 * tenant passes its byte budget its least recently used keys are evicted (never the key being
 * written), so the newest data always survives.
 */

export interface TenantStoreOptions<T = unknown> {
  /** keys per tenant; least recently used keys are evicted */
  maxKeysPerTenant: number;
  /** tenants held; least recently used tenants are evicted */
  maxTenants: number;
  /** approximate bytes one tenant may hold; needs `sizeOf` */
  maxBytesPerTenant?: number;
  /** approximate size in bytes of a stored value; read again on `settle` for values that grow in place */
  sizeOf?: (value: T) => number;
}

export class TenantStore<T> {
  private readonly tenants = new Map<string, Map<string, T>>();

  constructor(private readonly options: TenantStoreOptions<T>) {}

  get(tenantId: string, key: string): T | undefined {
    const tenant = this.touchTenant(tenantId, false);
    const value = tenant?.get(key);
    if (value !== undefined && tenant) {
      tenant.delete(key);
      tenant.set(key, value);
    }
    return value;
  }

  getOrCreate(tenantId: string, key: string, create: () => T): T {
    const existing = this.get(tenantId, key);
    if (existing !== undefined) return existing;
    const value = create();
    this.set(tenantId, key, value);
    return value;
  }

  /** Throws when the value alone is larger than the tenant's whole byte budget. */
  set(tenantId: string, key: string, value: T): void {
    const { maxBytesPerTenant, sizeOf } = this.options;
    if (maxBytesPerTenant !== undefined && sizeOf) {
      const bytes = sizeOf(value);
      if (bytes > maxBytesPerTenant) {
        throw new Error(
          `A value of ${bytes} bytes is larger than the per-tenant budget of ${maxBytesPerTenant} bytes`,
        );
      }
    }
    const tenant = this.touchTenant(tenantId, true)!;
    tenant.delete(key);
    tenant.set(key, value);
    while (tenant.size > this.options.maxKeysPerTenant) {
      tenant.delete(tenant.keys().next().value as string);
    }
    this.enforceBudget(tenant, key);
  }

  /** Call after a stored value grew in place: evicts other keys of the tenant until it fits its byte budget. */
  settle(tenantId: string, key: string): void {
    const tenant = this.tenants.get(tenantId);
    if (tenant?.has(key)) this.enforceBudget(tenant, key);
  }

  /** approximate bytes held by one tenant (0 without a `sizeOf`) */
  bytesUsed(tenantId: string): number {
    const tenant = this.tenants.get(tenantId);
    return tenant ? this.tenantBytes(tenant) : 0;
  }

  delete(tenantId: string, key: string): void {
    this.tenants.get(tenantId)?.delete(key);
  }

  /** keys of one tenant (most recently used last) */
  keys(tenantId: string): string[] {
    return [...(this.tenants.get(tenantId)?.keys() ?? [])];
  }

  clear(): void {
    this.tenants.clear();
  }

  private tenantBytes(tenant: Map<string, T>): number {
    const { sizeOf } = this.options;
    if (!sizeOf) return 0;
    let total = 0;
    for (const value of tenant.values()) total += sizeOf(value);
    return total;
  }

  private enforceBudget(tenant: Map<string, T>, keep: string): void {
    const { maxBytesPerTenant, sizeOf } = this.options;
    if (maxBytesPerTenant === undefined || !sizeOf) return;
    let total = this.tenantBytes(tenant);
    for (const [key, value] of tenant) {
      if (total <= maxBytesPerTenant) return;
      if (key === keep) continue;
      total -= sizeOf(value);
      tenant.delete(key);
    }
  }

  private touchTenant(tenantId: string, create: boolean): Map<string, T> | undefined {
    if (!tenantId) throw new Error('A tenant id is required');
    let tenant = this.tenants.get(tenantId);
    if (tenant) {
      this.tenants.delete(tenantId);
      this.tenants.set(tenantId, tenant);
      return tenant;
    }
    if (!create) return undefined;
    tenant = new Map();
    this.tenants.set(tenantId, tenant);
    while (this.tenants.size > this.options.maxTenants) {
      this.tenants.delete(this.tenants.keys().next().value as string);
    }
    return tenant;
  }
}
