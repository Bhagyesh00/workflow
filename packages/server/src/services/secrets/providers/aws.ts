/**
 * AWS Secrets Manager (P4-08). Access keys of an IAM user only: the host's own AWS identity is never
 * used. The host is built from a validated region, so a settings value cannot point the call elsewhere.
 * ListSecrets for the names, BatchGetSecretValue in batches of 20 for the values; only SecretString is kept.
 */

import type { SecretProviderDeps, SecretProviderSettings, SecretProviderType } from '../types';
import { signAwsRequest } from './aws-sigv4';
import {
  asArray,
  asObject,
  MemoryProvider,
  requireSettings,
  SecretProviderError,
  settingString,
  TEXT_BAD_SETTINGS,
  text,
  vaultCall,
} from './errors';

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const SERVICE = 'secretsmanager';
const BATCH = 20;
/** a vault with more names than this is cut off, so a refresh stays bounded */
const MAX_SECRETS = 10_000;

export function awsHost(region: string): string {
  if (!REGION.test(region)) throw new SecretProviderError(TEXT_BAD_SETTINGS);
  return `secretsmanager.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`;
}

class AwsSecretsProvider extends MemoryProvider {
  private host = '';
  private region = '';
  private accessKeyId = '';
  private secretAccessKey = '';

  async init(): Promise<void> {
    this.region = settingString(this.settings, 'region');
    this.accessKeyId = settingString(this.settings, 'accessKeyId');
    this.secretAccessKey = settingString(this.settings, 'secretAccessKey');
    if (settingString(this.settings, 'authentication', 'iamUser') !== 'iamUser') {
      throw new SecretProviderError(TEXT_BAD_SETTINGS);
    }
    requireSettings(this.region, this.accessKeyId, this.secretAccessKey);
    this.host = awsHost(this.region);
  }

  private async call(action: string, payload: Record<string, unknown>, timeoutMs: number) {
    const body = JSON.stringify(payload);
    const signed = signAwsRequest({
      method: 'POST',
      url: `https://${this.host}/`,
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `secretsmanager.${action}`,
      },
      body,
      region: this.region,
      service: SERVICE,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
    });
    const answer = await vaultCall(
      this.deps,
      { url: `https://${this.host}/`, method: 'POST', headers: signed.headers, body, bodyType: 'raw' },
      timeoutMs,
    );
    return asObject(answer.body);
  }

  async connect(): Promise<void> {
    await this.call('ListSecrets', { MaxResults: 1 }, this.deps.connectTimeoutMs);
  }

  protected async readAll(): Promise<Map<string, unknown>> {
    const names: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.call(
        'ListSecrets',
        { MaxResults: 100, ...(token ? { NextToken: token } : {}) },
        this.deps.refreshTimeoutMs,
      );
      for (const entry of asArray(page.SecretList)) {
        const name = text((entry as Record<string, unknown>)?.Name);
        if (name) names.push(name);
      }
      token = text(page.NextToken) || undefined;
    } while (token && names.length < MAX_SECRETS);

    const secrets = new Map<string, unknown>();
    for (let i = 0; i < names.length; i += BATCH) {
      const page = await this.call(
        'BatchGetSecretValue',
        { SecretIdList: names.slice(i, i + BATCH) },
        this.deps.refreshTimeoutMs,
      );
      for (const entry of asArray(page.SecretValues)) {
        const e = entry as Record<string, unknown>;
        const name = text(e?.Name);
        if (name && typeof e.SecretString === 'string') secrets.set(name, e.SecretString);
      }
    }
    return secrets;
  }

  protected forget(): void {
    this.accessKeyId = '';
    this.secretAccessKey = '';
  }
}

export const awsSecretProviderType: SecretProviderType = {
  name: 'awsSecretsManager',
  displayName: 'AWS Secrets Manager',
  properties: [
    {
      displayName: 'Region',
      name: 'region',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'eu-west-1',
      description: 'The AWS region of the secrets',
    },
    {
      displayName: 'Authentication Method',
      name: 'authentication',
      type: 'options',
      default: 'iamUser',
      options: [{ name: 'IAM User', value: 'iamUser', description: 'Access keys of an IAM user' }],
    },
    {
      displayName: 'Access Key ID',
      name: 'accessKeyId',
      type: 'string',
      default: '',
      required: true,
      displayOptions: { show: { authentication: ['iamUser'] } },
    },
    {
      displayName: 'Secret Access Key',
      name: 'secretAccessKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      displayOptions: { show: { authentication: ['iamUser'] } },
    },
  ],
  create(settings: SecretProviderSettings, deps: SecretProviderDeps) {
    return new AwsSecretsProvider(settings, deps);
  },
};
