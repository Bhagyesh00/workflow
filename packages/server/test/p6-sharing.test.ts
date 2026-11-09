/**
 * P6-29 sharing (L9): PUT /workflows/:id/share and /credentials/:id/share take the full list of sharee
 * project ids. New shares get `workflow:editor` and `credential:user`; a sharee project runs the workflow
 * and cannot delete it; adding needs `:share`, removing `:unshare`; a personal owner lacks `:share`
 * (sharing off) and gets the standard 403; another workspace's ids and projects are 404.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import {
  addToProject,
  createTestServer,
  credentialIn,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;

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
const suffix = () => randomUUID().slice(0, 8);

/** an owner, its workspace, three team projects (`home` owns the rows, `away` and `third` are sharees) */
async function setup() {
  const owner = await signup(server.app);
  const tenantId = owner.tenant.id;
  const home = await projectIn(server, tenantId, `Home ${suffix()}`);
  const away = await projectIn(server, tenantId, `Away ${suffix()}`);
  const third = await projectIn(server, tenantId, `Third ${suffix()}`);
  return { owner, tenantId, home, away, third };
}

const flow = (tenantId: string, projectId: string) =>
  workflowIn(server, tenantId, projectId, {
    nodes: [node('Start', 'core.manualTrigger', {}, [0, 0])],
    connections: {},
  });

/** the workspace policy "sharing in personal spaces" (on by default; off takes `:share` from a personal owner) */
async function setPersonalSharing(tenantId: string, on: boolean) {
  const tenant = await repos().tenants.get(tenantId);
  const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
  const policy = (settings.securityPolicy ?? {}) as Record<string, unknown>;
  await repos().tenants.updateSettings(tenantId, {
    ...settings,
    securityPolicy: { ...policy, personalSpaceSharing: on },
  });
}

const sharedWorkflowIds = async (tenantId: string, workflowId: string) =>
  (await repos().shares.listForWorkflow(tenantId, workflowId)).map((s) => s.projectId).sort();

describe('PUT /workflows/:id/share', () => {
  it('adds shares with workflow:editor; the sharee project runs the workflow and cannot delete it', async () => {
    const { owner, tenantId, home, away } = await setup();
    const workflow = await flow(tenantId, home.id);
    const sharee = await realMember(owner);
    await addToProject(server, tenantId, away.id, sharee.user.id, 'project:editor');

    // before the share the sharee project's member does not reach the workflow
    expect((await sharee.client.post(`/rest/workflows/${workflow.id}/run`, {})).statusCode).toBe(403);

    const res = await owner.client.put(`/rest/workflows/${workflow.id}/share`, { shareWithIds: [away.id] });
    expect(res.statusCode).toBe(200);
    const rows = await repos().shares.listForWorkflow(tenantId, workflow.id);
    expect(rows.map((r) => [r.projectId, r.role])).toEqual([[away.id, 'workflow:editor']]);

    const run = await sharee.client.post(`/rest/workflows/${workflow.id}/run`, {});
    expect(run.statusCode).toBe(200);
    const del = await sharee.client.delete(`/rest/workflows/${workflow.id}`);
    expect(del.statusCode).toBe(403);
    expect(del.body).toContain(MISSING_SCOPE_MESSAGE);
    expect(await repos().workflows.get(tenantId, workflow.id)).toBeTruthy();
    // the sharee cannot change the share list either
    const again = await sharee.client.put(`/rest/workflows/${workflow.id}/share`, { shareWithIds: [] });
    expect(again.statusCode).toBe(403);
  });

  it('takes the full list: adds the missing, removes the others, keeps the rest', async () => {
    const { owner, tenantId, home, away, third } = await setup();
    const workflow = await flow(tenantId, home.id);
    const put = (ids: string[]) =>
      owner.client.put(`/rest/workflows/${workflow.id}/share`, { shareWithIds: ids });

    expect((await put([away.id, third.id])).statusCode).toBe(200);
    expect(await sharedWorkflowIds(tenantId, workflow.id)).toEqual([away.id, third.id].sort());
    expect((await put([third.id])).statusCode).toBe(200);
    expect(await sharedWorkflowIds(tenantId, workflow.id)).toEqual([third.id]);
    // the owning project in the list is not a share; a repeated id is one share
    expect((await put([home.id, third.id, third.id])).statusCode).toBe(200);
    expect(await sharedWorkflowIds(tenantId, workflow.id)).toEqual([third.id]);
    expect((await put([])).statusCode).toBe(200);
    expect(await sharedWorkflowIds(tenantId, workflow.id)).toEqual([]);
  });

  it('removal ends the sharee access on the next call', async () => {
    const { owner, tenantId, home, away } = await setup();
    const workflow = await flow(tenantId, home.id);
    const sharee = await realMember(owner);
    await addToProject(server, tenantId, away.id, sharee.user.id, 'project:editor');
    await repos().shares.set(tenantId, 'workflow', workflow.id, [away.id]);
    expect((await sharee.client.post(`/rest/workflows/${workflow.id}/run`, {})).statusCode).toBe(200);
    await owner.client.put(`/rest/workflows/${workflow.id}/share`, { shareWithIds: [] });
    expect((await sharee.client.post(`/rest/workflows/${workflow.id}/run`, {})).statusCode).toBe(403);
  });

  it('adding needs workflow:share, removing needs workflow:unshare, each checked on its own', async () => {
    const { owner, tenantId, away, third } = await setup();
    // a personal owner holds :unshare but not :share (sharing in personal spaces is off)
    const personal = await realMember(owner);
    const space = await repos().projects.ensurePersonal(tenantId, personal.user);
    const workflow = await flow(tenantId, space.id);
    await setPersonalSharing(tenantId, false);
    const put = (ids: string[]) =>
      personal.client.put(`/rest/workflows/${workflow.id}/share`, { shareWithIds: ids });

    const add = await put([away.id]);
    expect(add.statusCode).toBe(403);
    expect(add.body).toContain(MISSING_SCOPE_MESSAGE);
    expect(await sharedWorkflowIds(tenantId, workflow.id)).toEqual([]);

    await repos().shares.set(tenantId, 'workflow', workflow.id, [away.id, third.id]);
    // keeping one and removing one is allowed, a list that also adds is not
    expect((await put([away.id, third.id])).statusCode).toBe(200);
    expect((await put([away.id])).statusCode).toBe(200);
    expect(await sharedWorkflowIds(tenantId, workflow.id)).toEqual([away.id]);
    expect((await put([away.id, third.id])).statusCode).toBe(403);
    expect(await sharedWorkflowIds(tenantId, workflow.id)).toEqual([away.id]);
    expect((await put([])).statusCode).toBe(200);
    expect(await sharedWorkflowIds(tenantId, workflow.id)).toEqual([]);
  });

  it('refuses a project viewer, a member outside the project, unknown and other workspace ids', async () => {
    const { owner, tenantId, home, away } = await setup();
    const workflow = await flow(tenantId, home.id);
    const viewer = await realMember(owner);
    await addToProject(server, tenantId, home.id, viewer.user.id, 'project:viewer');
    const outsider = await realMember(owner);
    const body = { shareWithIds: [away.id] };
    expect((await viewer.client.put(`/rest/workflows/${workflow.id}/share`, body)).statusCode).toBe(403);
    expect((await outsider.client.put(`/rest/workflows/${workflow.id}/share`, body)).statusCode).toBe(403);
    expect(await sharedWorkflowIds(tenantId, workflow.id)).toEqual([]);

    const missing = await owner.client.put(`/rest/workflows/${randomUUID()}/share`, body);
    expect(missing.statusCode).toBe(404);
    const unknownProject = await owner.client.put(`/rest/workflows/${workflow.id}/share`, {
      shareWithIds: [randomUUID()],
    });
    expect(unknownProject.statusCode).toBe(404);

    const other = await signup(server.app);
    const foreign = await projectIn(server, other.tenant.id, `Foreign ${suffix()}`);
    const crossTenant = await owner.client.put(`/rest/workflows/${workflow.id}/share`, {
      shareWithIds: [foreign.id],
    });
    expect(crossTenant.statusCode).toBe(404);
    const foreignWorkflow = await flow(other.tenant.id, foreign.id);
    const foreignRow = await owner.client.put(`/rest/workflows/${foreignWorkflow.id}/share`, body);
    expect(foreignRow.statusCode).toBe(404);
    expect(await sharedWorkflowIds(tenantId, workflow.id)).toEqual([]);
    const malformed = await owner.client.put(`/rest/workflows/${workflow.id}/share`, { shareWithIds: ['x'] });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('PUT /credentials/:id/share', () => {
  it('adds shares with credential:user; the sharee project reads it and cannot delete it', async () => {
    const { owner, tenantId, home, away } = await setup();
    const credential = await credentialIn(server, tenantId, home.id);
    const sharee = await realMember(owner);
    await addToProject(server, tenantId, away.id, sharee.user.id, 'project:editor');
    expect((await sharee.client.get(`/rest/credentials/${credential.id}`)).statusCode).toBe(403);

    const res = await owner.client.put(`/rest/credentials/${credential.id}/share`, {
      shareWithIds: [away.id],
    });
    expect(res.statusCode).toBe(200);
    const rows = await repos().shares.listForCredential(tenantId, credential.id);
    expect(rows.map((r) => [r.projectId, r.role])).toEqual([[away.id, 'credential:user']]);

    expect((await sharee.client.get(`/rest/credentials/${credential.id}`)).statusCode).toBe(200);
    expect((await sharee.client.delete(`/rest/credentials/${credential.id}`)).statusCode).toBe(403);
    const reshare = await sharee.client.put(`/rest/credentials/${credential.id}/share`, { shareWithIds: [] });
    expect(reshare.statusCode).toBe(403);

    const removed = await owner.client.put(`/rest/credentials/${credential.id}/share`, { shareWithIds: [] });
    expect(removed.statusCode).toBe(200);
    expect(await repos().shares.listForCredential(tenantId, credential.id)).toEqual([]);
    expect((await sharee.client.get(`/rest/credentials/${credential.id}`)).statusCode).toBe(403);
  });

  it('sharing off: a personal owner gets the standard 403 on add, and may remove', async () => {
    const { owner, tenantId, away } = await setup();
    const personal = await realMember(owner);
    const space = await repos().projects.ensurePersonal(tenantId, personal.user);
    const credential = await credentialIn(server, tenantId, space.id);
    await setPersonalSharing(tenantId, false);
    const put = (ids: string[]) =>
      personal.client.put(`/rest/credentials/${credential.id}/share`, { shareWithIds: ids });

    const add = await put([away.id]);
    expect(add.statusCode).toBe(403);
    expect(add.body).toContain(MISSING_SCOPE_MESSAGE);
    expect(await repos().shares.listForCredential(tenantId, credential.id)).toEqual([]);

    await repos().shares.set(tenantId, 'credential', credential.id, [away.id]);
    expect((await put([])).statusCode).toBe(200);
    expect(await repos().shares.listForCredential(tenantId, credential.id)).toEqual([]);

    // the policy back on gives the personal owner :share again
    await setPersonalSharing(tenantId, true);
    expect((await put([away.id])).statusCode).toBe(200);
    expect((await repos().shares.listForCredential(tenantId, credential.id)).map((s) => s.projectId)).toEqual([
      away.id,
    ]);
  });

  it('refuses unknown, other workspace and malformed ids', async () => {
    const { owner, tenantId, home } = await setup();
    const credential = await credentialIn(server, tenantId, home.id);
    const url = `/rest/credentials/${credential.id}/share`;
    const missing = await owner.client.put(`/rest/credentials/${randomUUID()}/share`, { shareWithIds: [] });
    expect(missing.statusCode).toBe(404);
    expect((await owner.client.put(url, { shareWithIds: [randomUUID()] })).statusCode).toBe(404);
    const other = await signup(server.app);
    const foreign = await projectIn(server, other.tenant.id, `Foreign ${suffix()}`);
    expect((await owner.client.put(url, { shareWithIds: [foreign.id] })).statusCode).toBe(404);
    expect((await owner.client.put(url, { shareWithIds: 'nope' })).statusCode).toBe(400);
    expect(await repos().shares.listForCredential(tenantId, credential.id)).toEqual([]);
  });
});
