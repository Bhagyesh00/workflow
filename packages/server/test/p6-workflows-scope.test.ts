/**
 * P6-22 (L2): the workflow routes check scopes, not roles. A true `member` (invited as `member`, given a
 * project role through `addToProject`) holds what its project gives it: `scopes` on GET one and on lists,
 * 403 on another project's workflow, the sharee mask, the list filter, another workspace's id as 404, and a
 * run with a body `workflowData` still needing `workflow:execute`.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  chain,
  createTestServer,
  folderIn,
  node,
  projectIn,
  realMember,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';

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

const basic = (name = 'Basic') => ({
  name,
  nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'greeting', 'hi')],
  connections: chain('Start', 'Set'),
});

/** an owner, a member and two team projects; the member is `role` in `alpha` and nothing in `beta` */
async function setup(role = 'project:editor') {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const beta = await projectIn(server, owner.tenant.id, 'Beta');
  await addToProject(server, owner.tenant.id, alpha.id, member.user.id, role);
  const inAlpha = await workflowIn(server, owner.tenant.id, alpha.id, { name: 'In alpha' });
  const inBeta = await workflowIn(server, owner.tenant.id, beta.id, { name: 'In beta' });
  return { owner, member, alpha, beta, inAlpha, inBeta };
}

describe('GET /workflows/:id', () => {
  it('returns the caller scopes, the owner project and the sharees', async () => {
    const { member, alpha, inAlpha } = await setup();
    const res = await member.client.get(`/rest/workflows/${inAlpha.id}`);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.scopes).toContain('workflow:update');
    expect(data.scopes).toContain('workflow:read');
    expect(data.projectId).toBe(alpha.id);
    expect(data.homeProject).toMatchObject({ id: alpha.id, name: 'Alpha', type: 'team' });
    expect(data.sharedWithProjects).toEqual([]);
  });

  it('a project viewer reads but holds no update scope', async () => {
    const { member, inAlpha } = await setup('project:viewer');
    const data = await member.client.data(member.client.get(`/rest/workflows/${inAlpha.id}`));
    expect(data.scopes).toContain('workflow:read');
    expect(data.scopes).not.toContain('workflow:update');
    const patch = await member.client.patch(`/rest/workflows/${inAlpha.id}`, { name: 'x' });
    expect(patch.statusCode).toBe(403);
  });

  it('answers 403 with n8n text on another project workflow, for every verb', async () => {
    const { member, inBeta } = await setup();
    const get = await member.client.get(`/rest/workflows/${inBeta.id}`);
    expect(get.statusCode).toBe(403);
    expect(get.json().error.message).toBe(FORBIDDEN);
    for (const [method, url] of [
      ['patch', `/rest/workflows/${inBeta.id}`],
      ['delete', `/rest/workflows/${inBeta.id}`],
      ['post', `/rest/workflows/${inBeta.id}/run`],
      ['post', `/rest/workflows/${inBeta.id}/activate`],
      ['post', `/rest/workflows/${inBeta.id}/archive`],
      ['get', `/rest/workflows/${inBeta.id}/versions`],
      ['get', `/rest/workflows/${inBeta.id}/webhook-urls`],
    ] as const) {
      const res = await member.client[method](url);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('answers 404 for a workflow of another workspace', async () => {
    const { member } = await setup();
    const other = await signup(server.app);
    const project = (await server.ctx.repos.projects.oldestTeam(other.tenant.id))!.id;
    const foreign = await workflowIn(server, other.tenant.id, project);
    const res = await member.client.get(`/rest/workflows/${foreign.id}`);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /workflows', () => {
  it('lists only what the member projects hold, with home project and optional scopes', async () => {
    const { member, alpha, inAlpha, inBeta } = await setup();
    const list = await member.client.get('/rest/workflows');
    expect(list.statusCode).toBe(200);
    const ids = list.json().data.map((w: { id: string }) => w.id);
    expect(ids).toEqual([inAlpha.id]);
    expect(ids).not.toContain(inBeta.id);
    const row = list.json().data[0];
    expect(row.homeProject).toMatchObject({ id: alpha.id });
    expect(row.scopes).toBeUndefined();
    const withScopes = await member.client.data(member.client.get('/rest/workflows?includeScopes=true'));
    expect(withScopes[0].scopes).toContain('workflow:update');
  });

  it('the owner sees every project and can filter by project', async () => {
    const { owner, alpha, inAlpha, inBeta } = await setup();
    const all = await owner.client.data(owner.client.get('/rest/workflows'));
    expect(all.map((w: { id: string }) => w.id).sort()).toEqual([inAlpha.id, inBeta.id].sort());
    const one = await owner.client.data(owner.client.get(`/rest/workflows?projectId=${alpha.id}`));
    expect(one.map((w: { id: string }) => w.id)).toEqual([inAlpha.id]);
  });

  it('refuses a project filter for a project the member is not in', async () => {
    const { member, beta } = await setup();
    const res = await member.client.get(`/rest/workflows?projectId=${beta.id}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(FORBIDDEN);
    const missing = await member.client.get('/rest/workflows?projectId=00000000-0000-4000-8000-000000000001');
    expect(missing.statusCode).toBe(404);
  });

  it('the sharee mask: a workflow shared into the member project is listed, readable, not deletable', async () => {
    const { owner, member, alpha, beta, inBeta } = await setup();
    await server.ctx.repos.shares.set(owner.tenant.id, 'workflow', inBeta.id, [alpha.id]);
    const list = await member.client.data(member.client.get('/rest/workflows?includeScopes=true'));
    const shared = list.find((w: { id: string }) => w.id === inBeta.id);
    expect(shared).toBeDefined();
    expect(shared.homeProject).toMatchObject({ id: beta.id });
    expect(shared.sharedWithProjects.map((p: { id: string }) => p.id)).toEqual([alpha.id]);
    expect(shared.scopes).toContain('workflow:read');
    expect(shared.scopes).not.toContain('workflow:delete');
    const del = await member.client.delete(`/rest/workflows/${inBeta.id}`);
    expect(del.statusCode).toBe(403);
    const get = await member.client.data(member.client.get(`/rest/workflows/${inBeta.id}`));
    expect(get.scopes).not.toContain('workflow:delete');
  });

  it('onlySharedWithMe lists what is shared into the personal project, not what is owned', async () => {
    const { owner, member, inAlpha, inBeta } = await setup();
    const personal = await server.ctx.repos.projects.getPersonal(owner.tenant.id, member.user.id);
    await server.ctx.repos.shares.set(owner.tenant.id, 'workflow', inBeta.id, [personal!.id]);
    const list = await member.client.data(member.client.get('/rest/workflows?onlySharedWithMe=true'));
    expect(list.map((w: { id: string }) => w.id)).toEqual([inBeta.id]);
    expect(list.map((w: { id: string }) => w.id)).not.toContain(inAlpha.id);
  });
});

describe('POST /workflows', () => {
  it('creates in the named project for a member who may, and returns the scopes', async () => {
    const { member, alpha } = await setup();
    const res = await member.client.post('/rest/workflows', { ...basic(), projectId: alpha.id });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.projectId).toBe(alpha.id);
    expect(data.homeProject).toMatchObject({ id: alpha.id });
    expect(data.scopes).toContain('workflow:update');
  });

  it('refuses a project the member is not in (403), a project viewer (403) and an unknown project (404)', async () => {
    const { member, beta } = await setup('project:viewer');
    const hidden = await member.client.post('/rest/workflows', { ...basic(), projectId: beta.id });
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json().error.message).toBe(FORBIDDEN);
    const viewer = await member.client.post('/rest/workflows', {
      ...basic(),
      projectId: (await server.ctx.repos.projects.listForUser(member.tenant.id, member.user.id)).find(
        (p) => p.name === 'Alpha',
      )!.id,
    });
    expect(viewer.statusCode).toBe(403);
    const unknown = await member.client.post('/rest/workflows', {
      ...basic(),
      projectId: '00000000-0000-4000-8000-000000000002',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('from-url checks the project too', async () => {
    const { member, beta } = await setup();
    const res = await member.client.post('/rest/workflows/from-url', {
      url: 'https://example.com/w.json',
      projectId: beta.id,
    });
    expect(res.statusCode).toBe(403);
  });

  it('from-url passes the project gate for a member of the project (the fetch itself is refused by the guard)', async () => {
    const { member, alpha } = await setup();
    const res = await member.client.post('/rest/workflows/from-url', {
      url: 'http://127.0.0.1:1/w.json',
      projectId: alpha.id,
    });
    expect(res.statusCode).toBe(400);
  });

  it('a new workflow follows MCP auto expose when the creator holds workflow:update', async () => {
    const { owner, member, alpha } = await setup();
    await owner.client.data(
      owner.client.patch('/rest/mcp/settings', { mcpAccessEnabled: true, autoExposeNewWorkflows: true }),
    );
    const created = await member.client.data(
      member.client.post('/rest/workflows', { ...basic(), projectId: alpha.id }),
    );
    expect(created.settings.availableInMCP).toBe(true);
  });
});

describe('moving and running', () => {
  it('POST /workflows/move needs every workflow and keeps the folder in one project', async () => {
    const { owner, member, alpha, beta, inAlpha, inBeta } = await setup();
    const folderAlpha = await folderIn(server, owner.tenant.id, alpha.id);
    const folderBeta = await folderIn(server, owner.tenant.id, beta.id);
    const ok = await member.client.post('/rest/workflows/move', {
      workflowIds: [inAlpha.id],
      folderId: folderAlpha.id,
    });
    expect(ok.statusCode).toBe(200);
    const hiddenWorkflow = await member.client.post('/rest/workflows/move', {
      workflowIds: [inAlpha.id, inBeta.id],
      folderId: folderAlpha.id,
    });
    expect(hiddenWorkflow.statusCode).toBe(403);
    const hiddenFolder = await member.client.post('/rest/workflows/move', {
      workflowIds: [inAlpha.id],
      folderId: folderBeta.id,
    });
    expect(hiddenFolder.statusCode).toBe(403);
    // the owner may touch both projects, but the folder and the workflows must share one
    const crossing = await owner.client.post('/rest/workflows/move', {
      workflowIds: [inAlpha.id],
      folderId: folderBeta.id,
    });
    expect(crossing.statusCode).toBe(400);
  });

  it('a run with a body workflowData still needs workflow:execute on the stored workflow', async () => {
    const { member, inAlpha } = await setup('project:viewer');
    const res = await member.client.post(`/rest/workflows/${inAlpha.id}/run`, { workflowData: basic() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(FORBIDDEN);
  });

  it('a project editor runs the stored workflow', async () => {
    const { owner, member, alpha } = await setup();
    const created = await member.client.data(
      member.client.post('/rest/workflows', { ...basic(), projectId: alpha.id }),
    );
    const res = await member.client.post(`/rest/workflows/${created.id}/run`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().data.executionId).toBeTruthy();
    expect(owner.tenant.id).toBe(member.tenant.id);
  });
});

describe('source', () => {
  it('has no requireRole or hasRole call left in the owned route and service files', () => {
    for (const file of [
      'src/routes/workflows.ts',
      'src/services/workflows.ts',
      'src/services/workflow-archive.ts',
      'src/services/workflow-import-url.ts',
      'src/repositories/workflows.ts',
    ]) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(text, file).not.toMatch(/\b(requireRole|hasRole)\(/);
    }
  });
});
