/** The six secret providers (P4-08): each reads a secret from a node:http fake of its vault, no database. */
import { generateKeyPairSync } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_PROVIDER_TYPES } from '../src/services/secrets/providers';
import { awsHost } from '../src/services/secrets/providers/aws';
import { GCP_TOKEN_URL } from '../src/services/secrets/providers/gcp';
import type { SecretProvider, SecretProviderDeps, SecretProviderType } from '../src/services/secrets/types';
import {
  awsHandler,
  azureHandler,
  type Fake,
  gcpHandler,
  type Handler,
  infisicalHandler,
  onePasswordHandler,
  reply,
  rewriteHttp,
  startFake,
  vaultHandler,
} from './fakes/vaults';

const noLog = { debug() {}, info() {}, warn() {}, error() {} };
const open: Fake[] = [];

async function fake(handler: Handler): Promise<Fake> {
  const started = await startFake(handler);
  open.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const allowLocal = () => new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });

function deps(http: HttpClient, extra: Partial<SecretProviderDeps> = {}): SecretProviderDeps {
  return { http, logger: noLog, connectTimeoutMs: 5000, refreshTimeoutMs: 5000, preferGet: false, ...extra };
}

function type(name: string): SecretProviderType {
  const found = SECRET_PROVIDER_TYPES.find((t) => t.name === name);
  if (!found) throw new Error(`no type ${name}`);
  return found;
}

async function ready(p: SecretProvider): Promise<SecretProvider> {
  await p.init();
  await p.connect();
  await p.update();
  return p;
}

describe('registry', () => {
  it('lists the six types with their password fields marked', () => {
    expect(SECRET_PROVIDER_TYPES.map((t) => t.name)).toEqual([
      'awsSecretsManager',
      'gcpSecretsManager',
      'azureKeyVault',
      'vault',
      'onepassword',
      'infisical',
    ]);
    const secretFields = (name: string) =>
      type(name)
        .properties.filter((p) => p.typeOptions?.password)
        .map((p) => p.name);
    expect(secretFields('awsSecretsManager')).toEqual(['secretAccessKey']);
    expect(secretFields('gcpSecretsManager')).toEqual(['serviceAccountKey']);
    expect(secretFields('azureKeyVault')).toEqual(['clientId', 'clientSecret']);
    expect(secretFields('vault')).toEqual(['token', 'password', 'secretId']);
    expect(secretFields('onepassword')).toEqual(['token']);
    expect(secretFields('infisical')).toEqual(['clientSecret']);
    for (const t of SECRET_PROVIDER_TYPES)
      expect(t.properties.every((p) => p.name && p.displayName)).toBe(true);
  });
});

describe('AWS Secrets Manager', () => {
  const keys = { accessKeyId: 'AKIDTEST', secretAccessKey: 'aws-secret-key-value' };
  const settings = (region: string) => ({ region, authentication: 'iamUser', ...keys });

  it('reads signed, in pages and batches of 20, and keeps only text secrets', async () => {
    const secrets: Record<string, string | { binary: true }> = { blob: { binary: true } };
    for (let i = 0; i < 44; i += 1) secrets[`s${i}`] = `v${i}`;
    const server = await fake((req, res) =>
      awsHandler({
        host: 'secretsmanager.eu-west-1.amazonaws.com',
        region: 'eu-west-1',
        ...keys,
        secrets,
        pageSize: 20,
      })(req, res),
    );
    const { http, asked } = rewriteHttp(allowLocal(), {
      'secretsmanager.eu-west-1.amazonaws.com': server.origin,
    });
    const provider = await ready(type('awsSecretsManager').create(settings('eu-west-1'), deps(http)));

    expect(provider.getSecret('s7')).toBe('v7');
    expect(provider.hasSecret('s43')).toBe(true);
    expect(provider.hasSecret('blob')).toBe(false);
    expect(provider.getSecretNames()).toHaveLength(44);
    expect(new Set(asked)).toEqual(new Set(['https://secretsmanager.eu-west-1.amazonaws.com/']));
    const targets = server.requests.map((r) => r.headers['x-amz-target']);
    expect(targets.filter((t) => t === 'secretsmanager.BatchGetSecretValue')).toHaveLength(3);
    expect(targets.filter((t) => t === 'secretsmanager.ListSecrets')).toHaveLength(1 + 3);
    expect(server.requests[0].headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/eu-west-1\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    expect(JSON.stringify(server.requests.map((r) => [r.url, r.body]))).not.toContain(keys.secretAccessKey);
  });

  it('builds the host from a validated region only', () => {
    expect(awsHost('us-east-1')).toBe('secretsmanager.us-east-1.amazonaws.com');
    expect(awsHost('cn-north-1')).toBe('secretsmanager.cn-north-1.amazonaws.com.cn');
    for (const bad of ['evil.com/x', 'us-east-1.evil.com', 'US-EAST-1', 'us-east-1@evil', 'x', '']) {
      expect(() => awsHost(bad)).toThrow('The connection settings are not valid');
    }
  });

  it('refuses bad settings without a request and tests with a fixed text', async () => {
    const server = await fake((_req, res) => reply(res, 200, {}));
    const { http } = rewriteHttp(allowLocal(), {});
    const bad = type('awsSecretsManager').create(settings('evil.com/x'), deps(http));
    await expect(bad.init()).rejects.toMatchObject({ name: 'SecretProviderError' });
    expect((await bad.test()).error).toBe('The connection settings are not valid');
    const noKey = type('awsSecretsManager').create({ region: 'us-east-1' }, deps(http));
    await expect(noKey.init()).rejects.toThrow('The connection settings are not valid');
    expect(server.requests).toHaveLength(0);
  });

  it('answers a wrong key with the status and not the body', async () => {
    const server = await fake((req, res) =>
      awsHandler({
        host: 'secretsmanager.us-east-1.amazonaws.com',
        region: 'us-east-1',
        ...keys,
        secrets: {},
      })(req, res),
    );
    const { http } = rewriteHttp(allowLocal(), { 'secretsmanager.us-east-1.amazonaws.com': server.origin });
    const provider = type('awsSecretsManager').create(
      { ...settings('us-east-1'), secretAccessKey: 'wrong' },
      deps(http),
    );
    const result = await provider.test();
    expect(result).toEqual({ success: false, error: 'The vault answered 403' });
    expect(JSON.stringify(result)).not.toContain('SECRET-BODY');
  });

  it('tests ok with good keys', async () => {
    const server = await fake((req, res) =>
      awsHandler({
        host: 'secretsmanager.us-east-1.amazonaws.com',
        region: 'us-east-1',
        ...keys,
        secrets: { a: '1' },
      })(req, res),
    );
    const { http } = rewriteHttp(allowLocal(), { 'secretsmanager.us-east-1.amazonaws.com': server.origin });
    expect(await type('awsSecretsManager').create(settings('us-east-1'), deps(http)).test()).toEqual({
      success: true,
    });
  });
});

describe('GCP Secret Manager', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'service_account',
      project_id: 'my-project',
      client_email: 'sa@my-project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: 'https://evil.example.invalid/steal',
      ...extra,
    });

  it('signs a JWT for the fixed token URL, lists, reads latest and skips what is denied', async () => {
    const server = await fake(
      gcpHandler({
        projectId: 'my-project',
        email: 'sa@my-project.iam.gserviceaccount.com',
        publicKey,
        secrets: { api_key: 'k-1', db: 'päss', denied: 403, gone: 404, down: 503 },
        pageSize: 2,
      }),
    );
    const { http, asked } = rewriteHttp(allowLocal(), {
      'oauth2.googleapis.com': server.origin,
      'secretmanager.googleapis.com': server.origin,
    });
    const provider = await ready(
      type('gcpSecretsManager').create({ serviceAccountKey: keyFile() }, deps(http)),
    );

    expect(provider.getSecret('api_key')).toBe('k-1');
    expect(provider.getSecret('db')).toBe('päss');
    expect(provider.getSecretNames().sort()).toEqual(['api_key', 'db']);
    expect(GCP_TOKEN_URL).toBe('https://oauth2.googleapis.com/token');
    expect(asked.some((u) => u.includes('evil.example.invalid'))).toBe(false);
    expect(asked.filter((u) => u === GCP_TOKEN_URL)).toHaveLength(1);
    expect(asked.every((u) => /^https:\/\/(oauth2|secretmanager)\.googleapis\.com\//.test(u))).toBe(true);
  });

  it('aborts on another failure and reports bad keys as settings errors', async () => {
    const server = await fake(
      gcpHandler({
        projectId: 'my-project',
        email: 'sa@my-project.iam.gserviceaccount.com',
        publicKey,
        secrets: { a: 500 },
      }),
    );
    const { http } = rewriteHttp(allowLocal(), {
      'oauth2.googleapis.com': server.origin,
      'secretmanager.googleapis.com': server.origin,
    });
    const provider = type('gcpSecretsManager').create({ serviceAccountKey: keyFile() }, deps(http));
    await provider.init();
    await provider.connect();
    await expect(provider.update()).rejects.toThrow('The vault answered 500');
    for (const bad of [
      '',
      'not json',
      '{"client_email":"a"}',
      keyFile({ private_key: 'nope' }),
      keyFile({ project_id: 'a/b' }),
    ]) {
      await expect(
        type('gcpSecretsManager').create({ serviceAccountKey: bad }, deps(http)).init(),
      ).rejects.toThrow('The connection settings are not valid');
    }
  });

  it('rejects a token request the vault refuses with a fixed text', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const server = await fake(
      gcpHandler({
        projectId: 'my-project',
        email: 'sa@my-project.iam.gserviceaccount.com',
        publicKey: other,
        secrets: {},
      }),
    );
    const { http } = rewriteHttp(allowLocal(), { 'oauth2.googleapis.com': server.origin });
    const result = await type('gcpSecretsManager')
      .create({ serviceAccountKey: keyFile() }, deps(http))
      .test();
    expect(result).toEqual({ success: false, error: 'The vault answered 401' });
  });
});

describe('Azure Key Vault', () => {
  const creds = {
    tenantId: '11111111-2222-3333-4444-555555555555',
    clientId: 'client-id-1',
    clientSecret: 'azure-client-secret',
  };

  it('reads through client credentials on the hosts of each cloud', async () => {
    const cases = [
      {
        cloud: 'public',
        vault: 'myvault.vault.azure.net',
        authority: 'login.microsoftonline.com',
        scope: 'https://vault.azure.net/.default',
      },
      {
        cloud: 'usGovernment',
        vault: 'myvault.vault.usgovcloudapi.net',
        authority: 'login.microsoftonline.us',
        scope: 'https://vault.usgovcloudapi.net/.default',
      },
      {
        cloud: 'china',
        vault: 'myvault.vault.azure.cn',
        authority: 'login.partner.microsoftonline.cn',
        scope: 'https://vault.azure.cn/.default',
      },
    ];
    for (const c of cases) {
      const server = await fake(
        azureHandler({
          ...creds,
          scope: c.scope,
          pageSize: 2,
          secrets: {
            'db-pass': { value: 'p1' },
            token: { value: 't1' },
            off: { value: 'x', enabled: false },
            locked: { status: 403 },
            third: { value: 'v3' },
          },
        }),
      );
      const { http, asked } = rewriteHttp(allowLocal(), {
        [c.vault]: server.origin,
        [c.authority]: server.origin,
      });
      const provider = await ready(
        type('azureKeyVault').create({ cloud: c.cloud, vaultName: 'myvault', ...creds }, deps(http)),
      );
      expect(provider.getSecretNames().sort()).toEqual(['db-pass', 'third', 'token']);
      expect(provider.getSecret('db-pass')).toBe('p1');
      expect(asked[0]).toBe(`https://${c.authority}/${creds.tenantId}/oauth2/v2.0/token`);
      // a next link to another host is asked of the same vault
      expect(asked.every((u) => new URL(u).host === c.vault || new URL(u).host === c.authority)).toBe(true);
    }
  });

  it('works with a custom vault and authority host', async () => {
    // the scope is the vault host without its first label; a one-label host keeps itself
    const server = await fake(
      azureHandler({ ...creds, scope: 'https://localhost/.default', secrets: { a: { value: '1' } } }),
    );
    const origin = server.origin.replace('127.0.0.1', 'localhost');
    const http = new HttpClient({ ssrf: { allow: ['localhost', '127.0.0.1'] } });
    const provider = await ready(
      type('azureKeyVault').create(
        { cloud: 'custom', vaultUrl: origin, authorityHost: origin, ...creds },
        deps(http),
      ),
    );
    expect(provider.getSecret('a')).toBe('1');
  });

  it('fails when nothing can be read, and refuses unsafe settings', async () => {
    const server = await fake(
      azureHandler({
        ...creds,
        scope: 'https://vault.azure.net/.default',
        secrets: { a: { status: 403 }, b: { status: 404 } },
      }),
    );
    const { http } = rewriteHttp(allowLocal(), {
      'myvault.vault.azure.net': server.origin,
      'login.microsoftonline.com': server.origin,
    });
    const provider = type('azureKeyVault').create(
      { cloud: 'public', vaultName: 'myvault', ...creds },
      deps(http),
    );
    await provider.init();
    await provider.connect();
    await expect(provider.update()).rejects.toThrow('Could not read any secrets from Azure Key Vault');
    const settings = (extra: Record<string, unknown>) => ({
      cloud: 'public',
      vaultName: 'myvault',
      ...creds,
      ...extra,
    });
    for (const bad of [
      settings({ vaultName: 'a.evil.com/x' }),
      settings({ tenantId: '../x' }),
      settings({ clientId: 'a b' }),
      settings({ cloud: 'mars' }),
      settings({ clientSecret: '' }),
    ]) {
      await expect(type('azureKeyVault').create(bad, deps(http)).init()).rejects.toThrow(
        'The connection settings are not valid',
      );
    }
  });
});

describe('HashiCorp Vault', () => {
  const mounts = {
    secret: {
      version: 2 as const,
      secrets: {
        app: { user: 'u1', pass: 'p1' },
        'team/db': { host: 'h', password: 'dbpw' },
        'team/deep/key': { v: 'deep' },
      },
    },
    legacy: { version: 1 as const, secrets: { old: { token: 'o1' } } },
  };

  it('finds kv mounts, walks folders and reads v2 and v1 secrets with a token', async () => {
    const handler = vaultHandler({ token: 'root-token', mounts });
    const server = await fake(handler);
    const provider = await ready(
      type('vault').create(
        { url: `${server.origin}/v1/`, authMethod: 'token', token: 'root-token' },
        deps(allowLocal()),
      ),
    );
    expect(provider.getSecretNames().sort()).toEqual([
      'legacy/old',
      'secret/app',
      'secret/team/db',
      'secret/team/deep/key',
    ]);
    expect(provider.getSecret('secret/team/db')).toEqual({ host: 'h', password: 'dbpw' });
    expect(provider.getSecret('legacy/old')).toEqual({ token: 'o1' });
    const lists = server.requests.filter((r) => r.query.get('list') === 'true');
    expect(lists.length).toBeGreaterThan(2);
    expect(lists.every((r) => r.method === 'GET')).toBe(true);
    expect(server.requests.every((r) => r.headers['x-vault-token'] === 'root-token')).toBe(true);
  });

  it('uses a given mount without sys/mounts, a start folder, a namespace and prefer-get', async () => {
    const handler = vaultHandler({ token: 't', namespace: 'team-a', mounts });
    const server = await fake(handler);
    const provider = await ready(
      type('vault').create(
        {
          url: `${server.origin}/v1`,
          namespace: 'team-a',
          authMethod: 'token',
          token: 't',
          kvMountPath: '/secret/',
          kvVersion: 'v2',
          kvSecretPath: 'team',
        },
        deps(allowLocal(), { preferGet: true }),
      ),
    );
    expect(provider.getSecretNames().sort()).toEqual(['team/db', 'team/deep/key']);
    expect(server.requests.some((r) => r.path === '/v1/sys/mounts')).toBe(false);
    expect(server.requests.every((r) => r.headers['x-vault-namespace'] === 'team-a')).toBe(true);
  });

  it('signs in with a username and password, and with an AppRole', async () => {
    const handler = vaultHandler({
      username: 'dev user',
      password: 'pw-1',
      roleId: 'role-1',
      secretId: 'sid-1',
      mounts,
    });
    const server = await fake(handler);
    const viaUser = await ready(
      type('vault').create(
        {
          url: `${server.origin}/v1/`,
          authMethod: 'usernameAndPassword',
          username: 'dev user',
          password: 'pw-1',
          kvMountPath: 'legacy',
          kvVersion: 'v1',
        },
        deps(allowLocal()),
      ),
    );
    expect(viaUser.getSecret('old')).toEqual({ token: 'o1' });
    expect(server.requests[0].path).toBe('/v1/auth/userpass/login/dev%20user');
    const viaRole = await ready(
      type('vault').create(
        {
          url: `${server.origin}/v1/`,
          authMethod: 'appRole',
          roleId: 'role-1',
          secretId: 'sid-1',
          kvMountPath: 'legacy',
          kvVersion: 'v1',
        },
        deps(allowLocal()),
      ),
    );
    expect(viaRole.getSecret('old')).toEqual({ token: 'o1' });
    const wrong = type('vault').create(
      { url: `${server.origin}/v1/`, authMethod: 'appRole', roleId: 'role-1', secretId: 'bad' },
      deps(allowLocal()),
    );
    expect(await wrong.test()).toEqual({ success: false, error: 'The vault answered 400' });
  });

  it('renews a token at half of its lifetime', async () => {
    const handler = vaultHandler({ token: 'short', ttl: 1, mounts });
    const server = await fake(handler);
    const provider = type('vault').create(
      {
        url: `${server.origin}/v1/`,
        authMethod: 'token',
        token: 'short',
        kvMountPath: 'legacy',
        kvVersion: 'v1',
      },
      deps(allowLocal()),
    );
    await provider.init();
    await provider.connect();
    await provider.update();
    expect(handler.renewals()).toBe(0);
    await new Promise((r) => setTimeout(r, 650));
    await provider.update();
    expect(handler.renewals()).toBe(1);
    expect(provider.getSecret('old')).toEqual({ token: 'o1' });
  });

  it('says what is missing for a wrong base URL and for sys/mounts', async () => {
    const handler = vaultHandler({ token: 't', denyMounts: true, mounts });
    const server = await fake(handler);
    const noV1 = type('vault').create(
      { url: server.origin, authMethod: 'token', token: 't' },
      deps(allowLocal()),
    );
    expect(await noV1.test()).toEqual({
      success: false,
      error: 'Could not find auth path. Try adding /v1/ to the end of your base URL.',
    });
    const denied = type('vault').create(
      { url: `${server.origin}/v1/`, authMethod: 'token', token: 't' },
      deps(allowLocal()),
    );
    await denied.init();
    await denied.connect();
    await expect(denied.update()).rejects.toThrow(
      "Couldn't list mounts. Please give these credentials 'read' access to sys/mounts.",
    );
    for (const bad of [
      { url: '' },
      { url: 'ftp://x/v1' },
      { url: 'https://u:p@x/v1' },
      { authMethod: 'saml' },
      { token: '' },
    ]) {
      await expect(
        type('vault')
          .create(
            { url: `${server.origin}/v1/`, authMethod: 'token', token: 't', ...bad },
            deps(allowLocal()),
          )
          .init(),
      ).rejects.toThrow('The connection settings are not valid');
    }
  });
});

describe('1Password Connect', () => {
  it('reads items from every vault as an object of field labels', async () => {
    const server = await fake(
      onePasswordHandler({
        token: 'op-token',
        vaults: {
          v1: {
            i1: {
              title: 'Stripe',
              fields: [{ label: 'key', value: 'sk_1' }, { label: 'note' }, { value: 'no label' }],
            },
          },
          v2: { i2: { title: 'Mail', fields: [{ label: 'password', value: 'm-pw' }] } },
        },
      }),
    );
    const provider = await ready(
      type('onepassword').create({ connectUrl: `${server.origin}/`, token: 'op-token' }, deps(allowLocal())),
    );
    expect(provider.getSecret('Stripe')).toEqual({ key: 'sk_1' });
    expect(provider.getSecret('Mail')).toEqual({ password: 'm-pw' });
    expect(provider.getSecretNames().sort()).toEqual(['Mail', 'Stripe']);
    expect(server.requests.every((r) => r.headers.authorization === 'Bearer op-token')).toBe(true);
    expect(
      await type('onepassword')
        .create({ connectUrl: server.origin, token: 'bad' }, deps(allowLocal()))
        .test(),
    ).toEqual({
      success: false,
      error: 'The vault answered 401',
    });
  });
});

describe('Infisical', () => {
  const base = {
    clientId: 'cid',
    clientSecret: 'csecret',
    projectId: 'proj-1',
    environment: 'prod',
    secretPath: '/app',
  };

  it('signs in with universal auth, reads the path and lets it win over an import', async () => {
    const server = await fake(
      infisicalHandler({
        ...base,
        secrets: { DB_URL: 'postgres://a', API: 'direct' },
        imports: { API: 'imported', SHARED: 's1' },
      }),
    );
    const provider = await ready(
      type('infisical').create(
        { siteUrl: server.origin, authentication: 'universalAuth', ...base },
        deps(allowLocal()),
      ),
    );
    expect(provider.getSecret('DB_URL')).toBe('postgres://a');
    expect(provider.getSecret('API')).toBe('direct');
    expect(provider.getSecret('SHARED')).toBe('s1');
    expect(server.requests[0].path).toBe('/api/v1/auth/universal-auth/login');
    expect(server.requests.at(-1)?.headers.authorization).toMatch(/^Bearer inf-token-/);
  });

  it('signs in again before the token ends', async () => {
    const server = await fake(infisicalHandler({ ...base, secrets: { A: '1' }, expiresIn: 1 }));
    const provider = type('infisical').create({ siteUrl: server.origin, ...base }, deps(allowLocal()));
    await provider.init();
    await provider.connect();
    await provider.update();
    expect(server.requests.filter((r) => r.path.endsWith('/login'))).toHaveLength(2);
  });

  it('refuses wrong client keys with a fixed text', async () => {
    const server = await fake(infisicalHandler({ ...base, secrets: {} }));
    const result = await type('infisical')
      .create({ siteUrl: server.origin, ...base, clientSecret: 'nope' }, deps(allowLocal()))
      .test();
    expect(result).toEqual({ success: false, error: 'The vault answered 401' });
  });
});

describe('errors and the network guard', () => {
  it('never puts a response body in an error and does not follow a redirect', async () => {
    const server = await fake((req, res) => {
      if (req.path === '/v1/vaults') {
        res.statusCode = 302;
        res.setHeader('location', 'http://127.0.0.1:1/steal');
        return res.end('SECRET-BODY-redirect');
      }
      return reply(res, 500, 'SECRET-BODY-5xx password=hunter2');
    });
    const redirected = await type('onepassword')
      .create({ connectUrl: server.origin, token: 't' }, deps(allowLocal()))
      .test();
    expect(redirected).toEqual({ success: false, error: 'The vault answered 302' });
    const failed = type('infisical').create(
      { siteUrl: server.origin, clientId: 'c', clientSecret: 's', projectId: 'p' },
      deps(allowLocal()),
    );
    const result = await failed.test();
    expect(result).toEqual({ success: false, error: 'The vault answered 500' });
    await failed.init();
    const thrown = await failed.connect().catch((e: Error) => e);
    expect((thrown as Error).name).toBe('SecretProviderError');
    expect(JSON.stringify([result, (thrown as Error).message])).not.toMatch(/SECRET-BODY|hunter2/);
  });

  it('says why a vault cannot be reached', async () => {
    const closed = await startFake((_r, res) => res.end());
    const url = closed.origin;
    await closed.close();
    const result = await type('vault')
      .create({ url: `${url}/v1/`, authMethod: 'token', token: 't' }, deps(allowLocal()))
      .test();
    expect(result).toEqual({ success: false, error: "Couldn't reach the vault: connection refused" });
  });

  it('keeps the guard on: a private vault host is refused unless the operator allows it', async () => {
    const server = await fake((_req, res) => reply(res, 200, {}));
    const result = await type('onepassword')
      .create({ connectUrl: server.origin, token: 't' }, deps(new HttpClient()))
      .test();
    expect(result).toEqual({ success: false, error: 'Blocked by the network rules' });
    expect(server.requests).toHaveLength(0);
  });

  it('answers within the time limit of the call', async () => {
    const server = await fake(() => {
      /* never answers */
    });
    const provider = type('onepassword').create(
      { connectUrl: server.origin, token: 't' },
      deps(allowLocal(), { connectTimeoutMs: 200 }),
    );
    await provider.init();
    const started = Date.now();
    await expect(provider.connect()).rejects.toThrow("Couldn't reach the vault");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('forgets everything on disconnect', async () => {
    const server = await fake(
      onePasswordHandler({
        token: 't',
        vaults: { v: { i: { title: 'A', fields: [{ label: 'k', value: 'v' }] } } },
      }),
    );
    const provider = await ready(
      type('onepassword').create({ connectUrl: server.origin, token: 't' }, deps(allowLocal())),
    );
    expect(provider.hasSecret('A')).toBe(true);
    await provider.disconnect();
    expect(provider.getSecretNames()).toEqual([]);
    expect(provider.getSecret('A')).toBeUndefined();
  });
});
