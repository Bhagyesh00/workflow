/**
 * P6-20 (L4) the members list: filters (q, role, projectId), sort from a fixed list, paging with the total,
 * pending invitations among the rows, `status` and `statusCounts` for callers with `user:create` only, the
 * 2FA, last active, disabled and SCIM columns, and no row of another workspace.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userMfa } from '../src/db/schema';
import {
  addToProject,
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
} from './helpers';

const MISSING_SCOPE = 'User is missing a scope required to perform this action';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const repos = () => server.ctx.repos;

let ipCounter = 0;
const ws = () =>
  signup(server.app, { remoteAddress: `10.65.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` });

type Owner = Awaited<ReturnType<typeof ws>>;

interface Row {
  userId: string;
  invitationId?: string;
  email: string;
  name: string;
  role: string;
  status: 'active' | 'pending' | 'disabled';
  lastActiveAt: string | null;
  mfaEnabled: boolean;
  managedByScim: boolean;
  allowSsoManualLogin: boolean;
}

async function list(client: Owner['client'], query = ''): Promise<{ rows: Row[]; body: any }> {
  const res = await client.get(`/rest/members${query}`);
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${res.body}`);
  const body = res.json();
  return { rows: body.data as Row[], body };
}

const tag = () => randomUUID().slice(0, 8);

describe('GET /members', () => {
  it('lists members and pending invitations with the columns of the page', async () => {
    const owner = await ws();
    const member = await realMember(owner, { name: 'Mia Member' });
    const email = `pending-${tag()}@example.com`;
    await owner.client.data(owner.client.post('/rest/members/invite', { email, role: 'admin' }));

    const { rows, body } = await list(owner.client);
    expect(body.count).toBe(3);
    expect(body.nextCursor).toBeNull();
    const pending = rows.find((r) => r.email === email)!;
    expect(pending).toMatchObject({ status: 'pending', role: 'admin', name: '', mfaEnabled: false });
    expect(pending.invitationId).toBe(pending.userId);
    const mia = rows.find((r) => r.userId === member.user.id)!;
    expect(mia).toMatchObject({ name: 'Mia Member', role: 'member', status: 'active', managedByScim: false });
    expect(rows.find((r) => r.role === 'owner')?.status).toBe('active');
  });

  it('an invitation whose person already joined is not listed twice', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const { rows } = await list(owner.client);
    expect(rows.filter((r) => r.email === member.email)).toHaveLength(1);
    expect(rows.find((r) => r.email === member.email)?.status).toBe('active');
  });

  it('filters by q (name or email, wildcards literal), role and project', async () => {
    const owner = await ws();
    const alice = await realMember(owner, { name: 'Alice Adams', email: `alice-${tag()}@example.com` });
    const bob = await realMember(owner, { name: 'Bob 100%', email: `bob-${tag()}@example.com` });
    await owner.client.data(owner.client.patch(`/rest/members/${bob.user.id}`, { role: 'admin' }));

    const byName = await list(owner.client, '?q=alice');
    expect(byName.rows.map((r) => r.userId)).toEqual([alice.user.id]);
    const byMail = await list(owner.client, `?q=${encodeURIComponent(bob.email.slice(0, 8))}`);
    expect(byMail.rows.map((r) => r.userId)).toEqual([bob.user.id]);
    // % is a character, not a wildcard
    expect((await list(owner.client, `?q=${encodeURIComponent('100%')}`)).rows.map((r) => r.userId)).toEqual([
      bob.user.id,
    ]);
    expect((await list(owner.client, `?q=${encodeURIComponent('%')}`)).body.count).toBe(1);
    expect((await list(owner.client, '?role=admin')).rows.map((r) => r.userId)).toEqual([bob.user.id]);

    const project = await projectIn(server, owner.tenant.id, `Team ${tag()}`);
    await addToProject(server, owner.tenant.id, project.id, alice.user.id, 'project:editor');
    const inProject = await list(owner.client, `?projectId=${project.id}`);
    expect(inProject.rows.map((r) => r.userId)).toEqual([alice.user.id]);
    expect(inProject.body.count).toBe(1);
    expect((await owner.client.get('/rest/members?projectId=nope')).statusCode).toBe(400);
  });

  it('sorts by the five names, either way; a name outside the list is 400', async () => {
    const owner = await ws();
    const zed = await realMember(owner, { name: 'Zed', email: `a-${tag()}@example.com` });
    const amy = await realMember(owner, { name: 'Amy', email: `z-${tag()}@example.com` });
    await server.ctx.database.db
      .insert(userMfa)
      .values({ userId: zed.user.id, secretEnc: 'x', enabledAt: new Date() });
    await repos().memberships.touchLastActive(owner.tenant.id, amy.user.id, new Date('2026-01-02'));

    const ids = async (sort: string) => (await list(owner.client, `?sort=${sort}`)).rows.map((r) => r.userId);
    const byName = await ids('name:asc');
    expect(byName[0]).toBe(amy.user.id);
    expect(byName[byName.length - 1]).toBe(zed.user.id);
    expect(await ids('name:desc')).toEqual([...byName].reverse());
    const byEmail = await list(owner.client, '?sort=email:asc');
    const emails = byEmail.rows.map((r) => r.email.toLowerCase());
    expect(emails).toEqual([...emails].sort());
    expect((await ids('mfaEnabled:desc'))[0]).toBe(zed.user.id);
    expect((await ids('lastActiveAt:asc'))[0]).toBe(amy.user.id);
    const roleSorted = (await list(owner.client, '?sort=role:asc')).rows.map((r) => r.role);
    expect(roleSorted).toEqual([...roleSorted].sort());

    for (const bad of ['password:asc', 'name:sideways', 'users.id', 'name;drop']) {
      expect((await owner.client.get(`/rest/members?sort=${encodeURIComponent(bad)}`)).statusCode).toBe(400);
    }
  });

  it('pages with take and skip and keeps the total in count', async () => {
    const owner = await ws();
    for (let i = 0; i < 4; i++) await realMember(owner);
    const first = await list(owner.client, '?sort=email:asc&take=2&skip=0');
    const second = await list(owner.client, '?sort=email:asc&take=2&skip=2');
    const last = await list(owner.client, '?sort=email:asc&take=2&skip=4');
    expect(first.body.count).toBe(5);
    expect(first.rows).toHaveLength(2);
    expect(second.rows).toHaveLength(2);
    expect(last.rows).toHaveLength(1);
    const seen = [...first.rows, ...second.rows, ...last.rows].map((r) => r.userId);
    expect(new Set(seen).size).toBe(5);
    expect((await owner.client.get('/rest/members?take=0')).statusCode).toBe(400);
    expect((await owner.client.get('/rest/members?skip=-1')).statusCode).toBe(400);
  });

  it('shows a disabled member with its badge, the SCIM mark, last active and 2FA', async () => {
    const owner = await ws();
    const gone = await realMember(owner);
    const scim = await realMember(owner);
    const at = new Date('2026-03-04T05:06:07.000Z');
    await repos().memberships.touchLastActive(owner.tenant.id, scim.user.id, at);
    await repos().users.setManagedBy(scim.user.id, owner.tenant.id);
    await server.ctx.database.db
      .insert(userMfa)
      .values({ userId: scim.user.id, secretEnc: 'x', enabledAt: new Date() });
    await repos().memberships.disable(owner.tenant.id, gone.user.id);

    const { rows } = await list(owner.client);
    expect(rows.find((r) => r.userId === gone.user.id)?.status).toBe('disabled');
    expect(rows.find((r) => r.userId === scim.user.id)).toMatchObject({
      status: 'active',
      managedByScim: true,
      mfaEnabled: true,
      lastActiveAt: at.toISOString(),
    });
    // a pending 2FA setup (no enabled_at) is not 2FA
    await server.ctx.database.db
      .insert(userMfa)
      .values({ userId: gone.user.id, secretEnc: 'x', enabledAt: null });
    expect((await list(owner.client)).rows.find((r) => r.userId === gone.user.id)?.mfaEnabled).toBe(false);
  });

  it('a SCIM mark from another workspace is not a mark here', async () => {
    const owner = await ws();
    const other = await ws();
    const member = await realMember(owner);
    await repos().users.setManagedBy(member.user.id, other.tenant.id);
    expect((await list(owner.client)).rows.find((r) => r.userId === member.user.id)?.managedByScim).toBe(
      false,
    );
  });

  it('finds users by status and counts each status for a caller with user:create', async () => {
    const owner = await ws();
    const off = await realMember(owner);
    await realMember(owner);
    await owner.client.data(
      owner.client.post('/rest/members/invite', { email: `p-${tag()}@example.com`, role: 'member' }),
    );
    await repos().memberships.disable(owner.tenant.id, off.user.id);

    const disabled = await list(owner.client, '?status=disabled');
    expect(disabled.rows.map((r) => r.userId)).toEqual([off.user.id]);
    expect(disabled.body.count).toBe(1);
    // the counts ignore the status filter but not the others
    expect(disabled.body.statusCounts).toEqual({ active: 2, pending: 1, disabled: 1 });
    expect((await list(owner.client, '?status=pending')).rows.map((r) => r.status)).toEqual(['pending']);
    const withRole = await list(owner.client, '?role=member');
    expect(withRole.body.statusCounts).toEqual({ active: 1, pending: 1, disabled: 1 });
    expect((await owner.client.get('/rest/members?status=gone')).statusCode).toBe(400);
  });

  it('a member without user:create cannot filter by status and gets no counts', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const plain = await list(member.client);
    expect(plain.body.statusCounts).toBeUndefined();
    expect(plain.rows.length).toBeGreaterThan(0);
    const res = await member.client.get('/rest/members?status=disabled');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(MISSING_SCOPE);
  });

  it('a custom role holding user:create gets the counts', async () => {
    const owner = await ws();
    await repos().roles.create(owner.tenant.id, {
      slug: 'global:people',
      displayName: 'People',
      roleType: 'global',
      scopes: ['user:list', 'user:create'],
    });
    const hr = await realMember(owner);
    await owner.client.data(owner.client.patch(`/rest/members/${hr.user.id}`, { role: 'global:people' }));
    const { body } = await list(hr.client, '?status=active');
    expect(body.statusCounts).toEqual({ active: 2, pending: 0, disabled: 0 });
  });

  it('shows no member or invitation of another workspace', async () => {
    const owner = await ws();
    const other = await ws();
    const stranger = await realMember(other);
    const email = `elsewhere-${tag()}@example.com`;
    await other.client.data(other.client.post('/rest/members/invite', { email, role: 'member' }));
    const { rows, body } = await list(owner.client);
    expect(body.count).toBe(1);
    expect(rows.map((r) => r.email)).not.toContain(email);
    expect(rows.map((r) => r.userId)).not.toContain(stranger.user.id);
    expect((await list(owner.client, `?q=${encodeURIComponent(email)}`)).rows).toEqual([]);
  });

  it('is refused without a session', async () => {
    const anon = await server.app.inject({ url: '/rest/members' });
    expect(anon.statusCode).toBe(401);
  });
});
