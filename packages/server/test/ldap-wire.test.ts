/**
 * P6-12 (L10): the LDAP wire against the `openldap` service (osixia/openldap:1.5.0, profile `brokers`,
 * 127.0.0.1:3389, base dc=workflow,dc=local, admin cn=admin password `workflow`). Skipped unless
 * `LDAP_TEST_URL` is set (`ldap://127.0.0.1:3389`). Each test group works in its own organizational unit
 * under the base DN with unique entry names, and removes it again. It checks a real bind and a paged search
 * through the pinned lookup of `resolveAllowedHost`, a bind as a user, a private host refused without
 * `SSRF_ALLOW`, and the whole service (config, test connection, sign-in, sync) over the wire.
 */
import { randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import { Client } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLdapDirectory } from '../src/services/sso/ldap-directory';
import { createTestServer, flushRedis, ORIGIN, signup, TestClient, type TestServer } from './helpers';

const LDAP_URL = process.env.LDAP_TEST_URL;
const BASE = 'dc=workflow,dc=local';
const ADMIN_DN = `cn=admin,${BASE}`;
const ADMIN_PASSWORD = 'workflow';

const target = LDAP_URL ? new URL(LDAP_URL) : undefined;
const HOST = target?.hostname ?? '127.0.0.1';
const PORT = Number(target?.port || 389);

const allowLoopback = new HttpClient({
  ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] },
});
const strict = new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } });
const resolveWith = (http: HttpClient) => (host: string) => http.resolveAllowedHost(host);

const unique = () => randomUUID().slice(0, 8);

/** a raw admin connection of the test itself, to build and remove the test entries */
async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ url: `ldap://${HOST}:${PORT}` });
  try {
    await client.bind(ADMIN_DN, ADMIN_PASSWORD);
    return await work(client);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

interface Seeded {
  ou: string;
  users: Array<{ uid: string; mail: string; password: string }>;
}

async function seed(count: number): Promise<Seeded> {
  const ou = `ou=t${unique()},${BASE}`;
  const users: Seeded['users'] = [];
  await withAdmin(async (client) => {
    await client.add(ou, { objectClass: ['organizationalUnit'], ou: ou.split(',')[0].slice(3) });
    for (let i = 0; i < count; i++) {
      const uid = `u${i}${unique()}`;
      const user = { uid, mail: `${uid}@example.com`, password: `pw-${unique()}` };
      users.push(user);
      await client.add(`uid=${uid},${ou}`, {
        objectClass: ['inetOrgPerson'],
        uid,
        cn: `Person ${uid}`,
        sn: 'Wire',
        givenName: `Given${i}`,
        mail: user.mail,
        userPassword: user.password,
      });
    }
  });
  return { ou, users };
}

async function unseed(seeded: Seeded): Promise<void> {
  await withAdmin(async (client) => {
    for (const user of seeded.users) await client.del(`uid=${user.uid},${seeded.ou}`).catch(() => undefined);
    await client.del(seeded.ou).catch(() => undefined);
  });
}

describe.skipIf(!LDAP_URL)('ldap wire', () => {
  const options = {
    host: HOST,
    port: PORT,
    security: 'none' as const,
    allowUnauthorizedCerts: false,
    timeoutMs: 10_000,
  };

  describe('directory', () => {
    let seeded: Seeded;
    beforeAll(async () => {
      seeded = await seed(5);
    });
    afterAll(async () => {
      if (seeded) await unseed(seeded);
    });

    it('binds the admin, runs a paged search and binds as a user, all through the pinned lookup', async () => {
      const directory = await openLdapDirectory(options, resolveWith(allowLoopback));
      try {
        await directory.bind(ADMIN_DN, ADMIN_PASSWORD);
        const found = await directory.search({
          baseDn: seeded.ou,
          filter: '(objectClass=inetOrgPerson)',
          attributes: ['uid', 'mail', 'givenName', 'sn', 'entryUUID'],
          pageSize: 2,
          timeoutMs: 10_000,
        });
        expect(found).toHaveLength(5);
        const first = found.find((entry) => entry.attributes.uid === seeded.users[0].uid);
        expect(first?.attributes.mail).toBe(seeded.users[0].mail);
        expect(String(first?.attributes.entryUUID)).toMatch(/^[0-9a-f-]{36}$/);
        const one = await directory.search({
          baseDn: seeded.ou,
          filter: `(uid=${seeded.users[1].uid})`,
          attributes: ['uid'],
          pageSize: 0,
          timeoutMs: 10_000,
        });
        expect(one).toHaveLength(1);
        await directory.bind(one[0].dn, seeded.users[1].password);
      } finally {
        await directory.close();
      }
    });

    it('refuses a wrong user password and a wrong admin password', async () => {
      const directory = await openLdapDirectory(options, resolveWith(allowLoopback));
      try {
        await expect(directory.bind(ADMIN_DN, 'not-the-password')).rejects.toMatchObject({
          name: 'InvalidCredentialsError',
        });
        await directory.bind(ADMIN_DN, ADMIN_PASSWORD);
        await expect(directory.bind(`uid=${seeded.users[0].uid},${seeded.ou}`, 'nope')).rejects.toMatchObject(
          {
            name: 'InvalidCredentialsError',
          },
        );
      } finally {
        await directory.close();
      }
    });

    it('refuses a private host without SSRF_ALLOW, before any socket opens', async () => {
      await expect(openLdapDirectory(options, resolveWith(strict))).rejects.toThrow();
      await expect(
        openLdapDirectory({ ...options, host: '10.0.0.5' }, resolveWith(strict)),
      ).rejects.toThrow();
      await expect(
        openLdapDirectory({ ...options, host: '169.254.169.254' }, resolveWith(allowLoopback)),
      ).rejects.toThrow();
    });
  });

  describe('service', () => {
    let server: TestServer;
    let seeded: Seeded;
    beforeAll(async () => {
      await flushRedis();
      server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
      seeded = await seed(3);
    });
    afterAll(async () => {
      await server?.close();
      if (seeded) await unseed(seeded);
    });

    const config = (extra: Record<string, unknown> = {}) => ({
      loginEnabled: true,
      connectionUrl: HOST,
      connectionPort: PORT,
      connectionSecurity: 'none',
      baseDn: seeded.ou,
      bindingAdminDn: ADMIN_DN,
      bindingAdminPassword: ADMIN_PASSWORD,
      firstNameAttribute: 'givenName',
      lastNameAttribute: 'sn',
      emailAttribute: 'mail',
      loginIdAttribute: 'uid',
      ldapIdAttribute: 'entryUUID',
      userFilter: '(objectClass=inetOrgPerson)',
      searchPageSize: 2,
      ...extra,
    });

    it('tests the connection, signs a directory user in and syncs the rest', async () => {
      const o = await signup(server.app, { projects: 'real', remoteAddress: '10.72.0.1' });
      const saved = await o.client.put('/rest/ldap/config', config());
      expect(saved.statusCode).toBe(200);
      expect((await o.client.post('/rest/ldap/test-connection')).json().data).toMatchObject({ ok: true });

      const user = seeded.users[0];
      const client = new TestClient(server.app, ORIGIN, '10.72.0.2');
      const login = await client.post('/rest/auth/login', {
        email: user.uid,
        password: user.password,
        workspace: o.tenant.slug,
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().data.user.email).toBe(user.mail);
      const wrong = await new TestClient(server.app, ORIGIN, '10.72.0.3').post('/rest/auth/login', {
        email: user.uid,
        password: 'wrong-password',
        workspace: o.tenant.slug,
      });
      expect(wrong.statusCode).toBe(401);

      const run = await o.client.data<Record<string, any>>(
        o.client.post('/rest/ldap/sync', { type: 'live' }),
      );
      expect(run).toMatchObject({ status: 'success', scanned: 3, created: 2, updated: 0, disabled: 0 });
    });

    it('is refused for a private host the platform does not allow', async () => {
      const strictServer = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { http: strict });
      try {
        const o = await signup(strictServer.app, { projects: 'real', remoteAddress: '10.72.0.9' });
        const saved = await o.client.put('/rest/ldap/config', config());
        expect(saved.statusCode).toBe(200);
        const test = await o.client.post('/rest/ldap/test-connection');
        expect(test.statusCode).toBe(400);
        expect(test.json().error.code).toBe('ldap_connection_failed');
        const run = await o.client.data<Record<string, any>>(
          o.client.post('/rest/ldap/sync', { type: 'dry' }),
        );
        expect(run.status).toBe('error');
        const login = await new TestClient(strictServer.app, ORIGIN, '10.72.0.10').post('/rest/auth/login', {
          email: seeded.users[0].uid,
          password: seeded.users[0].password,
          workspace: o.tenant.slug,
        });
        expect(login.statusCode).toBe(401);
      } finally {
        await strictServer.close();
      }
    });
  });
});
