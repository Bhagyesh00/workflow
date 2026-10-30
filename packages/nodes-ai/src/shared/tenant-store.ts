/**
 * Bounded in-process stores keyed by tenant. Used by the window buffer memory and the in-memory
 * vector store: one tenant can never read another tenant's keys, and size caps keep a single
 * tenant from exhausting a worker's heap.
 */

export interface TenantStoreOptions {
  /** keys per tenant; least recently used keys are evicted */
  maxKeysPerTenant: number;
  /** tenants held; least recently used tenants are evicted */
  maxTenants: number;
}

export class TenantStore<T> {
  private readonly tenants = new Map<string, Map<string, T>>();

  constructor(private readonly options: TenantStoreOptions) {}

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

  set(tenantId: string, key: string, value: T): void {
    const tenant = this.touchTenant(tenantId, true)!;
    tenant.delete(key);
    tenant.set(key, value);
    while (tenant.size > this.options.maxKeysPerTenant) {
      tenant.delete(tenant.keys().next().value as string);
    }
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
