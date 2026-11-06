/**
 * GCP Secret Manager (P4-08) over REST. The service account key signs an RS256 JWT, and the token is
 * fetched from a fixed URL: the key file's own `token_uri` is never used. A secret that is denied,
 * missing or unavailable is skipped; any other failure stops the refresh.
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import type { SecretProviderDeps, SecretProviderSettings, SecretProviderType } from '../types';
import {
  asArray,
  asObject,
  MemoryProvider,
  mapLimit,
  SecretProviderError,
  settingString,
  TEXT_BAD_ANSWER,
  TEXT_BAD_SETTINGS,
  text,
  vaultCall,
} from './errors';

export const GCP_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://secretmanager.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SECRET_NAME = /^[A-Za-z0-9_-]{1,255}$/;
const SKIPPED = [403, 404, 503];
const READ_CONCURRENCY = 10;
const MAX_SECRETS = 10_000;

const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

class GcpSecretsProvider extends MemoryProvider {
  private email = '';
  private projectId = '';
  private key?: KeyObject;
  private token = '';
  private tokenUntil = 0;

  async init(): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = asObject(JSON.parse(settingString(this.settings, 'serviceAccountKey')));
    } catch {
      throw new SecretProviderError(TEXT_BAD_SETTINGS);
    }
    const email = text(parsed.client_email);
    const projectId = text(parsed.project_id);
    if (!email || !PROJECT.test(projectId) || !text(parsed.private_key)) {
      throw new SecretProviderError(TEXT_BAD_SETTINGS);
    }
    try {
      this.key = createPrivateKey(text(parsed.private_key));
    } catch {
      throw new SecretProviderError(TEXT_BAD_SETTINGS);
    }
    this.email = email;
    this.projectId = projectId;
  }

  private assertion(): string {
    if (!this.key) throw new SecretProviderError(TEXT_BAD_SETTINGS);
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({ iss: this.email, scope: SCOPE, aud: GCP_TOKEN_URL, iat: now, exp: now + 3600 }),
    );
    const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(this.key);
    return `${head}.${claims}.${b64url(signature)}`;
  }

  private async accessToken(timeoutMs: number): Promise<string> {
    if (this.token && Date.now() < this.tokenUntil - 60_000) return this.token;
    const answer = await vaultCall(
      this.deps,
      {
        url: GCP_TOKEN_URL,
        method: 'POST',
        bodyType: 'form-urlencoded',
        body: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: this.assertion() },
      },
      timeoutMs,
    );
    const body = asObject(answer.body);
    const token = text(body.access_token);
    if (!token) throw new SecretProviderError(TEXT_BAD_ANSWER);
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.token = token;
    this.tokenUntil = Date.now() + seconds * 1000;
    return token;
  }

  private async get(path: string, qs: Record<string, unknown>, timeoutMs: number, allow: number[] = []) {
    const token = await this.accessToken(timeoutMs);
    return vaultCall(
      this.deps,
      { url: `${API}/${path}`, qs, headers: { authorization: `Bearer ${token}` } },
      timeoutMs,
      allow,
    );
  }

  private get project(): string {
    return `projects/${encodeURIComponent(this.projectId)}`;
  }

  async connect(): Promise<void> {
    await this.get(`${this.project}/secrets`, { pageSize: 1 }, this.deps.connectTimeoutMs);
  }

  protected async readAll(): Promise<Map<string, unknown>> {
    const timeout = this.deps.refreshTimeoutMs;
    const names: string[] = [];
    let pageToken = '';
    do {
      const answer = await this.get(
        `${this.project}/secrets`,
        { pageSize: 250, ...(pageToken ? { pageToken } : {}) },
        timeout,
      );
      const page = asObject(answer.body);
      for (const entry of asArray(page.secrets)) {
        const full = text((entry as Record<string, unknown>)?.name);
        const name = full.slice(full.lastIndexOf('/') + 1);
        if (SECRET_NAME.test(name)) names.push(name);
      }
      pageToken = text(page.nextPageToken);
    } while (pageToken && names.length < MAX_SECRETS);

    const secrets = new Map<string, unknown>();
    await mapLimit(names, READ_CONCURRENCY, async (name) => {
      const answer = await this.get(
        `${this.project}/secrets/${name}/versions/latest:access`,
        {},
        timeout,
        SKIPPED,
      );
      if (answer.status !== 200) return;
      const payload = asObject(asObject(answer.body).payload);
      if (typeof payload.data === 'string') {
        secrets.set(name, Buffer.from(payload.data, 'base64').toString('utf8'));
      }
    });
    return secrets;
  }

  protected forget(): void {
    this.token = '';
    this.tokenUntil = 0;
    this.key = undefined;
  }
}

export const gcpSecretProviderType: SecretProviderType = {
  name: 'gcpSecretsManager',
  displayName: 'GCP Secret Manager',
  properties: [
    {
      displayName: 'Service Account Key',
      name: 'serviceAccountKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true, rows: 6 },
      description: 'The JSON key file of a service account that can read the secrets',
    },
  ],
  create(settings: SecretProviderSettings, deps: SecretProviderDeps) {
    return new GcpSecretsProvider(settings, deps);
  },
};
