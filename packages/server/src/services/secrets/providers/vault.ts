/**
 * HashiCorp Vault (P4-08) over REST: token, username and password, or AppRole; KV version 1 and 2;
 * mounts given or found through sys/mounts; an optional namespace. Folders are listed with
 * `GET ...?list=true`, and a secret's value is its key/value object. A secret's name always starts with
 * its mount, as n8n: `$secrets.<connection>['<mount>/<path>'].<key>`.
 * A token that has a lifetime is renewed at half of it, or the sign-in is repeated.
 */

import type { SecretProviderDeps, SecretProviderSettings, SecretProviderType } from '../types';
import {
  asArray,
  asObject,
  isPlain,
  joinUrl,
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

const READ_CONCURRENCY = 50;
const MAX_SECRETS = 10_000;
const MAX_DEPTH = 10;
const TEXT_MOUNTS = "Couldn't list mounts. Please give these credentials 'read' access to sys/mounts.";
const TEXT_NO_AUTH = 'Could not find auth path. Try adding /v1/ to the end of your base URL.';

interface Mount {
  /** path of the mount, no slashes at the ends */
  path: string;
  version: 1 | 2;
}

class VaultProvider extends MemoryProvider {
  private base?: URL;
  private namespace = '';
  private method = 'token';
  private token = '';
  /** when to renew, epoch ms; 0 for a token that never ends */
  private renewAt = 0;
  private renewable = false;
  private explicitMount = false;

  async init(): Promise<void> {
    const url = settingString(this.settings, 'url');
    this.namespace = settingString(this.settings, 'namespace');
    this.method = settingString(this.settings, 'authMethod', 'token');
    requireSettings(url);
    if (this.namespace && !isPlain(this.namespace)) {
      throw new SecretProviderError(TEXT_BAD_SETTINGS);
    }
    if (this.method === 'token') requireSettings(settingString(this.settings, 'token'));
    else if (this.method === 'usernameAndPassword') {
      requireSettings(settingString(this.settings, 'username'), settingString(this.settings, 'password'));
    } else if (this.method === 'appRole') {
      requireSettings(settingString(this.settings, 'roleId'), settingString(this.settings, 'secretId'));
    } else throw new SecretProviderError(TEXT_BAD_SETTINGS);
    const base = parseBaseUrl(url);
    // the API root ends in /v1/; the base is kept with its path
    this.base = base;
    this.explicitMount = settingString(this.settings, 'kvMountPath').replace(/^\/+|\/+$/g, '') !== '';
  }

  private headers(): Record<string, string> {
    return {
      'x-vault-token': this.token,
      ...(this.namespace ? { 'x-vault-namespace': this.namespace } : {}),
    };
  }

  private url(segments: string[]): string {
    if (!this.base) throw new Error('not initialised');
    return joinUrl(this.base, ...segments);
  }

  private async login(timeoutMs: number): Promise<void> {
    const headers = this.namespace ? { 'x-vault-namespace': this.namespace } : undefined;
    if (this.method === 'token') {
      this.token = settingString(this.settings, 'token');
      const answer = await vaultCall(
        this.deps,
        { url: this.url(['auth', 'token', 'lookup-self']), headers: this.headers() },
        timeoutMs,
        [404],
      );
      if (answer.status === 404) throw new SecretProviderError(TEXT_NO_AUTH);
      const data = asObject(asObject(answer.body).data);
      this.setLifetime(typeof data.ttl === 'number' ? data.ttl : 0, data.renewable === true);
      return;
    }
    const path =
      this.method === 'appRole'
        ? ['auth', 'approle', 'login']
        : ['auth', 'userpass', 'login', settingString(this.settings, 'username')];
    const body =
      this.method === 'appRole'
        ? {
            role_id: settingString(this.settings, 'roleId'),
            secret_id: settingString(this.settings, 'secretId'),
          }
        : { password: settingString(this.settings, 'password') };
    const answer = await vaultCall(
      this.deps,
      { url: this.url(path), method: 'POST', headers, body },
      timeoutMs,
      [404],
    );
    if (answer.status === 404) throw new SecretProviderError(TEXT_NO_AUTH);
    const auth = asObject(asObject(answer.body).auth);
    const token = text(auth.client_token);
    if (!token) throw new SecretProviderError(TEXT_BAD_ANSWER);
    this.token = token;
    this.setLifetime(
      typeof auth.lease_duration === 'number' ? auth.lease_duration : 0,
      auth.renewable === true,
    );
  }

  private setLifetime(ttlSeconds: number, renewable: boolean): void {
    this.renewable = renewable;
    this.renewAt = ttlSeconds > 0 ? Date.now() + (ttlSeconds * 1000) / 2 : 0;
  }

  /** before a read: renew a token that is half spent, or sign in again */
  private async ensureToken(timeoutMs: number): Promise<void> {
    if (!this.token) return this.login(timeoutMs);
    if (!this.renewAt || Date.now() < this.renewAt) return;
    if (this.renewable) {
      try {
        const answer = await vaultCall(
          this.deps,
          {
            url: this.url(['auth', 'token', 'renew-self']),
            method: 'POST',
            headers: this.headers(),
            body: {},
          },
          timeoutMs,
        );
        const auth = asObject(asObject(answer.body).auth);
        this.setLifetime(typeof auth.lease_duration === 'number' ? auth.lease_duration : 0, true);
        return;
      } catch {
        // a renewal that fails falls through to a new sign-in
      }
    }
    await this.login(timeoutMs);
  }

  async connect(): Promise<void> {
    this.token = '';
    await this.login(this.deps.connectTimeoutMs);
  }

  private async get(
    segments: string[],
    qs: Record<string, unknown> | undefined,
    timeoutMs: number,
    allow: number[] = [],
  ) {
    await this.ensureToken(timeoutMs);
    return vaultCall(this.deps, { url: this.url(segments), qs, headers: this.headers() }, timeoutMs, allow);
  }

  private async mounts(timeoutMs: number): Promise<Mount[]> {
    const version = settingString(this.settings, 'kvVersion', 'v2') === 'v1' ? 1 : 2;
    if (this.explicitMount) {
      return [{ path: settingString(this.settings, 'kvMountPath').replace(/^\/+|\/+$/g, ''), version }];
    }
    let answer: Awaited<ReturnType<VaultProvider['get']>>;
    try {
      answer = await this.get(['sys', 'mounts'], undefined, timeoutMs);
    } catch (error) {
      if ((error as Error).message === 'The vault answered 403') throw new SecretProviderError(TEXT_MOUNTS);
      throw error;
    }
    const root = asObject(answer.body);
    // the mounts are under `data`, and in older servers also at the top
    const list = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
    const found: Mount[] = [];
    for (const [key, value] of Object.entries(list)) {
      const mount = value as { type?: unknown; options?: { version?: unknown } } | null;
      if (!mount || typeof mount !== 'object' || !key.endsWith('/')) continue;
      if (mount.type !== 'kv' && mount.type !== 'generic') continue;
      found.push({
        path: key.replace(/\/+$/, ''),
        version: mount.type === 'kv' && String(mount.options?.version ?? '1') === '2' ? 2 : 1,
      });
    }
    return found;
  }

  /** every secret path under `folder`, relative to the mount */
  private async walk(
    mount: Mount,
    folder: string,
    depth: number,
    out: string[],
    timeoutMs: number,
  ): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_SECRETS) return;
    const segments = mount.version === 2 ? [mount.path, 'metadata', folder] : [mount.path, folder];
    const answer = await this.get(segments, { list: true }, timeoutMs, [404]);
    if (answer.status === 404) return;
    const keys = asArray(asObject(asObject(answer.body).data).keys);
    for (const key of keys) {
      if (typeof key !== 'string' || !key || key.includes('..')) continue;
      const path = folder ? `${folder.replace(/\/+$/, '')}/${key}` : key;
      if (key.endsWith('/')) await this.walk(mount, path, depth + 1, out, timeoutMs);
      else out.push(path);
    }
  }

  protected async readAll(): Promise<Map<string, unknown>> {
    const timeout = this.deps.refreshTimeoutMs;
    const mounts = await this.mounts(timeout);
    const start = settingString(this.settings, 'kvSecretPath').replace(/^\/+/, '');
    const refs: Array<{ mount: Mount; path: string }> = [];
    for (const mount of mounts) {
      const paths: string[] = [];
      await this.walk(mount, start, 0, paths, timeout);
      for (const path of paths) refs.push({ mount, path });
    }

    const secrets = new Map<string, unknown>();
    const values = await mapLimit(refs, READ_CONCURRENCY, async ({ mount, path }) => {
      const segments = mount.version === 2 ? [mount.path, 'data', path] : [mount.path, path];
      const answer = await this.get(segments, undefined, timeout, [403, 404]);
      if (answer.status !== 200) return undefined;
      const data = asObject(asObject(answer.body).data);
      return mount.version === 2 ? asObject(data.data) : data;
    });
    refs.forEach((ref, index) => {
      const value = values[index];
      if (!value) return;
      secrets.set(`${ref.mount.path}/${ref.path}`, value);
    });
    return secrets;
  }

  protected forget(): void {
    this.token = '';
    this.renewAt = 0;
  }
}

export const vaultSecretProviderType: SecretProviderType = {
  name: 'vault',
  displayName: 'HashiCorp Vault',
  properties: [
    {
      displayName: 'Vault URL',
      name: 'url',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://vault.example.com/v1/',
      description: 'The API root of the server, ending in /v1/',
    },
    {
      displayName: 'Namespace',
      name: 'namespace',
      type: 'string',
      default: '',
      description: 'Only for Vault Enterprise namespaces',
    },
    {
      displayName: 'Authentication Method',
      name: 'authMethod',
      type: 'options',
      default: 'token',
      options: [
        { name: 'Token', value: 'token' },
        { name: 'Username and Password', value: 'usernameAndPassword' },
        { name: 'AppRole', value: 'appRole' },
      ],
    },
    {
      displayName: 'Token',
      name: 'token',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      displayOptions: { show: { authMethod: ['token'] } },
    },
    {
      displayName: 'Username',
      name: 'username',
      type: 'string',
      default: '',
      required: true,
      displayOptions: { show: { authMethod: ['usernameAndPassword'] } },
    },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      displayOptions: { show: { authMethod: ['usernameAndPassword'] } },
    },
    {
      displayName: 'Role ID',
      name: 'roleId',
      type: 'string',
      default: '',
      required: true,
      displayOptions: { show: { authMethod: ['appRole'] } },
    },
    {
      displayName: 'Secret ID',
      name: 'secretId',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      displayOptions: { show: { authMethod: ['appRole'] } },
    },
    {
      displayName: 'KV Mount Path',
      name: 'kvMountPath',
      type: 'string',
      default: '',
      placeholder: 'secret',
      description: 'Leave empty to find the KV mounts through sys/mounts',
    },
    {
      displayName: 'KV Version',
      name: 'kvVersion',
      type: 'options',
      default: 'v2',
      options: [
        { name: 'v1', value: 'v1' },
        { name: 'v2', value: 'v2' },
      ],
      description: 'Used with a KV mount path; found mounts report their own version',
    },
    {
      displayName: 'KV Secret Path',
      name: 'kvSecretPath',
      type: 'string',
      default: '',
      description: 'A folder to start from; empty reads the whole mount',
    },
  ],
  create(settings: SecretProviderSettings, deps: SecretProviderDeps) {
    return new VaultProvider(settings, deps);
  },
};
