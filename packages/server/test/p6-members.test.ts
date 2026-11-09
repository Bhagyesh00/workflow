/**
 * P6-31 (L10): member roles and member removal. A true `member` (`realMember`) holds the global member
 * scopes plus what its project relations give; removing one asks where its personal work goes.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  credentialIn,
  dataTableIn,
  folderIn,
  ORIGIN,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
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
/** a workspace signed up from its own IP (signup is rate limited per IP) */
const ws = () =>
  signup(server.app, { remoteAddress: `10.62.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` });

type Owner = Awaited<ReturnType<typeof ws>>;

const removeWith = (owner: Owner, userId: string, body: unknown, query = '') =>
  owner.client.request('DELETE', `/rest/members/${userId}${query}`, body);

/** a member with a workflow, a credential, a folder and a data table in its personal project */
async function memberWithWork(owner: Owner) {
  const member = await realMember(owner);
  const personal = (await repos().projects.getPersonal(owner.tenant.id, member.user.id))!;
  const workflow = await workflowIn(server, owner.tenant.id, personal.id, { name: 'Personal flow' });
  const credential = await credentialIn(server, owner.tenant.id, personal.id);
  const folder = await folderIn(server, owner.tenant.id, personal.id);
  const table = await dataTableIn(server, owner.tenant.id, personal.id, 'mine');
  return { member, personal, workflow, credential, folder, table };
}

describe('member roles', () => {
  it('an invitation takes the system roles and a custom global slug; the old words are refused (P6-39)', async () => {
    const owner = await ws();
    await repos().roles.create(owner.tenant.id, {
      slug: 'global:auditor',
      displayName: 'Auditor',
      roleType: 'global',
      scopes: ['workflow:read'],
    });
    for (const role of ['admin', 'member', 'global:auditor']) {
      const res = await owner.client.post('/rest/members/invite', {
        email: `${randomUUID().slice(0, 8)}@example.com`,
        role,
      });
      expect(res.statusCode, role).toBe(200);
      expect(res.json().data.role).toBe(role);
    }
    for (const role of ['editor', 'viewer']) {
      const res = await owner.client.post('/rest/members/invite', {
        email: `${randomUUID().slice(0, 8)}@example.com`,
        role,
      });
      expect(res.statusCode, role).toBe(400);
    }
  });

  it('an unknown slug, a project role and a project-type custom role are refused with 400', async () => {
    const owner = await ws();
    await repos().roles.create(owner.tenant.id, {
      slug: 'project:lead',
      displayName: 'Lead',
      roleType: 'project',
      scopes: ['workflow:read'],
    });
    for (const role of ['nobody', 'project:admin', 'project:lead', 'workflow:owner']) {
      const res = await owner.client.post('/rest/members/invite', {
        email: `${randomUUID().slice(0, 8)}@example.com`,
        role,
      });
      expect(res.statusCode, role).toBe(400);
    }
    expect((await repos().invitations.listPending(owner.tenant.id)).length).toBe(0);
  });

  it("a role is another workspace's custom slug: refused", async () => {
    const owner = await ws();
    const other = await ws();
    await repos().roles.create(other.tenant.id, {
      slug: 'global:secret',
      displayName: 'Secret',
      roleType: 'global',
      scopes: ['workflow:read'],
    });
    const res = await owner.client.post('/rest/members/invite', {
      email: 'x@example.com',
      role: 'global:secret',
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH takes a custom global slug, refuses an unknown one, and only an owner grants owner', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    await repos().roles.create(owner.tenant.id, {
      slug: 'global:auditor',
      displayName: 'Auditor',
      roleType: 'global',
      scopes: ['workflow:read'],
    });
    const url = `/rest/members/${member.user.id}`;
    expect((await owner.client.patch(url, { role: 'global:auditor' })).statusCode).toBe(200);
    expect((await repos().memberships.get(owner.tenant.id, member.user.id))?.role).toBe('global:auditor');
    expect((await owner.client.patch(url, { role: 'ghost' })).statusCode).toBe(400);

    const admin = await realMember(owner);
    await owner.client.patch(`/rest/members/${admin.user.id}`, { role: 'admin' });
    const denied = await admin.client.patch(url, { role: 'owner' });
    expect(denied.statusCode).toBe(403);
    expect((await owner.client.patch(url, { role: 'owner' })).statusCode).toBe(200);
  });

  it('a true member lists members but cannot invite, change roles or remove', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const other = await realMember(owner);
    expect((await member.client.get('/rest/members')).statusCode).toBe(200);
    const invite = await member.client.post('/rest/members/invite', {
      email: 'a@example.com',
      role: 'member',
    });
    expect(invite.statusCode).toBe(403);
    expect(invite.json().error.message).toBe(MISSING_SCOPE);
    expect((await member.client.patch(`/rest/members/${other.user.id}`, { role: 'admin' })).statusCode).toBe(
      403,
    );
    expect(
      (await removeWith(member as unknown as Owner, other.user.id, { deleteData: true })).statusCode,
    ).toBe(403);
    expect((await member.client.get('/rest/audit-log')).statusCode).toBe(403);
    expect((await member.client.get('/rest/invitations')).statusCode).toBe(403);
  });
});

describe('removing a member', () => {
  it('with no choice it is 400 and nothing changes', async () => {
    const owner = await ws();
    const { member, personal, workflow } = await memberWithWork(owner);
    for (const body of [{}, undefined, { deleteData: false }, { transferToProjectId: 'not-a-uuid' }]) {
      expect((await removeWith(owner, member.user.id, body)).statusCode).toBe(400);
    }
    expect(
      (await removeWith(owner, member.user.id, { deleteData: true, transferToProjectId: personal.id }))
        .statusCode,
    ).toBe(400);
    expect(await repos().memberships.get(owner.tenant.id, member.user.id)).toBeDefined();
    expect(await repos().workflows.get(owner.tenant.id, workflow.id)).toBeDefined();
  });

  it('moves the personal work to the chosen project, then removes the member', async () => {
    const owner = await ws();
    const { member, personal, workflow, credential, folder, table } = await memberWithWork(owner);
    const team = await projectIn(server, owner.tenant.id, 'Receiving team');

    const res = await removeWith(owner, member.user.id, { transferToProjectId: team.id });
    expect(res.statusCode).toBe(200);

    expect(await repos().memberships.get(owner.tenant.id, member.user.id)).toBeUndefined();
    expect(await repos().projects.get(owner.tenant.id, personal.id)).toBeUndefined();
    expect((await repos().workflows.get(owner.tenant.id, workflow.id))?.projectId).toBe(team.id);
    expect((await repos().credentials.get(owner.tenant.id, credential.id))?.projectId).toBe(team.id);
    expect((await repos().folders.get(owner.tenant.id, folder.id))?.projectId).toBe(team.id);
    expect((await repos().dataTables.get(owner.tenant.id, table.id))?.projectId).toBe(team.id);
    // the user row stays, the session of the workspace goes
    expect(await repos().users.get(member.user.id)).toBeDefined();
    expect((await member.client.get('/rest/members')).statusCode).toBe(401);
    const audit = (await repos().audit.list(owner.tenant.id, 20)).find((r) => r.action === 'member.removed');
    expect(audit?.resourceId).toBe(member.user.id);
    expect(audit?.metadata).toMatchObject({ transferToProjectId: team.id });
  });

  it("also reads n8n's ?transferId= query", async () => {
    const owner = await ws();
    const { member, workflow } = await memberWithWork(owner);
    const team = await projectIn(server, owner.tenant.id, 'Receiving team');
    const res = await owner.client.request('DELETE', `/rest/members/${member.user.id}?transferId=${team.id}`);
    expect(res.statusCode).toBe(200);
    expect((await repos().workflows.get(owner.tenant.id, workflow.id))?.projectId).toBe(team.id);
  });

  it('deleteData deletes the personal work and removes the member', async () => {
    const owner = await ws();
    const { member, workflow, credential, folder, table } = await memberWithWork(owner);
    const res = await removeWith(owner, member.user.id, { deleteData: true });
    expect(res.statusCode).toBe(200);
    expect(await repos().memberships.get(owner.tenant.id, member.user.id)).toBeUndefined();
    expect(await repos().workflows.get(owner.tenant.id, workflow.id)).toBeUndefined();
    expect(await repos().credentials.get(owner.tenant.id, credential.id)).toBeUndefined();
    expect(await repos().folders.get(owner.tenant.id, folder.id)).toBeUndefined();
    expect(await repos().dataTables.get(owner.tenant.id, table.id)).toBeUndefined();
  });

  it('leaves other workspaces and other members alone', async () => {
    const owner = await ws();
    const other = await ws();
    const mine = await memberWithWork(owner);
    const bystander = await memberWithWork(owner);
    const foreign = await memberWithWork(other);
    const team = await projectIn(server, owner.tenant.id, 'Receiving team');

    expect((await removeWith(owner, mine.member.user.id, { transferToProjectId: team.id })).statusCode).toBe(
      200,
    );

    expect((await repos().workflows.get(owner.tenant.id, bystander.workflow.id))?.projectId).toBe(
      bystander.personal.id,
    );
    expect(await repos().memberships.get(owner.tenant.id, bystander.member.user.id)).toBeDefined();
    expect((await repos().workflows.get(other.tenant.id, foreign.workflow.id))?.projectId).toBe(
      foreign.personal.id,
    );
    expect(await repos().memberships.get(other.tenant.id, foreign.member.user.id)).toBeDefined();

    // a member of another workspace, or a project of another workspace, is 404
    expect((await removeWith(owner, foreign.member.user.id, { deleteData: true })).statusCode).toBe(404);
    const foreignTeam = await projectIn(server, other.tenant.id, 'Theirs');
    expect(
      (await removeWith(owner, bystander.member.user.id, { transferToProjectId: foreignTeam.id })).statusCode,
    ).toBe(404);
    expect(await repos().memberships.get(owner.tenant.id, bystander.member.user.id)).toBeDefined();
  });

  it("keeps the user's other workspace when removed from one", async () => {
    const owner = await ws();
    const other = await ws();
    const member = await realMember(owner);
    // the same person joins the second workspace too
    const invite = await other.client.data<{ token: string }>(
      other.client.post('/rest/members/invite', { email: member.email, role: 'member' }),
    );
    const accept = await server.app.inject({
      method: 'POST',
      url: `/rest/invitations/${invite.token}/accept`,
      remoteAddress: '10.62.250.1',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Same', password: 'Passw0rd!' }),
    });
    expect(accept.statusCode).toBe(200);
    const otherPersonal = (await repos().projects.getPersonal(other.tenant.id, member.user.id))!;
    const keep = await workflowIn(server, other.tenant.id, otherPersonal.id);

    expect((await removeWith(owner, member.user.id, { deleteData: true })).statusCode).toBe(200);
    expect(await repos().memberships.get(other.tenant.id, member.user.id)).toBeDefined();
    expect((await repos().workflows.get(other.tenant.id, keep.id))?.projectId).toBe(otherPersonal.id);
  });

  it('refuses a move into a project that holds a data table of the same name, 409', async () => {
    const owner = await ws();
    const { member, workflow } = await memberWithWork(owner);
    const team = await projectIn(server, owner.tenant.id, 'Has mine');
    await dataTableIn(server, owner.tenant.id, team.id, 'mine');
    const res = await removeWith(owner, member.user.id, { transferToProjectId: team.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('mine');
    expect(await repos().memberships.get(owner.tenant.id, member.user.id)).toBeDefined();
    expect((await repos().workflows.get(owner.tenant.id, workflow.id))?.projectId).not.toBe(team.id);
  });

  it('a move needs the create scopes on the target project', async () => {
    const owner = await ws();
    const { member, workflow } = await memberWithWork(owner);
    // a custom global role with the right to delete users but no scope on projects
    await repos().roles.create(owner.tenant.id, {
      slug: 'global:hr',
      displayName: 'HR',
      roleType: 'global',
      scopes: ['user:delete', 'user:list'],
    });
    const hr = await realMember(owner);
    await owner.client.patch(`/rest/members/${hr.user.id}`, { role: 'global:hr' });
    const team = await projectIn(server, owner.tenant.id, 'Locked team');
    await addToProject(server, owner.tenant.id, team.id, hr.user.id, 'project:viewer');

    const denied = await removeWith(hr as unknown as Owner, member.user.id, { transferToProjectId: team.id });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING_SCOPE);
    expect(await repos().memberships.get(owner.tenant.id, member.user.id)).toBeDefined();
    expect((await repos().workflows.get(owner.tenant.id, workflow.id))?.projectId).not.toBe(team.id);
  });

  it('the last owner stays, and only an owner removes an owner', async () => {
    const owner = await ws();
    const admin = await realMember(owner);
    await owner.client.patch(`/rest/members/${admin.user.id}`, { role: 'admin' });
    const denied = await removeWith(admin as unknown as Owner, owner.user.id, { deleteData: true });
    expect(denied.statusCode).toBe(403);

    const second = await realMember(owner);
    await owner.client.patch(`/rest/members/${second.user.id}`, { role: 'owner' });
    expect((await removeWith(owner, second.user.id, { deleteData: true })).statusCode).toBe(200);
    // the owner is the only one left
    const last = await removeWith(owner, owner.user.id, { deleteData: true });
    expect(last.statusCode).toBe(409);
    expect(await repos().memberships.get(owner.tenant.id, owner.user.id)).toBeDefined();
  });

  it("the removed member's API keys stop working", async () => {
    const owner = await ws();
    const member = await realMember(owner);
    await member.client.data(member.client.post('/rest/api-keys', { name: 'mine' }));
    expect((await repos().apiKeys.list(owner.tenant.id, member.user.id)).length).toBe(1);
    expect((await removeWith(owner, member.user.id, { deleteData: true })).statusCode).toBe(200);
    expect((await repos().apiKeys.list(owner.tenant.id, member.user.id)).length).toBe(0);
  });
});

describe('transferPersonalWork', () => {
  it('moves the work and leaves the membership, or deletes it with null', async () => {
    const owner = await ws();
    const a = await memberWithWork(owner);
    const b = await memberWithWork(owner);
    const team = await projectIn(server, owner.tenant.id, 'Receiving team');
    const { transferPersonalWork } = await import('../src/services/member-removal');

    await transferPersonalWork(server.ctx, owner.tenant.id, a.member.user.id, team.id);
    expect((await repos().workflows.get(owner.tenant.id, a.workflow.id))?.projectId).toBe(team.id);
    expect(await repos().memberships.get(owner.tenant.id, a.member.user.id)).toBeDefined();
    expect(await repos().projects.getPersonal(owner.tenant.id, a.member.user.id)).toBeDefined();

    await transferPersonalWork(server.ctx, owner.tenant.id, b.member.user.id, null);
    expect(await repos().workflows.get(owner.tenant.id, b.workflow.id)).toBeUndefined();
    expect(await repos().credentials.get(owner.tenant.id, b.credential.id)).toBeUndefined();
    expect(await repos().memberships.get(owner.tenant.id, b.member.user.id)).toBeDefined();
  });
});
