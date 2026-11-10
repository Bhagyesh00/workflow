/**
 * P6-09 (L7): SAML sign-in per workspace against the in-process identity provider (test/fakes/saml-idp.ts,
 * samlify in its IdP role with the fixture key). Sign-in by the redirect binding and by the POST binding, the
 * ACS by POST and by redirect, JIT, linking, attribute mapping, RelayState, the test flow (no session, runs
 * while SAML is off), method off, the toggle and the metadata URL (read at save, read again after 24 hours,
 * the copy kept on failure).
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAML_TEST_PAGE_CSP } from '../src/services/sso/views';
import { FakeSamlIdp, formBody, SAML_CLAIMS, type SamlTarget, type SamlTestUser } from './fakes/saml-idp';
import { BASE_URL, createTestServer, realMember, signup, type TestServer } from './helpers';

let server: TestServer;
let idp: FakeSamlIdp;
let seq = 0;

beforeAll(async () => {
  server = await createTestServer({}, { allowInsecureIdp: true });
  idp = await FakeSamlIdp.start();
}, 120_000);

afterAll(async () => {
  await idp?.close();
  await server?.close();
});

type Owner = Awaited<ReturnType<typeof signup>>;

async function workspace(): Promise<Owner> {
  seq++;
  return signup(server.app, { remoteAddress: `10.71.${seq >> 8}.${seq & 255}`, projects: 'real' });
}

function target(slug: string): SamlTarget {
  return { entityId: `${BASE_URL}/sso/saml/${slug}/metadata`, acsUrl: `${BASE_URL}/sso/saml/${slug}/acs` };
}

function person(tag: string, extra: Partial<SamlTestUser> = {}): SamlTestUser {
  const email = `${tag}-${seq}-${Date.now()}@example.com`;
  return { email, firstName: 'Sam', lastName: 'Lee', upn: `upn-${email}`, ...extra };
}

/** saves the fake's metadata and turns SAML on */
async function samlOn(owner: Owner, config: Record<string, unknown> = {}): Promise<void> {
  await owner.client.data(
    owner.client.post('/rest/sso/saml/config', { metadata: idp.metadata(), ...config }),
  );
  await owner.client.data(owner.client.post('/rest/sso/saml/config/toggle', { loginEnabled: true }));
}

function postAcs(slug: string, fields: Record<string, string>): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: 'POST',
    url: `/sso/saml/${slug}/acs`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody(fields),
  });
}

function getAcs(slug: string, query: string): Promise<LightMyRequestResponse> {
  return server.app.inject({ method: 'GET', url: `/sso/saml/${slug}/acs?${query}` });
}

function sessionCookie(res: LightMyRequestResponse): string | undefined {
  const cookie = res.cookies.find((c) => c.name === 'wf_session');
  return cookie?.value ? `wf_session=${cookie.value}` : undefined;
}

async function me(cookie: string) {
  const res = await server.app.inject({ method: 'GET', url: '/rest/auth/me', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json().data as {
    user: { id: string; email: string; name: string };
    tenant: { id: string };
    authMethod: string;
  };
}

function ssoError(res: LightMyRequestResponse): string | null {
  expect(res.statusCode).toBe(302);
  const location = String(res.headers.location);
  expect(location.startsWith('/signin?')).toBe(true);
  return new URLSearchParams(location.slice('/signin?'.length)).get('ssoError');
}

async function audits(tenantId: string, action: string) {
  return (await server.ctx.repos.audit.list(tenantId, 100)).filter((row) => row.action === action);
}

describe('SAML service provider and config', () => {
  it('serves the service provider metadata with the slug in entity id and ACS', async () => {
    const owner = await workspace();
    const res = await server.app.inject({ method: 'GET', url: `/sso/saml/${owner.tenant.slug}/metadata` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    const { entityId, acsUrl } = target(owner.tenant.slug);
    expect(res.body).toContain(`entityID="${entityId}"`);
    expect(res.body).toContain(`Location="${acsUrl}"`);
    expect(res.body).toContain('WantAssertionsSigned="true"');
    const unknown = await server.app.inject({ method: 'GET', url: '/sso/saml/no-such-workspace-x/metadata' });
    expect(unknown.statusCode).toBe(404);
  });

  it('saves and reads the config; a member without saml:manage gets 403', async () => {
    const owner = await workspace();
    const saved = await owner.client.data(
      owner.client.post('/rest/sso/saml/config', {
        metadata: idp.metadata(),
        loginBinding: 'post',
        loginLabel: 'Company SSO',
        emailVerifiedRequired: true,
        mapping: { email: 'mail' },
      }),
    );
    expect(saved).toMatchObject({
      metadataUrl: '',
      loginBinding: 'post',
      loginEnabled: false,
      loginLabel: 'Company SSO',
      emailVerifiedRequired: true,
      wantAssertionsSigned: true,
      wantMessageSigned: true,
      authnRequestsSigned: false,
      entityID: target(owner.tenant.slug).entityId,
      returnUrl: target(owner.tenant.slug).acsUrl,
      mapping: {
        email: 'mail',
        firstName: SAML_CLAIMS.firstName,
        lastName: SAML_CLAIMS.lastName,
        userPrincipalName: SAML_CLAIMS.userPrincipalName,
      },
    });
    expect(saved.metadata).toContain(idp.entityId);
    const read = await owner.client.data(owner.client.get('/rest/sso/saml/config'));
    expect(read).toEqual(saved);
    expect((await audits(owner.tenant.id, 'sso.saml_config_updated')).length).toBe(1);

    const member = await realMember(owner);
    expect((await member.client.get('/rest/sso/saml/config')).statusCode).toBe(403);
    expect((await member.client.post('/rest/sso/saml/config', { loginLabel: 'x' })).statusCode).toBe(403);
    expect(
      (await member.client.post('/rest/sso/saml/config/toggle', { loginEnabled: true })).statusCode,
    ).toBe(403);
    expect((await member.client.post('/rest/sso/saml/config/test', {})).statusCode).toBe(403);
  });

  it('toggles SAML on and off as the sign-in method, with audit', async () => {
    const owner = await workspace();
    const before = await owner.client.post('/rest/sso/saml/config/toggle', { loginEnabled: true });
    expect(before.statusCode).toBe(400);
    expect(before.json().error.code).toBe('sso_config_missing');
    await samlOn(owner);
    expect((await server.ctx.repos.sso.get(owner.tenant.id))?.method).toBe('saml');
    const on = await owner.client.data(owner.client.get('/rest/sso/saml/config'));
    expect(on.loginEnabled).toBe(true);
    const off = await owner.client.data(
      owner.client.post('/rest/sso/saml/config/toggle', { loginEnabled: false }),
    );
    expect(off.loginEnabled).toBe(false);
    expect((await server.ctx.repos.sso.get(owner.tenant.id))?.method).toBe('email');
    const changes = await audits(owner.tenant.id, 'sso.method_changed');
    expect(changes.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([
        { from: 'email', to: 'saml' },
        { from: 'saml', to: 'email' },
      ]),
    );
  });
});

describe('SAML sign-in', () => {
  it('signs in by the redirect binding (initsso 302) with the response by POST; JIT creates the member', async () => {
    const owner = await workspace();
    await samlOn(owner);
    const start = await server.app.inject({
      method: 'GET',
      url: `/sso/saml/${owner.tenant.slug}/initsso?redirect=${encodeURIComponent('/workflows?x=1')}`,
    });
    expect(start.statusCode).toBe(302);
    const location = String(start.headers.location);
    expect(location.startsWith(`${idp.ssoUrl}?`)).toBe(true);
    const request = idp.readRedirectRequest(location);
    expect(request.relayState).toBe('/workflows?x=1');
    expect(request.acsUrl).toBe(target(owner.tenant.slug).acsUrl);

    const user = person('jit');
    const res = await postAcs(
      owner.tenant.slug,
      idp.postResponse({
        sp: target(owner.tenant.slug),
        user,
        inResponseTo: request.id,
        relayState: request.relayState,
      }),
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/workflows?x=1');
    const cookie = sessionCookie(res);
    expect(cookie).toBeTruthy();
    const session = await me(cookie as string);
    expect(session.user.email).toBe(user.email);
    expect(session.user.name).toBe('Sam Lee');
    expect(session.tenant.id).toBe(owner.tenant.id);
    expect(session.authMethod).toBe('saml');
    const identity = await server.ctx.repos.sso.getIdentity(owner.tenant.id, 'saml', user.upn as string);
    expect(identity?.userId).toBe(session.user.id);
    expect((await audits(owner.tenant.id, 'auth.sso_login')).length).toBe(1);
  });

  it('signs in by the POST binding (initsso POST page with its own CSP) with the response by redirect', async () => {
    const owner = await workspace();
    await samlOn(owner, { loginBinding: 'post' });
    const start = await server.app.inject({
      method: 'GET',
      url: `/sso/saml/${owner.tenant.slug}/initsso?redirect=/home`,
    });
    expect(start.statusCode).toBe(200);
    expect(start.headers['content-type']).toContain('text/html');
    const csp = String(start.headers['content-security-policy']);
    expect(csp).toContain(`form-action ${new URL(idp.ssoUrl).origin}`);
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(start.body).toContain(`<script nonce="${nonce}">`);
    const request = idp.readPostRequest(start.body);
    expect(request.action).toBe(idp.ssoUrl);
    expect(request.relayState).toBe('/home');

    const user = person('post');
    const res = await getAcs(
      owner.tenant.slug,
      idp.redirectResponse({
        sp: target(owner.tenant.slug),
        user,
        inResponseTo: request.id,
        relayState: '/home',
      }),
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/home');
    const session = await me(sessionCookie(res) as string);
    expect(session.user.email).toBe(user.email);
    expect(session.authMethod).toBe('saml');
  });

  it('accepts an IdP-started response (no request) on the POST ACS and goes home without a RelayState', async () => {
    const owner = await workspace();
    await samlOn(owner);
    const res = await postAcs(
      owner.tenant.slug,
      idp.postResponse({ sp: target(owner.tenant.slug), user: person('idp') }),
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(sessionCookie(res)).toBeTruthy();
  });

  it('JIT off refuses an unknown email; an existing member links by email', async () => {
    const owner = await workspace();
    // invites are blocked under SSO without SCIM, so the member joins first
    const member = await realMember(owner);
    await samlOn(owner);
    await server.ctx.repos.sso.upsert(owner.tenant.id, { jit: false });
    const refused = await postAcs(
      owner.tenant.slug,
      idp.postResponse({ sp: target(owner.tenant.slug), user: person('nojit') }),
    );
    expect(ssoError(refused)).toBe('sso_user_unknown');
    expect(sessionCookie(refused)).toBeUndefined();

    const res = await postAcs(
      owner.tenant.slug,
      idp.postResponse({
        sp: target(owner.tenant.slug),
        user: { email: member.email, firstName: 'M', lastName: 'B', upn: `m-${member.user.id}` },
      }),
    );
    expect(res.statusCode).toBe(302);
    expect((await me(sessionCookie(res) as string)).user.id).toBe(member.user.id);
  });

  it('emailVerifiedRequired refuses a response without email_verified true', async () => {
    const owner = await workspace();
    await samlOn(owner, { emailVerifiedRequired: true });
    const user = person('verify');
    const refused = await postAcs(
      owner.tenant.slug,
      idp.postResponse({ sp: target(owner.tenant.slug), user }),
    );
    expect(ssoError(refused)).toBe('sso_email_unverified');
    const ok = await postAcs(
      owner.tenant.slug,
      idp.postResponse({
        sp: target(owner.tenant.slug),
        user: { ...user, attributes: { email_verified: 'true' } },
      }),
    );
    expect(ok.statusCode).toBe(302);
    expect(sessionCookie(ok)).toBeTruthy();
  });

  it('maps attributes by the workspace mapping and refuses missing ones with their names', async () => {
    const owner = await workspace();
    await samlOn(owner, { mapping: { email: 'mail', userPrincipalName: 'uid' } });
    const user = person('map');
    const refused = await postAcs(
      owner.tenant.slug,
      idp.postResponse({ sp: target(owner.tenant.slug), user }),
    );
    expect(ssoError(refused)).toBe('saml_attributes_missing');
    const [failed] = await audits(owner.tenant.id, 'auth.sso_login_failed');
    expect(failed.metadata).toMatchObject({
      method: 'saml',
      reason: 'saml_attributes_missing',
      missing: ['mail', 'uid'],
    });

    const mapped = await postAcs(
      owner.tenant.slug,
      idp.postResponse({
        sp: target(owner.tenant.slug),
        user: {
          ...user,
          omit: ['email', 'userPrincipalName'],
          attributes: { mail: user.email as string, uid: 'u-1' },
        },
      }),
    );
    expect(mapped.statusCode).toBe(302);
    expect((await me(sessionCookie(mapped) as string)).user.email).toBe(user.email);
  });

  it('a response without a name signs in and goes to the onboarding page', async () => {
    const owner = await workspace();
    await samlOn(owner);
    const res = await postAcs(
      owner.tenant.slug,
      idp.postResponse({
        sp: target(owner.tenant.slug),
        user: person('noname', { firstName: undefined, lastName: undefined }),
      }),
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/saml/onboarding');
    expect(sessionCookie(res)).toBeTruthy();
  });

  it('a RelayState to another host stays local', async () => {
    const owner = await workspace();
    await samlOn(owner);
    for (const relayState of [
      'https://evil.example/steal',
      '//evil.example/x',
      'javascript:alert(1)',
      `${BASE_URL}.evil.test/`,
    ]) {
      const res = await postAcs(
        owner.tenant.slug,
        idp.postResponse({ sp: target(owner.tenant.slug), user: person('relay'), relayState }),
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/');
    }
    const start = await server.app.inject({
      method: 'GET',
      url: `/sso/saml/${owner.tenant.slug}/initsso?redirect=${encodeURIComponent('https://evil.example/')}`,
    });
    expect(idp.readRedirectRequest(String(start.headers.location)).relayState).toBe('/');
  });

  it('refuses initsso and the ACS while SAML is not the active method', async () => {
    const owner = await workspace();
    await owner.client.data(owner.client.post('/rest/sso/saml/config', { metadata: idp.metadata() }));
    const start = await server.app.inject({ method: 'GET', url: `/sso/saml/${owner.tenant.slug}/initsso` });
    expect(ssoError(start)).toBe('sso_method_inactive');
    const res = await postAcs(
      owner.tenant.slug,
      idp.postResponse({ sp: target(owner.tenant.slug), user: person('off') }),
    );
    expect(ssoError(res)).toBe('sso_method_inactive');
    expect(sessionCookie(res)).toBeUndefined();
    const [failed] = await audits(owner.tenant.id, 'auth.sso_login_failed');
    expect(failed.metadata).toMatchObject({ method: 'saml', reason: 'sso_method_inactive' });
  });

  it('corrupt stored metadata refuses the sign-in and keeps the config', async () => {
    const owner = await workspace();
    await samlOn(owner, { loginLabel: 'Keep me' });
    await server.ctx.repos.sso.upsert(owner.tenant.id, { samlMetadata: '<md:EntityDescriptor broken' });
    const res = await postAcs(
      owner.tenant.slug,
      idp.postResponse({ sp: target(owner.tenant.slug), user: person('corrupt') }),
    );
    expect(ssoError(res)).toBe('saml_config_invalid');
    const row = await server.ctx.repos.sso.get(owner.tenant.id);
    expect(row?.method).toBe('saml');
    expect(row?.samlMetadata).toBe('<md:EntityDescriptor broken');
    expect((row?.saml as { loginLabel?: string } | undefined)?.loginLabel).toBe('Keep me');
  });
});

describe('SAML test flow', () => {
  it('runs while SAML is off, shows the mapped attributes and never makes a session', async () => {
    const owner = await workspace();
    const { url } = await owner.client.data<{ url: string }>(
      owner.client.post('/rest/sso/saml/config/test', { metadata: idp.metadata() }),
    );
    expect(url.startsWith(`${BASE_URL}/sso/saml/${owner.tenant.slug}/initsso?test=`)).toBe(true);
    // nothing was saved by the test
    expect((await server.ctx.repos.sso.get(owner.tenant.id))?.samlMetadata ?? null).toBeNull();

    const start = await server.app.inject({ method: 'GET', url: url.slice(BASE_URL.length) });
    expect(start.statusCode).toBe(302);
    const request = idp.readRedirectRequest(String(start.headers.location));
    expect(request.relayState?.startsWith('saml-test:')).toBe(true);

    const user = person('test');
    const res = await postAcs(
      owner.tenant.slug,
      idp.postResponse({ sp: target(owner.tenant.slug), user, relayState: request.relayState }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(SAML_TEST_PAGE_CSP);
    expect(res.body).toContain('SAML test passed');
    expect(res.body).toContain(user.email);
    expect(res.body).toContain(SAML_CLAIMS.userPrincipalName);
    expect(sessionCookie(res)).toBeUndefined();
    expect(await server.ctx.repos.users.getByEmail(user.email as string)).toBeUndefined();
  });

  it('shows the missing attributes, escapes values, and an unknown token says the test expired', async () => {
    const owner = await workspace();
    const { url } = await owner.client.data<{ url: string }>(
      owner.client.post('/rest/sso/saml/config/test', { metadata: idp.metadata() }),
    );
    const relayState = `saml-test:${new URL(url).searchParams.get('test')}`;
    const res = await postAcs(
      owner.tenant.slug,
      idp.postResponse({
        sp: target(owner.tenant.slug),
        user: { ...person('miss'), omit: ['userPrincipalName'], attributes: { note: '<script>x</script>' } },
        relayState,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SAML test failed');
    expect(res.body).toContain(SAML_CLAIMS.userPrincipalName);
    expect(res.body).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(res.body).not.toContain('<script>x</script>');

    const other = await workspace();
    const elsewhere = await postAcs(
      other.tenant.slug,
      idp.postResponse({ sp: target(other.tenant.slug), user: person('else'), relayState }),
    );
    expect(elsewhere.statusCode).toBe(200);
    expect(elsewhere.body).toContain('expired');
    expect(sessionCookie(elsewhere)).toBeUndefined();
  });

  it('with the POST binding the test starts on the POST page', async () => {
    const owner = await workspace();
    const { url } = await owner.client.data<{ url: string }>(
      owner.client.post('/rest/sso/saml/config/test', { metadata: idp.metadata(), loginBinding: 'post' }),
    );
    const start = await server.app.inject({ method: 'GET', url: url.slice(BASE_URL.length) });
    expect(start.statusCode).toBe(200);
    expect(idp.readPostRequest(start.body).relayState?.startsWith('saml-test:')).toBe(true);
  });
});

describe('SAML metadata URL', () => {
  it('reads the URL at save through ctx.http and again when the copy is older than 24 hours, keeping it on failure', async () => {
    const owner = await workspace();
    const metadataUrl = `${idp.baseUrl}/metadata`;
    const saved = await owner.client.data(owner.client.post('/rest/sso/saml/config', { metadataUrl }));
    expect(saved.metadataUrl).toBe(metadataUrl);
    expect(saved.metadata).toBe(idp.metadataXml);
    await owner.client.data(owner.client.post('/rest/sso/saml/config/toggle', { loginEnabled: true }));

    // the copy turns old and the identity provider answers garbage: the stored copy stays in use
    const row = await server.ctx.repos.sso.get(owner.tenant.id);
    await server.ctx.repos.sso.upsert(owner.tenant.id, {
      saml: { ...(row?.saml ?? {}), metadataFetchedAt: '2000-01-01T00:00:00.000Z' },
    });
    const good = idp.metadataXml;
    idp.metadataXml = '<not-metadata/>';
    const hits = idp.hits.length;
    try {
      const start = await server.app.inject({ method: 'GET', url: `/sso/saml/${owner.tenant.slug}/initsso` });
      expect(start.statusCode).toBe(302);
      expect(String(start.headers.location).startsWith(idp.ssoUrl)).toBe(true);
      expect(idp.hits.slice(hits)).toContain('/metadata');
      expect((await server.ctx.repos.sso.get(owner.tenant.id))?.samlMetadata).toBe(good);
    } finally {
      idp.metadataXml = good;
    }
  });
});
