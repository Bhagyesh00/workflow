/**
 * P6-10 (L8): OIDC sign-in. A provider fake on node:http (discovery, token, JWKS, userinfo, RS256 by node
 * crypto) plays the identity provider; the browser is played by `inject`. Sign-in, the attack tests (wrong
 * issuer, nonce, state, audience, key; expired; replay; the provider's error text), the method off
 * (GHSA-pf83-w3f9-8m37), the SSRF guard on every provider URL, the email verified rule, the config (secret
 * encrypted, blank keeps it), the test flow (no session) and the logout.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FakeOidcIdp, type FakeOidcPerson, startFakeOidcIdp } from './fakes/oidc-idp';
import {
  createTestServer,
  flushRedis,
  ORIGIN,
  realMember,
  signup,
  TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;
let address = 0;
const nextAddress = () => {
  address++;
  return `10.62.${Math.floor(address / 250)}.${(address % 250) + 1}`;
};
const idps: FakeOidcIdp[] = [];

beforeAll(async () => {
  await flushRedis();
  server = await createTestServer({}, { allowInsecureIdp: true });
});

afterAll(async () => {
  await server?.close();
});

afterEach(async () => {
  while (idps.length) await idps.pop()!.close();
});

interface Workspace {
  owner: Awaited<ReturnType<typeof signup>>;
  tenantId: string;
  slug: string;
  idp: FakeOidcIdp;
  /** a member made before SSO was on (invites are blocked under SSO) */
  member: Awaited<ReturnType<typeof realMember>>;
}

type ConfigBody = Record<string, unknown>;

/** a workspace with a provider fake and the OIDC config saved through the route */
async function workspace(
  config: ConfigBody = {},
  idpOptions: Parameters<typeof startFakeOidcIdp>[0] = {},
): Promise<Workspace> {
  const idp = await startFakeOidcIdp(idpOptions);
  idps.push(idp);
  const owner = await signup(server.app, { remoteAddress: nextAddress() });
  const member = await realMember(owner, { remoteAddress: nextAddress() });
  const saved = await owner.client.post('/rest/sso/oidc/config', {
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    discoveryEndpoint: idp.discoveryUrl,
    loginEnabled: true,
    ...config,
  });
  if (saved.statusCode !== 200) throw new Error(`config save failed: ${saved.body}`);
  return { owner, tenantId: owner.tenant.id, slug: owner.tenant.slug, idp, member };
}

const person = (overrides: Partial<FakeOidcPerson> = {}): FakeOidcPerson => ({
  sub: `sub-${randomUUID()}`,
  email: `oidc-${randomUUID().slice(0, 8)}@example.com`,
  email_verified: true,
  given_name: 'Ada',
  family_name: 'Lovelace',
  ...overrides,
});

type Injected = Awaited<ReturnType<TestServer['app']['inject']>>;

/** name to value of the cookies a response sets (an empty value = cleared) */
function cookiesOf(res: Injected): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cookie of res.cookies) out[cookie.name] = cookie.value;
  return out;
}

const cookieHeader = (cookies: Record<string, string>) =>
  Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

function browserGet(url: string, cookies: Record<string, string> = {}): Promise<Injected> {
  return server.app.inject({
    method: 'GET',
    url,
    remoteAddress: nextAddress(),
    headers: Object.keys(cookies).length ? { cookie: cookieHeader(cookies) } : {},
  });
}

/** the browser's start of a sign-in: the provider's URL and the cookies the server set */
async function startLogin(w: Workspace, redirect?: string) {
  const query = redirect === undefined ? '' : `?redirect=${encodeURIComponent(redirect)}`;
  const res = await browserGet(`/sso/oidc/${w.slug}/login${query}`);
  return { res, location: String(res.headers.location ?? ''), cookies: cookiesOf(res) };
}

function callbackUrl(w: Workspace, query: Record<string, string>): string {
  return `/sso/oidc/${w.slug}/callback?${new URLSearchParams(query).toString()}`;
}

/** the whole visit: login, the provider, the callback */
async function signIn(
  w: Workspace,
  visit: Parameters<FakeOidcIdp['authorize']>[1],
  options: { redirect?: string } = {},
) {
  const login = await startLogin(w, options.redirect);
  expect(login.res.statusCode, login.res.body).toBe(302);
  const query = w.idp.authorize(login.location, visit);
  const res = await browserGet(callbackUrl(w, query), login.cookies);
  return { login, query, res, location: String(res.headers.location ?? ''), cookies: cookiesOf(res) };
}

function errorOf(location: string): string | null {
  return new URL(location, 'http://localhost').searchParams.get('ssoError');
}

const sessionOf = (cookies: Record<string, string>) => cookies.wf_session ?? '';

async function userCount(email: string): Promise<number> {
  const { rows } = await server.ctx.database.pool.query('select count(*)::int as n from users where email = $1', [
    email,
  ]);
  return rows[0].n;
}

async function sessionRows(userId: string): Promise<Array<{ auth_method: string; mfa_verified: boolean }>> {
  const { rows } = await server.ctx.database.pool.query(
    'select auth_method, mfa_verified from sessions where user_id = $1',
    [userId],
  );
  return rows;
}

describe('sign-in', () => {
  it('signs a new person in through the provider (state, nonce, no PKCE) and starts an oidc session', async () => {
    const w = await workspace();
    const who = person();
    const login = await startLogin(w);
    expect(login.res.statusCode).toBe(302);
    const auth = new URL(login.location);
    expect(`${auth.origin}${auth.pathname}`).toBe(`${w.idp.url}/authorize`);
    expect(auth.searchParams.get('client_id')).toBe(w.idp.clientId);
    expect(auth.searchParams.get('response_type')).toBe('code');
    expect(auth.searchParams.get('scope')).toBe('openid email profile');
    expect(auth.searchParams.get('prompt')).toBe('select_account');
    expect(auth.searchParams.get('redirect_uri')).toBe(
      `${server.ctx.config.baseUrl}/sso/oidc/${w.slug}/callback`,
    );
    expect(auth.searchParams.get('state')?.length).toBeGreaterThan(20);
    expect(auth.searchParams.get('nonce')?.length).toBeGreaterThan(20);
    expect(auth.searchParams.has('code_challenge')).toBe(false);
    // both cookies are httpOnly, 15 minutes, on the workspace's own path
    for (const name of ['wf_oidc_state', 'wf_oidc_nonce']) {
      const cookie = login.res.cookies.find((c) => c.name === name)!;
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.path).toBe(`/sso/oidc/${w.slug}`);
      expect(cookie.maxAge).toBe(900);
    }

    const query = w.idp.authorize(login.location, { person: who });
    const res = await browserGet(callbackUrl(w, query), login.cookies);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookies = cookiesOf(res);
    expect(sessionOf(cookies)).not.toBe('');
    const me = await new TestClient(server.app, ORIGIN, nextAddress());
    me.cookie = `wf_session=${sessionOf(cookies)}`;
    const meRes = await me.get('/rest/auth/me');
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().data.user.email).toBe(who.email);
    expect(meRes.json().data.tenant.id).toBe(w.tenantId);
    const rows = await sessionRows(meRes.json().data.user.id);
    expect(rows).toEqual([{ auth_method: 'oidc', mfa_verified: true }]);
    // the state and nonce cookies are cleared
    expect(cookies.wf_oidc_state).toBe('');
    expect(cookies.wf_oidc_nonce).toBe('');
    // the token request carried the code, the secret and the redirect URI
    expect(w.idp.tokenRequests[0]).toMatchObject({
      grant_type: 'authorization_code',
      client_secret: w.idp.clientSecret,
    });
  });

  it('a second sign-in of the same person is the same user, and discovery was read once', async () => {
    const w = await workspace();
    const who = person();
    const first = await signIn(w, { person: who });
    const second = await signIn(w, { person: who });
    expect(first.res.statusCode).toBe(302);
    expect(second.res.statusCode).toBe(302);
    const rows = await server.ctx.database.pool.query(
      'select count(*)::int as n from auth_identities where tenant_id = $1 and provider_type = $2',
      [w.tenantId, 'oidc'],
    );
    expect(rows.rows[0].n).toBe(1);
    // the save primed the cache; two sign-ins read nothing again
    expect(w.idp.requests.filter((r) => r.path === '/.well-known/openid-configuration')).toHaveLength(1);
  });

  it('the userinfo is merged and the id token wins where both speak', async () => {
    const w = await workspace();
    const who = person({ email: 'merge@example.com', given_name: undefined, family_name: undefined });
    const res = await signIn(w, {
      person: who,
      userinfo: { given_name: 'Grace', family_name: 'Hopper', email: 'ignored@example.com' },
    });
    expect(res.res.statusCode).toBe(302);
    expect(w.idp.requests.some((r) => r.path === '/userinfo')).toBe(true);
    const { rows } = await server.ctx.database.pool.query('select name from users where email = $1', [
      'merge@example.com',
    ]);
    expect(rows[0].name).toBe('Grace Hopper');
    expect(await userCount('ignored@example.com')).toBe(0);
  });

  it('sends the browser on to a safe redirect only', async () => {
    const w = await workspace();
    const ok = await signIn(w, { person: person() }, { redirect: '/workflows?tab=mine' });
    expect(ok.location).toBe('/workflows?tab=mine');
    const evil = await signIn(w, { person: person() }, { redirect: 'https://evil.example/steal' });
    expect(evil.location).toBe('/');
    const slashes = await signIn(w, { person: person() }, { redirect: '//evil.example' });
    expect(slashes.location).toBe('/');
  });

  it('the authorization URL holds the prompt, the ACR values and the extra scopes', async () => {
    const w = await workspace({
      prompt: 'login',
      authenticationContextClassReference: ['urn:mfa', 'urn:phr'],
      additionalScopes: 'groups offline_access',
    });
    const login = await startLogin(w);
    const params = new URL(login.location).searchParams;
    expect(params.get('prompt')).toBe('login');
    expect(params.get('acr_values')).toBe('urn:mfa urn:phr');
    expect(params.get('scope')).toBe('openid email profile groups offline_access');
  });

  it("asks for provisioning's scope name when provisioning is on", async () => {
    const w = await workspace();
    await server.ctx.repos.sso.upsert(w.tenantId, {
      provisioning: { scopesProvisionInstanceRole: true, scopesName: 'wf_roles' },
    });
    const login = await startLogin(w);
    expect(new URL(login.location).searchParams.get('scope')).toBe('openid email profile wf_roles');
  });

  it('an unknown workspace is 404', async () => {
    const res = await browserGet('/sso/oidc/no-such-workspace/login');
    expect(res.statusCode).toBe(404);
  });
});

describe('attacks', () => {
  async function refused(visit: Parameters<FakeOidcIdp['authorize']>[1], code = 'sso_login_failed') {
    const w = await workspace();
    const res = await signIn(w, visit);
    expect(res.res.statusCode).toBe(302);
    expect(errorOf(res.location)).toBe(code);
    expect(res.location.startsWith('/signin?')).toBe(true);
    expect(new URL(res.location, 'http://localhost').searchParams.get('workspace')).toBe(w.slug);
    expect(sessionOf(res.cookies)).toBe('');
    expect(await userCount(String(visit.person.email))).toBe(0);
    return { w, res };
  }

  it('a wrong issuer is refused', async () => {
    await refused({ person: person(), idToken: { iss: 'http://127.0.0.1:1' } });
  });

  it('a wrong nonce is refused', async () => {
    await refused({ person: person(), idToken: { nonce: 'not-the-nonce' } });
  });

  it('a wrong audience is refused', async () => {
    await refused({ person: person(), idToken: { aud: 'another-client' } });
  });

  it('an expired id token is refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    await refused({ person: person(), idToken: { iat: now - 7200, exp: now - 3600 } });
  });

  it('an id token signed with a key the provider does not publish is refused', async () => {
    await refused({ person: person(), signWithOtherKey: true });
  });

  it('a wrong state is refused before any call to the provider', async () => {
    const w = await workspace();
    const login = await startLogin(w);
    const query = w.idp.authorize(login.location, { person: person(), state: 'forged-state' });
    const res = await browserGet(callbackUrl(w, query), login.cookies);
    expect(errorOf(String(res.headers.location))).toBe('sso_state_invalid');
    expect(w.idp.tokenRequests).toHaveLength(0);
    expect(sessionOf(cookiesOf(res))).toBe('');
  });

  it('a callback with no state cookie, or a forged one, is refused', async () => {
    const w = await workspace();
    const login = await startLogin(w);
    const query = w.idp.authorize(login.location, { person: person() });
    const none = await browserGet(callbackUrl(w, query));
    expect(errorOf(String(none.headers.location))).toBe('sso_state_invalid');
    const forged = await browserGet(callbackUrl(w, query), {
      ...login.cookies,
      wf_oidc_state: `${login.cookies.wf_oidc_state.slice(0, -4)}AAAA`,
    });
    expect(errorOf(String(forged.headers.location))).toBe('sso_state_invalid');
    // the nonce cookie alone is not the proof either
    const noNonce = await browserGet(callbackUrl(w, query), { wf_oidc_state: login.cookies.wf_oidc_state });
    expect(errorOf(String(noNonce.headers.location))).toBe('sso_state_invalid');
    expect(w.idp.tokenRequests).toHaveLength(0);
  });

  it("another workspace's cookies do not open this workspace's callback", async () => {
    const a = await workspace();
    const b = await workspace();
    const login = await startLogin(a);
    const query = a.idp.authorize(login.location, { person: person() });
    const res = await browserGet(callbackUrl(b, query), login.cookies);
    expect(errorOf(String(res.headers.location))).toBe('sso_state_invalid');
  });

  it('the same callback twice is refused the second time (the code is used once)', async () => {
    const w = await workspace();
    const login = await startLogin(w);
    const query = w.idp.authorize(login.location, { person: person() });
    const first = await browserGet(callbackUrl(w, query), login.cookies);
    expect(sessionOf(cookiesOf(first))).not.toBe('');
    const second = await browserGet(callbackUrl(w, query), login.cookies);
    expect(errorOf(String(second.headers.location))).toBe('sso_login_failed');
    expect(sessionOf(cookiesOf(second))).toBe('');
  });

  it("the provider's error text is never reflected", async () => {
    const w = await workspace();
    const login = await startLogin(w);
    const query = w.idp.authorize(login.location, {
      person: person(),
      error: { error: 'server_error', description: '<script>alert(1)</script> IDP-DESC' },
    });
    const res = await browserGet(callbackUrl(w, query), login.cookies);
    const location = String(res.headers.location);
    expect(errorOf(location)).toBe('sso_login_failed');
    expect(location).not.toContain('IDP-DESC');
    expect(location).not.toContain('script');
    expect(res.body).not.toContain('IDP-DESC');
    // a refusal at the provider is the access error
    const again = await startLogin(w);
    const denied = w.idp.authorize(again.location, { person: person(), error: { error: 'access_denied' } });
    const res2 = await browserGet(callbackUrl(w, denied), again.cookies);
    expect(errorOf(String(res2.headers.location))).toBe('sso_access_blocked');
  });

  it("the token endpoint's error text is never reflected", async () => {
    const w = await workspace();
    // the secret changed at the provider: its answer holds a text with a marker
    w.idp.clientSecret = 'rotated-at-the-provider';
    const res = await signIn(w, { person: person() });
    expect(errorOf(res.location)).toBe('sso_login_failed');
    expect(res.location).not.toContain('IDP-SECRET-TEXT');
    expect(res.res.body).not.toContain('IDP-SECRET-TEXT');
  });
});

describe('the method must be on (GHSA-pf83-w3f9-8m37)', () => {
  it('login and callback refuse while OIDC is not the active method, and call nobody', async () => {
    const w = await workspace();
    const login = await startLogin(w);
    const query = w.idp.authorize(login.location, { person: person() });
    // an admin turns OIDC off after the browser left for the provider
    await server.ctx.repos.sso.upsert(w.tenantId, { method: 'email' });
    const res = await browserGet(callbackUrl(w, query), login.cookies);
    expect(errorOf(String(res.headers.location))).toBe('sso_method_inactive');
    expect(sessionOf(cookiesOf(res))).toBe('');
    expect(w.idp.tokenRequests).toHaveLength(0);
    const again = await startLogin(w);
    expect(errorOf(again.location)).toBe('sso_method_inactive');
    expect(again.cookies.wf_oidc_state).toBeUndefined();
  });

  it('a workspace that never saved OIDC refuses too', async () => {
    const owner = await signup(server.app, { remoteAddress: nextAddress() });
    const res = await browserGet(`/sso/oidc/${owner.tenant.slug}/login`);
    expect(errorOf(String(res.headers.location))).toBe('sso_method_inactive');
  });

  it('a config saved with login off signs nobody in', async () => {
    const w = await workspace({ loginEnabled: false });
    const res = await startLogin(w);
    expect(errorOf(res.location)).toBe('sso_method_inactive');
  });
});

describe('the egress guard', () => {
  it('a discovery endpoint on a private host is refused at save', async () => {
    const owner = await signup(server.app, { remoteAddress: nextAddress() });
    const res = await owner.client.post('/rest/sso/oidc/config', {
      clientId: 'c',
      clientSecret: 's',
      discoveryEndpoint: 'http://10.0.0.5/.well-known/openid-configuration',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('oidc_discovery_failed');
    expect(res.json().error.message).toMatch(/blocked/);
    const config = await owner.client.get('/rest/sso/oidc/config');
    expect(config.json().data.clientId).toBe('');
  });

  it('a discovery answering 302 to a blocked host is refused', async () => {
    const idp = await startFakeOidcIdp({ discoveryRedirect: 'http://10.0.0.5/.well-known/openid-configuration' });
    idps.push(idp);
    const owner = await signup(server.app, { remoteAddress: nextAddress() });
    const res = await owner.client.post('/rest/sso/oidc/config', {
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      discoveryEndpoint: idp.discoveryUrl,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('oidc_discovery_failed');
  });

  for (const key of ['jwks_uri', 'token_endpoint', 'userinfo_endpoint'] as const) {
    it(`a discovery whose ${key} is 10.0.0.5 fails the sign-in with the guard's error, never reflected`, async () => {
      const w = await workspace({}, { metadata: { [key]: 'http://10.0.0.5/endpoint' } });
      const res = await signIn(w, { person: person() });
      expect(res.res.statusCode).toBe(302);
      expect(errorOf(res.location)).toBe('sso_login_failed');
      expect(res.location).not.toContain('10.0.0.5');
      expect(res.res.body).not.toContain('10.0.0.5');
      expect(sessionOf(res.cookies)).toBe('');
    });
  }

  it('plain http to the provider is refused without the test option', async () => {
    const strict = await createTestServer({}, { reset: false });
    try {
      const idp = await startFakeOidcIdp();
      idps.push(idp);
      const owner = await signup(strict.app, { remoteAddress: nextAddress() });
      const res = await owner.client.post('/rest/sso/oidc/config', {
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        discoveryEndpoint: idp.discoveryUrl,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('oidc_discovery_failed');
      expect(idp.requests).toHaveLength(0);
    } finally {
      await strict.close();
    }
  });
});

describe('the verified email', () => {
  it('email_verified false is refused, absent passes unless required', async () => {
    const w = await workspace();
    const unverified = person({ email_verified: false });
    const res = await signIn(w, { person: unverified });
    expect(errorOf(res.location)).toBe('sso_email_unverified');
    expect(await userCount(String(unverified.email))).toBe(0);
    const absent = person({ email_verified: undefined });
    const ok = await signIn(w, { person: absent });
    expect(sessionOf(ok.cookies)).not.toBe('');
  });

  it('with the setting on, only a verified email passes', async () => {
    const w = await workspace({ emailVerifiedRequired: true });
    const absent = await signIn(w, { person: person({ email_verified: undefined }) });
    expect(errorOf(absent.location)).toBe('sso_email_unverified');
    const no = await signIn(w, { person: person({ email_verified: false }) });
    expect(errorOf(no.location)).toBe('sso_email_unverified');
    const yes = await signIn(w, { person: person({ email_verified: true }) });
    expect(sessionOf(yes.cookies)).not.toBe('');
  });

  it("a person whose email has an account elsewhere is not linked by email alone", async () => {
    const other = await signup(server.app, { remoteAddress: nextAddress() });
    const w = await workspace();
    const res = await signIn(w, { person: person({ email: other.user.email }) });
    expect(errorOf(res.location)).toBe('sso_invite_required');
    expect(sessionOf(res.cookies)).toBe('');
  });

  it('a current member signs in by a verified email', async () => {
    const w = await workspace();
    const res = await signIn(w, { person: person({ email: w.member.email }) });
    expect(sessionOf(res.cookies)).not.toBe('');
    const { rows } = await server.ctx.database.pool.query(
      'select user_id from auth_identities where tenant_id = $1 and provider_type = $2',
      [w.tenantId, 'oidc'],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('the config', () => {
  it('encrypts the secret, answers it blank, and a blank on save keeps it', async () => {
    const w = await workspace({ prompt: 'consent', additionalScopes: 'groups' });
    const { rows } = await server.ctx.database.pool.query(
      'select oidc_secret_enc, oidc from tenant_auth_settings where tenant_id = $1',
      [w.tenantId],
    );
    expect(rows[0].oidc_secret_enc).toMatch(/^v1\./);
    expect(rows[0].oidc_secret_enc).not.toContain(w.idp.clientSecret);
    expect(JSON.stringify(rows[0].oidc)).not.toContain(w.idp.clientSecret);

    const got = (await w.owner.client.get('/rest/sso/oidc/config')).json().data;
    expect(got).toMatchObject({
      clientId: w.idp.clientId,
      clientSecret: '',
      discoveryEndpoint: w.idp.discoveryUrl,
      loginEnabled: true,
      prompt: 'consent',
      additionalScopes: 'groups',
      emailVerifiedRequired: false,
      rpInitiatedLogoutEnabled: false,
      callbackUrl: `${server.ctx.config.baseUrl}/sso/oidc/${w.slug}/callback`,
    });
    expect(JSON.stringify(got)).not.toContain(w.idp.clientSecret);

    // the page sends the answer back: the secret stays
    const resave = await w.owner.client.post('/rest/sso/oidc/config', { ...got, clientSecret: '' });
    expect(resave.statusCode, resave.body).toBe(200);
    const sentinel = await w.owner.client.post('/rest/sso/oidc/config', { clientSecret: '__REDACTED__' });
    expect(sentinel.statusCode).toBe(200);
    const signedIn = await signIn(w, { person: person() });
    expect(sessionOf(signedIn.cookies)).not.toBe('');

    // a new secret replaces it (and the cached configuration of the old one is not used)
    const changed = await w.owner.client.post('/rest/sso/oidc/config', { clientSecret: 'a-new-secret' });
    expect(changed.statusCode).toBe(200);
    const stale = await signIn(w, { person: person() });
    expect(errorOf(stale.location)).toBe('sso_login_failed');
  });

  it('refuses a save whose discovery fails and keeps the stored config', async () => {
    const w = await workspace();
    const res = await w.owner.client.post('/rest/sso/oidc/config', {
      discoveryEndpoint: `${w.idp.url}/missing/.well-known/openid-configuration`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('oidc_discovery_failed');
    const got = (await w.owner.client.get('/rest/sso/oidc/config')).json().data;
    expect(got.discoveryEndpoint).toBe(w.idp.discoveryUrl);
  });

  it('needs a client, an endpoint and a first secret', async () => {
    const owner = await signup(server.app, { remoteAddress: nextAddress() });
    expect((await owner.client.post('/rest/sso/oidc/config', {})).statusCode).toBe(400);
    const idp = await startFakeOidcIdp();
    idps.push(idp);
    const noSecret = await owner.client.post('/rest/sso/oidc/config', {
      clientId: idp.clientId,
      discoveryEndpoint: idp.discoveryUrl,
    });
    expect(noSecret.statusCode).toBe(400);
    const badPrompt = await owner.client.post('/rest/sso/oidc/config', {
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      discoveryEndpoint: idp.discoveryUrl,
      prompt: 'sometimes',
    });
    expect(badPrompt.statusCode).toBe(400);
  });

  it('turning login on and off moves the workspace method and audits it, without the secret', async () => {
    const w = await workspace({ loginEnabled: false });
    expect(await server.ctx.ssoSettings.activeMethod(w.tenantId)).toBe('email');
    await w.owner.client.post('/rest/sso/oidc/config', { loginEnabled: true });
    expect(await server.ctx.ssoSettings.activeMethod(w.tenantId)).toBe('oidc');
    await w.owner.client.post('/rest/sso/oidc/config', { loginEnabled: false });
    expect(await server.ctx.ssoSettings.activeMethod(w.tenantId)).toBe('email');
    const { rows } = await server.ctx.database.pool.query(
      'select action, metadata from audit_log where tenant_id = $1 and action in ($2, $3) order by id',
      [w.tenantId, 'sso.oidc_config_updated', 'sso.method_changed'],
    );
    expect(rows.map((r) => r.action)).toContain('sso.oidc_config_updated');
    expect(rows.map((r) => r.action)).toContain('sso.method_changed');
    expect(JSON.stringify(rows)).not.toContain(w.idp.clientSecret);
  });

  it('is for oidc:manage only, and each workspace reads its own', async () => {
    const w = await workspace();
    const { member } = w;
    expect((await member.client.get('/rest/sso/oidc/config')).statusCode).toBe(403);
    expect((await member.client.post('/rest/sso/oidc/config', { prompt: 'login' })).statusCode).toBe(403);
    expect((await member.client.post('/rest/sso/oidc/config/test')).statusCode).toBe(403);
    const other = await signup(server.app, { remoteAddress: nextAddress() });
    const theirs = (await other.client.get('/rest/sso/oidc/config')).json().data;
    expect(theirs.clientId).toBe('');
    expect(theirs.loginEnabled).toBe(false);
  });
});

describe('the test flow', () => {
  it('runs with the method off, shows the result and sets no session cookie', async () => {
    const w = await workspace({ loginEnabled: false });
    const test = await w.owner.client.post('/rest/sso/oidc/config/test');
    expect(test.statusCode, test.body).toBe(200);
    const { url } = test.json().data;
    expect(new URL(url).pathname).toBe('/authorize');
    const cookies = cookiesOf(test);
    expect(cookies.wf_oidc_state).toBeTruthy();
    const who = person();
    const query = w.idp.authorize(url, { person: who });
    const res = await browserGet(callbackUrl(w, query), cookies);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(res.body).toContain('Test sign-in worked');
    expect(res.body).toContain(String(who.email));
    expect(sessionOf(cookiesOf(res))).toBe('');
    expect(res.cookies.map((c) => c.name)).not.toContain('wf_session');
    expect(await userCount(String(who.email))).toBe(0);
  });

  it('shows a failure page, with fixed words, when the id token is refused', async () => {
    const w = await workspace({ loginEnabled: false });
    const test = await w.owner.client.post('/rest/sso/oidc/config/test');
    const query = w.idp.authorize(test.json().data.url, {
      person: person({ email: '<b>x</b>@example.com' }),
      idToken: { nonce: 'wrong' },
    });
    const res = await browserGet(callbackUrl(w, query), cookiesOf(test));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Test sign-in didn't work");
    expect(res.body).not.toContain('<b>x</b>');
    expect(sessionOf(cookiesOf(res))).toBe('');
  });

  it('escapes the email on the success page', async () => {
    const w = await workspace({ loginEnabled: false });
    const test = await w.owner.client.post('/rest/sso/oidc/config/test');
    const query = w.idp.authorize(test.json().data.url, { person: person({ email: '"><img src=x>@e.com' }) });
    const res = await browserGet(callbackUrl(w, query), cookiesOf(test));
    expect(res.body).not.toContain('<img');
  });

  it('refuses a test before the settings are saved', async () => {
    const owner = await signup(server.app, { remoteAddress: nextAddress() });
    const res = await owner.client.post('/rest/sso/oidc/config/test');
    expect(res.statusCode).toBe(400);
  });

  it("a login cookie does not run as a test once the method is off", async () => {
    const w = await workspace({ loginEnabled: false });
    // a login-flow cookie (test: false) with the method off is refused: only the test flow runs while off
    await server.ctx.repos.sso.upsert(w.tenantId, { method: 'oidc' });
    const login = await startLogin(w);
    const query = w.idp.authorize(login.location, { person: person() });
    await server.ctx.repos.sso.upsert(w.tenantId, { method: 'email' });
    const res = await browserGet(callbackUrl(w, query), login.cookies);
    expect(errorOf(String(res.headers.location))).toBe('sso_method_inactive');
  });
});

describe('logout', () => {
  async function signedIn(w: Workspace, who = person()) {
    const res = await signIn(w, { person: who });
    const client = new TestClient(server.app, ORIGIN, nextAddress());
    client.cookie = cookieHeader({ wf_session: sessionOf(res.cookies), wf_oidc_idt: res.cookies.wf_oidc_idt ?? '' });
    return { res, client };
  }

  it("ends the session first, then answers the provider's end session URL with the id token", async () => {
    const w = await workspace({ rpInitiatedLogoutEnabled: true });
    const { res, client } = await signedIn(w);
    expect(res.cookies.wf_oidc_idt).toBeTruthy();
    // encrypted: the id token is not in the cookie
    expect(res.cookies.wf_oidc_idt).not.toContain(w.idp.lastIdToken!.split('.')[1]);
    const idtCookie = res.res.cookies.find((c) => c.name === 'wf_oidc_idt')!;
    expect(idtCookie.path).toBe('/rest');
    expect(idtCookie.httpOnly).toBe(true);

    const out = await client.post('/rest/sso/oidc/logout');
    expect(out.statusCode, out.body).toBe(200);
    const url = new URL(out.json().data.url);
    expect(`${url.origin}${url.pathname}`).toBe(w.idp.endSessionUrl);
    expect(url.searchParams.get('id_token_hint')).toBe(w.idp.lastIdToken);
    // the session is gone before the browser reaches the provider
    const me = new TestClient(server.app, ORIGIN, nextAddress());
    me.cookie = `wf_session=${sessionOf(res.cookies)}`;
    expect((await me.get('/rest/auth/me')).statusCode).toBe(401);
    // a session that was cleared: the cookies are cleared in the answer
    expect(cookiesOf(out).wf_oidc_idt).toBe('');
  });

  it('is a local logout when the provider has no end session URL or the setting is off', async () => {
    const off = await workspace({ rpInitiatedLogoutEnabled: false });
    const a = await signedIn(off);
    expect(a.res.cookies.wf_oidc_idt ?? '').toBe('');
    const outA = await a.client.post('/rest/sso/oidc/logout');
    expect(outA.statusCode).toBe(200);
    expect(outA.json().data.url).toBeNull();

    const noEnd = await workspace({ rpInitiatedLogoutEnabled: true }, { noEndSession: true });
    const b = await signedIn(noEnd);
    expect(b.res.cookies.wf_oidc_idt ?? '').toBe('');
    const outB = await b.client.post('/rest/sso/oidc/logout');
    expect(outB.json().data.url).toBeNull();
    const me = new TestClient(server.app, ORIGIN, nextAddress());
    me.cookie = `wf_session=${sessionOf(b.res.cookies)}`;
    expect((await me.get('/rest/auth/me')).statusCode).toBe(401);
  });

  it('is a local logout when the id token is over 3800 bytes', async () => {
    const w = await workspace({ rpInitiatedLogoutEnabled: true });
    const big = await signedIn(w, person({ extra: { groups: 'g'.repeat(5000) } }));
    expect(big.res.cookies.wf_oidc_idt ?? '').toBe('');
    const out = await big.client.post('/rest/sso/oidc/logout');
    expect(out.statusCode).toBe(200);
    expect(out.json().data.url).toBeNull();
  });

  it('clears an older id token cookie when the new sign-in sets none, so logout is local', async () => {
    const w = await workspace({ rpInitiatedLogoutEnabled: true });
    const who = person();
    const first = await signIn(w, { person: who });
    const old = first.cookies.wf_oidc_idt;
    expect(old).toBeTruthy();
    // the same person signs in again with an id token over 3800 bytes: no new cookie, and the old one is cleared
    const login = await startLogin(w);
    const query = w.idp.authorize(login.location, {
      person: { ...who, extra: { groups: 'g'.repeat(5000) } },
    });
    const again = await browserGet(callbackUrl(w, query), { ...login.cookies, wf_oidc_idt: old });
    expect(again.statusCode).toBe(302);
    const cleared = cookiesOf(again);
    expect('wf_oidc_idt' in cleared).toBe(true);
    expect(cleared.wf_oidc_idt).toBe('');
    // without the old cookie the logout is local
    const client = new TestClient(server.app, ORIGIN, nextAddress());
    client.cookie = cookieHeader({ wf_session: sessionOf(cleared) });
    const out = await client.post('/rest/sso/oidc/logout');
    expect(out.statusCode).toBe(200);
    expect(out.json().data.url).toBeNull();
  });

  it("does not use a cookie from another person, and needs a session", async () => {
    const w = await workspace({ rpInitiatedLogoutEnabled: true });
    const first = await signedIn(w);
    const second = await signedIn(w);
    // person two's session with person one's id token cookie: no hint is built
    const mixed = new TestClient(server.app, ORIGIN, nextAddress());
    mixed.cookie = cookieHeader({ wf_session: sessionOf(second.res.cookies), wf_oidc_idt: first.res.cookies.wf_oidc_idt });
    const out = await mixed.post('/rest/sso/oidc/logout');
    expect(out.statusCode).toBe(200);
    expect(out.json().data.url).toBeNull();
    const anon = await new TestClient(server.app, ORIGIN, nextAddress()).post('/rest/sso/oidc/logout');
    expect(anon.statusCode).toBe(401);
  });
});
