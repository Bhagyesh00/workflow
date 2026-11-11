/**
 * P6-51 (L6): the destination project's type policies on every way work moves between projects: the three
 * move routes and their previews, delete of a project with a transfer, removing a member with a transfer
 * (REST and public `DELETE /users/:id?transferId=`), and the personal-work transfer SCIM deprovision and the
 * LDAP reset call. A refusal is 403 `policy_violation` before the first write: nothing moves, no membership
 * goes. The text of a project denial holds no project name.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { transferPersonalWork } from '../src/services/member-removal';
import {
  addToProject,
  createTestServer,
  credentialIn,
  folderIn,
  node,
  policyDeny,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;
let signups = 0;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const repos = () => server.ctx.repos;
const suffix = () => randomUUID().slice(0, 6);

async function setup() {
  signups++;
  const owner = await signup(server.app, { remoteAddress: `10.77.${signups >> 8}.${signups & 255}` });
  const tenantId = owner.tenant.id;
  const home = await projectIn(server, tenantId, `Home ${suffix()}`);
  const away = await projectIn(server, tenantId, `Away ${suffix()}`);
  return { owner, tenantId, home, away };
}
type World = Awaited<ReturnType<typeof setup>>;

const BLOCKED = 'test.useCredential';

/** a workflow that uses the blocked node type and the credential type `testApi` */
const blockedNodes = () => [
  node('Use', BLOCKED, {}, [0, 0], { credentials: { testApi: { id: 'x', name: 'x' } } }),
];
const plainNodes = () => [node('Hook', 'core.manualTrigger')];

async function expectViolation(res: { statusCode: number; json(): any }, type: string, scope: string) {
  expect(res.statusCode).toBe(403);
  const { error } = res.json();
  expect(error.code).toBe('policy_violation');
  expect(error.details.violations).toEqual(
    expect.arrayContaining([expect.objectContaining({ type, scope })]),
  );
  return error as { message: string };
}

describe('workflow, credential and folder moves', () => {
  it('a blocked node type in the destination project refuses the workflow move and changes nothing', async () => {
    const { owner, tenantId, home, away } = await setup();
    await policyDeny(server, tenantId, 'node', BLOCKED, away.id);
    const wf = await workflowIn(server, tenantId, home.id, { nodes: blockedNodes() });
    await repos().shares.set(tenantId, 'workflow', wf.id, []);
    const res = await owner.client.put(`/rest/workflows/${wf.id}/transfer`, {
      destinationProjectId: away.id,
    });
    const error = await expectViolation(res, BLOCKED, 'project');
    expect(error.message).not.toContain(away.name);
    expect((await repos().workflows.get(tenantId, wf.id))?.projectId).toBe(home.id);
    expect(
      (await repos().audit.list(tenantId, 50)).filter((row) => row.action === 'workflow.transferred'),
    ).toHaveLength(0);
    // the same move to a project with no policy goes through
    const free = await projectIn(server, tenantId, `Free ${suffix()}`);
    expect(
      (await owner.client.put(`/rest/workflows/${wf.id}/transfer`, { destinationProjectId: free.id }))
        .statusCode,
    ).toBe(200);
  });

  it('a workspace denial refuses the move into any project', async () => {
    const { owner, tenantId, home, away } = await setup();
    await policyDeny(server, tenantId, 'node', BLOCKED);
    const wf = await workflowIn(server, tenantId, home.id, { nodes: blockedNodes() });
    const res = await owner.client.put(`/rest/workflows/${wf.id}/transfer`, {
      destinationProjectId: away.id,
    });
    await expectViolation(res, BLOCKED, 'workspace');
    expect((await repos().workflows.get(tenantId, wf.id))?.projectId).toBe(home.id);
  });

  it("a blocked credential type of a node's credentials refuses the workflow move", async () => {
    const { owner, tenantId, home, away } = await setup();
    await policyDeny(server, tenantId, 'credential', 'testApi', away.id);
    const wf = await workflowIn(server, tenantId, home.id, { nodes: blockedNodes() });
    const res = await owner.client.put(`/rest/workflows/${wf.id}/transfer`, {
      destinationProjectId: away.id,
    });
    await expectViolation(res, 'testApi', 'project');
  });

  it('a blocked credential type in the destination refuses the credential move', async () => {
    const { owner, tenantId, home, away } = await setup();
    await policyDeny(server, tenantId, 'credential', 'testApi', away.id);
    const credential = await credentialIn(server, tenantId, home.id);
    const res = await owner.client.put(`/rest/credentials/${credential.id}/transfer`, {
      destinationProjectId: away.id,
    });
    await expectViolation(res, 'testApi', 'project');
    expect((await repos().credentials.get(tenantId, credential.id))?.projectId).toBe(home.id);
  });

  it('a blocked type in any workflow of the tree refuses the folder move, and no workflow moves', async () => {
    const { owner, tenantId, home, away } = await setup();
    await policyDeny(server, tenantId, 'node', BLOCKED, away.id);
    const folder = await folderIn(server, tenantId, home.id);
    const ok = await workflowIn(server, tenantId, home.id, { nodes: plainNodes(), folderId: folder.id });
    const bad = await workflowIn(server, tenantId, home.id, { nodes: blockedNodes(), folderId: folder.id });
    const res = await owner.client.put(`/rest/folders/${folder.id}/transfer`, {
      destinationProjectId: away.id,
    });
    await expectViolation(res, BLOCKED, 'project');
    for (const wf of [ok, bad])
      expect((await repos().workflows.get(tenantId, wf.id))?.projectId).toBe(home.id);
    expect((await repos().folders.get(tenantId, folder.id))?.projectId).toBe(home.id);
  });

  it('a type the policy allows moves as before', async () => {
    const { owner, tenantId, home, away } = await setup();
    await policyDeny(server, tenantId, 'node', 'core.set', away.id);
    const wf = await workflowIn(server, tenantId, home.id, { nodes: plainNodes() });
    expect(
      (await owner.client.put(`/rest/workflows/${wf.id}/transfer`, { destinationProjectId: away.id }))
        .statusCode,
    ).toBe(200);
    expect((await repos().workflows.get(tenantId, wf.id))?.projectId).toBe(away.id);
  });

  it('a delegated type moves only into a project with an explicit allow rule', async () => {
    const { owner, tenantId, home, away } = await setup();
    const third = await projectIn(server, tenantId, `Third ${suffix()}`);
    const store = server.ctx.typePolicies;
    const workspace = await store.getScope(tenantId, 'node', null);
    await store.putScope(tenantId, 'node', null, { defaultAction: 'delegate' }, workspace.version);
    const { policy } = await store.createPolicy(tenantId, 'node', {
      name: `allow ${suffix()}`,
      rules: [{ id: randomUUID(), action: 'allow', selector: { name: BLOCKED } }],
    });
    await store.putScope(
      tenantId,
      'node',
      away.id,
      { defaultAction: 'allow', attachments: [{ policyId: policy.id, priority: 0, isFloor: false }] },
      0,
    );
    const wf = await workflowIn(server, tenantId, home.id, { nodes: blockedNodes().slice(0, 1) });
    const refused = await owner.client.put(`/rest/workflows/${wf.id}/transfer`, {
      destinationProjectId: third.id,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.details.violations[0]).toMatchObject({
      scope: 'workspace',
      optInAvailable: true,
    });
    expect(
      (await owner.client.put(`/rest/workflows/${wf.id}/transfer`, { destinationProjectId: away.id }))
        .statusCode,
    ).toBe(200);
  });
});

describe('transfer previews list the restricted types', () => {
  const preview = (owner: World['owner'], kind: string, id: string, destination: string) =>
    owner.client.data(
      owner.client.get(`/rest/${kind}/${id}/transfer-preview?destinationProjectId=${destination}`),
    );

  it('a workflow preview names each blocked node and credential type', async () => {
    const { owner, tenantId, home, away } = await setup();
    await policyDeny(server, tenantId, 'node', BLOCKED, away.id);
    await policyDeny(server, tenantId, 'credential', 'testApi');
    const wf = await workflowIn(server, tenantId, home.id, { nodes: blockedNodes() });
    const out = await preview(owner, 'workflows', wf.id, away.id);
    expect(out.checkFailed).toBe(false);
    expect(out.restricted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'node-type-unavailable', subject: wf.id, scope: 'project' }),
        expect.objectContaining({ kind: 'credential-type-unavailable', scope: 'workspace' }),
      ]),
    );
    for (const row of out.restricted) expect(row.message).not.toContain(away.name);
    // a preview refuses nothing and writes no audit row
    expect(
      (await repos().audit.list(tenantId, 50)).filter((r) => r.action === 'policy.blocked'),
    ).toHaveLength(0);
  });

  it('a credential preview and a folder preview list them too; an allowed move lists nothing', async () => {
    const { owner, tenantId, home, away } = await setup();
    await policyDeny(server, tenantId, 'credential', 'testApi', away.id);
    await policyDeny(server, tenantId, 'node', BLOCKED, away.id);
    const credential = await credentialIn(server, tenantId, home.id);
    const credentialOut = await preview(owner, 'credentials', credential.id, away.id);
    expect(credentialOut.restricted).toEqual([
      expect.objectContaining({ kind: 'credential-type-unavailable', subjectType: 'credential' }),
    ]);

    const folder = await folderIn(server, tenantId, home.id);
    await workflowIn(server, tenantId, home.id, { nodes: blockedNodes(), folderId: folder.id });
    const folderOut = await preview(owner, 'folders', folder.id, away.id);
    expect(folderOut.restricted.map((row: { kind: string }) => row.kind).sort()).toEqual([
      'credential-type-unavailable',
      'node-type-unavailable',
    ]);

    const free = await projectIn(server, tenantId, `Free ${suffix()}`);
    expect((await preview(owner, 'credentials', credential.id, free.id)).restricted).toEqual([]);
    expect((await preview(owner, 'folders', folder.id, free.id)).restricted).toEqual([]);
  });
});

/** a member with a blocked workflow and a credential in their personal project, and a team project */
async function memberWork(world: World) {
  const member = await realMember(world.owner);
  const personal = (await repos().projects.getPersonal(world.tenantId, member.user.id))!;
  const workflow = await workflowIn(server, world.tenantId, personal.id, { nodes: blockedNodes() });
  const credential = await credentialIn(server, world.tenantId, personal.id);
  return { member, personal, workflow, credential };
}

async function expectNothingMoved(world: World, work: Awaited<ReturnType<typeof memberWork>>) {
  expect((await repos().workflows.get(world.tenantId, work.workflow.id))?.projectId).toBe(work.personal.id);
  expect((await repos().credentials.get(world.tenantId, work.credential.id))?.projectId).toBe(
    work.personal.id,
  );
  expect(await repos().memberships.get(world.tenantId, work.member.user.id)).toBeDefined();
  expect(await repos().projects.get(world.tenantId, work.personal.id)).toBeDefined();
}

describe('a blocked type enters by none of the four other paths', () => {
  it('DELETE /members/:userId with transferToProjectId', async () => {
    const world = await setup();
    await policyDeny(server, world.tenantId, 'node', BLOCKED, world.away.id);
    const work = await memberWork(world);
    const res = await world.owner.client.request('DELETE', `/rest/members/${work.member.user.id}`, {
      transferToProjectId: world.away.id,
    });
    await expectViolation(res, BLOCKED, 'project');
    await expectNothingMoved(world, work);
    // the way in stays: the refusal ended nothing
    expect((await work.member.client.get('/rest/members')).statusCode).not.toBe(401);
  });

  it('DELETE /members/:userId refuses a blocked credential type too', async () => {
    const world = await setup();
    await policyDeny(server, world.tenantId, 'credential', 'testApi', world.away.id);
    const work = await memberWork(world);
    const res = await world.owner.client.request('DELETE', `/rest/members/${work.member.user.id}`, {
      transferToProjectId: world.away.id,
    });
    await expectViolation(res, 'testApi', 'project');
    await expectNothingMoved(world, work);
  });

  it('public DELETE /users/:id?transferId= (a route test)', async () => {
    const world = await setup();
    await policyDeny(server, world.tenantId, 'node', BLOCKED);
    const work = await memberWork(world);
    const made = await world.owner.client.data(
      world.owner.client.post('/rest/api-keys', { name: `k-${suffix()}` }),
    );
    const res = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${work.member.user.id}?transferId=${world.away.id}`,
      headers: { 'x-api-key': made.key as string },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code ?? res.json().error?.code).toBe('policy_violation');
    await expectNothingMoved(world, work);
  });

  it('transferPersonalWork, which SCIM deprovision and the LDAP reset command call', async () => {
    const world = await setup();
    await policyDeny(server, world.tenantId, 'node', BLOCKED, world.away.id);
    const work = await memberWork(world);
    await expect(
      transferPersonalWork(server.ctx, world.tenantId, work.member.user.id, world.away.id),
    ).rejects.toMatchObject({ statusCode: 403, code: 'policy_violation' });
    await expectNothingMoved(world, work);
    // a target with no policy takes the work, and deleting it (null) is not a move
    const free = await projectIn(server, world.tenantId, `Free ${suffix()}`);
    await transferPersonalWork(server.ctx, world.tenantId, work.member.user.id, free.id);
    expect((await repos().workflows.get(world.tenantId, work.workflow.id))?.projectId).toBe(free.id);
  });

  it('SCIM deprovision: the member is disabled, the data stays and the membership stays', async () => {
    const world = await setup();
    await policyDeny(server, world.tenantId, 'node', BLOCKED, world.away.id);
    const work = await memberWork(world);
    const tenant = (await repos().tenants.get(world.tenantId))!;
    await repos().tenants.updateSettings(world.tenantId, {
      ...((tenant.settings ?? {}) as Record<string, unknown>),
      scim: { enabled: true, onDelete: 'delete', dataAction: 'transfer', transferProjectId: world.away.id },
    });
    const fresh = (await repos().tenants.get(world.tenantId))!;
    await expect(server.ctx.scim.deleteUser(fresh, work.member.user.id)).rejects.toMatchObject({
      code: 'policy_violation',
    });
    // access ended (disabled first), the work and the membership stay
    expect((await repos().workflows.get(world.tenantId, work.workflow.id))?.projectId).toBe(work.personal.id);
    expect(await repos().memberships.getIncludingDisabled(world.tenantId, work.member.user.id)).toBeDefined();
    expect(await repos().memberships.get(world.tenantId, work.member.user.id)).toBeUndefined();
  });

  it('DELETE /projects/:id?transferId= judges the whole project and keeps it when refused', async () => {
    const world = await setup();
    await policyDeny(server, world.tenantId, 'node', BLOCKED, world.away.id);
    const wf = await workflowIn(server, world.tenantId, world.home.id, { nodes: blockedNodes() });
    const res = await world.owner.client.delete(
      `/rest/projects/${world.home.id}?transferId=${world.away.id}`,
    );
    await expectViolation(res, BLOCKED, 'project');
    expect((await repos().projects.get(world.tenantId, world.home.id))?.id).toBe(world.home.id);
    expect((await repos().workflows.get(world.tenantId, wf.id))?.projectId).toBe(world.home.id);
    // into a project with no policy it goes
    const free = await projectIn(server, world.tenantId, `Free ${suffix()}`);
    const ok = await world.owner.client.delete(`/rest/projects/${world.home.id}?transferId=${free.id}`);
    expect(ok.statusCode).toBe(200);
    expect((await repos().workflows.get(world.tenantId, wf.id))?.projectId).toBe(free.id);
  });

  it('a member who may fill the target is refused the same way as an owner', async () => {
    const world = await setup();
    await policyDeny(server, world.tenantId, 'node', BLOCKED, world.away.id);
    const wf = await workflowIn(server, world.tenantId, world.home.id, { nodes: blockedNodes() });
    const admin = await realMember(world.owner);
    await addToProject(server, world.tenantId, world.home.id, admin.user.id, 'project:admin');
    await addToProject(server, world.tenantId, world.away.id, admin.user.id, 'project:admin');
    const res = await admin.client.put(`/rest/workflows/${wf.id}/transfer`, {
      destinationProjectId: world.away.id,
    });
    await expectViolation(res, BLOCKED, 'project');
  });
});

describe('what is not judged', () => {
  it('a team project with no work moves nothing, so a policy has nothing to refuse', async () => {
    const world = await setup();
    await policyDeny(server, world.tenantId, 'node', BLOCKED, world.away.id);
    const empty = await projectIn(server, world.tenantId, `Empty ${suffix()}`);
    const res = await world.owner.client.delete(`/rest/projects/${empty.id}?transferId=${world.away.id}`);
    expect(res.statusCode).toBe(200);
  });
});
