/**
 * External secrets manager (P4-07): the registry of provider types, the per-tenant connections and
 * the cache of live providers on every main and worker process. The type registry is real. `start`
 * and `stop` are no-ops until L9 because boot and close call them; everything else throws 501.
 */
import type { ServiceDeps } from '../../context';
import { ApiError } from '../../http/errors';
import { SECRET_PROVIDER_TYPES } from './providers';
import type {
  SecretActor,
  SecretConnectionCreateInput,
  SecretConnectionDTO,
  SecretConnectionTestResult,
  SecretConnectionUpdateInput,
  SecretProviderType,
} from './types';

const notBuilt = () => new ApiError(501, 'not_built', 'not built');

export interface SecretsManagerOptions {
  /** added to the six; one with the same name replaces it (tests add a fake vault) */
  secretProviderTypes?: SecretProviderType[];
}

export class SecretsManager {
  private readonly types = new Map<string, SecretProviderType>();

  constructor(
    readonly deps: ServiceDeps,
    options: SecretsManagerOptions = {},
  ) {
    for (const type of [...SECRET_PROVIDER_TYPES, ...(options.secretProviderTypes ?? [])]) {
      this.types.set(type.name, type);
    }
  }

  /** Load the cache, start the refresh timer and the bus reload. Runs before jobs start. */
  async start(): Promise<void> {
    // L9
  }

  /** Stop the timer and disconnect every provider. */
  async stop(): Promise<void> {
    // L9
  }

  listTypes(): SecretProviderType[] {
    return [...this.types.values()];
  }

  getType(name: string): SecretProviderType | undefined {
    return this.types.get(name);
  }

  async listConnections(_tenantId: string): Promise<SecretConnectionDTO[]> {
    throw notBuilt();
  }

  async getConnection(_tenantId: string, _providerKey: string): Promise<SecretConnectionDTO> {
    throw notBuilt();
  }

  async createConnection(
    _tenantId: string,
    _input: SecretConnectionCreateInput,
    _actor?: SecretActor,
  ): Promise<SecretConnectionDTO> {
    throw notBuilt();
  }

  async updateConnection(
    _tenantId: string,
    _providerKey: string,
    _input: SecretConnectionUpdateInput,
    _actor?: SecretActor,
  ): Promise<SecretConnectionDTO> {
    throw notBuilt();
  }

  async deleteConnection(_tenantId: string, _providerKey: string, _actor?: SecretActor): Promise<void> {
    throw notBuilt();
  }

  async testConnection(
    _tenantId: string,
    _providerKey: string,
    _actor?: SecretActor,
  ): Promise<SecretConnectionTestResult> {
    throw notBuilt();
  }

  async reloadConnection(
    _tenantId: string,
    _providerKey: string,
    _actor?: SecretActor,
  ): Promise<{ success: boolean }> {
    throw notBuilt();
  }

  /** names only, never values: `{<providerKey>: [secret names]}` */
  async completions(_tenantId: string): Promise<Record<string, string[]>> {
    throw notBuilt();
  }

  /** the `$secrets` object of a tenant, only for reading credential data (resolver.ts) */
  secretsFor(_tenantId: string): Record<string, Record<string, unknown>> {
    throw notBuilt();
  }
}
