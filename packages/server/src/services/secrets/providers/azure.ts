/**
 * Azure Key Vault (P4-08) over REST with client credentials. The token endpoint and the vault host come
 * from the chosen cloud; tenant, client and vault name are checked as safe path parts. A secret that
 * cannot be read is skipped; if none can be read the refresh fails.
 */

import { clientCredentialsRequest, parseAccessToken } from '@workflow/core';
import type { SecretProviderDeps, SecretProviderSettings, SecretProviderType } from '../types';
import {
  asArray,
  asObject,
  MemoryProvider,
  mapLimit,
  parseBaseUrl,
  requireSettings,
  SecretProviderError,
  settingString,
  TEXT_BAD_ANSWER,
  TEXT_BAD_SETTINGS,
  text,
  vaultCall,
} from './errors';

const API_VERSION = '7.4';
const READ_CONCURRENCY = 10;
const MAX_SECRETS = 10_000;
const VAULT_NAME = /^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const CLIENT = /^[A-Za-z0-9._-]{1,128}$/;
const SECRET_NAME = /^[A-Za-z0-9-]{1,127}$/;

interface Cloud {
  /** vault host suffix: https://<name>.<suffix> */
  vaultSuffix: string;
  authority: string;
}

const CLOUDS: Record<string, Cloud> = {
  public: { vaultSuffix: 'vault.azure.net', authority: 'https://login.microsoftonline.com' },
  usGovernment: { vaultSuffix: 'vault.usgovcloudapi.net', authority: 'https://login.microsoftonline.us' },
  china: { vaultSuffix: 'vault.azure.cn', authority: 'https://login.partner.microsoftonline.cn' },
};

class AzureKeyVaultProvider extends MemoryProvider {
  private vaultOrigin = '';
  private authority = '';
  private scope = '';
  private tenantId = '';
  private clientId = '';
  private clientSecret = '';
  private token = '';
  private tokenUntil = 0;

  async init(): Promise<void> {
    const cloud = settingString(this.settings, 'cloud', 'public');
    this.tenantId = settingString(this.settings, 'tenantId');
    this.clientId = settingString(this.settings, 'clientId');
    this.clientSecret = settingString(this.settings, 'clientSecret');
    requireSettings(this.tenantId, this.clientId, this.clientSecret);
    if (!TENANT.test(this.tenantId) || !CLIENT.test(this.clientId)) {
      throw new SecretProviderError(TEXT_BAD_SETTINGS);
    }
    if (cloud === 'custom') {
      const vault = parseBaseUrl(settingString(this.settings, 'vaultUrl'));
      const authority = parseBaseUrl(settingString(this.settings, 'authorityHost'));
      this.vaultOrigin = vault.origin;
      this.authority = authority.origin;
      // the resource is the vault host without its name label
      this.scope = `https://${vault.hostname.split('.').slice(1).join('.') || vault.hostname}/.default`;
    } else {
      const known = CLOUDS[cloud];
      const name = settingString(this.settings, 'vaultName');
      if (!known || !VAULT_NAME.test(name)) throw new SecretProviderError(TEXT_BAD_SETTINGS);
      this.vaultOrigin = `https://${name}.${known.vaultSuffix}`;
      this.authority = known.authority;
      this.scope = `https://${known.vaultSuffix}/.default`;
    }
  }

  private async accessToken(timeoutMs: number): Promise<string> {
    if (this.token && Date.now() < this.tokenUntil - 60_000) return this.token;
    const answer = await vaultCall(
      this.deps,
      clientCredentialsRequest({
        tokenUrl: `${this.authority}/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        scope: this.scope,
      }),
      timeoutMs,
    );
    try {
      const { token, expiresInSeconds } = parseAccessToken(answer.body);
      this.token = token;
      this.tokenUntil = Date.now() + expiresInSeconds * 1000;
      return token;
    } catch {
      throw new SecretProviderError(TEXT_BAD_ANSWER);
    }
  }

  private async get(pathAndQuery: string, timeoutMs: number, allow: number[] = []) {
    const token = await this.accessToken(timeoutMs);
    return vaultCall(
      this.deps,
      { url: `${this.vaultOrigin}${pathAndQuery}`, headers: { authorization: `Bearer ${token}` } },
      timeoutMs,
      allow,
    );
  }

  async connect(): Promise<void> {
    await this.get(`/secrets?api-version=${API_VERSION}&maxresults=1`, this.deps.connectTimeoutMs);
  }

  protected async readAll(): Promise<Map<string, unknown>> {
    const timeout = this.deps.refreshTimeoutMs;
    const names: string[] = [];
    let next = `/secrets?api-version=${API_VERSION}`;
    while (next && names.length < MAX_SECRETS) {
      const page = asObject((await this.get(next, timeout)).body);
      for (const entry of asArray(page.value)) {
        const e = entry as { id?: unknown; attributes?: { enabled?: unknown } };
        if (e?.attributes?.enabled === false) continue;
        const id = text(e?.id);
        const name = id.slice(id.lastIndexOf('/') + 1);
        if (SECRET_NAME.test(name)) names.push(name);
      }
      // the next page is asked of the same vault, whatever host the link names
      next = '';
      const link = text(page.nextLink);
      if (link) {
        try {
          const url = new URL(link);
          next = `${url.pathname}${url.search}`;
        } catch {
          next = '';
        }
      }
    }

    const secrets = new Map<string, unknown>();
    await mapLimit(names, READ_CONCURRENCY, async (name) => {
      const answer = await this.get(
        `/secrets/${name}?api-version=${API_VERSION}`,
        timeout,
        [401, 403, 404, 409, 429, 503],
      );
      if (answer.status !== 200) return;
      const value = asObject(answer.body).value;
      if (typeof value === 'string') secrets.set(name, value);
    });
    if (names.length && !secrets.size) {
      throw new SecretProviderError('Could not read any secrets from Azure Key Vault');
    }
    return secrets;
  }

  protected forget(): void {
    this.token = '';
    this.tokenUntil = 0;
    this.clientSecret = '';
  }
}

export const azureSecretProviderType: SecretProviderType = {
  name: 'azureKeyVault',
  displayName: 'Azure Key Vault',
  properties: [
    {
      displayName: 'Azure Cloud',
      name: 'cloud',
      type: 'options',
      default: 'public',
      options: [
        { name: 'Azure (Public)', value: 'public' },
        { name: 'Azure US Government', value: 'usGovernment' },
        { name: 'Azure China', value: 'china' },
        { name: 'Custom', value: 'custom' },
      ],
    },
    {
      displayName: 'Vault Name',
      name: 'vaultName',
      type: 'string',
      default: '',
      required: true,
      displayOptions: { hide: { cloud: ['custom'] } },
    },
    {
      displayName: 'Vault URL',
      name: 'vaultUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://my-vault.vault.example.net',
      displayOptions: { show: { cloud: ['custom'] } },
    },
    {
      displayName: 'Authority Host',
      name: 'authorityHost',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://login.example.net',
      displayOptions: { show: { cloud: ['custom'] } },
    },
    { displayName: 'Tenant ID', name: 'tenantId', type: 'string', default: '', required: true },
    {
      displayName: 'Client ID',
      name: 'clientId',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
    {
      displayName: 'Client Secret',
      name: 'clientSecret',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
  ],
  create(settings: SecretProviderSettings, deps: SecretProviderDeps) {
    return new AzureKeyVaultProvider(settings, deps);
  },
};
