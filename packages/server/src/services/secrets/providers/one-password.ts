/**
 * 1Password Connect (P4-08) over REST: vaults, items, and each item's fields. A secret is an item's
 * title and its value an object of field label to value (`$secrets.<connection>.<item>.<field>`).
 */

import type { SecretProviderDeps, SecretProviderSettings, SecretProviderType } from '../types';
import {
  asArray,
  asObject,
  joinUrl,
  MemoryProvider,
  mapLimit,
  parseBaseUrl,
  requireSettings,
  settingString,
  text,
  vaultCall,
} from './errors';

const READ_CONCURRENCY = 10;
const MAX_ITEMS = 10_000;

class OnePasswordProvider extends MemoryProvider {
  private base?: URL;
  private token = '';

  async init(): Promise<void> {
    const url = settingString(this.settings, 'connectUrl');
    this.token = settingString(this.settings, 'token');
    requireSettings(url, this.token);
    this.base = parseBaseUrl(url);
  }

  private get(segments: string[], timeoutMs: number) {
    if (!this.base) throw new Error('not initialised');
    return vaultCall(
      this.deps,
      { url: joinUrl(this.base, 'v1', ...segments), headers: { authorization: `Bearer ${this.token}` } },
      timeoutMs,
    );
  }

  async connect(): Promise<void> {
    await this.get(['vaults'], this.deps.connectTimeoutMs);
  }

  protected async readAll(): Promise<Map<string, unknown>> {
    const timeout = this.deps.refreshTimeoutMs;
    const vaults = asArray((await this.get(['vaults'], timeout)).body);
    const refs: Array<{ vault: string; item: string }> = [];
    for (const vault of vaults) {
      const vaultId = text((vault as Record<string, unknown>)?.id);
      if (!vaultId) continue;
      const items = asArray((await this.get(['vaults', vaultId, 'items'], timeout)).body);
      for (const item of items) {
        const itemId = text((item as Record<string, unknown>)?.id);
        if (itemId && refs.length < MAX_ITEMS) refs.push({ vault: vaultId, item: itemId });
      }
    }

    const secrets = new Map<string, unknown>();
    const read = await mapLimit(refs, READ_CONCURRENCY, async (ref) =>
      asObject((await this.get(['vaults', ref.vault, 'items', ref.item], timeout)).body),
    );
    for (const item of read) {
      const title = text(item.title);
      if (!title) continue;
      const fields: Record<string, string> = {};
      for (const field of asArray(item.fields)) {
        const f = field as Record<string, unknown>;
        const label = text(f?.label);
        if (label && typeof f.value === 'string') fields[label] = f.value;
      }
      secrets.set(title, fields);
    }
    return secrets;
  }

  protected forget(): void {
    this.token = '';
  }
}

export const onePasswordSecretProviderType: SecretProviderType = {
  name: 'onepassword',
  displayName: '1Password Connect',
  properties: [
    {
      displayName: 'Connect Server URL',
      name: 'connectUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://connect.example.com',
      description: 'The URL of your 1Password Connect server',
    },
    {
      displayName: 'Access Token',
      name: 'token',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
  ],
  create(settings: SecretProviderSettings, deps: SecretProviderDeps) {
    return new OnePasswordProvider(settings, deps);
  },
};
