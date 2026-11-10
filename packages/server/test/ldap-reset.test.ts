/**
 * P6-12 (L10): `ldap:reset --tenant <slug>` with exactly one of `--userId`, `--projectId`,
 * `--deleteWorkflowsAndCredentials`. The work of every LDAP user moves to the user's personal project, to the
 * project, or is deleted; then the config, identities and history are cleared, the method goes back to email,
 * the LDAP users' sessions end and the members stay. Wrong arguments change nothing; another workspace is
 * untouched.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ldapResetCommand } from '../src/commands/ldap-reset';
import { createFakeLdap, type FakeLdap } from './fakes/ldap-directory';
import { createTestServer, flushRedis, ORIGIN, signup, TestClient, type TestServer } from './helpers';

let server: TestServer;
beforeAll(async () => {
  await flushRedis();
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server?.close();
});

let ipCounter = 0;
const nextIp = () => `10.71.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
const unique = () => randomUUID().slice(0, 8);
const query = async (sql: string, params: unknown[] = []) =>
  (await server.ctx.database.pool.query(sql, params)).rows;

/** an owner with LDAP on, two directory people who signed in and each made one workflow */
async function directoryWorkspace() {
  const o = await signup(server.app, { projects: 'real', remoteAddress: nextIp() });
  const base = `dc=${unique()},dc=test`;
  const fake: FakeLdap = createFakeLdap({
    baseDn: base,
    adminDn: `cn=admin,${base}`,
    adminPassword: 'adm-pw-1',
  });
  server.ctx.ldap.openDirectory = fake.open;
  const saved = await o.client.put('/rest/ldap/config', {
    loginEnabled: true,
    connectionUrl: 'ldap.test',
    baseDn: base,
    bindingAdminDn: `cn=admin,${base}`,
    bindingAdminPassword: 'adm-pw-1',
    firstNameAttribute: 'givenName',
    lastNameAttribute: 'sn',
    emailAttribute: 'mail',
    loginIdAttribute: 'uid',
    ldapIdAttribute: 'entryUUID',
  });
  expect(saved.statusCode).toBe(200);
  const people: Array<{ id: string; client: TestClient; workflowId: string }> = [];
  for (const uid of ['uma', 'vic']) {
    fake.addPerson({
      uid,
      mail: `${uid}-${unique()}@example.com`,
      givenName: uid,
      sn: 'T',
      password: `${uid}-pw`,
    });
    const client = new TestClient(server.app, ORIGIN, nextIp());
    const login = await client.post('/rest/auth/login', {
      email: uid,
      password: `${uid}-pw`,
      workspace: o.tenant.slug,
    });
    expect(login.statusCode).toBe(200);
    const workflow = await client.data<{ id: string }>(
      client.post('/rest/workflows', { name: `${uid} flow`, nodes: [], connections: {}, settings: {} }),
    );
    people.push({ id: login.json().data.user.id, client, workflowId: workflow.id });
  }
  return { o, people, fake };
}

const projectOf = async (workflowId: string) =>
  (await query('select project_id from workflows where id = $1', [workflowId]))[0]?.project_id as
    | string
    | undefined;
const personalOf = async (tenantId: string, userId: string) =>
  (
    await query("select id from projects where tenant_id = $1 and type = 'personal' and owner_user_id = $2", [
      tenantId,
      userId,
    ])
  )[0].id as string;

async function expectCleared(tenantId: string) {
  const [row] = await query(
    'select method, ldap, ldap_password_enc from tenant_auth_settings where tenant_id = $1',
    [tenantId],
  );
  expect(row.method).toBe('email');
  expect(row.ldap).toBeNull();
  expect(row.ldap_password_enc).toBeNull();
  expect((await query('select 1 from auth_identities where tenant_id = $1', [tenantId])).length).toBe(0);
  expect(
    (await query('select 1 from auth_provider_sync_history where tenant_id = $1', [tenantId])).length,
  ).toBe(0);
}

describe('ldap:reset', () => {
  it('--userId moves the work to that user, clears everything, ends the LDAP sessions and keeps the members', async () => {
    const { o, people } = await directoryWorkspace();
    await o.client.post('/rest/ldap/sync', { type: 'dry' });
    await ldapResetCommand(server.ctx, ['--tenant', o.tenant.slug, '--userId', o.user.id]);
    const ownerPersonal = await personalOf(o.tenant.id, o.user.id);
    for (const p of people) expect(await projectOf(p.workflowId)).toBe(ownerPersonal);
    await expectCleared(o.tenant.id);
    for (const p of people) {
      expect((await query('select 1 from sessions where user_id = $1', [p.id])).length).toBe(0);
      expect(await server.ctx.repos.memberships.get(o.tenant.id, p.id)).toBeDefined();
    }
    const audit = await query(
      "select metadata::text as metadata from audit_log where tenant_id = $1 and action = 'ldap.config_updated' order by id desc limit 1",
      [o.tenant.id],
    );
    expect(audit[0].metadata).toContain('reset');
    // the directory no longer signs anyone in
    const again = new TestClient(server.app, ORIGIN, nextIp());
    const res = await again.post('/rest/auth/login', {
      email: 'uma',
      password: 'uma-pw',
      workspace: o.tenant.slug,
    });
    expect(res.statusCode).toBe(401);
  });

  it('--projectId moves the work to the project', async () => {
    const { o, people } = await directoryWorkspace();
    const team = await o.client.data<{ id: string }>(o.client.post('/rest/projects', { name: 'Landing' }));
    await ldapResetCommand(server.ctx, [`--tenant=${o.tenant.slug}`, `--projectId=${team.id}`]);
    for (const p of people) expect(await projectOf(p.workflowId)).toBe(team.id);
    await expectCleared(o.tenant.id);
  });

  it('--deleteWorkflowsAndCredentials deletes the work of the LDAP users only', async () => {
    const { o, people } = await directoryWorkspace();
    const mine = await o.client.data<{ id: string }>(
      o.client.post('/rest/workflows', { name: 'Owner flow', nodes: [], connections: {}, settings: {} }),
    );
    await ldapResetCommand(server.ctx, ['--tenant', o.tenant.slug, '--deleteWorkflowsAndCredentials']);
    for (const p of people) expect(await projectOf(p.workflowId)).toBeUndefined();
    expect(await projectOf(mine.id)).toBeDefined();
    await expectCleared(o.tenant.id);
  });

  it('needs exactly one target and a known workspace, and changes nothing when it refuses', async () => {
    const { o, people } = await directoryWorkspace();
    const run = (argv: string[]) => ldapResetCommand(server.ctx, argv);
    await expect(run([])).rejects.toThrow('Usage');
    await expect(run(['--tenant', o.tenant.slug])).rejects.toThrow('Usage');
    await expect(
      run(['--tenant', o.tenant.slug, '--userId', o.user.id, '--deleteWorkflowsAndCredentials']),
    ).rejects.toThrow('Usage');
    await expect(run(['--tenant', o.tenant.slug, '--userId'])).rejects.toThrow('Usage');
    await expect(run(['--tenant', o.tenant.slug, '--bogus'])).rejects.toThrow('Unknown option');
    await expect(run(['--tenant', 'no-such-workspace', '--userId', o.user.id])).rejects.toThrow(
      'No workspace',
    );
    await expect(run(['--tenant', o.tenant.slug, '--userId', randomUUID()])).rejects.toThrow('not a member');
    await expect(run(['--tenant', o.tenant.slug, '--projectId', randomUUID()])).rejects.toThrow(
      'No such project',
    );
    const [row] = await query('select method from tenant_auth_settings where tenant_id = $1', [o.tenant.id]);
    expect(row.method).toBe('ldap');
    expect((await query('select 1 from auth_identities where tenant_id = $1', [o.tenant.id])).length).toBe(2);
    for (const p of people)
      expect(await projectOf(p.workflowId)).not.toBe(await personalOf(o.tenant.id, o.user.id));
  });

  it("leaves another workspace's LDAP settings and identities alone", async () => {
    const one = await directoryWorkspace();
    const two = await directoryWorkspace();
    server.ctx.ldap.openDirectory = two.fake.open;
    await ldapResetCommand(server.ctx, ['--tenant', one.o.tenant.slug, '--userId', one.o.user.id]);
    const [row] = await query('select method from tenant_auth_settings where tenant_id = $1', [
      two.o.tenant.id,
    ]);
    expect(row.method).toBe('ldap');
    expect(
      (await query('select 1 from auth_identities where tenant_id = $1', [two.o.tenant.id])).length,
    ).toBe(2);
    for (const p of two.people)
      expect(await projectOf(p.workflowId)).toBe(await personalOf(two.o.tenant.id, p.id));
  });
});
