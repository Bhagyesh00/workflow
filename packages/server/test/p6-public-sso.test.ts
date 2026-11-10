/**
 * P6-14 (L12): GET and PUT /api/v1/settings/sso/saml (`saml:manage`) and /settings/sso/oidc (`oidc:manage`).
 * A key with the scope reads and writes, one without gets 403, another workspace's config is unseen, a GET
 * answer can be sent back as the PUT body, and no secret is in any answer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeOidcIdp, startFakeOidcIdp } from './fakes/oidc-idp';
import {
  createTestServer,
  realMember,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;
const idps: FakeOidcIdp[] = [];

beforeAll(async () => {
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000' },
    { startMain: false, allowInsecureIdp: true },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});
afterEach(async () => {
  while (idps.length) await idps.pop()!.close();
});

const api = (key: string, method: 'GET' | 'PUT', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

let keyCount = 0;
async function keyOf(client: TestClient, scopes?: string[]): Promise<string> {
  const made = await client.data(
    client.post('/rest/api-keys', { name: `k${(keyCount += 1)}`, ...(scopes ? { scopes } : {}) }),
  );
  return made.key as string;
}

describe('SAML config', () => {
  it('reads, writes, and the GET answer goes back as the PUT body', async () => {
    const owner = await signup(server.app);
    const key = await keyOf(owner.client);
    const got = await api(key, 'GET', '/settings/sso/saml');
    expect(got.statusCode).toBe(200);
    const put = await api(key, 'PUT', '/settings/sso/saml', {
      loginLabel: 'Corp SAML',
      loginBinding: 'post',
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data).toMatchObject({ loginLabel: 'Corp SAML', loginBinding: 'post' });
    const again = (await api(key, 'GET', '/settings/sso/saml')).json().data;
    const echoed = await api(key, 'PUT', '/settings/sso/saml', again);
    expect(echoed.statusCode).toBe(200);
    expect(echoed.json().data).toEqual(again);
  });

  it('refuses a key without the scope', async () => {
    const owner = await signup(server.app);
    const narrow = await keyOf(owner.client, ['workflow:read']);
    for (const method of ['GET', 'PUT'] as const) {
      const res = await api(narrow, method, '/settings/sso/saml', method === 'PUT' ? {} : undefined);
      expect(res.statusCode).toBe(403);
    }
    const scoped = await keyOf(owner.client, ['saml:manage']);
    expect((await api(scoped, 'GET', '/settings/sso/saml')).statusCode).toBe(200);
    expect((await api(scoped, 'GET', '/settings/sso/oidc')).statusCode).toBe(403);
  });

  it('shows one workspace nothing of another', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    await api(await keyOf(a.client), 'PUT', '/settings/sso/saml', { loginLabel: 'A only' });
    const seen = (await api(await keyOf(b.client), 'GET', '/settings/sso/saml')).json().data;
    expect(seen.loginLabel).not.toBe('A only');
  });
});

describe('OIDC config', () => {
  async function save(key: string, extra: Record<string, unknown> = {}) {
    const idp = await startFakeOidcIdp();
    idps.push(idp);
    const body = {
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      discoveryEndpoint: idp.discoveryUrl,
      ...extra,
    };
    return { idp, res: await api(key, 'PUT', '/settings/sso/oidc', body) };
  }

  it('writes, blanks the secret, keeps it on a blank, and takes the GET answer back', async () => {
    const owner = await signup(server.app);
    const key = await keyOf(owner.client);
    const { idp, res } = await save(key, { loginLabel: 'Corp OIDC' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      clientId: idp.clientId,
      clientSecret: '',
      loginLabel: 'Corp OIDC',
    });
    expect(res.body).not.toContain(idp.clientSecret);
    const got = await api(key, 'GET', '/settings/sso/oidc');
    expect(got.body).not.toContain(idp.clientSecret);
    const echoed = await api(key, 'PUT', '/settings/sso/oidc', got.json().data);
    expect(echoed.statusCode).toBe(200);
    expect(echoed.json().data).toEqual(got.json().data);
    expect(echoed.body).not.toContain(idp.clientSecret);
    const stored = await server.ctx.repos.sso.get(owner.tenant.id);
    expect(stored?.oidcSecretEnc).toBeTruthy();
  });

  it('refuses a key without the scope and hides another workspace', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const { idp } = await save(await keyOf(a.client));
    const narrow = await keyOf(a.client, ['saml:manage']);
    expect((await api(narrow, 'GET', '/settings/sso/oidc')).statusCode).toBe(403);
    expect((await api(narrow, 'PUT', '/settings/sso/oidc', {})).statusCode).toBe(403);
    const seen = (await api(await keyOf(b.client), 'GET', '/settings/sso/oidc')).json().data;
    expect(seen.clientId).not.toBe(idp.clientId);
  });
});

describe('a true member', () => {
  it('is refused on both configs with a key that has no scopes, and the stored config stays', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const ownerKey = await keyOf(owner.client);
    await api(ownerKey, 'PUT', '/settings/sso/saml', { loginLabel: 'Owner SAML' });
    const before = await server.ctx.repos.sso.get(owner.tenant.id);
    const memberKey = await keyOf(member.client);
    for (const kind of ['saml', 'oidc']) {
      for (const method of ['GET', 'PUT'] as const) {
        const payload = method === 'PUT' ? { loginLabel: 'Taken' } : undefined;
        const res = await api(memberKey, method, `/settings/sso/${kind}`, payload);
        expect(res.statusCode).toBe(403);
      }
    }
    expect(await server.ctx.repos.sso.get(owner.tenant.id)).toEqual(before);
    expect((await api(ownerKey, 'GET', '/settings/sso/saml')).json().data.loginLabel).toBe('Owner SAML');
  });
});
