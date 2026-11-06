/**
 * The providers of this process that can answer a read, per tenant (P4-07). Secret values live inside
 * them, in memory only. Each main and worker keeps its own; a tenant only ever sees its own map.
 */
import type { SecretsView } from './proxy';
import type { SecretProvider } from './types';

export class SecretsCache {
  private readonly tenants = new Map<string, Map<string, SecretProvider>>();

  get(tenantId: string, providerKey: string): SecretProvider | undefined {
    return this.tenants.get(tenantId)?.get(providerKey);
  }

  /** the provider it replaces, for the caller to disconnect */
  set(tenantId: string, providerKey: string, provider: SecretProvider): SecretProvider | undefined {
    let providers = this.tenants.get(tenantId);
    if (!providers) {
      providers = new Map();
      this.tenants.set(tenantId, providers);
    }
    const previous = providers.get(providerKey);
    providers.set(providerKey, provider);
    return previous;
  }

  /** the provider it took out, for the caller to disconnect */
  delete(tenantId: string, providerKey: string): SecretProvider | undefined {
    const providers = this.tenants.get(tenantId);
    const previous = providers?.get(providerKey);
    providers?.delete(providerKey);
    if (providers?.size === 0) this.tenants.delete(tenantId);
    return previous;
  }

  names(tenantId: string, providerKey: string): string[] {
    return this.get(tenantId, providerKey)?.getSecretNames() ?? [];
  }

  /** one tenant's providers, as `$secrets` reads them */
  view(tenantId: string): SecretsView {
    return {
      keys: () => [...(this.tenants.get(tenantId)?.keys() ?? [])],
      provider: (providerKey) => this.get(tenantId, providerKey),
    };
  }

  /** every provider, emptied out */
  clear(): SecretProvider[] {
    const all = [...this.tenants.values()].flatMap((providers) => [...providers.values()]);
    this.tenants.clear();
    return all;
  }
}
