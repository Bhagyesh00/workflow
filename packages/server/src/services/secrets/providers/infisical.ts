/**
 * Infisical (P4-08) over REST with universal auth. Secrets of the path win over the same key in an
 * import. The token is renewed by signing in again shortly before it ends.
 */

import type { SecretProviderDeps, SecretProviderSettings, SecretProviderType } from '../types';
import {
  asArray,
  asObject,
  joinUrl,
  MemoryProvider,
  parseBaseUrl,
  requireSettings,
  SecretProviderError,
  settingString,
  TEXT_BAD_ANSWER,
  text,
  vaultCall,
} from './errors';

class InfisicalProvider extends MemoryProvider {
  private base?: URL;
  private clientId = '';
  private clientSecret = '';
  private projectId = '';
  private environment = '';
  private secretPath = '/';
  private token = '';
  private tokenUntil = 0;

  async init(): Promise<void> {
    const site = settingString(this.settings, 'siteUrl', 'https://app.infisical.com');
    this.clientId = settingString(this.settings, 'clientId');
    this.clientSecret = settingString(this.settings, 'clientSecret');
    this.projectId = settingString(this.settings, 'projectId');
    this.environment = settingString(this.settings, 'environment', 'dev');
    this.secretPath = settingString(this.settings, 'secretPath', '/') || '/';
    requireSettings(
      site,
      this.clientId,
      this.clientSecret,
      this.projectId,
      this.environment,
      this.secretPath,
    );
    this.base = parseBaseUrl(site);
  }

  private url(...segments: string[]): string {
    if (!this.base) throw new Error('not initialised');
    return joinUrl(this.base, ...segments);
  }

  private async accessToken(timeoutMs: number): Promise<string> {
    if (this.token && Date.now() < this.tokenUntil - 30_000) return this.token;
    const answer = await vaultCall(
      this.deps,
      {
        url: this.url('api', 'v1', 'auth', 'universal-auth', 'login'),
        method: 'POST',
        body: { clientId: this.clientId, clientSecret: this.clientSecret },
      },
      timeoutMs,
    );
    const body = asObject(answer.body);
    const token = text(body.accessToken);
    if (!token) throw new SecretProviderError(TEXT_BAD_ANSWER);
    this.token = token;
    this.tokenUntil = Date.now() + (typeof body.expiresIn === 'number' ? body.expiresIn : 3600) * 1000;
    return token;
  }

  private async list(timeoutMs: number): Promise<Record<string, unknown>> {
    const token = await this.accessToken(timeoutMs);
    const answer = await vaultCall(
      this.deps,
      {
        url: this.url('api', 'v4', 'secrets'),
        qs: {
          projectId: this.projectId,
          environment: this.environment,
          secretPath: this.secretPath,
          expandSecretReferences: true,
          includeImports: true,
        },
        headers: { authorization: `Bearer ${token}` },
      },
      timeoutMs,
    );
    return asObject(answer.body);
  }

  async connect(): Promise<void> {
    await this.list(this.deps.connectTimeoutMs);
  }

  protected async readAll(): Promise<Map<string, unknown>> {
    const body = await this.list(this.deps.refreshTimeoutMs);
    const secrets = new Map<string, unknown>();
    const take = (entries: unknown[], overwrite: boolean): void => {
      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        const key = text(e?.secretKey);
        if (key && typeof e.secretValue === 'string' && (overwrite || !secrets.has(key))) {
          secrets.set(key, e.secretValue);
        }
      }
    };
    take(asArray(body.secrets), true);
    for (const imported of asArray(body.imports)) {
      take(asArray((imported as Record<string, unknown>)?.secrets), false);
    }
    return secrets;
  }

  protected forget(): void {
    this.token = '';
    this.tokenUntil = 0;
    this.clientSecret = '';
  }
}

export const infisicalSecretProviderType: SecretProviderType = {
  name: 'infisical',
  displayName: 'Infisical',
  properties: [
    {
      displayName: 'Site URL',
      name: 'siteUrl',
      type: 'string',
      default: 'https://app.infisical.com',
      required: true,
    },
    { displayName: 'Project ID', name: 'projectId', type: 'string', default: '', required: true },
    { displayName: 'Environment', name: 'environment', type: 'string', default: 'dev', required: true },
    { displayName: 'Secret Path', name: 'secretPath', type: 'string', default: '/' },
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'universalAuth',
      options: [{ name: 'Universal Auth', value: 'universalAuth' }],
    },
    {
      displayName: 'Client ID',
      name: 'clientId',
      type: 'string',
      default: '',
      required: true,
      displayOptions: { show: { authentication: ['universalAuth'] } },
    },
    {
      displayName: 'Client Secret',
      name: 'clientSecret',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      displayOptions: { show: { authentication: ['universalAuth'] } },
    },
  ],
  create(settings: SecretProviderSettings, deps: SecretProviderDeps) {
    return new InfisicalProvider(settings, deps);
  },
};
