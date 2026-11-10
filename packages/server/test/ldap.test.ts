/**
 * P6-12 (L10): LDAP sign-in and sync with the `LdapDirectory` fake (test/fakes/ldap-directory.ts). The
 * config (defaults as n8n, bind password encrypted and blank on read, validation, scopes), a directory user
 * signing in (personal project, `ldap` session not MFA verified until the MFA step passes), the refusals (wrong password, filter
 * injection, two entries, another workspace's user, a disabled member), MFA, a slow directory, the sync
 * (create, update, disable, re-enable, dry run, duplicate emails, history paging, one run at a time, the
 * sweep) and the public rows. The wire test is ldap-wire.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { totp } from '@workflow/nodes-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disableMember } from '../src/services/member-disable';
import { createFakeLdap, type FakeLdap } from './fakes/ldap-directory';
import {
  createTestServer,
  flushRedis,
  ORIGIN,
  realMember,
  signup,
  ssoOn,
  TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;
beforeAll(async () => {
  await flushRedis();
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server?.close();
});

let ipCounter = 0;
/** signup allows 20 calls an hour per IP, so each caller has its own address */
const nextIp = () => `10.70.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
const unique = () => randomUUID().slice(0, 8);
const query = async (sql: string, params: unknown[] = []) =>
  (await server.ctx.database.pool.query(sql, params)).rows;

const ADMIN_PASSWORD = 'adminpw-secret-4711';

function configFor(base: string, extra: Record<string, unknown> = {}) {
  return {
    loginEnabled: true,
    loginLabel: 'Company directory',
    connectionUrl: 'ldap.test',
    connectionSecurity: 'none',
    connectionPort: 389,
    baseDn: base,
    bindingAdminDn: `cn=admin,${base}`,
    bindingAdminPassword: ADMIN_PASSWORD,
    firstNameAttribute: 'givenName',
    lastNameAttribute: 'sn',
    emailAttribute: 'mail',
    loginIdAttribute: 'uid',
    ldapIdAttribute: 'entryUUID',
    userFilter: '(objectClass=inetOrgPerson)',
    ...extra,
  };
}

/** an owner, a fake directory with its own base DN, and the LDAP config saved with login on */
async function workspace(extra: Record<string, unknown> = {}, configure = true) {
  const o = await signup(server.app, { projects: 'real', remoteAddress: nextIp() });
  const base = `dc=${unique()},dc=test`;
  const fake = createFakeLdap({ baseDn: base, adminDn: `cn=admin,${base}`, adminPassword: ADMIN_PASSWORD });
  server.ctx.ldap.openDirectory = fake.open;
  server.ctx.ldap.budgets.login = 15_000;
  if (configure) {
    const res = await o.client.put('/rest/ldap/config', configFor(base, extra));
    if (res.statusCode !== 200) throw new Error(`config failed: ${res.body}`);
  }
  return { o, base, fake };
}

/** a true member joins first (an LDAP workspace takes no password invitation), then the directory is switched on */
async function workspaceWithMember(extra: Record<string, unknown> = {}) {
  const made = await workspace(extra, false);
  const m = await realMember(made.o, { remoteAddress: nextIp() });
  const res = await made.o.client.put('/rest/ldap/config', configFor(made.base, extra));
  if (res.statusCode !== 200) throw new Error(`config failed: ${res.body}`);
  return { ...made, m };
}

function person(fake: FakeLdap, uid: string, extra: Partial<Parameters<FakeLdap['addPerson']>[0]> = {}) {
  const mail = `${uid}-${unique()}@example.com`;
  fake.addPerson({ uid, mail, givenName: uid, sn: 'Tester', password: `${uid}-pw`, ...extra });
  return { uid, mail: (extra.mail ?? mail).toLowerCase(), password: extra.password ?? `${uid}-pw` };
}

function ldapLogin(slug: string, id: string, password: string, extra: Record<string, unknown> = {}) {
  const client = new TestClient(server.app, ORIGIN, nextIp());
  return client.post('/rest/auth/login', { email: id, password, workspace: slug, ...extra }).then((res) => ({
    res,
    client,
  }));
}

const syncNow = (c: TestClient, type: 'live' | 'dry' = 'live') =>
  c.data<Record<string, any>>(c.post('/rest/ldap/sync', { type }));

describe('config', () => {
  it('answers n8n defaults before anything is saved', async () => {
    const { o } = await workspace({}, false);
    const config = await o.client.data(o.client.get('/rest/ldap/config'));
    expect(config).toMatchObject({
      loginEnabled: false,
      loginLabel: '',
      connectionUrl: '',
      connectionSecurity: 'none',
      connectionPort: 389,
      allowUnauthorizedCerts: false,
      synchronizationEnabled: false,
      synchronizationInterval: 60,
      searchPageSize: 0,
      searchTimeout: 60,
      bindingAdminPassword: '',
    });
  });

  it('encrypts the bind password, blanks it on read and keeps it on a blank save', async () => {
    const { o, base, fake } = await workspace();
    const saved = await o.client.data(o.client.get('/rest/ldap/config'));
    expect(saved).toMatchObject({ loginEnabled: true, baseDn: base, bindingAdminPassword: '' });
    const [row] = await query(
      'select method, ldap::text as ldap, ldap_password_enc from tenant_auth_settings where tenant_id = $1',
      [o.tenant.id],
    );
    expect(row.method).toBe('ldap');
    expect(row.ldap_password_enc).toBeTruthy();
    expect(row.ldap_password_enc).not.toContain(ADMIN_PASSWORD);
    expect(row.ldap).not.toContain(ADMIN_PASSWORD);
    // a save without a password keeps the stored one: the connection test still binds
    const again = await o.client.put('/rest/ldap/config', {
      loginLabel: 'Renamed',
      bindingAdminPassword: '',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ loginLabel: 'Renamed', bindingAdminPassword: '' });
    expect((await o.client.post('/rest/ldap/test-connection')).statusCode).toBe(200);
    expect(fake.binds.at(-1)).toEqual({ dn: `cn=admin,${base}`, ok: true });
    const audit = await query(
      "select action, metadata::text as metadata from audit_log where tenant_id = $1 and action in ('ldap.config_updated','sso.method_changed') order by id",
      [o.tenant.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'sso.method_changed',
      'ldap.config_updated',
      'ldap.config_updated',
    ]);
    expect(JSON.stringify(audit)).not.toContain(ADMIN_PASSWORD);
  });

  it('refuses bad values with a 400', async () => {
    const { o, base } = await workspace({}, false);
    const put = (body: Record<string, unknown>) => o.client.put('/rest/ldap/config', configFor(base, body));
    expect((await put({ connectionUrl: 'ldap://dir.test' })).statusCode).toBe(400);
    expect((await put({ connectionUrl: 'dir.test:389' })).statusCode).toBe(400);
    expect((await put({ loginIdAttribute: 'uid)(cn=*' })).statusCode).toBe(400);
    expect((await put({ userFilter: 'objectClass=person' })).statusCode).toBe(400);
    expect((await put({ userFilter: '(a=b)(c=d)' })).statusCode).toBe(400);
    expect((await put({ connectionPort: 70000 })).statusCode).toBe(400);
    expect((await put({ connectionSecurity: 'ssl' })).statusCode).toBe(400);
    const missing = await put({ baseDn: '' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain('base DN');
    // nothing was saved by the refusals
    expect(
      (await query('select 1 from tenant_auth_settings where tenant_id = $1', [o.tenant.id])).length,
    ).toBe(0);
  });

  it('is for owners and admins: a member holds no ldap scope', async () => {
    const { m } = await workspaceWithMember();
    expect((await m.client.get('/rest/ldap/config')).statusCode).toBe(403);
    expect((await m.client.put('/rest/ldap/config', { loginLabel: 'x' })).statusCode).toBe(403);
    expect((await m.client.post('/rest/ldap/test-connection')).statusCode).toBe(403);
    expect((await m.client.get('/rest/ldap/sync')).statusCode).toBe(403);
    expect((await m.client.post('/rest/ldap/sync', { type: 'dry' })).statusCode).toBe(403);
  });

  it('moves from another method only through email, and turns off again', async () => {
    const { o, base } = await workspace({}, false);
    await ssoOn(server, o.tenant.id, 'saml', { samlMetadata: '<EntityDescriptor/>' });
    const refused = await o.client.put('/rest/ldap/config', configFor(base));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('sso_switch_through_email');
    await ssoOn(server, o.tenant.id, 'email');
    expect((await o.client.put('/rest/ldap/config', configFor(base))).statusCode).toBe(200);
    const off = await o.client.put('/rest/ldap/config', { loginEnabled: false });
    expect(off.json().data.loginEnabled).toBe(false);
    const [row] = await query('select method from tenant_auth_settings where tenant_id = $1', [o.tenant.id]);
    expect(row.method).toBe('email');
  });

  it('tests the connection: ok, a refused bind and an unreachable host, never with the password', async () => {
    const { o, fake } = await workspace();
    expect((await o.client.post('/rest/ldap/test-connection')).json().data).toMatchObject({ ok: true });
    const wrong = await o.client.put('/rest/ldap/config', { bindingAdminPassword: 'not-the-password-9' });
    expect(wrong.statusCode).toBe(200);
    const refused = await o.client.post('/rest/ldap/test-connection');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('ldap_connection_failed');
    expect(refused.body).not.toContain('not-the-password-9');
    expect(refused.body).toContain('bind password was refused');
    await o.client.put('/rest/ldap/config', { bindingAdminPassword: ADMIN_PASSWORD });
    fake.failOpen = new Error(`connect ECONNREFUSED 10.0.0.9:389 with bind ${ADMIN_PASSWORD}`);
    const down = await o.client.post('/rest/ldap/test-connection');
    expect(down.statusCode).toBe(400);
    expect(down.body).toContain('ECONNREFUSED');
  });
});

describe('sign-in', () => {
  it('a directory user signs in: one personal project, an ldap session not MFA verified, and a workflow lands there', async () => {
    const { o, fake } = await workspace();
    const alice = person(fake, 'alice', { givenName: 'Alice', sn: 'Smith' });
    const { res, client } = await ldapLogin(o.tenant.slug, 'alice', alice.password);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.user.email).toBe(alice.mail);
    expect(data.tenant.id).toBe(o.tenant.id);
    expect(data.role).toBe('member');
    const userId = data.user.id as string;
    const [user] = await query('select name from users where id = $1', [userId]);
    expect(user.name).toBe('Alice Smith');
    const [session] = await query('select auth_method, mfa_verified from sessions where user_id = $1', [
      userId,
    ]);
    // a bind is only a password: a new directory user has passed no MFA step (n8n; P6-01)
    expect(session).toEqual({ auth_method: 'ldap', mfa_verified: false });
    const personal = await query(
      "select id from projects where tenant_id = $1 and type = 'personal' and owner_user_id = $2",
      [o.tenant.id, userId],
    );
    expect(personal.length).toBe(1);
    const created = await client.data<{ id: string }>(
      client.post('/rest/workflows', { name: 'Mine', nodes: [], connections: {}, settings: {} }),
    );
    const [wf] = await query('select project_id from workflows where id = $1', [created.id]);
    expect(wf.project_id).toBe(personal[0].id);
    // the second sign-in is the same person through the identity
    const second = await ldapLogin(o.tenant.slug, 'alice', alice.password);
    expect(second.res.statusCode).toBe(200);
    expect(second.res.json().data.user.id).toBe(userId);
    expect((await query('select 1 from auth_identities where tenant_id = $1', [o.tenant.id])).length).toBe(1);
    const audit = await query("select 1 from audit_log where tenant_id = $1 and action = 'auth.sso_login'", [
      o.tenant.id,
    ]);
    expect(audit.length).toBe(2);
    // the user's password reached the directory for one bind and nowhere else
    expect(fake.binds.filter((b) => b.dn.startsWith('uid=alice'))).toHaveLength(2);
    const rows = await query('select * from audit_log where tenant_id = $1', [o.tenant.id]);
    expect(JSON.stringify(rows)).not.toContain(alice.password);
  });

  it('refuses a wrong password, an unknown id and two entries for one id', async () => {
    const { o, fake } = await workspace();
    person(fake, 'alice');
    fake.addPerson({ uid: 'twin', mail: `twin1-${unique()}@example.com`, password: 'twin-pw' });
    fake.entries.push({
      dn: `uid=twin,ou=staff,${fake.baseDn}`,
      attributes: {
        uid: 'twin',
        mail: `twin2-${unique()}@example.com`,
        objectClass: ['inetOrgPerson'],
        entryUUID: 'u-twin2',
      },
      password: 'twin-pw',
    });
    const wrong = await ldapLogin(o.tenant.slug, 'alice', 'not-alice');
    expect(wrong.res.statusCode).toBe(401);
    expect(wrong.res.json().error.code).toBe('invalid_credentials');
    expect(fake.binds.some((b) => b.dn.startsWith('uid=alice') && !b.ok)).toBe(true);
    expect((await ldapLogin(o.tenant.slug, 'nobody', 'x')).res.statusCode).toBe(401);
    const twin = await ldapLogin(o.tenant.slug, 'twin', 'twin-pw');
    expect(twin.res.statusCode).toBe(401);
    expect(fake.binds.some((b) => b.dn.includes('twin'))).toBe(false);
    expect((await query('select 1 from memberships where tenant_id = $1', [o.tenant.id])).length).toBe(1);
  });

  it('escapes the login id in the filter, so it cannot match more than one person', async () => {
    const { o, fake } = await workspace();
    person(fake, 'alice');
    person(fake, 'bob');
    for (const id of ['*', 'alice)(uid=bob', '*)(uid=*', 'ali*', 'alice\\']) {
      const { res } = await ldapLogin(o.tenant.slug, id, 'alice-pw');
      expect(res.statusCode).toBe(401);
    }
    const star = fake.searches.find((s) => s.filter.includes('(uid=\\2a)'));
    expect(star?.filter).toBe('(&(uid=\\2a)(objectClass=inetOrgPerson))');
    const injected = fake.searches.find((s) => s.filter.includes('alice\\29\\28uid=bob'));
    expect(injected?.filter).toBe('(&(uid=alice\\29\\28uid=bob)(objectClass=inetOrgPerson))');
    expect(fake.binds.filter((b) => b.dn.startsWith('uid=')).length).toBe(0);
  });

  it('never binds with an empty password or without a workspace, and ignores a workspace without LDAP', async () => {
    const { o, fake } = await workspace();
    person(fake, 'alice');
    const svc = server.ctx.ldap;
    const asks = (input: { email: string; password: string; workspace?: string }) =>
      svc.loginWithDirectory(input, {});
    expect(await asks({ email: 'alice', password: '', workspace: o.tenant.slug })).toBeUndefined();
    expect(await asks({ email: 'alice', password: 'alice-pw' })).toBeUndefined();
    expect(await asks({ email: 'alice', password: 'alice-pw', workspace: 'no-such' })).toBeUndefined();
    expect(fake.searches).toHaveLength(0);
    const plain = await signup(server.app, { projects: 'real', remoteAddress: nextIp() });
    expect(
      await asks({ email: 'alice', password: 'alice-pw', workspace: plain.tenant.slug }),
    ).toBeUndefined();
    expect(fake.opened).toHaveLength(0);
  });

  it('keeps the password path for owners and refuses it for members', async () => {
    const { o, m } = await workspaceWithMember();
    const owner = await ldapLogin(o.tenant.slug, o.user.email, 'Passw0rd!');
    expect(owner.res.statusCode).toBe(200);
    const [session] = await query(
      "select auth_method from sessions where user_id = $1 and auth_method = 'password'",
      [o.user.id],
    );
    expect(session).toBeTruthy();
    const member = await ldapLogin(o.tenant.slug, m.email, 'Passw0rd!');
    expect(member.res.statusCode).toBe(403);
    expect(member.res.json().error.code).toBe('sso_required');
  });

  it("refuses another workspace's user: by default the link is off, with it on the invite rule says no", async () => {
    const { o, fake } = await workspace();
    const other = await signup(server.app, { projects: 'real', remoteAddress: nextIp() });
    const entry = person(fake, 'stranger', { mail: other.user.email });
    const off = await ldapLogin(o.tenant.slug, 'stranger', entry.password);
    expect(off.res.statusCode).toBe(403);
    expect(off.res.json().error.code).toBe('ldap_link_disabled');
    await o.client.put('/rest/ldap/config', { linkExistingAccountsByEmail: true });
    const on = await ldapLogin(o.tenant.slug, 'stranger', entry.password);
    expect(on.res.statusCode).toBe(403);
    expect(on.res.json().error.code).toBe('sso_invite_required');
    const joined = await query('select 1 from memberships where tenant_id = $1 and user_id = $2', [
      o.tenant.id,
      other.user.id,
    ]);
    expect(joined.length).toBe(0);
    expect((await query('select 1 from auth_identities where tenant_id = $1', [o.tenant.id])).length).toBe(0);
  });

  it('links a current member by email only when the admin allows it', async () => {
    const { o, fake, m } = await workspaceWithMember();
    const entry = person(fake, 'member1', { mail: m.email });
    const off = await ldapLogin(o.tenant.slug, 'member1', entry.password);
    expect(off.res.json().error.code).toBe('ldap_link_disabled');
    await o.client.put('/rest/ldap/config', { linkExistingAccountsByEmail: true });
    const { res } = await ldapLogin(o.tenant.slug, 'member1', entry.password);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.id).toBe(m.user.id);
    const linked = await query('select 1 from auth_identities where tenant_id = $1 and user_id = $2', [
      o.tenant.id,
      m.user.id,
    ]);
    expect(linked.length).toBe(1);
  });

  it('refuses a sign-in when another entry shares the email, until uniqueness is switched off (ldap-1)', async () => {
    const { o, fake, m } = await workspaceWithMember({ linkExistingAccountsByEmail: true });
    // alice and bob carry the member's email; bob signs in with his own id and password
    const alice = person(fake, 'alice', { mail: m.email });
    const bob = person(fake, 'bob', { mail: m.email });
    for (const entry of [alice, bob]) {
      const { res } = await ldapLogin(o.tenant.slug, entry.uid, entry.password);
      expect(res.statusCode).toBe(401);
    }
    expect(fake.binds.some((b) => b.dn.startsWith('uid=bob'))).toBe(false);
    expect(fake.binds.some((b) => b.dn.startsWith('uid=alice'))).toBe(false);
    expect((await query('select 1 from auth_identities where tenant_id = $1', [o.tenant.id])).length).toBe(0);
    // the rule follows the setting
    await o.client.put('/rest/ldap/config', { enforceEmailUniqueness: false });
    const { res } = await ldapLogin(o.tenant.slug, 'bob', bob.password);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.id).toBe(m.user.id);
  });

  it('joins a person with a pending invitation, and refuses a disabled member', async () => {
    const { o, fake } = await workspace();
    const email = `invited-${unique()}@example.com`;
    expect((await o.client.post('/rest/members/invite', { email, role: 'member' })).statusCode).toBe(200);
    const entry = person(fake, 'invited', { mail: email });
    const joined = await ldapLogin(o.tenant.slug, 'invited', entry.password);
    expect(joined.res.statusCode).toBe(200);
    const userId = joined.res.json().data.user.id as string;
    const [invite] = await query('select accepted_at from invitations where tenant_id = $1 and email = $2', [
      o.tenant.id,
      email,
    ]);
    expect(invite.accepted_at).toBeTruthy();
    await disableMember(server.ctx, o.tenant.id, userId, o.user.id);
    const refused = await ldapLogin(o.tenant.slug, 'invited', entry.password);
    expect(refused.res.statusCode).toBe(403);
    expect(refused.res.json().error.code).toBe('sso_user_disabled');
  });

  it('asks for the MFA code after the directory check: none is 401 mfa_required, a valid code signs in', async () => {
    const { o, fake } = await workspace();
    const entry = person(fake, 'secure');
    const first = await ldapLogin(o.tenant.slug, 'secure', entry.password);
    expect(first.res.statusCode).toBe(200);
    const userId = first.res.json().data.user.id as string;
    // MFA is set up from a password session of the same user (an ldap session cannot change two-factor)
    const pw = new TestClient(server.app, ORIGIN, nextIp());
    const token = await server.ctx.auth.createSession(
      userId,
      o.tenant.id,
      {},
      { authMethod: 'password', mfaVerified: false },
    );
    pw.cookie = `wf_session=${token}`;
    const setup = await pw.data<{ secret: string }>(pw.get('/rest/auth/mfa/setup'));
    const code = (steps: number) =>
      totp({ secret: setup.secret, timestampMs: Date.now() + steps * 30_000 }).token;
    expect((await pw.post('/rest/auth/mfa/enable', { mfaCode: code(-6) })).statusCode).toBe(200);
    const none = await ldapLogin(o.tenant.slug, 'secure', entry.password);
    expect(none.res.statusCode).toBe(401);
    expect(none.res.json().error.code).toBe('mfa_required');
    const wrong = await ldapLogin(o.tenant.slug, 'secure', entry.password, { mfaCode: '000000' });
    expect(wrong.res.statusCode).toBe(401);
    const ok = await ldapLogin(o.tenant.slug, 'secure', entry.password, { mfaCode: code(1) });
    expect(ok.res.statusCode).toBe(200);
    expect(ok.res.json().data.user.id).toBe(userId);
    // only the sign-in that passed the MFA step is verified (as n8n)
    const sessions = await query(
      "select mfa_verified from sessions where user_id = $1 and auth_method = 'ldap' order by expires_at",
      [userId],
    );
    expect(sessions.map((s) => s.mfa_verified)).toEqual([false, true]);
  });

  it('in a workspace that enforces MFA, a directory user without MFA must set it up after signing in', async () => {
    const { o, fake } = await workspace();
    await server.ctx.repos.tenants.update(o.tenant.id, { settings: { mfa: { enforced: true } } });
    const entry = person(fake, 'unenrolled');
    const { res, client } = await ldapLogin(o.tenant.slug, 'unenrolled', entry.password);
    expect(res.statusCode).toBe(200);
    const blocked = await client.get('/rest/workflows');
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error.code).toBe('mfa_enrollment_required');
  });

  it('does not hold the login for a slow directory: no match, the password path decides', async () => {
    const { o, fake } = await workspace();
    const entry = person(fake, 'slow');
    fake.searchDelayMs = 600;
    server.ctx.ldap.budgets.login = 80;
    const started = Date.now();
    const { res } = await ldapLogin(o.tenant.slug, 'slow', entry.password);
    expect(res.statusCode).toBe(401);
    expect(Date.now() - started).toBeLessThan(500);
    server.ctx.ldap.budgets.login = 15_000;
    fake.searchDelayMs = 0;
    expect((await ldapLogin(o.tenant.slug, 'slow', entry.password)).res.statusCode).toBe(200);
  });
});

describe('sync', () => {
  it('creates members with a personal project and one history row, then changes nothing on a repeat', async () => {
    const { o, fake } = await workspace();
    const a = person(fake, 'anna', { givenName: 'Anna', sn: 'A' });
    person(fake, 'ben');
    const run = await syncNow(o.client);
    expect(run).toMatchObject({
      runMode: 'live',
      status: 'success',
      scanned: 2,
      created: 2,
      updated: 0,
      disabled: 0,
      error: null,
    });
    expect(run.endedAt).toBeTruthy();
    const [anna] = await query('select id, name from users where email = $1', [a.mail]);
    expect(anna.name).toBe('Anna A');
    const personal = await query("select 1 from projects where owner_user_id = $1 and type = 'personal'", [
      anna.id,
    ]);
    expect(personal.length).toBe(1);
    const active = await query(
      'select 1 from memberships where tenant_id = $1 and user_id = $2 and disabled_at is null',
      [o.tenant.id, anna.id],
    );
    expect(active.length).toBe(1);
    expect((await syncNow(o.client)).created).toBe(0);
    const history = await o.client.data<any[]>(o.client.get('/rest/ldap/sync'));
    expect(history).toHaveLength(2);
    expect(history[0].startedAt >= history[1].startedAt).toBe(true);
    const audit = await query(
      "select metadata from audit_log where tenant_id = $1 and action = 'ldap.synced'",
      [o.tenant.id],
    );
    expect(audit).toHaveLength(2);
    // the created member signs in with the directory password afterwards
    expect((await ldapLogin(o.tenant.slug, 'anna', a.password)).res.statusCode).toBe(200);
  });

  it('updates a changed name, disables a removed member in this workspace only, and enables a returned one', async () => {
    const { o, fake } = await workspace();
    const a = person(fake, 'anna', { givenName: 'Anna', sn: 'A' });
    const b = person(fake, 'ben');
    await syncNow(o.client);
    const [ben] = await query('select id from users where email = $1', [b.mail]);
    const elsewhere = await signup(server.app, { projects: 'real', remoteAddress: nextIp() });
    await server.ctx.repos.memberships.add(elsewhere.tenant.id, ben.id, 'member');
    fake.entries.find((e) => e.attributes.uid === 'anna')!.attributes.givenName = 'Annabel';
    fake.remove('ben');
    const run = await syncNow(o.client);
    expect(run).toMatchObject({ status: 'success', scanned: 1, created: 0, updated: 1, disabled: 1 });
    expect((await query('select name from users where email = $1', [a.mail]))[0].name).toBe('Annabel A');
    expect(await server.ctx.repos.memberships.get(o.tenant.id, ben.id)).toBeUndefined();
    expect(await server.ctx.repos.memberships.get(elsewhere.tenant.id, ben.id)).toBeDefined();
    expect((await ldapLogin(o.tenant.slug, 'ben', b.password)).res.statusCode).toBe(401);
    fake.addPerson({
      uid: 'ben',
      mail: b.mail,
      givenName: 'ben',
      sn: 'Tester',
      password: b.password,
      extra: { entryUUID: 'uuid-ben' },
    });
    const back = await syncNow(o.client);
    expect(back).toMatchObject({ status: 'success', created: 0, updated: 1, disabled: 0 });
    expect(await server.ctx.repos.memberships.get(o.tenant.id, ben.id)).toBeDefined();
    const actions = await query(
      "select action from audit_log where tenant_id = $1 and action in ('member.disabled','member.enabled') order by id",
      [o.tenant.id],
    );
    expect(actions.map((r) => r.action)).toEqual(['member.disabled', 'member.enabled']);
  });

  it("skips another workspace's user and keeps an owner", async () => {
    const { o, fake } = await workspace({ linkExistingAccountsByEmail: true });
    const other = await signup(server.app, { projects: 'real', remoteAddress: nextIp() });
    person(fake, 'stranger', { mail: other.user.email });
    person(fake, 'carol');
    const run = await syncNow(o.client);
    expect(run).toMatchObject({ scanned: 2, created: 1, updated: 0 });
    const joined = await query('select 1 from memberships where tenant_id = $1 and user_id = $2', [
      o.tenant.id,
      other.user.id,
    ]);
    expect(joined.length).toBe(0);
    // the owner is linked to a directory entry and then leaves the directory: still enabled
    person(fake, 'boss', { mail: o.user.email });
    expect((await syncNow(o.client)).updated).toBe(1);
    fake.remove('boss');
    const after = await syncNow(o.client);
    expect(after.disabled).toBe(0);
    expect(await server.ctx.repos.memberships.get(o.tenant.id, o.user.id)).toBeDefined();
  });

  it('does not disable a user who still has one identity in the directory (ldap-2)', async () => {
    const { o, fake, m } = await workspaceWithMember({ linkExistingAccountsByEmail: true });
    person(fake, 'carol', { mail: m.email });
    expect(await syncNow(o.client)).toMatchObject({ updated: 1, disabled: 0 });
    // the entry is re-created with a new entryUUID and the same email: the user has two identities
    fake.remove('carol');
    person(fake, 'carol2', { mail: m.email, extra: { entryUUID: `uuid-${unique()}` } });
    for (let run = 0; run < 3; run++) {
      expect(await syncNow(o.client)).toMatchObject({ status: 'success', disabled: 0 });
      expect(await server.ctx.repos.memberships.get(o.tenant.id, m.user.id)).toBeDefined();
    }
    const actions = await query(
      "select action from audit_log where tenant_id = $1 and action in ('member.disabled','member.enabled')",
      [o.tenant.id],
    );
    expect(actions).toHaveLength(0);
  });

  it('a dry run counts what the live run disables, and not an owner (ldap-4)', async () => {
    const { o, fake, m } = await workspaceWithMember({ linkExistingAccountsByEmail: true });
    person(fake, 'boss', { mail: o.user.email });
    person(fake, 'worker', { mail: m.email });
    person(fake, 'stays');
    expect((await syncNow(o.client)).updated).toBe(2);
    fake.remove('boss');
    fake.remove('worker');
    const dry = await syncNow(o.client, 'dry');
    expect(dry).toMatchObject({ runMode: 'dry', disabled: 1 });
    expect(await server.ctx.repos.memberships.get(o.tenant.id, m.user.id)).toBeDefined();
    const live = await syncNow(o.client);
    expect(live).toMatchObject({ disabled: 1 });
    expect(await server.ctx.repos.memberships.get(o.tenant.id, m.user.id)).toBeUndefined();
    expect(await server.ctx.repos.memberships.get(o.tenant.id, o.user.id)).toBeDefined();
  });

  it('a dry run writes nothing but its history row', async () => {
    const { o, fake } = await workspace();
    person(fake, 'dora');
    const users = async () => (await query('select count(*)::int as n from users'))[0].n as number;
    const before = await users();
    const dry = await syncNow(o.client, 'dry');
    expect(dry).toMatchObject({ runMode: 'dry', status: 'success', scanned: 1, created: 1 });
    expect(await users()).toBe(before);
    expect((await query('select 1 from auth_identities where tenant_id = $1', [o.tenant.id])).length).toBe(0);
    const rows = await query('select 1 from auth_provider_sync_history where tenant_id = $1', [o.tenant.id]);
    expect(rows.length).toBe(1);
    expect((await syncNow(o.client)).created).toBe(1);
  });

  it('never makes two accounts of one email', async () => {
    const { o, fake } = await workspace();
    const mail = `shared-${unique()}@example.com`;
    person(fake, 'one', { mail });
    person(fake, 'two', { mail });
    person(fake, 'fine');
    expect(await syncNow(o.client)).toMatchObject({ scanned: 3, created: 1 });
    expect((await query('select 1 from users where email = $1', [mail])).length).toBe(0);
    await o.client.put('/rest/ldap/config', { enforceEmailUniqueness: false });
    expect(await syncNow(o.client)).toMatchObject({ created: 1 });
    expect((await query('select 1 from users where email = $1', [mail])).length).toBe(1);
  });

  it('refuses to disable everybody when the directory returns nothing', async () => {
    const { o, fake } = await workspace();
    person(fake, 'erin');
    await syncNow(o.client);
    fake.entries = [];
    const run = await syncNow(o.client);
    expect(run.status).toBe('error');
    expect(run.error).toContain('returned no users');
    expect(run.disabled).toBe(0);
    const off = await query('select 1 from memberships where tenant_id = $1 and disabled_at is not null', [
      o.tenant.id,
    ]);
    expect(off.length).toBe(0);
  });

  it('records a failed run as a row with the reason and no password', async () => {
    const { o, fake } = await workspace();
    fake.failOpen = new Error(`connect ECONNREFUSED with password ${ADMIN_PASSWORD}`);
    const run = await syncNow(o.client);
    expect(run.status).toBe('error');
    expect(run.error).toContain('ECONNREFUSED');
    expect(JSON.stringify(run)).not.toContain(ADMIN_PASSWORD);
    expect(run.endedAt).toBeTruthy();
    const noConfig = await workspace({}, false);
    const refused = await noConfig.o.client.post('/rest/ldap/sync', { type: 'live' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('ldap_config_missing');
  });

  it('pages the history and runs one sync at a time', async () => {
    const { o, fake } = await workspace();
    person(fake, 'fay');
    for (let i = 0; i < 3; i++) await syncNow(o.client, 'dry');
    const first = await o.client.get('/rest/ldap/sync?limit=2');
    expect(first.json().data).toHaveLength(2);
    expect(first.json().nextCursor).toBeTruthy();
    const second = await o.client.get(`/rest/ldap/sync?limit=2&cursor=${first.json().nextCursor}`);
    expect(second.json().data).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();
    expect((await o.client.get('/rest/ldap/sync?limit=0')).statusCode).toBe(400);
    fake.searchDelayMs = 300;
    const [a, b] = await Promise.all([
      o.client.post('/rest/ldap/sync', { type: 'dry' }),
      o.client.post('/rest/ldap/sync', { type: 'dry' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it("another workspace's history and config stay out of reach", async () => {
    const one = await workspace();
    const two = await workspace();
    person(two.fake, 'zed');
    server.ctx.ldap.openDirectory = two.fake.open;
    await syncNow(two.o.client);
    expect(await one.o.client.data<any[]>(one.o.client.get('/rest/ldap/sync'))).toHaveLength(0);
    expect((await one.o.client.get('/rest/ldap/config')).json().data.baseDn).toBe(one.base);
  });

  it('the sweep runs a workspace when its interval has passed and not before', async () => {
    const { o, fake } = await workspace({ synchronizationEnabled: true, synchronizationInterval: 30 });
    person(fake, 'gus');
    const svc = server.ctx.ldap;
    const count = async (c: TestClient) => (await c.data<any[]>(c.get('/rest/ldap/sync'))).length;
    expect(await svc.runDue(new Date())).toBeGreaterThanOrEqual(1);
    expect(await count(o.client)).toBe(1);
    // asked again at once: the latest run is younger than 30 minutes
    await svc.runDue(new Date());
    expect(await count(o.client)).toBe(1);
    await svc.runDue(new Date(Date.now() + 31 * 60_000));
    expect(await count(o.client)).toBe(2);
    const off = await workspace({ synchronizationEnabled: false });
    server.ctx.ldap.openDirectory = off.fake.open;
    await svc.runDue(new Date(Date.now() + 31 * 60_000));
    expect(await count(off.o.client)).toBe(0);
    svc.startSweep();
    svc.startSweep();
    svc.stopSweep();
  });

  it('a run left `running` by a stopped process is closed by the sweep', async () => {
    const { o } = await workspace({ synchronizationEnabled: false });
    const row = await server.ctx.repos.ldapHistory.start(o.tenant.id, {
      providerType: 'ldap',
      runMode: 'live',
    });
    await query(
      "update auth_provider_sync_history set started_at = now() - interval '1 hour' where id = $1",
      [row.id],
    );
    await server.ctx.ldap.runDue(new Date());
    const [after] = await query('select status, error from auth_provider_sync_history where id = $1', [
      row.id,
    ]);
    expect(after.status).toBe('error');
    expect(after.error).toContain('stopped');
  });
});

describe('public rows', () => {
  async function keyFor(o: { client: TestClient }) {
    const created = await o.client.data<{ key: string }>(o.client.post('/rest/api-keys', { name: 'ldap' }));
    return (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
      server.app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { 'x-api-key': created.key },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
  }

  it('reads and saves the config, runs a sync and pages the history', async () => {
    const { o, base, fake } = await workspace({}, false);
    person(fake, 'pia');
    const api = await keyFor(o);
    const put = await api('PUT', '/settings/ldap', configFor(base));
    expect(put.statusCode).toBe(200);
    expect(put.json().data).toMatchObject({ loginEnabled: true, baseDn: base, bindingAdminPassword: '' });
    expect((await api('GET', '/settings/ldap')).json().data.bindingAdminPassword).toBe('');
    const run = await api('POST', '/settings/ldap/sync', { type: 'dry' });
    expect(run.statusCode).toBe(200);
    expect(run.json().data).toMatchObject({ runMode: 'dry', status: 'success', created: 1 });
    await api('POST', '/settings/ldap/sync', { type: 'live' });
    const page = await api('GET', '/settings/ldap/sync?limit=1');
    expect(page.json().data).toHaveLength(1);
    expect(page.json().nextCursor).toBeTruthy();
    const rest = await api('GET', `/settings/ldap/sync?limit=1&cursor=${page.json().nextCursor}`);
    expect(rest.json().data).toHaveLength(1);
    expect(rest.json().nextCursor).toBeNull();
    expect((await api('POST', '/settings/ldap/sync', { type: 'bogus' })).statusCode).toBe(400);
  });
});
