/**
 * P6-26 (L6): folders belong to one project. A true `member` (invited as `member`, given a project role
 * through `addToProject`) holds what its project gives it: `scopes` on every folder row, 403 with n8n's text on
 * another project's folder, a folder moves only inside its project (parent, `transferToFolderId`), and a
 * project can be a favorite (read scope on the target; a lost project drops out of the list).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  folderIn,
  projectIn,
  realMember,
  resetDatabase,
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

/** an owner, a member and two team projects; the member is `role` in `alpha` and nothing in `beta` */
async function setup(role = 'project:editor') {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const beta = await projectIn(server, owner.tenant.id, 'Beta');
  await addToProject(server, owner.tenant.id, alpha.id, member.user.id, role);
  const inAlpha = await folderIn(server, owner.tenant.id, alpha.id, 'In alpha');
  const inBeta = await folderIn(server, owner.tenant.id, beta.id, 'In beta');
  return { owner, member, alpha, beta, inAlpha, inBeta };
}

describe('GET /folders/:id and lists', () => {
  it('a project editor gets folder:update in scopes, the project id and the home project', async () => {
    const { member, alpha, inAlpha } = await setup();
    const res = await member.client.get(`/rest/folders/${inAlpha.id}`);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.scopes).toContain('folder:update');
    expect(data.scopes).toContain('folder:read');
    expect(data.projectId).toBe(alpha.id);
    expect(data.homeProject).toMatchObject({ id: alpha.id, name: 'Alpha', type: 'team' });
  });

  it('a project viewer reads but holds no update or delete scope', async () => {
    const { member, inAlpha } = await setup('project:viewer');
    const data = await member.client.data(member.client.get(`/rest/folders/${inAlpha.id}`));
    expect(data.scopes).toContain('folder:read');
    expect(data.scopes).not.toContain('folder:update');
    expect((await member.client.patch(`/rest/folders/${inAlpha.id}`, { name: 'x' })).statusCode).toBe(403);
    expect((await member.client.delete(`/rest/folders/${inAlpha.id}`)).statusCode).toBe(403);
  });

  it('answers 403 with n8n text on another project folder, for every verb', async () => {
    const { member, inBeta } = await setup();
    for (const res of [
      await member.client.get(`/rest/folders/${inBeta.id}`),
      await member.client.patch(`/rest/folders/${inBeta.id}`, { name: 'x' }),
      await member.client.delete(`/rest/folders/${inBeta.id}`),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe(FORBIDDEN);
    }
  });

  it('another workspace folder is 404', async () => {
    const { member } = await setup();
    const other = await signup(server.app);
    const project = await projectIn(server, other.tenant.id, 'Other');
    const foreign = await folderIn(server, other.tenant.id, project.id, 'Foreign');
    expect((await member.client.get(`/rest/folders/${foreign.id}`)).statusCode).toBe(404);
  });

  it('the list holds only the projects the member belongs to; includeScopes adds scopes; projectId filters', async () => {
    const { member, alpha, beta, inAlpha } = await setup();
    const list = await member.client.get('/rest/folders?includeScopes=true');
    expect(list.statusCode).toBe(200);
    const rows = list.json().data as Array<{ id: string; projectId: string; scopes: string[] }>;
    expect(rows.map((r) => r.id)).toEqual([inAlpha.id]);
    expect(rows[0].scopes).toContain('folder:update');
    const plain = (await member.client.get('/rest/folders')).json().data as Array<{ scopes?: string[] }>;
    expect(plain[0].scopes).toBeUndefined();
    expect((await member.client.get(`/rest/folders?projectId=${alpha.id}`)).json().data).toHaveLength(1);
    expect((await member.client.get(`/rest/folders?projectId=${beta.id}`)).statusCode).toBe(403);
  });

  it('the owner lists every project', async () => {
    const { owner } = await setup();
    const rows = (await owner.client.get('/rest/folders')).json().data as unknown[];
    expect(rows).toHaveLength(2);
  });
});

describe('POST /folders', () => {
  it('creates in the named project when the member holds folder:create there', async () => {
    const { member, alpha } = await setup();
    const res = await member.client.post('/rest/folders', { name: 'New', projectId: alpha.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.projectId).toBe(alpha.id);
    expect(res.json().data.scopes).toContain('folder:create');
  });

  it('refuses a project the member has no folder:create in', async () => {
    const { member, beta } = await setup();
    const res = await member.client.post('/rest/folders', { name: 'New', projectId: beta.id });
    expect(res.statusCode).toBe(403);
    const viewer = await setup('project:viewer');
    const denied = await viewer.member.client.post('/rest/folders', {
      name: 'New',
      projectId: viewer.alpha.id,
    });
    expect(denied.statusCode).toBe(403);
  });

  it('a subfolder lands in its parent project, and a parent of another project is refused', async () => {
    const { member, alpha, beta, inAlpha, inBeta } = await setup();
    const child = await member.client.post('/rest/folders', { name: 'Child', parentFolderId: inAlpha.id });
    expect(child.statusCode).toBe(200);
    expect(child.json().data.projectId).toBe(alpha.id);
    const clash = await member.client.post('/rest/folders', {
      name: 'Clash',
      parentFolderId: inAlpha.id,
      projectId: beta.id,
    });
    expect([400, 403]).toContain(clash.statusCode);
    const foreignParent = await member.client.post('/rest/folders', {
      name: 'Foreign',
      parentFolderId: inBeta.id,
    });
    expect(foreignParent.statusCode).toBe(403);
  });
});

describe('a folder moves only inside its project', () => {
  it('PATCH parentFolderId into another project is 400; inside the project it works', async () => {
    const { owner, member, alpha, beta, inAlpha, inBeta } = await setup();
    const sibling = await folderIn(server, owner.tenant.id, alpha.id, 'Sibling');
    const cross = await owner.client.patch(`/rest/folders/${inAlpha.id}`, { parentFolderId: inBeta.id });
    expect(cross.statusCode).toBe(400);
    const own = await member.client.patch(`/rest/folders/${inAlpha.id}`, { parentFolderId: sibling.id });
    expect(own.statusCode).toBe(200);
    expect(own.json().data.parentFolderId).toBe(sibling.id);
    const row = await server.ctx.repos.folders.get(owner.tenant.id, inAlpha.id);
    expect(row?.projectId).toBe(alpha.id);
    expect(beta.id).not.toBe(alpha.id);
  });

  it('DELETE transferToFolderId in another project is 400, and nothing is deleted', async () => {
    const { owner, alpha, inAlpha, inBeta } = await setup();
    const wf = await workflowIn(server, owner.tenant.id, alpha.id, { folderId: inAlpha.id });
    const res = await owner.client.request('DELETE', `/rest/folders/${inAlpha.id}`, {
      transferToFolderId: inBeta.id,
    });
    expect(res.statusCode).toBe(400);
    expect(await server.ctx.repos.folders.get(owner.tenant.id, inAlpha.id)).toBeDefined();
    const kept = await server.ctx.repos.workflows.get(owner.tenant.id, wf.id);
    expect(kept?.folderId).toBe(inAlpha.id);
  });

  it('DELETE transferToFolderId inside the project moves the workflows there', async () => {
    const { owner, member, alpha, inAlpha } = await setup();
    const target = await folderIn(server, owner.tenant.id, alpha.id, 'Target');
    const wf = await workflowIn(server, owner.tenant.id, alpha.id, { folderId: inAlpha.id });
    const res = await member.client.request('DELETE', `/rest/folders/${inAlpha.id}`, {
      transferToFolderId: target.id,
    });
    expect(res.statusCode).toBe(200);
    const moved = await server.ctx.repos.workflows.get(owner.tenant.id, wf.id);
    expect(moved?.folderId).toBe(target.id);
  });
});

describe('favorites', () => {
  it('a project can be a favorite, and it comes back with its name', async () => {
    const { member, alpha } = await setup();
    const add = await member.client.post('/rest/favorites', {
      resourceType: 'project',
      resourceId: alpha.id,
    });
    expect(add.statusCode).toBe(200);
    expect(add.json().data).toMatchObject({ resourceType: 'project', resourceId: alpha.id, name: 'Alpha' });
    const list = (await member.client.get('/rest/favorites')).json().data as Array<{ resourceId: string }>;
    expect(list.map((f) => f.resourceId)).toEqual([alpha.id]);
    expect((await member.client.delete(`/rest/favorites/project/${alpha.id}`)).statusCode).toBe(200);
    expect((await member.client.get('/rest/favorites')).json().data).toEqual([]);
  });

  it('needs read scope on the target: another project, its folder, its workflow are 403', async () => {
    const { owner, member, beta, inBeta } = await setup();
    const wf = await workflowIn(server, owner.tenant.id, beta.id);
    for (const [resourceType, resourceId] of [
      ['project', beta.id],
      ['folder', inBeta.id],
      ['workflow', wf.id],
    ]) {
      const res = await member.client.post('/rest/favorites', { resourceType, resourceId });
      expect(res.statusCode).toBe(403);
    }
  });

  it('an unknown or another workspace project is 404', async () => {
    const { member } = await setup();
    const other = await signup(server.app);
    const foreign = await projectIn(server, other.tenant.id, 'Foreign');
    for (const id of [randomUUID(), foreign.id]) {
      const res = await member.client.post('/rest/favorites', { resourceType: 'project', resourceId: id });
      expect(res.statusCode).toBe(404);
    }
  });

  it('a lost project, folder or workflow drops out of the list', async () => {
    const { owner, member, alpha, inAlpha } = await setup();
    const wf = await workflowIn(server, owner.tenant.id, alpha.id);
    for (const [resourceType, resourceId] of [
      ['project', alpha.id],
      ['folder', inAlpha.id],
      ['workflow', wf.id],
    ]) {
      expect((await member.client.post('/rest/favorites', { resourceType, resourceId })).statusCode).toBe(
        200,
      );
    }
    expect((await member.client.get('/rest/favorites')).json().data).toHaveLength(3);
    await server.ctx.repos.projects.relations.remove(owner.tenant.id, alpha.id, member.user.id);
    expect((await member.client.get('/rest/favorites')).json().data).toEqual([]);
    // the owner never lost it: its own list is unaffected by the member's relation
    expect((await owner.client.get('/rest/favorites')).json().data).toEqual([]);
  });

  it('a deleted project drops out of the list', async () => {
    const { owner } = await setup();
    const empty = await projectIn(server, owner.tenant.id, 'Empty');
    await owner.client.post('/rest/favorites', { resourceType: 'project', resourceId: empty.id });
    expect((await owner.client.get('/rest/favorites')).json().data).toHaveLength(1);
    await server.ctx.repos.projects.delete(owner.tenant.id, empty.id);
    expect((await owner.client.get('/rest/favorites')).json().data).toEqual([]);
  });
});
