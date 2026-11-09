/**
 * External secrets (P4-07): connections, cache, refresh, `$secrets` in the four credential read paths.
 * The vault is an in-process HTTP server, reached through the provider's guarded client.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient, redactCredentialData } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, type ServerContext } from '../src/context';
import { createSecretsProxy } from '../src/services/secrets/proxy';
import { collectSecretKeys, resolveCredentialData } from '../src/services/secrets/resolver';
import type {
  SecretProvider,
  SecretProviderDeps,
  SecretProviderSettings,
  SecretProviderType,
} from '../src/services/secrets/types';
import {
  chain,
  createTestServer,
  createWorkflow,
  flushRedis,
  memberAs,
  node,
  resetDatabase,
  signup as signupFrom,
  TEST_REDIS,
  type TestServer,
  teamProjectOf,
  testConfig,
  testPackage,
  waitFor,
  waitForExecution,
} from './helpers';

// retries wait 10 s and more in production
vi.mock('../src/services/secrets/retry', async (original) => {
  const actual = await original<typeof import('../src/services/secrets/retry')>();
  return { ...actual, backoffDelayMs: () => 200 };
});

const PROVIDERS = '/rest/secret-providers';
const CONNECTIONS = `${PROVIDERS}/connections`;
const NOT_REACHABLE = 'The credential in use pulls secrets from an external store that is not reachable';
const NOT_FOUND = 'The credential in use tries to use secret from an external store that could not be found';

// ---------------------------------------------------------------------------------------------
// the test vault

let vault: Server;
let vaultUrl: string;
/** token -> what the vault holds for it */
const vaultSecrets = new Map<string, Record<string, unknown>>();
let vaultStatus: number | undefined;
let vaultHits = 0;
let vaultHangMs = 0;

class FakeProvider implements SecretProvider {
  private secrets: Record<string, unknown> = {};

  constructor(
    private readonly settings: SecretProviderSettings,
    private readonly deps: SecretProviderDeps,
  ) {}

  private read() {
    return this.deps.http.request<Record<string, unknown>>({
      url: `${String(this.settings.url)}/secrets`,
      headers: { authorization: `Bearer ${String(this.settings.token)}` },
    }) as Promise<Record<string, unknown>>;
  }

  async init() {
    if (!this.settings.url) throw new Error('settings without a url');
  }
  async connect() {
    await this.read().catch(() => {
      throw new Error('the vault said BODY-LEAK');
    });
  }
  async update() {
    this.secrets = await this.read().catch(() => {
      throw new Error('the vault said BODY-LEAK');
    });
  }
  async test() {
    try {
      await this.read();
      return { success: true };
    } catch {
      return { success: false, error: 'The vault answered with an error' };
    }
  }
  getSecret(name: string) {
    return this.secrets[name];
  }
  hasSecret(name: string) {
    return Object.hasOwn(this.secrets, name);
  }
  getSecretNames() {
    return Object.keys(this.secrets);
  }
  async disconnect() {}
}

const fakeType: SecretProviderType = {
  name: 'testVault',
  displayName: 'Test vault',
  properties: [
    { displayName: 'URL', name: 'url', type: 'string', default: '' },
    { displayName: 'Token', name: 'token', type: 'string', default: '', typeOptions: { password: true } },
  ],
  create: (settings, deps) => new FakeProvider(settings, deps),
};

let server: TestServer;
let remote: Server;
let remoteUrl: string;
const received: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];

const listen = (s: Server) =>
  new Promise<string>((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)),
  );

beforeAll(async () => {
  vault = createServer((req, res) => {
    vaultHits++;
    const answer = () => {
      const token = (req.headers.authorization ?? '').replace('Bearer ', '');
      const secrets = vaultSecrets.get(token);
      if (vaultStatus || !secrets) {
        res.writeHead(vaultStatus ?? 403, { 'content-type': 'text/plain' });
        res.end('BODY-LEAK');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(secrets));
    };
    if (vaultHangMs) setTimeout(answer, vaultHangMs);
    else answer();
  });
  vaultUrl = await listen(vault);
  remote = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/token') {
        res.end(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }));
      } else if (req.url === '/refresh') {
        res.end(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }));
      } else {
        res.end('{"ok":true}');
      }
    });
  });
  remoteUrl = await listen(remote);
  server = await createTestServer({}, { secretProviderTypes: [fakeType] });
});
afterAll(async () => {
  await server.close();
  await new Promise((r) => vault.close(r));
  await new Promise((r) => remote.close(r));
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  // what a test left retrying must not call the vault during the next
  await server.ctx.secrets.stop();
  await server.ctx.secrets.start();
  vaultSecrets.clear();
  vaultStatus = undefined;
  vaultHangMs = 0;
  vaultHits = 0;
  received.length = 0;
});

const newToken = () => `token-${randomUUID()}`;

// signup allows 20 calls an hour per IP
let signups = 0;
const signup = (app: TestServer['app']) => {
  signups++;
  return signupFrom(app, { remoteAddress: `10.77.${signups >> 8}.${signups & 255}` });
};

async function member(owner: Awaited<ReturnType<typeof signup>>, role: 'admin' | 'editor' | 'viewer') {
  return (await memberAs(owner, role)).client;
}

/** an enabled connection whose vault holds `secrets` */
async function connection(
  owner: Awaited<ReturnType<typeof signup>>,
  providerKey: string,
  secrets: Record<string, unknown>,
) {
  const token = newToken();
  vaultSecrets.set(token, secrets);
  const dto = await owner.client.data(
    owner.client.post(CONNECTIONS, {
      providerKey,
      type: 'testVault',
      settings: { url: vaultUrl, token },
      isEnabled: true,
    }),
  );
  return { dto, token };
}

// ---------------------------------------------------------------------------------------------

describe('retry.ts', () => {
  it('backs off from 10 s to 5 min, jittered to 50-100 percent', async () => {
    const { backoffDelayMs } = await vi.importActual<typeof import('../src/services/secrets/retry')>(
      '../src/services/secrets/retry',
    );
    expect(backoffDelayMs(0, () => 1)).toBe(10_000);
    expect(backoffDelayMs(0, () => 0)).toBe(5_000);
    expect(backoffDelayMs(1, () => 1)).toBe(20_000);
    expect(backoffDelayMs(4, () => 1)).toBe(160_000);
    expect(backoffDelayMs(5, () => 1)).toBe(300_000);
    expect(backoffDelayMs(500, () => 1)).toBe(300_000);
    expect(backoffDelayMs(500, () => 0)).toBe(150_000);
  });

  it('withTimeout rejects with the fixed text and lets a fast promise through', async () => {
    const { withTimeout } = await vi.importActual<typeof import('../src/services/secrets/retry')>(
      '../src/services/secrets/retry',
    );
    await expect(withTimeout(Promise.resolve(1), 1000, 'too slow')).resolves.toBe(1);
    await expect(withTimeout(new Promise(() => {}), 5, 'too slow')).rejects.toThrow('too slow');
  });
});

describe('proxy.ts', () => {
  const provider = (secrets: Record<string, unknown>) =>
    ({
      getSecret: (n: string) => secrets[n],
      hasSecret: (n: string) => Object.hasOwn(secrets, n),
      getSecretNames: () => Object.keys(secrets),
    }) as unknown as SecretProvider;
  const view = (providers: Record<string, SecretProvider>) => ({
    keys: () => Object.keys(providers),
    provider: (key: string) => providers[key],
  });

  it('gives the two n8n errors, with their title', () => {
    const $secrets = createSecretsProxy(view({ t: provider({ key: 'v' }) }));
    expect($secrets.t.key).toBe('v');
    const failure = (read: () => unknown) => {
      try {
        read();
      } catch (error) {
        return error as Error & { description?: string };
      }
      throw new Error('it did not throw');
    };
    const unknownProvider = failure(() => $secrets.nope);
    expect(unknownProvider.message).toBe('Could not load secrets');
    expect(unknownProvider.description).toBe(NOT_REACHABLE);
    const unknownSecret = failure(() => $secrets.t.nope);
    expect(unknownSecret.message).toBe('Could not load secrets');
    expect(unknownSecret.description).toBe(NOT_FOUND);
  });

  it('lists names, refuses writes and raises the same error for a missing field of an object secret', () => {
    const $secrets = createSecretsProxy(view({ t: provider({ a: 'v', obj: { field: 'f' } }) }));
    expect(Object.keys($secrets)).toEqual(['t']);
    expect(Object.keys($secrets.t)).toEqual(['a', 'obj']);
    expect('a' in $secrets.t).toBe(true);
    expect('b' in $secrets.t).toBe(false);
    expect(($secrets.t.obj as Record<string, unknown>).field).toBe('f');
    expect(() => ($secrets.t.obj as Record<string, unknown>).nope).toThrow('Could not load secrets');
    expect(() => {
      ($secrets as Record<string, unknown>).x = 1;
    }).toThrow();
    expect(() => {
      $secrets.t.a = 'changed';
    }).toThrow();
    expect(Reflect.deleteProperty($secrets.t, 'a')).toBe(false);
    expect(JSON.stringify($secrets.t)).toBe('{"a":"v","obj":{"field":"f"}}');
  });
});

describe('resolver.ts', () => {
  const secrets = (values: Record<string, Record<string, unknown>>) => ({
    secretsFor: () => values,
  });
  const options = (values: Record<string, Record<string, unknown>> = {}) => ({
    tenantId: 't',
    vars: { region: 'eu' },
    secrets: secrets(values),
  });

  it('resolves expression leaves in a copy and leaves everything else alone', async () => {
    const raw: DataObject = {
      apiKey: '={{ $secrets.v.key }}',
      region: '={{ $vars.region }}',
      url: '=https://{{ $secrets.v.host }}/x',
      plain: 'text',
      nested: { list: ['={{ $secrets.v.key }}', 1], flag: true },
    };
    const resolved = await resolveCredentialData(raw, options({ v: { key: 'K', host: 'h.example' } }));
    expect(resolved).toEqual({
      apiKey: 'K',
      region: 'eu',
      url: 'https://h.example/x',
      plain: 'text',
      nested: { list: ['K', 1], flag: true },
    });
    expect(raw.apiKey).toBe('={{ $secrets.v.key }}');
  });

  it('keeps a value without {{ }} as typed: a password may begin with =', async () => {
    const resolved = await resolveCredentialData({ password: '=abc' }, options());
    expect(resolved.password).toBe('=abc');
  });

  it('keeps a value with an unclosed {{ as typed: a password may hold braces', async () => {
    const resolved = await resolveCredentialData({ password: '=aB{{9x' }, options());
    expect(resolved.password).toBe('=aB{{9x');
  });

  it('never evaluates token material or a value a secret returned', async () => {
    const resolved = await resolveCredentialData(
      { oauthTokenData: { access_token: '={{ $secrets.v.key }}' }, apiKey: '={{ $secrets.v.tricky }}' },
      options({ v: { key: 'K', tricky: '={{ $secrets.v.key }}' } }),
    );
    expect(resolved.oauthTokenData).toEqual({ access_token: '={{ $secrets.v.key }}' });
    expect(resolved.apiKey).toBe('={{ $secrets.v.key }}');
  });

  it('turns any other failure into a fixed text without the value', async () => {
    const attempt = resolveCredentialData(
      { apiKey: '={{ JSON.parse($secrets.v.key) }}' },
      options({ v: { key: 'not-json-VALUE' } }),
    );
    await expect(attempt).rejects.toThrow('Could not read the credential');
    await expect(attempt).rejects.not.toThrow('VALUE');
  });

  it('fails closed when no manager is there', async () => {
    await expect(
      resolveCredentialData({ apiKey: '={{ $secrets.v.key }}' }, { tenantId: 't', vars: {} }),
    ).rejects.toThrow('Could not load secrets');
  });

  it('collects provider keys with the engine, not a regex (GHSA-jp7m)', () => {
    expect(collectSecretKeys({ a: '={{ $secrets.one.key }}' })).toEqual(['one']);
    expect(collectSecretKeys({ a: `={{ $secrets['t' + 'wo'].key }}` })).toEqual(['two']);
    expect(collectSecretKeys({ a: '={{ (() => { const s = $secrets; return s.three.key; })() }}' })).toEqual([
      'three',
    ]);
    expect(
      collectSecretKeys({ a: '={{ $secrets.four.key.toUpperCase() + $secrets.five.obj.field }}' }),
    ).toEqual(['five', 'four']);
    expect(collectSecretKeys({ nested: { list: ['={{ $secrets.six.key }}'] } })).toEqual(['six']);
    // text that only looks like a reference
    expect(collectSecretKeys({ a: '$secrets.fake.key', b: '={{ "$secrets.fake.key" }}' })).toEqual([]);
    expect(collectSecretKeys({ oauthTokenData: { t: '={{ $secrets.token.key }}' } })).toEqual([]);
    expect(collectSecretKeys({ a: '={{ syntax error' })).toEqual([]);
  });
});

describe('connections API', () => {
  it('creates a connection, encrypts its settings and blanks the password on every read', async () => {
    const owner = await signup(server.app);
    const token = newToken();
    vaultSecrets.set(token, { key: 'value', other: 'x' });
    const dto = await owner.client.data(
      owner.client.post(CONNECTIONS, {
        providerKey: 'main',
        type: 'testVault',
        settings: { url: vaultUrl, token },
        isEnabled: true,
      }),
    );
    expect(dto).toMatchObject({
      providerKey: 'main',
      type: 'testVault',
      settings: { url: vaultUrl, token: '__REDACTED__' },
      isEnabled: true,
      state: 'connected',
      lastError: null,
      secretsCount: 2,
      credentialsCount: 0,
    });
    expect(typeof dto.createdAt).toBe('string');

    const listed = await owner.client.data(owner.client.get(CONNECTIONS));
    expect(listed).toHaveLength(1);
    expect(listed[0].settings.token).toBe('__REDACTED__');
    const single = await owner.client.data(owner.client.get(`${CONNECTIONS}/main`));
    expect(single.settings.token).toBe('__REDACTED__');
    expect(JSON.stringify([dto, listed, single])).not.toContain(token);

    const row = await server.ctx.repos.secrets.get(owner.tenant.id, 'main');
    expect(row?.settingsEnc).not.toContain(token);
    const binding = { tenantId: owner.tenant.id, credentialId: `secretConnection:${row!.id}` };
    expect(server.ctx.cipher.decrypt<DataObject>(row!.settingsEnc, binding).token).toBe(token);
    // bound to its row: another id cannot read it
    expect(() =>
      server.ctx.cipher.decrypt(row!.settingsEnc, { ...binding, credentialId: 'secretConnection:other' }),
    ).toThrow();
  });

  it('a new connection is off and reads nothing until it is enabled', async () => {
    const owner = await signup(server.app);
    const token = newToken();
    vaultSecrets.set(token, { key: 'value' });
    const dto = await owner.client.data(
      owner.client.post(CONNECTIONS, {
        providerKey: 'off',
        type: 'testVault',
        settings: { url: vaultUrl, token },
      }),
    );
    expect(dto).toMatchObject({ isEnabled: false, state: 'initialized', secretsCount: 0 });
    expect(vaultHits).toBe(0);
    expect(() => server.ctx.secrets.secretsFor(owner.tenant.id).off).toThrow('Could not load secrets');

    const on = await owner.client.data(owner.client.patch(`${CONNECTIONS}/off`, { isEnabled: true }));
    expect(on).toMatchObject({ isEnabled: true, state: 'connected', secretsCount: 1 });
    expect(server.ctx.secrets.secretsFor(owner.tenant.id).off.key).toBe('value');

    const off = await owner.client.data(owner.client.patch(`${CONNECTIONS}/off`, { isEnabled: false }));
    expect(off).toMatchObject({ isEnabled: false, state: 'initialized', secretsCount: 0 });
    expect(() => server.ctx.secrets.secretsFor(owner.tenant.id).off).toThrow('Could not load secrets');
  });

  it('PATCH merges the blanked password back and a new token replaces it', async () => {
    const owner = await signup(server.app);
    const { dto, token } = await connection(owner, 'main', { key: 'first' });
    await owner.client.data(
      owner.client.patch(`${CONNECTIONS}/main`, { settings: { ...dto.settings, url: `${vaultUrl}/` } }),
    );
    const read = async () => {
      const row = (await server.ctx.repos.secrets.get(owner.tenant.id, 'main'))!;
      return server.ctx.cipher.decrypt<DataObject>(row.settingsEnc, {
        tenantId: owner.tenant.id,
        credentialId: `secretConnection:${row.id}`,
      });
    };
    expect(await read()).toEqual({ url: `${vaultUrl}/`, token });

    // a field the form left out keeps its stored value
    await owner.client.data(owner.client.patch(`${CONNECTIONS}/main`, { settings: { url: vaultUrl } }));
    expect(await read()).toEqual({ url: vaultUrl, token });

    const next = newToken();
    vaultSecrets.set(next, { key: 'second' });
    const updated = await owner.client.data(
      owner.client.patch(`${CONNECTIONS}/main`, { settings: { url: vaultUrl, token: next } }),
    );
    expect(updated.state).toBe('connected');
    expect(await read()).toEqual({ url: vaultUrl, token: next });
    expect(server.ctx.secrets.secretsFor(owner.tenant.id).main.key).toBe('second');
  });

  it('answers with n8n texts for a duplicate, a missing key, a type change and an unknown type', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { key: 'v' });
    const body = { providerKey: 'main', type: 'testVault', settings: { url: vaultUrl } };
    const duplicate = await owner.client.post(CONNECTIONS, body);
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.body).toContain('Connection with key \\"main\\" already exists');

    const missing = await owner.client.get(`${CONNECTIONS}/nope`);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('Connection with key \\"nope\\" not found');
    for (const res of [
      await owner.client.patch(`${CONNECTIONS}/nope`, { isEnabled: true }),
      await owner.client.delete(`${CONNECTIONS}/nope`),
      await owner.client.post(`${CONNECTIONS}/nope/test`),
      await owner.client.post(`${CONNECTIONS}/nope/reload`),
    ]) {
      expect(res.statusCode).toBe(404);
    }

    const typeChange = await owner.client.patch(`${CONNECTIONS}/main`, { type: 'vault' });
    expect(typeChange.statusCode).toBe(400);
    expect(typeChange.body).toContain('When changing the connection type, new settings must be provided');

    const unknown = await owner.client.post(CONNECTIONS, { ...body, providerKey: 'x', type: 'nope' });
    expect(unknown.statusCode).toBe(400);
    const blocked = await owner.client.post(CONNECTIONS, { ...body, providerKey: 'constructor' });
    expect(blocked.statusCode).toBe(400);
  });

  it('a type change never carries stored settings to the new type', async () => {
    const owner = await signup(server.app);
    const { token } = await connection(owner, 'main', { key: 'v' });
    await owner.client.data(
      owner.client.patch(`${CONNECTIONS}/main`, {
        type: 'testVault',
        settings: { url: vaultUrl, token: '__REDACTED__' },
      }),
    );
    const row = (await server.ctx.repos.secrets.get(owner.tenant.id, 'main'))!;
    // same type: the sentinel keeps the token
    const binding = { tenantId: owner.tenant.id, credentialId: `secretConnection:${row.id}` };
    expect(server.ctx.cipher.decrypt<DataObject>(row.settingsEnc, binding).token).toBe(token);

    const other: SecretProviderType = { ...fakeType, name: 'otherVault', displayName: 'Other' };
    const local = await createTestServer({}, { reset: false, secretProviderTypes: [fakeType, other] });
    try {
      const dto = await local.ctx.secrets.updateConnection(owner.tenant.id, 'main', {
        type: 'otherVault',
        settings: { url: vaultUrl, token: '__REDACTED__' },
      });
      expect(dto.type).toBe('otherVault');
      const moved = (await local.ctx.repos.secrets.get(owner.tenant.id, 'main'))!;
      expect(local.ctx.cipher.decrypt<DataObject>(moved.settingsEnc, binding)).toEqual({ url: vaultUrl });
    } finally {
      await local.close();
    }
  });

  it('admin and owner manage, an editor lists names, a viewer gets nothing', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { key: 'value', other: 'value-2' });
    const admin = await member(owner, 'admin');
    const editor = await member(owner, 'editor');
    const viewer = await member(owner, 'viewer');

    expect((await admin.get(CONNECTIONS)).statusCode).toBe(200);
    for (const client of [editor, viewer]) {
      expect((await client.get(CONNECTIONS)).statusCode).toBe(403);
      expect((await client.get(`${CONNECTIONS}/main`)).statusCode).toBe(403);
      expect((await client.post(`${CONNECTIONS}/main/reload`)).statusCode).toBe(403);
      expect((await client.post(`${CONNECTIONS}/main/test`)).statusCode).toBe(403);
      expect((await client.delete(`${CONNECTIONS}/main`)).statusCode).toBe(403);
    }
    const completions = await editor.data(editor.get(`${PROVIDERS}/completions/secrets`));
    expect(completions).toEqual({ main: ['key', 'other'] });
    expect(JSON.stringify(completions)).not.toContain('value');
    expect((await viewer.get(`${PROVIDERS}/completions/secrets`)).statusCode).toBe(403);
  });

  it('keeps tenants apart: connections, names and $secrets', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    await connection(a, 'shared', { key: 'of-a' });
    await connection(b, 'shared', { key: 'of-b' });
    await connection(a, 'onlyA', { key: 'a2' });

    expect(server.ctx.secrets.secretsFor(a.tenant.id).shared.key).toBe('of-a');
    expect(server.ctx.secrets.secretsFor(b.tenant.id).shared.key).toBe('of-b');
    expect(() => server.ctx.secrets.secretsFor(b.tenant.id).onlyA).toThrow('Could not load secrets');

    expect((await b.client.get(`${CONNECTIONS}/onlyA`)).statusCode).toBe(404);
    expect((await b.client.delete(`${CONNECTIONS}/onlyA`)).statusCode).toBe(404);
    expect(await b.client.data(b.client.get(`${PROVIDERS}/completions/secrets`))).toEqual({
      shared: ['key'],
    });
    expect((await b.client.data(b.client.get(CONNECTIONS))).map((c: any) => c.providerKey)).toEqual([
      'shared',
    ]);
  });

  it('counts the credentials that use a connection and deletes it', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { key: 'value' });
    await connection(owner, 'other', { key: 'value' });
    const credential = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Uses main',
        type: 'testApi',
        data: { apiKey: `={{ $secrets['ma' + 'in'].key }}` },
      }),
    );
    const row = await server.ctx.repos.credentials.get(owner.tenant.id, credential.id);
    expect(row?.secretKeys).toEqual(['main']);
    expect((await owner.client.data(owner.client.get(`${CONNECTIONS}/main`))).credentialsCount).toBe(1);
    expect((await owner.client.data(owner.client.get(`${CONNECTIONS}/other`))).credentialsCount).toBe(0);

    await owner.client.data(
      owner.client.patch(`/rest/credentials/${credential.id}`, {
        data: { apiKey: '={{ $secrets.other.key }}' },
      }),
    );
    expect((await server.ctx.repos.credentials.get(owner.tenant.id, credential.id))?.secretKeys).toEqual([
      'other',
    ]);
    expect((await owner.client.data(owner.client.get(`${CONNECTIONS}/main`))).credentialsCount).toBe(0);
    expect((await owner.client.data(owner.client.get(`${CONNECTIONS}/other`))).credentialsCount).toBe(1);

    await owner.client.data(owner.client.delete(`${CONNECTIONS}/other`));
    expect((await owner.client.get(`${CONNECTIONS}/other`)).statusCode).toBe(404);
    expect(() => server.ctx.secrets.secretsFor(owner.tenant.id).other).toThrow('Could not load secrets');
  });

  it('writes audit rows without settings', async () => {
    const owner = await signup(server.app);
    const { token } = await connection(owner, 'main', { key: 'value' });
    await owner.client.data(owner.client.post(`${CONNECTIONS}/main/test`));
    await owner.client.data(owner.client.post(`${CONNECTIONS}/main/reload`));
    await owner.client.data(owner.client.patch(`${CONNECTIONS}/main`, { isEnabled: false }));
    await owner.client.data(owner.client.delete(`${CONNECTIONS}/main`));
    const audit = await owner.client.data<any>(owner.client.get('/rest/audit-log'));
    const rows = (audit.data ?? audit).filter((r: any) => r.resourceType === 'secret_connection');
    expect(rows.map((r: any) => r.action).sort()).toEqual([
      'secret_connection.created',
      'secret_connection.deleted',
      'secret_connection.reloaded',
      'secret_connection.tested',
      'secret_connection.updated',
    ]);
    expect(rows.every((r: any) => r.userId === owner.user.id)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe('test and reload', () => {
  it('tests with the stored settings: tested when off, connected when on', async () => {
    const owner = await signup(server.app);
    const token = newToken();
    vaultSecrets.set(token, { key: 'value' });
    await owner.client.data(
      owner.client.post(CONNECTIONS, {
        providerKey: 'main',
        type: 'testVault',
        settings: { url: vaultUrl, token },
      }),
    );
    expect(await owner.client.data(owner.client.post(`${CONNECTIONS}/main/test`))).toEqual({
      success: true,
      testState: 'tested',
    });
    await owner.client.data(owner.client.patch(`${CONNECTIONS}/main`, { isEnabled: true }));
    expect(await owner.client.data(owner.client.post(`${CONNECTIONS}/main/test`))).toEqual({
      success: true,
      testState: 'connected',
    });
  });

  it('a failed test gives a fixed text, never the body', async () => {
    const owner = await signup(server.app);
    const { dto } = await connection(owner, 'main', { key: 'value' });
    expect(dto.state).toBe('connected');
    vaultStatus = 500;
    const result = await owner.client.data(owner.client.post(`${CONNECTIONS}/main/test`));
    expect(result.success).toBe(false);
    expect(result.testState).toBe('error');
    expect(JSON.stringify(result)).not.toContain('BODY-LEAK');
  });

  it('reload reads the vault again; a failed reload keeps the last values', async () => {
    const owner = await signup(server.app);
    const { token } = await connection(owner, 'main', { key: 'first' });
    vaultSecrets.set(token, { key: 'second', added: 'x' });
    expect(await owner.client.data(owner.client.post(`${CONNECTIONS}/main/reload`))).toEqual({
      success: true,
    });
    expect(server.ctx.secrets.secretsFor(owner.tenant.id).main.key).toBe('second');

    vaultStatus = 500;
    expect(await owner.client.data(owner.client.post(`${CONNECTIONS}/main/reload`))).toEqual({
      success: false,
    });
    expect(server.ctx.secrets.secretsFor(owner.tenant.id).main.key).toBe('second');
    const dto = await owner.client.data(owner.client.get(`${CONNECTIONS}/main`));
    expect(dto.lastError).toBeTruthy();
    expect(dto.lastError).not.toContain('BODY-LEAK');
  });
});

describe('states, retries and refresh', () => {
  it('a failed connect has a fixed lastError, retries and then connects', async () => {
    const owner = await signup(server.app);
    const token = newToken();
    vaultStatus = 503;
    vaultSecrets.set(token, { key: 'late' });
    const dto = await owner.client.data(
      owner.client.post(CONNECTIONS, {
        providerKey: 'main',
        type: 'testVault',
        settings: { url: vaultUrl, token },
        isEnabled: true,
      }),
    );
    expect(dto.state).toBe('retrying');
    expect(dto.lastError).toBeTruthy();
    expect(dto.lastError).not.toContain('BODY-LEAK');
    expect(() => server.ctx.secrets.secretsFor(owner.tenant.id).main).toThrow('Could not load secrets');

    vaultStatus = undefined;
    await waitFor(async () => {
      const now = await owner.client.data(owner.client.get(`${CONNECTIONS}/main`));
      return now.state === 'connected';
    });
    const row = await server.ctx.repos.secrets.get(owner.tenant.id, 'main');
    expect(row).toMatchObject({ state: 'connected', lastError: null });
    expect(server.ctx.secrets.secretsFor(owner.tenant.id).main.key).toBe('late');
  });

  it('bad settings are an error that does not retry', async () => {
    const owner = await signup(server.app);
    const dto = await owner.client.data(
      owner.client.post(CONNECTIONS, {
        providerKey: 'main',
        type: 'testVault',
        settings: { token: 'x' },
        isEnabled: true,
      }),
    );
    expect(dto.state).toBe('error');
    expect(dto.lastError).not.toContain('settings without a url');
    await new Promise((r) => setTimeout(r, 120));
    expect(vaultHits).toBe(0);
    expect((await owner.client.data(owner.client.get(`${CONNECTIONS}/main`))).state).toBe('error');
  });

  it('a slow vault runs into the connect timeout', async () => {
    const local = await createTestServer(
      { EXTERNAL_SECRETS_CONNECT_TIMEOUT: '1' },
      { reset: false, secretProviderTypes: [fakeType] },
    );
    try {
      const owner = await signup(local.app);
      const token = newToken();
      vaultSecrets.set(token, { key: 'v' });
      vaultHangMs = 1500;
      const started = Date.now();
      const dto = await local.ctx.secrets.createConnection(owner.tenant.id, {
        providerKey: 'slow',
        type: 'testVault',
        settings: { url: vaultUrl, token },
        isEnabled: true,
      });
      expect(Date.now() - started).toBeLessThan(1400);
      expect(dto.state).toBe('retrying');
      expect(dto.lastError).toBe('The vault did not answer in time');
    } finally {
      vaultHangMs = 0;
      await local.close();
    }
  });

  it('refreshes on the timer and loads what another process wrote', async () => {
    const local = await createTestServer(
      { EXTERNAL_SECRETS_UPDATE_INTERVAL: '1' },
      { reset: false, secretProviderTypes: [fakeType] },
    );
    try {
      const owner = await signup(local.app);
      const token = newToken();
      vaultSecrets.set(token, { key: 'first' });
      await local.ctx.secrets.createConnection(owner.tenant.id, {
        providerKey: 'main',
        type: 'testVault',
        settings: { url: vaultUrl, token },
        isEnabled: true,
      });
      vaultSecrets.set(token, { key: 'second' });
      await waitFor(async () => local.ctx.secrets.secretsFor(owner.tenant.id).main.key === 'second', {
        timeout: 5000,
      });

      // a failed refresh keeps the values and says so; the next one recovers
      vaultStatus = 500;
      await waitFor(
        async () => (await local.ctx.secrets.getConnection(owner.tenant.id, 'main')).state === 'retrying',
        { timeout: 5000 },
      );
      expect(local.ctx.secrets.secretsFor(owner.tenant.id).main.key).toBe('second');
      vaultStatus = undefined;
      await waitFor(
        async () => (await local.ctx.secrets.getConnection(owner.tenant.id, 'main')).state === 'connected',
        { timeout: 5000 },
      );

      // a row this process never heard about (a lost bus message)
      const other = newToken();
      vaultSecrets.set(other, { key: 'via-server' });
      await server.ctx.secrets.createConnection(owner.tenant.id, {
        providerKey: 'written',
        type: 'testVault',
        settings: { url: vaultUrl, token: other },
        isEnabled: true,
      });
      await waitFor(
        async () => {
          try {
            return local.ctx.secrets.secretsFor(owner.tenant.id).written.key === 'via-server';
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      );
    } finally {
      await local.close();
    }
  });

  it('start loads the enabled connections before jobs; stop forgets them', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { key: 'value' });
    const fresh = await createContext({
      config: testConfig(),
      nodePackages: [nodesBasePackage, testPackage],
      secretProviderTypes: [fakeType],
      http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }),
      migrate: false,
    });
    try {
      expect(() => fresh.secrets.secretsFor(owner.tenant.id).main).toThrow('Could not load secrets');
      await fresh.secrets.start();
      expect(fresh.secrets.secretsFor(owner.tenant.id).main.key).toBe('value');
      // the credential service got the manager from start: a worker builds no routes
      const credential = await fresh.credentials.create(owner.tenant.id, {
        name: 'C',
        type: 'testApi',
        data: { apiKey: '={{ $secrets.main.key }}' },
      });
      const read = await fresh.credentials
        .provider(owner.tenant.id, await teamProjectOf(server, owner.tenant.id))
        .get({ id: credential.id, name: 'C' }, 'testApi');
      expect(read.apiKey).toBe('value');
      await fresh.secrets.stop();
      expect(() => fresh.secrets.secretsFor(owner.tenant.id).main).toThrow('Could not load secrets');
    } finally {
      await fresh.close();
    }
  });
});

describe('startup limit', () => {
  it('start waits a bounded time for vaults that never answer, and stop ends what is left', async () => {
    const owner = await signup(server.app);
    const { dto } = await connection(owner, 'main', { key: 'value' });
    const row = await server.ctx.repos.secrets.get(owner.tenant.id, dto.providerKey);
    const fresh = await createContext({
      config: testConfig({ EXTERNAL_SECRETS_CONNECT_TIMEOUT: '1', EXTERNAL_SECRETS_REFRESH_TIMEOUT: '1' }),
      nodePackages: [nodesBasePackage, testPackage],
      secretProviderTypes: [fakeType],
      http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }),
      migrate: false,
    });
    // 60 rows at 10 at a time and 1 s each: about 6 s without the limit of 2 s
    const rows = Array.from({ length: 60 }, (_, i) => ({ ...row!, providerKey: `slow${i}` }));
    vi.spyOn(fresh.repos.secrets, 'listAllEnabled').mockResolvedValue(rows);
    try {
      vaultHangMs = 10_000;
      const started = Date.now();
      await fresh.secrets.start();
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(1900);
      expect(waited).toBeLessThan(4000);
      // the connects go on in the background until stop
      const hits = vaultHits;
      await new Promise((r) => setTimeout(r, 1100));
      expect(vaultHits).toBeGreaterThan(hits);
      await fresh.secrets.stop();
      await new Promise((r) => setTimeout(r, 100));
      const afterStop = vaultHits;
      await new Promise((r) => setTimeout(r, 1100));
      expect(vaultHits).toBe(afterStop);
    } finally {
      vaultHangMs = 0;
      await fresh.close();
    }
  });
});

describe('bus reload', () => {
  it('a change on one instance reaches another', async () => {
    await flushRedis();
    const env = { EXECUTIONS_MODE: 'queue', REDIS_URL: TEST_REDIS, QUEUE_PREFIX: 'wfsecrets' };
    const main = await createTestServer(env, { reset: false, secretProviderTypes: [fakeType] });
    let worker: ServerContext | undefined;
    try {
      worker = await createContext({
        config: testConfig(env),
        nodePackages: [nodesBasePackage, testPackage],
        secretProviderTypes: [fakeType],
        http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }),
        migrate: false,
      });
      await worker.secrets.start();
      const owner = await signup(main.app);
      const token = newToken();
      vaultSecrets.set(token, { key: 'first' });
      const peer = worker;
      const read = () => {
        try {
          return peer.secrets.secretsFor(owner.tenant.id).main.key;
        } catch {
          return undefined;
        }
      };
      await main.ctx.secrets.createConnection(owner.tenant.id, {
        providerKey: 'main',
        type: 'testVault',
        settings: { url: vaultUrl, token },
        isEnabled: true,
      });
      await waitFor(async () => read() === 'first');

      vaultSecrets.set(token, { key: 'second' });
      await main.ctx.secrets.reloadConnection(owner.tenant.id, 'main');
      await waitFor(async () => read() === 'second');

      await main.ctx.secrets.updateConnection(owner.tenant.id, 'main', { isEnabled: false });
      await waitFor(async () => read() === undefined);

      await main.ctx.secrets.updateConnection(owner.tenant.id, 'main', { isEnabled: true });
      await waitFor(async () => read() === 'second');
      await main.ctx.secrets.deleteConnection(owner.tenant.id, 'main');
      await waitFor(async () => read() === undefined);
    } finally {
      await worker?.close();
      await main.close();
    }
  });
});

describe('credentials read secrets', () => {
  it('a credential field reads a secret from a test vault (HTTP Request node)', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { key: 'vault-value' });
    const credential = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Header',
        type: 'httpHeaderAuth',
        data: { name: 'x-from-vault', value: '={{ $secrets.main.key }}' },
      }),
    );
    const wf = await createWorkflow(owner.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Call',
          'core.httpRequest',
          {
            url: `${remoteUrl}/echo`,
            authentication: 'genericCredentialType',
            genericAuthType: 'httpHeaderAuth',
          },
          [200, 0],
          { credentials: { httpHeaderAuth: { id: credential.id, name: 'Header' } } },
        ),
      ],
      connections: chain('Start', 'Call'),
    });
    const { executionId } = await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const hit = received.find((r) => r.url === '/echo');
    expect(hit?.headers['x-from-vault']).toBe('vault-value');

    // the stored expression is still there, not the value
    const row = await server.ctx.repos.credentials.get(owner.tenant.id, credential.id);
    expect(server.ctx.credentials.decrypt(row!).value).toBe('={{ $secrets.main.key }}');
  });

  it('GET shows a password field that holds an expression, and redacts a typed password', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { key: 'vault-value' });
    const withExpression = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Expr',
        type: 'testApi',
        data: { apiKey: '={{ $secrets.main.key }}' },
      }),
    );
    const api = await owner.client.data(owner.client.get(`/rest/credentials/${withExpression.id}`));
    expect(api.data.apiKey).toBe('={{ $secrets.main.key }}');
    expect(JSON.stringify(api)).not.toContain('vault-value');

    const typed = await owner.client.data(
      owner.client.post('/rest/credentials', { name: 'Typed', type: 'testApi', data: { apiKey: '=typed' } }),
    );
    expect((await owner.client.data(owner.client.get(`/rest/credentials/${typed.id}`))).data.apiKey).toBe(
      '__REDACTED__',
    );

    const braces = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Braces',
        type: 'testApi',
        data: { apiKey: '=aB{{9x' },
      }),
    );
    expect((await owner.client.data(owner.client.get(`/rest/credentials/${braces.id}`))).data.apiKey).toBe(
      '__REDACTED__',
    );

    expect(
      redactCredentialData(
        { a: '={{ $x }}', b: 's', c: '', d: 5, e: '=aB{{9x', f: '=Bearer {{ $x }}' },
        new Set(['a', 'b', 'c', 'd', 'e', 'f']),
      ),
    ).toEqual({
      a: '={{ $x }}',
      b: '__REDACTED__',
      c: '',
      d: '__REDACTED__',
      e: '__REDACTED__',
      f: '=Bearer {{ $x }}',
    });
  });

  it('gives the two n8n errors at run time', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { key: 'vault-value' });
    const run = async (expression: string) => {
      const credential = await server.ctx.credentials.create(owner.tenant.id, {
        name: `C ${randomUUID()}`,
        type: 'testApi',
        data: { apiKey: expression },
      });
      const wf = await createWorkflow(owner.client, {
        nodes: [
          node('Start', 'core.manualTrigger'),
          node('Use', 'test.useCredential', {}, [200, 0], {
            credentials: { testApi: { id: credential.id, name: credential.name } },
          }),
        ],
        connections: chain('Start', 'Use'),
      });
      const { executionId } = await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
      await waitForExecution(server.ctx, owner.tenant.id, executionId, ['error']);
      return JSON.stringify(await owner.client.data(owner.client.get(`/rest/executions/${executionId}`)));
    };
    const provider = await run('={{ $secrets.nope.key }}');
    expect(provider).toContain('Could not load secrets');
    expect(provider).toContain(NOT_REACHABLE);
    const secret = await run('={{ $secrets.main.nope }}');
    expect(secret).toContain('Could not load secrets');
    expect(secret).toContain(NOT_FOUND);
    const good = await run('={{ JSON.parse($secrets.main.key) }}');
    expect(good).toContain('Could not read the credential');
    expect(good).not.toContain('vault-value');
  });

  it('reads $vars next to $secrets in a credential', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { key: 'vault-value' });
    await owner.client.data(owner.client.post('/rest/variables', { key: 'prefix', value: 'p-' }));
    const credential = await server.ctx.credentials.create(owner.tenant.id, {
      name: 'C',
      type: 'testApi',
      data: { apiKey: '={{ $vars.prefix + $secrets.main.key }}' },
    });
    const data = await server.ctx.credentials
      .provider(owner.tenant.id, await teamProjectOf(server, owner.tenant.id))
      .get({ id: credential.id, name: 'C' }, 'testApi');
    expect(data.apiKey).toBe('p-vault-value');
  });

  it('the test route resolves a stored and a sent expression and hides the value in its answer', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { key: 'vault-value', host: remoteUrl });
    const stored = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'T',
        type: 'testApi',
        data: { baseUrl: '={{ $secrets.main.host }}', apiKey: '={{ $secrets.main.key }}' },
      }),
    );
    const tested = await owner.client.data(
      owner.client.post('/rest/credentials/test', {
        id: stored.id,
        type: 'testApi',
        data: { baseUrl: '={{ $secrets.main.host }}', apiKey: '={{ $secrets.main.key }}' },
      }),
    );
    expect(tested.status).toBe('OK');
    expect(received.at(-1)?.headers['x-api-key']).toBe('vault-value');

    const unsaved = await owner.client.data(
      owner.client.post('/rest/credentials/test', {
        type: 'testApi',
        data: { baseUrl: remoteUrl, apiKey: '={{ $secrets.nope.key }}' },
      }),
    );
    expect(unsaved.status).toBe('Error');
    expect(unsaved.message).toContain('Could not load secrets');

    const broken = await owner.client.data(
      owner.client.post('/rest/credentials/test', {
        type: 'testApi',
        data: { baseUrl: '={{ $secrets.main.key }}', apiKey: 'x' },
      }),
    );
    expect(broken.status).toBe('Error');
    expect(JSON.stringify(broken)).not.toContain('vault-value');
  });

  it('OAuth2: the code exchange uses the vault value and the refresh writes back only the token', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { clientId: 'client-from-vault', clientSecret: 'secret-from-vault' });
    const credential = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'OAuth',
        type: 'testPkceOAuth2Api',
        data: {
          authUrl: 'https://auth.example.com/authorize',
          accessTokenUrl: `${remoteUrl}/token`,
          clientId: '={{ $secrets.main.clientId }}',
          clientSecret: '={{ $secrets.main.clientSecret }}',
        },
      }),
    );
    const { url } = await owner.client.data(
      owner.client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`),
    );
    const authorize = new URL(url);
    expect(authorize.searchParams.get('client_id')).toBe('client-from-vault');
    const callback = await server.app.inject({
      url: `/rest/oauth2/callback?code=abc&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
    });
    expect(callback.statusCode).toBe(200);
    const exchange = new URLSearchParams(received.find((r) => r.url === '/token')!.body);
    expect(exchange.get('client_secret')).toBe('secret-from-vault');

    const raw = async () =>
      server.ctx.credentials.decrypt(
        (await server.ctx.repos.credentials.get(owner.tenant.id, credential.id))!,
      );
    const afterCallback = await raw();
    expect(afterCallback.clientSecret).toBe('={{ $secrets.main.clientSecret }}');
    expect(afterCallback.oauthTokenData).toMatchObject({ access_token: 'access-1' });

    // what core's refresh hands to provider().update: the resolved data and the new token
    const provider = server.ctx.credentials.provider(
      owner.tenant.id,
      await teamProjectOf(server, owner.tenant.id),
    );
    const ref = { id: credential.id, name: 'OAuth' };
    const resolved = await provider.get(ref, 'testPkceOAuth2Api');
    expect(resolved.clientSecret).toBe('secret-from-vault');
    await provider.update(ref, 'testPkceOAuth2Api', {
      ...resolved,
      scope: 'written-back',
      oauthTokenData: { access_token: 'access-2' },
    });
    const afterRefresh = await raw();
    expect(afterRefresh.clientSecret).toBe('={{ $secrets.main.clientSecret }}');
    expect(afterRefresh.clientId).toBe('={{ $secrets.main.clientId }}');
    expect(afterRefresh.scope).toBeUndefined();
    expect(afterRefresh.oauthTokenData).toEqual({ access_token: 'access-2' });
    expect(JSON.stringify(afterRefresh)).not.toContain('secret-from-vault');
  });

  it('OAuth2 and OAuth1 authorize answer 400 with the fixed text when the secret is gone', async () => {
    const owner = await signup(server.app);
    const oauth2 = await server.ctx.credentials.create(owner.tenant.id, {
      name: 'O2',
      type: 'testPkceOAuth2Api',
      data: { authUrl: 'https://auth.example.com/a', clientId: '={{ $secrets.nope.id }}' },
    });
    const res = await owner.client.get(`/rest/oauth2/authorize?credentialId=${oauth2.id}`);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Could not load secrets');

    const oauth1 = await server.ctx.credentials.create(owner.tenant.id, {
      name: 'O1',
      type: 'oAuth1Api',
      data: {
        requestTokenUrl: `${remoteUrl}/request`,
        authUrl: 'https://auth.example.com/a',
        accessTokenUrl: `${remoteUrl}/access`,
        consumerKey: '={{ $secrets.nope.id }}',
      },
    });
    const one = await owner.client.get(`/rest/oauth1/authorize?credentialId=${oauth1.id}`);
    expect(one.statusCode).toBe(400);
    expect(one.body).toContain('Could not load secrets');
  });

  it('OAuth1: the request token call signs with the vault consumer key and the stored data stays', async () => {
    const owner = await signup(server.app);
    await connection(owner, 'main', { consumerKey: 'key-from-vault', consumerSecret: 'secret-from-vault' });
    const credential = await server.ctx.credentials.create(owner.tenant.id, {
      name: 'O1',
      type: 'oAuth1Api',
      data: {
        requestTokenUrl: `${remoteUrl}/request`,
        authUrl: 'https://auth.example.com/a',
        accessTokenUrl: `${remoteUrl}/access`,
        consumerKey: '={{ $secrets.main.consumerKey }}',
        consumerSecret: '={{ $secrets.main.consumerSecret }}',
      },
    });
    // the fake answers JSON, not a token form: the call has been made by then
    const res = await owner.client.get(`/rest/oauth1/authorize?credentialId=${credential.id}`);
    expect(res.statusCode).toBe(400);
    const call = received.find((r) => r.url === '/request');
    expect(String(call?.headers.authorization)).toContain('oauth_consumer_key="key-from-vault"');
    const row = await server.ctx.repos.credentials.get(owner.tenant.id, credential.id);
    expect(server.ctx.credentials.decrypt(row!).consumerKey).toBe('={{ $secrets.main.consumerKey }}');
    expect(row?.secretKeys).toEqual(['main']);
  });

  it('a credential without expressions reads no variables and does not need the manager', async () => {
    const owner = await signup(server.app);
    const credential = await server.ctx.credentials.create(owner.tenant.id, {
      name: 'Plain',
      type: 'testApi',
      data: { apiKey: 'typed' },
    });
    const map = vi.spyOn(server.ctx.repos.variables, 'map');
    const secretsFor = vi.spyOn(server.ctx.secrets, 'secretsFor');
    const data = await server.ctx.credentials
      .provider(owner.tenant.id, await teamProjectOf(server, owner.tenant.id))
      .get({ id: credential.id, name: 'Plain' }, 'testApi');
    expect(data.apiKey).toBe('typed');
    expect(map).not.toHaveBeenCalled();
    expect(secretsFor).not.toHaveBeenCalled();
    map.mockRestore();
    secretsFor.mockRestore();
  });
});
