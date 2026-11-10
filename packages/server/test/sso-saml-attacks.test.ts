/**
 * P6-09 (L7): the attack tests of plan section 4 and decisions "Security, final" for SAML: tampered, unsigned
 * (message, assertion, both), wrong certificate, expired, wrapped assertion, wrong issuer, another workspace's
 * assertion, replay (memory and Redis), DOCTYPE in a response and in metadata, oversize, the metadata URL
 * rules (plain http refused, a private host blocked by the guard, a redirect to 127.0.0.1 refused with the
 * stored copy kept) and the CSP of the other routes. Each refusal makes no session.
 */
import { deflateRawSync } from 'node:zlib';
import { HttpClient } from '@workflow/core';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeSamlIdp,
  formBody,
  type SamlResponseOptions,
  type SamlTarget,
  type SamlTestUser,
  strangerKey,
} from './fakes/saml-idp';
import { BASE_URL, createTestServer, signup, TEST_REDIS, type TestServer } from './helpers';

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

async function workspace(on: TestServer = server): Promise<Owner> {
  seq++;
  return signup(on.app, { remoteAddress: `10.72.${seq >> 8}.${seq & 255}`, projects: 'real' });
}

function target(slug: string): SamlTarget {
  return { entityId: `${BASE_URL}/sso/saml/${slug}/metadata`, acsUrl: `${BASE_URL}/sso/saml/${slug}/acs` };
}

function person(tag: string): SamlTestUser {
  const email = `${tag}-${seq}-${Date.now()}@example.com`;
  return { email, firstName: 'Ada', lastName: 'Byte', upn: `upn-${email}` };
}

async function samlOn(owner: Owner): Promise<void> {
  await owner.client.data(owner.client.post('/rest/sso/saml/config', { metadata: idp.metadata() }));
  await owner.client.data(owner.client.post('/rest/sso/saml/config/toggle', { loginEnabled: true }));
}

function postAcs(slug: string, fields: Record<string, string>, on: TestServer = server) {
  return on.app.inject({
    method: 'POST',
    url: `/sso/saml/${slug}/acs`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody(fields),
  });
}

function noSession(res: LightMyRequestResponse): void {
  expect(res.cookies.find((c) => c.name === 'wf_session' && c.value)).toBeUndefined();
}

function refusedWith(res: LightMyRequestResponse, code: string): void {
  expect(res.statusCode).toBe(302);
  const location = String(res.headers.location);
  expect(location.startsWith('/signin?')).toBe(true);
  expect(new URLSearchParams(location.slice('/signin?'.length)).get('ssoError')).toBe(code);
  noSession(res);
}

async function lastFailure(tenantId: string) {
  const rows = (await server.ctx.repos.audit.list(tenantId, 50)).filter(
    (row) => row.action === 'auth.sso_login_failed',
  );
  return rows[0]?.metadata as { reason?: string; detail?: string } | undefined;
}

describe('SAML response attacks', () => {
  let owner: Owner;
  let sp: SamlTarget;
  const respond = (options: Partial<SamlResponseOptions> = {}) =>
    idp.postResponse({ sp, user: person('atk'), ...options });

  beforeAll(async () => {
    owner = await workspace();
    await samlOn(owner);
    sp = target(owner.tenant.slug);
  });

  it('a genuine response signs in (the control case)', async () => {
    const res = await postAcs(owner.tenant.slug, respond());
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('refuses a tampered response', async () => {
    const user = person('tamper');
    const res = await postAcs(
      owner.tenant.slug,
      respond({ user, tamper: (xml) => xml.split(user.email as string).join('admin@example.com') }),
    );
    refusedWith(res, 'saml_response_invalid');
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('FAILED_TO_VERIFY_SIGNATURE');
    expect(await server.ctx.repos.users.getByEmail('admin@example.com')).toBeUndefined();
  });

  it('refuses an unsigned response', async () => {
    refusedWith(
      await postAcs(owner.tenant.slug, respond({ signAssertion: false, signMessage: false })),
      'saml_response_invalid',
    );
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('ERR_MISSING_MESSAGE_SIGNATURE');
  });

  it('refuses a signed message whose assertion is unsigned (wantAssertionsSigned)', async () => {
    refusedWith(await postAcs(owner.tenant.slug, respond({ signAssertion: false })), 'saml_response_invalid');
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('ERR_ASSERTION_UNSIGNED');
  });

  it('refuses a signed assertion in an unsigned message (wantMessageSigned)', async () => {
    refusedWith(await postAcs(owner.tenant.slug, respond({ signMessage: false })), 'saml_response_invalid');
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('ERR_MISSING_MESSAGE_SIGNATURE');
  });

  it('refuses a response signed with a key the metadata does not name (wrong certificate)', async () => {
    refusedWith(
      await postAcs(owner.tenant.slug, respond({ privateKey: strangerKey() })),
      'saml_response_invalid',
    );
  });

  it('refuses an assertion signed with a key the metadata does not name inside a correctly signed message', async () => {
    const user = person('stranger-assertion');
    refusedWith(
      await postAcs(owner.tenant.slug, respond({ user, assertionKey: strangerKey() })),
      'saml_response_invalid',
    );
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('ERR_ASSERTION_SIGNATURE');
    expect(await server.ctx.repos.users.getByEmail(user.email as string)).toBeUndefined();
  });

  it('refuses an expired response', async () => {
    const past = new Date(Date.now() - 10 * 60_000);
    const res = await postAcs(
      owner.tenant.slug,
      respond({ notBefore: new Date(past.getTime() - 60_000), notOnOrAfter: past }),
    );
    refusedWith(res, 'saml_response_invalid');
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('ERR_SUBJECT_UNCONFIRMED');
  });

  it('refuses a wrapped assertion (signature wrapping)', async () => {
    const res = await postAcs(owner.tenant.slug, respond({ wrapWithEmail: 'wrapped-admin@example.com' }));
    refusedWith(res, 'saml_response_invalid');
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('ERR_POTENTIAL_WRAPPING_ATTACK');
    expect(await server.ctx.repos.users.getByEmail('wrapped-admin@example.com')).toBeUndefined();
  });

  it('refuses a wrong issuer', async () => {
    refusedWith(
      await postAcs(owner.tenant.slug, respond({ issuer: 'https://other-idp.example/entity' })),
      'saml_response_invalid',
    );
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('ERR_UNMATCH_ISSUER');
  });

  it("refuses workspace A's assertion at workspace B's ACS", async () => {
    const other = await workspace();
    await samlOn(other);
    // signed for A (audience, destination and recipient are A's), posted to B
    refusedWith(await postAcs(other.tenant.slug, respond()), 'saml_response_invalid');
    // signed for B's audience but sent to A's destination
    const mixed = idp.postResponse({
      sp: target(other.tenant.slug),
      user: person('mixed'),
      destination: sp.acsUrl,
    });
    refusedWith(await postAcs(other.tenant.slug, mixed), 'saml_response_invalid');
    expect((await lastFailure(other.tenant.id))?.detail).toMatch(/DESTINATION|RECIPIENT/);
  });

  it('refuses a replayed response (memory store)', async () => {
    const once = respond();
    expect((await postAcs(owner.tenant.slug, once)).statusCode).toBe(302);
    refusedWith(await postAcs(owner.tenant.slug, once), 'saml_response_replayed');
  });

  it('refuses a DOCTYPE in a response before parsing', async () => {
    const res = await postAcs(
      owner.tenant.slug,
      respond({ prolog: '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>' }),
    );
    refusedWith(res, 'saml_response_invalid');
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('saml_doctype_refused');
  });

  it('refuses an oversize response: a body over 1 MB, and a deflated message that inflates past 1 MB', async () => {
    const big = await postAcs(owner.tenant.slug, { SAMLResponse: 'A'.repeat(1_100_000) });
    expect(big.statusCode).toBe(413);
    noSession(big);
    const bomb = deflateRawSync(Buffer.alloc(2 * 1_048_576, 0x20)).toString('base64');
    const res = await server.app.inject({
      method: 'GET',
      url: `/sso/saml/${owner.tenant.slug}/acs?SAMLResponse=${encodeURIComponent(bomb)}`,
    });
    refusedWith(res, 'saml_response_invalid');
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('saml_too_large');
  });

  it('refuses a redirect-binding response whose query signature is missing or wrong', async () => {
    const unsigned = idp.redirectResponse({ sp, user: person('q'), signQuery: false });
    refusedWith(
      await server.app.inject({ method: 'GET', url: `/sso/saml/${owner.tenant.slug}/acs?${unsigned}` }),
      'saml_response_invalid',
    );
    const stranger = idp.redirectResponse({ sp, user: person('q2'), privateKey: strangerKey() });
    refusedWith(
      await server.app.inject({ method: 'GET', url: `/sso/saml/${owner.tenant.slug}/acs?${stranger}` }),
      'saml_response_invalid',
    );
    // a correctly signed query and message whose assertion is signed with a stranger key
    const embedded = idp.redirectResponse({
      sp,
      user: person('q3'),
      signMessage: true,
      assertionKey: strangerKey(),
    });
    refusedWith(
      await server.app.inject({ method: 'GET', url: `/sso/saml/${owner.tenant.slug}/acs?${embedded}` }),
      'saml_response_invalid',
    );
    expect((await lastFailure(owner.tenant.id))?.detail).toBe('ERR_ASSERTION_SIGNATURE');
  });
});

describe('SAML replay with Redis', () => {
  it('refuses the second use of an assertion through SET NX', async () => {
    const redisServer = await createTestServer(
      { REDIS_URL: TEST_REDIS },
      { allowInsecureIdp: true, reset: false, startMain: false },
    );
    try {
      expect(redisServer.ctx.redis).toBeDefined();
      const owner = await workspace(redisServer);
      await samlOn(owner);
      const fields = idp.postResponse({ sp: target(owner.tenant.slug), user: person('redis') });
      expect((await postAcs(owner.tenant.slug, fields, redisServer)).statusCode).toBe(302);
      const again = await postAcs(owner.tenant.slug, fields, redisServer);
      expect(again.statusCode).toBe(302);
      expect(String(again.headers.location)).toContain('ssoError=saml_response_replayed');
      const keys = await redisServer.ctx.redis?.keys('wftest:saml:assertion:*');
      expect(keys?.length).toBeGreaterThan(0);
      const ttl = await redisServer.ctx.redis?.pttl(keys?.[0] as string);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(7 * 60_000);
    } finally {
      await redisServer.close();
    }
  });
});

describe('SAML metadata attacks', () => {
  it('refuses a DOCTYPE in pasted metadata and in metadata read from a URL', async () => {
    const owner = await workspace();
    const pasted = await owner.client.post('/rest/sso/saml/config', {
      metadata: `<!DOCTYPE md [<!ENTITY e SYSTEM "file:///etc/hosts">]>${idp.metadata()}`,
    });
    expect(pasted.statusCode).toBe(400);
    expect(pasted.json().error.code).toBe('saml_doctype_refused');
    const good = idp.metadataXml;
    idp.metadataXml = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY y "z">]>${good}`;
    try {
      const fetched = await owner.client.post('/rest/sso/saml/config', {
        metadataUrl: `${idp.baseUrl}/metadata`,
      });
      expect(fetched.statusCode).toBe(400);
      expect(fetched.json().error.code).toBe('saml_doctype_refused');
    } finally {
      idp.metadataXml = good;
    }
    expect((await server.ctx.repos.sso.get(owner.tenant.id))?.samlMetadata ?? null).toBeNull();
  });

  it('refuses metadata without a redirect single sign-on binding, and invalid metadata', async () => {
    const owner = await workspace();
    const noRedirect = await owner.client.post('/rest/sso/saml/config', {
      metadata: idp.metadataWithoutRedirect(),
    });
    expect(noRedirect.statusCode).toBe(400);
    expect(noRedirect.json().error.code).toBe('saml_metadata_invalid');
    const invalid = await owner.client.post('/rest/sso/saml/config', {
      metadata: '<EntityDescriptor xmlns="urn:x"/>',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('saml_metadata_invalid');
  });

  it('refuses a plain http metadata URL without the test allowance', async () => {
    const strict = await createTestServer({}, { reset: false, startMain: false });
    try {
      const owner = await workspace(strict);
      const res = await owner.client.post('/rest/sso/saml/config', {
        metadataUrl: `${idp.baseUrl}/metadata`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('saml_metadata_url_insecure');
    } finally {
      await strict.close();
    }
  });

  it('blocks a private host through the guard', async () => {
    const owner = await workspace();
    const res = await owner.client.post('/rest/sso/saml/config', {
      metadataUrl: 'https://10.255.255.1/metadata',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('saml_metadata_fetch_failed');
  });

  it('refuses a metadata URL that answers 302 to 127.0.0.1 (no allow entry) and keeps the stored copy', async () => {
    const guarded = await createTestServer(
      {},
      {
        reset: false,
        startMain: false,
        allowInsecureIdp: true,
        http: new HttpClient({ ssrf: { enabled: true, allow: ['localhost'], deny: [] } }),
      },
    );
    const moved = await FakeSamlIdp.start('localhost');
    try {
      const owner = await workspace(guarded);
      await owner.client.data(owner.client.post('/rest/sso/saml/config', { metadata: idp.metadata() }));
      const stored = (await guarded.ctx.repos.sso.get(owner.tenant.id))?.samlMetadata;
      moved.movedTo = `http://127.0.0.1:${new URL(moved.baseUrl).port}/metadata`;
      const res = await owner.client.post('/rest/sso/saml/config', { metadataUrl: `${moved.baseUrl}/moved` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('saml_metadata_fetch_failed');
      expect(moved.hits).toContain('/moved');
      expect(moved.hits).not.toContain('/metadata');
      const row = await guarded.ctx.repos.sso.get(owner.tenant.id);
      expect(row?.samlMetadata).toBe(stored);
      expect((row?.saml as { metadataUrl?: string } | undefined)?.metadataUrl).toBe('');
    } finally {
      await moved.close();
      await guarded.close();
    }
  });
});

describe('SAML pages and the app CSP', () => {
  it('keeps the global CSP on other routes and on the metadata route', async () => {
    const owner = await workspace();
    for (const url of ['/rest/auth/me', `/sso/saml/${owner.tenant.slug}/metadata`]) {
      const res = await owner.client.get(url);
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("default-src 'self'");
    }
  });

  it('a test RelayState with an unknown token shows the expired page and no session', async () => {
    const owner = await workspace();
    await samlOn(owner);
    const res = await postAcs(
      owner.tenant.slug,
      idp.postResponse({
        sp: target(owner.tenant.slug),
        user: person('t'),
        relayState: `saml-test:${'x'.repeat(43)}`,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('expired');
    noSession(res);
  });
});
