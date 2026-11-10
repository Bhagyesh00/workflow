/**
 * P6-02 (L13): the SCIM routes under /scim/v2 in the shapes of Okta and Entra: token and tenant binding, the
 * SCIM error shape, create, filter, PUT and PATCH, the owner guard, the rate limit and the discovery documents.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/services/auth';
import { mintScimToken } from '../src/services/scim-token';
import { createTestServer, realMember, resetDatabase, signup, ssoOn, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ SCIM_RATE_LIMIT: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const repos = () => server.ctx.repos;
const SCIM = 'application/scim+json';

let ipCounter = 0;
const nextIp = () => `10.130.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

/** a workspace with SAML on, SCIM on and a token */
async function workspace(options: { sso?: 'saml' | 'oidc' | 'email'; enabled?: boolean } = {}) {
  return turnOn(await signup(server.app, { remoteAddress: nextIp() }), options);
}

/** SSO and SCIM on for a workspace that was just made (members are invited before SSO is on) */
async function turnOn(
  owner: Awaited<ReturnType<typeof signup>>,
  options: { sso?: 'saml' | 'oidc' | 'email'; enabled?: boolean } = {},
) {
  await ssoOn(server, owner.tenant.id, options.sso ?? 'saml');
  if (options.enabled !== false) await repos().scim.patchSettings(owner.tenant.id, { enabled: true });
  const { token } = await mintScimToken(server.ctx.scim.deps, owner.tenant.id, owner.user.id);
  return { ...owner, token };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

function scim(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  token: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return server.app.inject({
    method,
    url: `/scim/v2${path}`,
    remoteAddress: '10.200.0.1',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': SCIM }),
      ...headers,
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

const email = (prefix = 'scim') => `${prefix}-${randomUUID().slice(0, 8)}@example.com`;

/** an Okta create: userName, name parts, one work email, active, an externalId */
const oktaUser = (userName: string, extra: Record<string, unknown> = {}) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  userName,
  name: { givenName: 'Ada', familyName: 'Lovelace' },
  emails: [{ value: userName, type: 'work', primary: true }],
  displayName: 'Ada Lovelace',
  externalId: `okta-${randomUUID().slice(0, 8)}`,
  active: true,
  ...extra,
});

/** an Entra create: the email only in userName, the id in externalId, the roles list it sends */
const entraUser = (userName: string, extra: Record<string, unknown> = {}) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  externalId: randomUUID(),
  userName,
  active: true,
  displayName: 'Grace Hopper',
  name: { givenName: 'Grace', familyName: 'Hopper' },
  roles: [],
  ...extra,
});

async function created(ws: Workspace, payload: Record<string, unknown>) {
  const res = await scim('POST', '/Users', ws.token, payload);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; userName: string; externalId?: string; active: boolean };
}

describe('token and tenant binding', () => {
  it('answers 401 with n8n texts for a missing and a wrong token, in the SCIM error shape', async () => {
    const ws = await workspace();
    const none = await scim('GET', '/Users', undefined);
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect(none.headers['content-type']).toContain(SCIM);
    expect(none.json()).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
      detail: 'Authorization header with Bearer token required',
    });
    const wrong = await scim('GET', '/Users', `${ws.token.slice(0, -1)}x`);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().detail).toBe('Invalid SCIM API key');
    // a session cookie or an API key is no SCIM token
    expect((await scim('GET', '/Users', 'wfk_abc_def')).statusCode).toBe(401);
    expect((await scim('GET', '/Users', ws.token)).statusCode).toBe(200);
  });

  it("takes the workspace from the token: another workspace's token sees only its own users", async () => {
    const a = await workspace();
    const b = await workspace();
    const inA = await created(a, oktaUser(email()));
    const inB = await created(b, oktaUser(email()));
    const listB = (await scim('GET', '/Users', b.token)).json();
    // the owner and the new user
    expect(listB.totalResults).toBe(2);
    expect(listB.Resources.map((r: { id: string }) => r.id)).toEqual([b.user.id, inB.id]);
    // a user of A is not found with B's token, by id, by filter, by PATCH or by DELETE
    expect((await scim('GET', `/Users/${inA.id}`, b.token)).statusCode).toBe(404);
    expect((await scim('PATCH', `/Users/${inA.id}`, b.token, { Operations: [] })).statusCode).toBe(404);
    expect((await scim('DELETE', `/Users/${inA.id}`, b.token)).statusCode).toBe(404);
    const byName = (await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${inA.userName}"`)}`, b.token)).json();
    expect(byName.totalResults).toBe(0);
    expect(await repos().memberships.get(a.tenant.id, inA.id)).toBeDefined();
  });

  it('the stored token is a hash with its last four characters; the raw token is wfs_scim_ and 43 characters', async () => {
    const ws = await workspace();
    expect(ws.token).toMatch(/^wfs_scim_[A-Za-z0-9_-]{43}$/);
    const row = await repos().scim.get(ws.tenant.id);
    expect(row?.tokenHash).toBe(sha256(ws.token));
    expect(row?.tokenHint).toBe(ws.token.slice(-4));
    expect(JSON.stringify(row)).not.toContain(ws.token);
    // a new token replaces the old one
    const next = await mintScimToken(server.ctx.scim.deps, ws.tenant.id, ws.user.id);
    expect((await scim('GET', '/Users', ws.token)).statusCode).toBe(401);
    expect((await scim('GET', '/Users', next.token)).statusCode).toBe(200);
  });

  it('refuses with 403 while SCIM is off, and while SSO is off, and keeps the token', async () => {
    const off = await workspace({ enabled: false });
    const disabled = await scim('GET', '/Users', off.token);
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().detail).toBe('SCIM provisioning is disabled');

    const ws = await workspace();
    expect((await scim('GET', '/Users', ws.token)).statusCode).toBe(200);
    await ssoOn(server, ws.tenant.id, 'email');
    const noSso = await scim('GET', '/Users', ws.token);
    expect(noSso.statusCode).toBe(403);
    expect(noSso.json().detail).toBe('SCIM provisioning requires SAML or OIDC single sign-on');
    expect(await repos().scim.get(ws.tenant.id)).toBeDefined();
    // SSO on again: the same token works
    await ssoOn(server, ws.tenant.id, 'oidc');
    expect((await scim('GET', '/Users', ws.token)).statusCode).toBe(200);
  });
});

describe('create', () => {
  it('Okta: makes a member managed by the workspace, with a personal project, the SCIM id and the identity', async () => {
    const ws = await workspace();
    const userName = email('okta');
    const payload = oktaUser(userName);
    const res = await scim('POST', '/Users', ws.token, payload);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      userName,
      externalId: payload.externalId,
      active: true,
      displayName: 'Ada Lovelace',
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      emails: [{ value: userName, type: 'work', primary: true }],
    });
    expect(body.meta.location).toContain(`/scim/v2/Users/${body.id}`);
    expect(body.schemas).toEqual(['urn:ietf:params:scim:schemas:core:2.0:User']);
    const user = await repos().users.get(body.id);
    expect(user).toMatchObject({ email: userName, name: 'Ada Lovelace', managedByTenantId: ws.tenant.id });
    // a random hash nobody knows: the password sign-in never works
    expect(user?.passwordHash).toBeTruthy();
    expect(await repos().memberships.get(ws.tenant.id, body.id)).toEqual({ role: 'member' });
    expect(await repos().projects.getPersonal(ws.tenant.id, body.id)).toBeDefined();
    const member = await repos().memberships.getByExternalId(ws.tenant.id, payload.externalId);
    expect(member?.userId).toBe(body.id);
    const identity = await repos().sso.getIdentity(ws.tenant.id, 'saml', payload.externalId);
    expect(identity?.userId).toBe(body.id);
    const audit = await repos().audit.list(ws.tenant.id, 50);
    const entry = audit.find((row) => row.action === 'scim.user_created');
    expect(entry).toMatchObject({ resourceId: body.id, userId: null });
  });

  it('Entra: the address is the userName, roles are ignored, the user is a member', async () => {
    const ws = await workspace({ sso: 'oidc' });
    const userName = email('entra');
    const body = await created(ws, entraUser(userName, { roles: [{ value: 'owner', primary: true }] }));
    expect(body.userName).toBe(userName);
    expect(await repos().memberships.get(ws.tenant.id, body.id)).toEqual({ role: 'member' });
    expect((await repos().sso.getIdentity(ws.tenant.id, 'oidc', body.externalId as string))?.userId).toBe(body.id);
  });

  it('active false creates a disabled member', async () => {
    const ws = await workspace();
    const body = await created(ws, entraUser(email(), { active: false }));
    expect(body.active).toBe(false);
    expect((await repos().memberships.getIncludingDisabled(ws.tenant.id, body.id))?.disabledAt).toBeTruthy();
  });

  it('answers 409 when the email exists in this workspace or in any other, before any write', async () => {
    const ws = await workspace();
    const other = await signup(server.app, { remoteAddress: nextIp() });
    const first = await created(ws, oktaUser(email()));
    const duplicate = await scim('POST', '/Users', ws.token, oktaUser(first.userName));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ status: '409', scimType: 'uniqueness' });
    expect(duplicate.json().detail).toBe('User with this userName already exists');
    // the same address in another case is the same account
    expect((await scim('POST', '/Users', ws.token, oktaUser(first.userName.toUpperCase()))).statusCode).toBe(409);
    // an account of another workspace is never attached
    const elsewhere = await scim('POST', '/Users', ws.token, oktaUser(other.user.email));
    expect(elsewhere.statusCode).toBe(409);
    expect(await repos().memberships.get(ws.tenant.id, other.user.id)).toBeUndefined();
    // the same SCIM id twice
    const sameId = await scim('POST', '/Users', ws.token, oktaUser(email(), { externalId: first.externalId }));
    expect(sameId.statusCode).toBe(409);
    expect((await scim('GET', '/Users', ws.token)).json().totalResults).toBe(2);
  });

  it('answers 400 invalidValue when no address can be found, and 400 for a body that is no object', async () => {
    const ws = await workspace();
    const none = await scim('POST', '/Users', ws.token, { userName: 'no-address', emails: [] });
    expect(none.statusCode).toBe(400);
    expect(none.json().scimType).toBe('invalidValue');
    const text = await scim('POST', '/Users', ws.token, [1, 2]);
    expect(text.statusCode).toBe(400);
    const broken = await server.app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: { authorization: `Bearer ${ws.token}`, 'content-type': SCIM },
      payload: '{"userName":',
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
  });

  it('refuses a body over 1 MB with 413 in the SCIM shape', async () => {
    const ws = await workspace();
    const res = await server.app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: { authorization: `Bearer ${ws.token}`, 'content-type': SCIM },
      payload: JSON.stringify({ userName: email(), pad: 'x'.repeat(1_100_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().status).toBe('413');
  });
});

describe('list, get and filters', () => {
  it('filters userName eq and externalId eq, pages with startIndex and count, and caps count at 1000', async () => {
    const ws = await workspace();
    const users = [];
    for (let i = 0; i < 3; i++) users.push(await created(ws, oktaUser(email(`p${i}`))));
    const all = (await scim('GET', '/Users', ws.token)).json();
    expect(all).toMatchObject({ totalResults: 4, startIndex: 1, itemsPerPage: 4 });
    expect(all.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);

    const byName = await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${users[1].userName.toUpperCase()}"`)}`, ws.token);
    expect(byName.json().Resources.map((r: { id: string }) => r.id)).toEqual([users[1].id]);
    const byId = await scim('GET', `/Users?filter=${encodeURIComponent(`externalId eq "${users[2].externalId}"`)}`, ws.token);
    expect(byId.json().Resources.map((r: { id: string }) => r.id)).toEqual([users[2].id]);
    expect((await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "nobody@example.com"')}`, ws.token)).json().totalResults).toBe(0);

    // the owner is first, then the users in the order they were made
    const page = (await scim('GET', '/Users?startIndex=3&count=1', ws.token)).json();
    expect(page).toMatchObject({ totalResults: 4, startIndex: 3, itemsPerPage: 1 });
    expect(page.Resources[0].id).toBe(users[1].id);
    const zero = (await scim('GET', '/Users?count=0', ws.token)).json();
    expect(zero).toMatchObject({ totalResults: 4, itemsPerPage: 0, Resources: [] });
    expect((await scim('GET', '/Users?count=100000', ws.token)).json().itemsPerPage).toBe(4);
    expect((await scim('GET', '/Users?startIndex=0', ws.token)).json().startIndex).toBe(1);
    expect((await scim('GET', '/Users?count=abc', ws.token)).statusCode).toBe(400);
  });

  it('answers 400 invalidFilter for any other filter', async () => {
    const ws = await workspace();
    for (const filter of [
      'displayName eq "x"',
      'userName co "x"',
      'userName eq "a" and active eq true',
      'userName eq a',
      'emails[type eq "work"].value eq "a"',
      'userName pr',
    ]) {
      const res = await scim('GET', `/Users?filter=${encodeURIComponent(filter)}`, ws.token);
      expect(res.statusCode, filter).toBe(400);
      expect(res.json()).toMatchObject({ status: '400', scimType: 'invalidFilter' });
    }
  });

  it('GET by id: 404 with the id in the text for an unknown or malformed id; disabled members are found', async () => {
    const ws = await workspace();
    const unknown = randomUUID();
    const missing = await scim('GET', `/Users/${unknown}`, ws.token);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().detail).toBe(`Resource ${unknown} not found`);
    expect((await scim('GET', '/Users/not-an-id', ws.token)).statusCode).toBe(404);
    const user = await created(ws, entraUser(email()));
    await repos().memberships.disable(ws.tenant.id, user.id);
    expect((await scim('GET', `/Users/${user.id}`, ws.token)).json().active).toBe(false);
  });
});

describe('PATCH and PUT of a user the workspace manages', () => {
  it('Okta: replace emails[type eq "work"].value, name parts and active; roles are ignored', async () => {
    const ws = await workspace();
    const user = await created(ws, oktaUser(email()));
    const next = email('moved');
    const res = await scim('PATCH', `/Users/${user.id}`, ws.token, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'replace', path: 'emails[type eq "work"].value', value: next },
        { op: 'replace', path: 'name.givenName', value: 'Augusta' },
        { op: 'replace', path: 'roles', value: [{ value: 'owner' }] },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userName: next, displayName: 'Augusta Lovelace', active: true });
    expect(await repos().users.get(user.id)).toMatchObject({ email: next, name: 'Augusta Lovelace' });
    expect(await repos().memberships.get(ws.tenant.id, user.id)).toEqual({ role: 'member' });
  });

  it('Entra: a path-less object, active as the string "False" and "True", userName and name', async () => {
    const ws = await workspace();
    const user = await created(ws, entraUser(email()));
    const off = await scim('PATCH', `/Users/${user.id}`, ws.token, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(off.json().active).toBe(false);
    const on = await scim('PATCH', `/Users/${user.id}`, ws.token, {
      Operations: [{ op: 'Replace', value: { active: true } }],
    });
    expect(on.json().active).toBe(true);
    const next = email('entra-new');
    const both = await scim('PATCH', `/Users/${user.id}`, ws.token, {
      Operations: [
        { op: 'Replace', value: { userName: next, 'name.familyName': 'Murray', roles: [{ value: 'admin' }] } },
        { op: 'Add', path: 'externalId', value: 'entra-2' },
      ],
    });
    expect(both.json()).toMatchObject({ userName: next, externalId: 'entra-2', displayName: 'Grace Murray' });
  });

  it('PUT replaces what it carries; a user name that clashes with another account is 409', async () => {
    const ws = await workspace();
    const user = await created(ws, oktaUser(email()));
    const other = await created(ws, oktaUser(email()));
    const clash = await scim('PUT', `/Users/${user.id}`, ws.token, oktaUser(other.userName, { externalId: user.externalId }));
    expect(clash.statusCode).toBe(409);
    const next = email('put');
    const res = await scim('PUT', `/Users/${user.id}`, ws.token, {
      userName: next,
      emails: [{ value: next, primary: true }],
      name: { givenName: 'Ada', familyName: 'King' },
      active: false,
      externalId: user.externalId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userName: next, displayName: 'Ada King', active: false });
    // a PUT that carries the same values writes nothing more
    const before = (await repos().audit.list(ws.tenant.id, 100)).filter((r) => r.action === 'scim.user_updated').length;
    await scim('PUT', `/Users/${user.id}`, ws.token, { userName: next, active: false, externalId: user.externalId });
    const after = (await repos().audit.list(ws.tenant.id, 100)).filter((r) => r.action === 'scim.user_updated').length;
    expect(after).toBe(before);
  });

  it('a PATCH with no Operations list or with an unknown op is a 400', async () => {
    const ws = await workspace();
    const user = await created(ws, entraUser(email()));
    expect((await scim('PATCH', `/Users/${user.id}`, ws.token, { schemas: [] })).statusCode).toBe(400);
    expect((await scim('PATCH', `/Users/${user.id}`, ws.token, { Operations: [{ op: 'move' }] })).statusCode).toBe(400);
  });
});

describe('a user the workspace does not manage', () => {
  it('Okta and Entra: userName, emails and name change neither users.email nor users.name; active and externalId apply', async () => {
    const owner = await signup(server.app, { remoteAddress: nextIp() });
    const other = await signup(server.app, { remoteAddress: nextIp() });
    const member = await realMember(owner, { name: 'Real Name' });
    const ws = await turnOn(owner);
    const user = await repos().users.get(member.user.id);
    await repos().memberships.add(other.tenant.id, member.user.id, 'member');
    const original = { email: user!.email, name: user!.name };
    expect(user?.managedByTenantId).toBeNull();

    const okta = await scim('PATCH', `/Users/${member.user.id}`, ws.token, {
      Operations: [
        { op: 'replace', path: 'emails[type eq "work"].value', value: email('x') },
        { op: 'replace', path: 'name.givenName', value: 'Other' },
        { op: 'replace', path: 'active', value: false },
        { op: 'add', path: 'externalId', value: 'okta-existing' },
      ],
    });
    expect(okta.statusCode).toBe(200);
    expect(okta.json()).toMatchObject({ userName: original.email, active: false, externalId: 'okta-existing' });
    const entra = await scim('PATCH', `/Users/${member.user.id}`, ws.token, {
      Operations: [{ op: 'Replace', value: { userName: email('y'), displayName: 'Changed', active: 'True' } }],
    });
    expect(entra.json()).toMatchObject({ userName: original.email, displayName: original.name, active: true });
    const put = await scim('PUT', `/Users/${member.user.id}`, ws.token, {
      userName: email('z'),
      emails: [{ value: email('z2'), primary: true }],
      name: { givenName: 'Nope', familyName: 'Nope' },
      active: true,
      externalId: 'okta-existing',
    });
    expect(put.statusCode).toBe(200);
    expect(await repos().users.get(member.user.id)).toMatchObject(original);

    // the person still signs in to the other workspace with the old address
    const login = await member.client.app.inject({
      method: 'POST',
      url: '/rest/auth/login',
      remoteAddress: nextIp(),
      headers: { origin: 'http://localhost:5678', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: original.email, password: 'Passw0rd!', workspace: other.tenant.slug }),
    });
    expect(login.statusCode).toBe(200);
  });
});

describe('a user the workspace made who also belongs to another workspace', () => {
  it('Okta and Entra: PATCH and PUT keep the global email and name; active and externalId still apply', async () => {
    const ws = await workspace();
    const other = await signup(server.app, { remoteAddress: nextIp() });
    const userName = email('shared');
    const user = await created(ws, oktaUser(userName));
    expect(await repos().users.get(user.id)).toMatchObject({ managedByTenantId: ws.tenant.id });
    // the person later joins another workspace
    await repos().memberships.add(other.tenant.id, user.id, 'member');
    const original = { email: userName, name: 'Ada Lovelace' };

    const okta = await scim('PATCH', `/Users/${user.id}`, ws.token, {
      Operations: [
        { op: 'replace', path: 'emails[type eq "work"].value', value: email('x') },
        { op: 'replace', path: 'name.givenName', value: 'Other' },
        { op: 'replace', path: 'active', value: false },
        { op: 'add', path: 'externalId', value: 'okta-moved' },
      ],
    });
    expect(okta.statusCode).toBe(200);
    expect(okta.json()).toMatchObject({
      userName: original.email,
      active: false,
      externalId: 'okta-moved',
    });
    expect(await repos().users.get(user.id)).toMatchObject(original);

    const entra = await scim('PATCH', `/Users/${user.id}`, ws.token, {
      Operations: [
        { op: 'Replace', value: { userName: email('y'), displayName: 'Changed', active: 'True' } },
      ],
    });
    expect(entra.statusCode).toBe(200);
    expect(entra.json()).toMatchObject({
      userName: original.email,
      displayName: original.name,
      active: true,
    });

    // a name that clashes with another account is no 409 either: nothing is written
    const clash = await scim('PUT', `/Users/${user.id}`, ws.token, {
      userName: other.user.email,
      name: { givenName: 'Nope', familyName: 'Nope' },
      active: true,
      externalId: 'okta-moved',
    });
    expect(clash.statusCode).toBe(200);
    expect(await repos().users.get(user.id)).toMatchObject(original);
  });
});

describe('the owner guard', () => {
  it('403 for an email change, a deactivation and a delete of the owner; name and id changes pass', async () => {
    const ws = await workspace();
    // the owner is a member the IdP knows (an externalId was set, as after a sign-in link)
    await repos().memberships.setExternalId(ws.tenant.id, ws.user.id, 'owner-ext');
    const ownerId = ws.user.id;
    const deactivate = await scim('PATCH', `/Users/${ownerId}`, ws.token, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(deactivate.statusCode).toBe(403);
    expect(deactivate.json().status).toBe('403');
    expect(
      (await scim('PATCH', `/Users/${ownerId}`, ws.token, { Operations: [{ op: 'replace', path: 'userName', value: email() }] })).statusCode,
    ).toBe(403);
    expect((await scim('PUT', `/Users/${ownerId}`, ws.token, { userName: email(), active: true })).statusCode).toBe(403);
    expect((await scim('DELETE', `/Users/${ownerId}`, ws.token)).statusCode).toBe(403);
    expect(await repos().memberships.get(ws.tenant.id, ownerId)).toEqual({ role: 'owner' });
    expect(
      (await scim('PATCH', `/Users/${ownerId}`, ws.token, { Operations: [{ op: 'replace', path: 'active', value: true }] })).statusCode,
    ).toBe(200);
  });

  it('403 for an externalId change and a rename of the owner; nothing is linked or written', async () => {
    const ws = await workspace();
    const ownerId = ws.user.id;
    const before = await repos().users.get(ownerId);
    const link = await scim('PATCH', `/Users/${ownerId}`, ws.token, {
      Operations: [{ op: 'replace', path: 'externalId', value: 'attacker-subject' }],
    });
    expect(link.statusCode).toBe(403);
    expect(await repos().sso.getIdentity(ws.tenant.id, 'saml', 'attacker-subject')).toBeUndefined();
    expect(await repos().memberships.getByExternalId(ws.tenant.id, 'attacker-subject')).toBeUndefined();
    // an owner who was made by SCIM and promoted afterwards is not renamed either
    await repos().users.setManagedBy(ownerId, ws.tenant.id);
    const rename = await scim('PATCH', `/Users/${ownerId}`, ws.token, {
      Operations: [{ op: 'replace', path: 'name.givenName', value: 'Renamed' }],
    });
    expect(rename.statusCode).toBe(403);
    const put = await scim('PUT', `/Users/${ownerId}`, ws.token, {
      userName: before?.email,
      displayName: 'Renamed',
      externalId: 'x',
    });
    expect(put.statusCode).toBe(403);
    expect(await repos().users.get(ownerId)).toMatchObject({ email: before?.email, name: before?.name });
  });

  it('an admin can be deactivated; the owner stays reachable for the same call with the same email', async () => {
    const ws = await workspace();
    const admin = await created(ws, oktaUser(email()));
    await repos().memberships.updateRole(ws.tenant.id, admin.id, 'admin');
    const res = await scim('PATCH', `/Users/${admin.id}`, ws.token, { Operations: [{ op: 'replace', path: 'active', value: false }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(false);
    expect(await repos().memberships.get(ws.tenant.id, admin.id)).toBeUndefined();
  });
});

describe('rate limit', () => {
  it('answers 429 in the SCIM shape after SCIM_RATE_LIMIT calls from one IP', async () => {
    const limited = await createTestServer({ SCIM_RATE_LIMIT: '3' }, { startMain: false, reset: false });
    try {
      const owner = await signup(limited.app, { remoteAddress: nextIp() });
      await ssoOn(limited, owner.tenant.id, 'saml');
      await limited.ctx.repos.scim.patchSettings(owner.tenant.id, { enabled: true });
      const { token } = await mintScimToken(limited.ctx.scim.deps, owner.tenant.id, owner.user.id);
      const call = (ip: string) =>
        limited.app.inject({ method: 'GET', url: '/scim/v2/Users', remoteAddress: ip, headers: { authorization: `Bearer ${token}` } });
      for (let i = 0; i < 3; i++) expect((await call('10.9.9.9')).statusCode).toBe(200);
      const over = await call('10.9.9.9');
      expect(over.statusCode).toBe(429);
      expect(over.json()).toMatchObject({ status: '429', schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'] });
      // another address has its own count
      expect((await call('10.9.9.10')).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('counts one budget per IP across all SCIM routes', async () => {
    const limited = await createTestServer({ SCIM_RATE_LIMIT: '3' }, { startMain: false, reset: false });
    try {
      const owner = await signup(limited.app, { remoteAddress: nextIp() });
      await ssoOn(limited, owner.tenant.id, 'saml');
      await limited.ctx.repos.scim.patchSettings(owner.tenant.id, { enabled: true });
      const { token } = await mintScimToken(limited.ctx.scim.deps, owner.tenant.id, owner.user.id);
      const call = (url: string) =>
        limited.app.inject({
          method: 'GET',
          url: `/scim/v2${url}`,
          remoteAddress: '10.9.8.7',
          headers: { authorization: `Bearer ${token}` },
        });
      expect((await call('/Users')).statusCode).toBe(200);
      expect((await call('/Users')).statusCode).toBe(200);
      expect((await call('/ServiceProviderConfig')).statusCode).toBe(200);
      const over = await call('/ServiceProviderConfig');
      expect(over.statusCode).toBe(429);
      expect(over.json()).toMatchObject({
        status: '429',
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      });
    } finally {
      await limited.close();
    }
  });
});

describe('discovery', () => {
  it('answers ServiceProviderConfig, ResourceTypes and Schemas for the User only', async () => {
    const ws = await workspace();
    const config = (await scim('GET', '/ServiceProviderConfig', ws.token)).json();
    expect(config).toMatchObject({
      patch: { supported: true },
      filter: { supported: true, maxResults: 1000 },
      bulk: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      changePassword: { supported: false },
    });
    const types = (await scim('GET', '/ResourceTypes', ws.token)).json();
    expect(types.Resources.map((r: { id: string }) => r.id)).toEqual(['User']);
    const schemas = (await scim('GET', '/Schemas', ws.token)).json();
    expect(schemas.Resources[0].id).toBe('urn:ietf:params:scim:schemas:core:2.0:User');
    // a token is needed here too
    expect((await scim('GET', '/ServiceProviderConfig', undefined)).statusCode).toBe(401);
  });
});
