/**
 * P6-03 (L1): the 12 /rest/projects routes as n8n's project controller. Rows are set up through the
 * repositories; a member is a true `member` (`realMember`) that holds what its project relations give it.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addToProject,
  createTestServer,
  credentialIn,
  memberAs,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  teamProjectOf,
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
  signup(server.app, { remoteAddress: `10.61.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` });

async function create(owner: { client: { post: (u: string, b: unknown) => Promise<any> } }, name: string) {
  const res = await owner.client.post('/rest/projects', { name });
  expect(res.statusCode).toBe(200);
  return res.json().data as { id: string; name: string };
}

describe('visibility', () => {
  it('a member sees only the projects it has a relation on', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const a = await create(owner, 'A');
    const b = await create(owner, 'B');
    await addToProject(server, owner.tenant.id, a.id, member.user.id, 'project:viewer');

    const list = (await member.client.get('/rest/projects')).json().data as Array<{
      id: string;
      role?: string;
      scopes?: string[];
    }>;
    expect(Array.isArray(list)).toBe(true);
    const ids = list.map((p) => p.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    const row = list.find((p) => p.id === a.id)!;
    expect(row.role).toBe('project:viewer');
    expect(row.scopes).toContain('project:read');
    expect(row.scopes).not.toContain('project:update');

    const mine = (await member.client.get('/rest/projects/my-projects')).json().data as Array<{ id: string }>;
    expect(mine.map((p) => p.id)).toEqual(ids);
  });

  it('a hidden project is 403 with n8n text and another workspace id is 404', async () => {
    const owner = await ws();
    const other = await ws();
    const member = await realMember(owner);
    const b = await create(owner, 'B');
    const foreign = await create(other, 'Foreign');

    const hidden = await member.client.get(`/rest/projects/${b.id}`);
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json().error.message).toBe(MISSING_SCOPE);
    expect((await member.client.get(`/rest/projects/${foreign.id}`)).statusCode).toBe(404);
    expect((await member.client.get(`/rest/projects/${randomUUID()}`)).statusCode).toBe(404);
    expect((await member.client.get('/rest/projects/not-a-uuid')).statusCode).toBe(404);
  });

  it('owners and admins are implicit project admins and listed as implicit members', async () => {
    const owner = await ws();
    const a = await create(owner, 'A');
    await repos().projects.relations.remove(owner.tenant.id, a.id, owner.user.id);
    const detail = (await owner.client.get(`/rest/projects/${a.id}`)).json().data;
    expect(detail.relations).toEqual([]);
    expect(detail.implicitMembers.map((m: { id: string }) => m.id)).toContain(owner.user.id);
    const implicit = detail.implicitMembers.find((m: { id: string }) => m.id === owner.user.id);
    expect(implicit.globalRole.slug).toBe('owner');
    expect(detail.scopes).toContain('project:manageMembers');
  });

  it('my-projects adds the team projects owners and admins reach implicitly, with no role (n8n)', async () => {
    const owner = await ws();
    const admin = await memberAs(owner, 'admin');
    const member = await realMember(owner);
    const other = await projectIn(server, owner.tenant.id, 'No relation');
    for (const client of [owner.client, admin.client]) {
      const mine = (await client.get('/rest/projects/my-projects')).json().data as Array<{
        id: string;
        role?: string;
        scopes: string[];
      }>;
      const row = mine.find((p) => p.id === other.id);
      expect(row).toBeDefined();
      expect(row!.role).toBeUndefined();
      expect(row!.scopes).toContain('project:manageMembers');
    }
    const memberMine = (await member.client.get('/rest/projects/my-projects')).json().data as Array<{
      id: string;
    }>;
    expect(memberMine.map((p) => p.id)).not.toContain(other.id);
    // another member's personal project is never added
    const personal = await repos().projects.ensurePersonal(owner.tenant.id, {
      id: member.user.id,
      name: member.user.name,
    });
    const ownerMine = (await owner.client.get('/rest/projects/my-projects')).json().data as Array<{
      id: string;
    }>;
    expect(ownerMine.map((p) => p.id)).not.toContain(personal.id);
  });

  it('the list answers { count, data } with take or skip, count and sharing candidates', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    await create(owner, 'A');
    await create(owner, 'B');
    const page = (await owner.client.get('/rest/projects?take=1&skip=0')).json().data;
    expect(page.data).toHaveLength(1);
    expect(page.count).toBeGreaterThanOrEqual(2);

    const counts = (await owner.client.get('/rest/projects/count')).json().data;
    expect(counts.team).toBe(await repos().projects.countTeam(owner.tenant.id));
    expect(counts.team).toBeGreaterThanOrEqual(2);

    // user:list holders see peers' personal projects among the candidates
    await repos().projects.ensurePersonal(owner.tenant.id, { id: member.user.id, name: member.user.name });
    const candidates = (await member.client.get('/rest/projects/sharing-candidates')).json().data as Array<{
      id: string;
      type: string;
    }>;
    expect(candidates.some((p) => p.type === 'personal')).toBe(true);
    // a team project the member has no relation on is not offered
    expect(candidates.some((p) => p.type === 'team')).toBe(false);
  });

  it('personal answers the caller own personal project with its scopes', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const res = await member.client.get('/rest/projects/personal');
    expect(res.statusCode).toBe(200);
    const personal = res.json().data;
    expect(personal.type).toBe('personal');
    expect(personal.relations.map((r: { role: string }) => r.role)).toEqual(['project:personalOwner']);
    expect(personal.scopes).toContain('workflow:create');
  });
});

describe('create', () => {
  it('needs project:create and gives the caller project:admin', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const denied = await member.client.post('/rest/projects', { name: 'Nope' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING_SCOPE);

    const res = await owner.client.post('/rest/projects', { name: '  Team  ', description: 'd' });
    const project = res.json().data;
    expect(project.name).toBe('Team');
    expect(project.type).toBe('team');
    expect(project.relations).toEqual([
      expect.objectContaining({ id: owner.user.id, role: 'project:admin' }),
    ]);
    const audit = await repos().audit.list(owner.tenant.id, 20);
    const entry = audit.find((a) => a.action === 'project.created');
    expect((entry!.metadata as { projectId?: string }).projectId).toBe(project.id);
  });

  it('refuses a team project over the plan limit with n8n text', async () => {
    const owner = await ws();
    await repos().tenants.updateSettings(owner.tenant.id, { limits: { maxTeamProjects: 100 } });
    const base = await repos().projects.countTeam(owner.tenant.id);
    await repos().tenants.updateSettings(owner.tenant.id, { limits: { maxTeamProjects: base + 1 } });
    await create(owner, 'One');
    const res = await owner.client.post('/rest/projects', { name: 'Two' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(
      `Attempted to create a new project but quota is already exhausted. You may have a maximum of ${base + 1} team projects`,
    );
  });
});

describe('update', () => {
  it('renames a team project, needs project:update and refuses a personal project', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const a = await create(owner, 'A');
    await addToProject(server, owner.tenant.id, a.id, member.user.id, 'project:editor');
    expect((await member.client.patch(`/rest/projects/${a.id}`, { name: 'X' })).statusCode).toBe(403);
    const ok = await owner.client.patch(`/rest/projects/${a.id}`, {
      name: 'Renamed',
      icon: { type: 'emoji', value: 'x' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.name).toBe('Renamed');
    expect(ok.json().data.icon).toEqual({ type: 'emoji', value: 'x' });

    const personal = await repos().projects.ensurePersonal(owner.tenant.id, owner.user as never);
    const refused = await owner.client.patch(`/rest/projects/${personal.id}`, { name: 'Mine' });
    expect(refused.statusCode).toBe(400);
  });
});

describe('members', () => {
  it('every member route needs project:manageMembers', async () => {
    const owner = await ws();
    const editor = await realMember(owner);
    const other = await realMember(owner);
    const a = await create(owner, 'A');
    await addToProject(server, owner.tenant.id, a.id, editor.user.id, 'project:editor');
    const body = { relations: [{ userId: other.user.id, role: 'project:viewer' }] };
    for (const res of [
      await editor.client.post(`/rest/projects/${a.id}/users`, body),
      await editor.client.patch(`/rest/projects/${a.id}/users/${editor.user.id}`, { role: 'project:admin' }),
      await editor.client.delete(`/rest/projects/${a.id}/users/${editor.user.id}`),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe(MISSING_SCOPE);
    }
  });

  it('adds users: 201 with conflicts, 409 when none is added, 200 when nothing to do', async () => {
    const owner = await ws();
    const m1 = await realMember(owner);
    const m2 = await realMember(owner);
    const a = await create(owner, 'A');
    const url = `/rest/projects/${a.id}/users`;

    const first = await owner.client.post(url, {
      relations: [{ userId: m1.user.id, role: 'project:editor' }],
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data.conflicts).toEqual([]);
    expect((await repos().projects.relations.get(owner.tenant.id, a.id, m1.user.id))?.role).toBe(
      'project:editor',
    );

    const mixed = await owner.client.post(url, {
      relations: [
        { userId: m1.user.id, role: 'project:viewer' },
        { userId: m2.user.id, role: 'project:viewer' },
      ],
    });
    expect(mixed.statusCode).toBe(201);
    expect(mixed.json().data.conflicts).toEqual([
      { userId: m1.user.id, currentRole: 'project:editor', requestedRole: 'project:viewer' },
    ]);
    // the existing role is kept
    expect((await repos().projects.relations.get(owner.tenant.id, a.id, m1.user.id))?.role).toBe(
      'project:editor',
    );

    const none = await owner.client.post(url, {
      relations: [{ userId: m1.user.id, role: 'project:viewer' }],
    });
    expect(none.statusCode).toBe(409);

    // an owner is dropped silently: nothing to do
    const nothing = await owner.client.post(url, {
      relations: [{ userId: owner.user.id, role: 'project:viewer' }],
    });
    expect(nothing.statusCode).toBe(200);
    expect(await repos().projects.relations.get(owner.tenant.id, a.id, owner.user.id)).toBeTruthy();
  });

  it('refuses personal projects, personalOwner, unknown roles and users of other workspaces', async () => {
    const owner = await ws();
    const stranger = await ws();
    const member = await realMember(owner);
    const a = await create(owner, 'A');
    const personal = await repos().projects.ensurePersonal(owner.tenant.id, {
      id: member.user.id,
      name: member.user.name,
    });
    const add = (projectId: string, userId: string, role: string) =>
      owner.client.post(`/rest/projects/${projectId}/users`, { relations: [{ userId, role }] });

    const toPersonal = await add(personal.id, member.user.id, 'project:viewer');
    expect(toPersonal.statusCode).toBe(400);
    expect(toPersonal.json().error.message).toBe("Can't add users to personal projects.");
    const asOwner = await add(a.id, member.user.id, 'project:personalOwner');
    expect(asOwner.statusCode).toBe(400);
    expect(asOwner.json().error.message).toBe("Can't add a personalOwner to a team project.");
    expect((await add(a.id, member.user.id, 'project:nonsense')).statusCode).toBe(400);
    expect((await add(a.id, stranger.user.id, 'project:viewer')).statusCode).toBe(404);
    expect(await repos().projects.relations.get(owner.tenant.id, a.id, stranger.user.id)).toBeUndefined();
  });

  it('accepts a custom project role slug and rejects a global one', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const a = await create(owner, 'A');
    await repos().roles.create(owner.tenant.id, {
      slug: 'project:reader',
      displayName: 'Reader',
      roleType: 'project',
      scopes: ['project:read', 'workflow:read', 'workflow:list'],
    });
    await repos().roles.create(owner.tenant.id, {
      slug: 'global-thing',
      displayName: 'Global thing',
      roleType: 'global',
      scopes: ['user:list'],
    });
    const ok = await owner.client.post(`/rest/projects/${a.id}/users`, {
      relations: [{ userId: member.user.id, role: 'project:reader' }],
    });
    expect(ok.statusCode).toBe(201);
    const detail = (await member.client.get(`/rest/projects/${a.id}`)).json().data;
    expect(detail.scopes).toContain('project:read');
    expect(detail.scopes).not.toContain('project:update');
    const bad = await owner.client.patch(`/rest/projects/${a.id}/users/${member.user.id}`, {
      role: 'global-thing',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('changes a role at once and removes a member at once', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const a = await create(owner, 'A');
    await addToProject(server, owner.tenant.id, a.id, member.user.id, 'project:viewer');
    expect((await member.client.patch(`/rest/projects/${a.id}`, { name: 'X' })).statusCode).toBe(403);

    const changed = await owner.client.patch(`/rest/projects/${a.id}/users/${member.user.id}`, {
      role: 'project:admin',
    });
    expect(changed.statusCode).toBe(200);
    expect((await member.client.patch(`/rest/projects/${a.id}`, { name: 'X' })).statusCode).toBe(200);

    const removed = await owner.client.delete(`/rest/projects/${a.id}/users/${member.user.id}`);
    expect(removed.statusCode).toBe(200);
    expect((await member.client.get(`/rest/projects/${a.id}`)).statusCode).toBe(403);
    expect((await owner.client.delete(`/rest/projects/${a.id}/users/${member.user.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await owner.client.patch(`/rest/projects/${a.id}/users/${member.user.id}`, {
          role: 'project:viewer',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('never removes or changes the owner of a personal project', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const personal = await repos().projects.ensurePersonal(owner.tenant.id, {
      id: member.user.id,
      name: member.user.name,
    });
    const res = await owner.client.delete(`/rest/projects/${personal.id}/users/${member.user.id}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Project owner cannot be removed from the project');
    const patch = await owner.client.patch(`/rest/projects/${personal.id}/users/${member.user.id}`, {
      role: 'project:viewer',
    });
    expect(patch.statusCode).toBe(400);
  });
});

describe('a true member who is project:admin (not an owner standing in)', () => {
  it('renames the project and adds, changes and removes members', async () => {
    const owner = await ws();
    const admin = await realMember(owner);
    const other = await realMember(owner);
    const a = await projectIn(server, owner.tenant.id, 'A');
    await addToProject(server, owner.tenant.id, a.id, admin.user.id, 'project:admin');
    const renamed = await admin.client.patch(`/rest/projects/${a.id}`, { name: 'Renamed' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.name).toBe('Renamed');
    const added = await admin.client.post(`/rest/projects/${a.id}/users`, {
      relations: [{ userId: other.user.id, role: 'project:viewer' }],
    });
    expect(added.statusCode).toBe(201);
    const changed = await admin.client.patch(`/rest/projects/${a.id}/users/${other.user.id}`, {
      role: 'project:editor',
    });
    expect(changed.statusCode).toBe(200);
    expect((await repos().projects.relations.get(owner.tenant.id, a.id, other.user.id))?.role).toBe(
      'project:editor',
    );
    const removed = await admin.client.delete(`/rest/projects/${a.id}/users/${other.user.id}`);
    expect(removed.statusCode).toBe(200);
    expect(await repos().projects.relations.get(owner.tenant.id, a.id, other.user.id)).toBeUndefined();
    // the same calls on a project the member only edits are refused
    const b = await projectIn(server, owner.tenant.id, 'B');
    await addToProject(server, owner.tenant.id, b.id, admin.user.id, 'project:editor');
    expect((await admin.client.patch(`/rest/projects/${b.id}`, { name: 'X' })).statusCode).toBe(403);
    expect((await admin.client.delete(`/rest/projects/${b.id}`)).statusCode).toBe(403);
  });

  it('deletes with a transfer into a project it edits, and with a wipe', async () => {
    const owner = await ws();
    const admin = await realMember(owner);
    const source = await projectIn(server, owner.tenant.id, 'Source');
    const target = await projectIn(server, owner.tenant.id, 'Target');
    const wiped = await projectIn(server, owner.tenant.id, 'Wiped');
    await addToProject(server, owner.tenant.id, source.id, admin.user.id, 'project:admin');
    await addToProject(server, owner.tenant.id, wiped.id, admin.user.id, 'project:admin');
    await addToProject(server, owner.tenant.id, target.id, admin.user.id, 'project:editor');
    const wf = await workflowIn(server, owner.tenant.id, source.id);
    const moved = await admin.client.delete(`/rest/projects/${source.id}?transferId=${target.id}`);
    expect(moved.statusCode).toBe(200);
    expect((await repos().workflows.get(owner.tenant.id, wf.id))?.projectId).toBe(target.id);
    const gone = await workflowIn(server, owner.tenant.id, wiped.id);
    const res = await admin.client.delete(`/rest/projects/${wiped.id}`);
    expect(res.statusCode).toBe(200);
    expect(await repos().projects.get(owner.tenant.id, wiped.id)).toBeUndefined();
    expect(await repos().workflows.get(owner.tenant.id, gone.id)).toBeUndefined();
  });
});

describe('a member manager gives only roles whose scopes it holds', () => {
  async function managerWorld() {
    const owner = await ws();
    const manager = await realMember(owner);
    const other = await realMember(owner);
    const a = await projectIn(server, owner.tenant.id, 'A');
    await repos().roles.create(owner.tenant.id, {
      slug: 'project:manager',
      displayName: 'Manager',
      roleType: 'project',
      scopes: ['project:read', 'project:manageMembers'],
    });
    await addToProject(server, owner.tenant.id, a.id, manager.user.id, 'project:manager');
    return { owner, manager, other, a };
  }

  it('cannot change its own relation to project:admin', async () => {
    const { owner, manager, a } = await managerWorld();
    const res = await manager.client.patch(`/rest/projects/${a.id}/users/${manager.user.id}`, {
      role: 'project:admin',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("Couldn't change the role: the role gives scopes you don't have");
    expect((await repos().projects.relations.get(owner.tenant.id, a.id, manager.user.id))?.role).toBe(
      'project:manager',
    );
  });

  it('cannot add a user with a role that gives scopes it lacks', async () => {
    const { owner, manager, other, a } = await managerWorld();
    const res = await manager.client.post(`/rest/projects/${a.id}/users`, {
      relations: [{ userId: other.user.id, role: 'project:editor' }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("Couldn't add the member: the role gives scopes you don't have");
    expect(await repos().projects.relations.get(owner.tenant.id, a.id, other.user.id)).toBeUndefined();
  });

  it('cannot change or remove a member whose role holds scopes it lacks', async () => {
    const { owner, manager, other, a } = await managerWorld();
    await addToProject(server, owner.tenant.id, a.id, other.user.id, 'project:admin');
    const changed = await manager.client.patch(`/rest/projects/${a.id}/users/${other.user.id}`, {
      role: 'project:manager',
    });
    expect(changed.statusCode).toBe(403);
    expect(changed.json().error.message).toBe(
      "Couldn't change the role: the role gives scopes you don't have",
    );
    const removed = await manager.client.delete(`/rest/projects/${a.id}/users/${other.user.id}`);
    expect(removed.statusCode).toBe(403);
    expect(removed.json().error.message).toBe(
      "Couldn't remove the member: the role gives scopes you don't have",
    );
    expect((await repos().projects.relations.get(owner.tenant.id, a.id, other.user.id))?.role).toBe(
      'project:admin',
    );
  });

  it('still changes and removes a member whose role it holds', async () => {
    const { owner, manager, other, a } = await managerWorld();
    await addToProject(server, owner.tenant.id, a.id, other.user.id, 'project:manager');
    const removed = await manager.client.delete(`/rest/projects/${a.id}/users/${other.user.id}`);
    expect(removed.statusCode).toBe(200);
    expect(await repos().projects.relations.get(owner.tenant.id, a.id, other.user.id)).toBeUndefined();
  });

  it('a project:admin still changes another member to project:editor', async () => {
    const owner = await ws();
    const admin = await realMember(owner);
    const other = await realMember(owner);
    const a = await projectIn(server, owner.tenant.id, 'A');
    await addToProject(server, owner.tenant.id, a.id, admin.user.id, 'project:admin');
    await addToProject(server, owner.tenant.id, a.id, other.user.id, 'project:viewer');
    const res = await admin.client.patch(`/rest/projects/${a.id}/users/${other.user.id}`, {
      role: 'project:editor',
    });
    expect(res.statusCode).toBe(200);
    expect((await repos().projects.relations.get(owner.tenant.id, a.id, other.user.id))?.role).toBe(
      'project:editor',
    );
  });
});

describe('delete', () => {
  async function filled(owner: Awaited<ReturnType<typeof signup>>, name: string) {
    const project = await projectIn(server, owner.tenant.id, name);
    const wf = await workflowIn(server, owner.tenant.id, project.id, { createdBy: owner.user.id });
    const cred = await credentialIn(server, owner.tenant.id, project.id);
    const folder = await repos().folders.create(owner.tenant.id, {
      name: 'F',
      parentFolderId: null,
      projectId: project.id,
    });
    const table = await repos().dataTables.create(
      owner.tenant.id,
      project.id,
      `t${randomUUID().slice(0, 6)}`,
    );
    return { project, wf, cred, folder, table };
  }

  it('moves the work to the transfer project and deletes the project', async () => {
    const owner = await ws();
    const source = await filled(owner, 'Source');
    const target = await projectIn(server, owner.tenant.id, 'Target');
    const res = await owner.client.delete(`/rest/projects/${source.project.id}?transferId=${target.id}`);
    expect(res.statusCode).toBe(200);
    expect(await repos().projects.get(owner.tenant.id, source.project.id)).toBeUndefined();
    expect((await repos().workflows.get(owner.tenant.id, source.wf.id))?.projectId).toBe(target.id);
    expect((await repos().credentials.get(owner.tenant.id, source.cred.id))?.projectId).toBe(target.id);
    expect((await repos().folders.get(owner.tenant.id, source.folder.id))?.projectId).toBe(target.id);
    expect((await repos().dataTables.get(owner.tenant.id, source.table.id))?.projectId).toBe(target.id);
    const audit = await repos().audit.list(owner.tenant.id, 20);
    const entry = audit.find((a) => a.action === 'project.deleted');
    expect((entry!.metadata as { projectId?: string }).projectId).toBe(source.project.id);
  });

  it('wipes the work without a transfer project', async () => {
    const owner = await ws();
    const source = await filled(owner, 'Source');
    const res = await owner.client.delete(`/rest/projects/${source.project.id}`);
    expect(res.statusCode).toBe(200);
    expect(await repos().projects.get(owner.tenant.id, source.project.id)).toBeUndefined();
    expect(await repos().workflows.get(owner.tenant.id, source.wf.id)).toBeUndefined();
    expect(await repos().credentials.get(owner.tenant.id, source.cred.id)).toBeUndefined();
    expect(await repos().folders.get(owner.tenant.id, source.folder.id)).toBeUndefined();
    expect(await repos().dataTables.get(owner.tenant.id, source.table.id)).toBeUndefined();
  });

  it('refuses a personal project, the same id, a missing target and a target the caller cannot create in', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const personal = await repos().projects.ensurePersonal(owner.tenant.id, {
      id: member.user.id,
      name: member.user.name,
    });
    const refused = await owner.client.delete(`/rest/projects/${personal.id}`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toBe(
      `Can't delete project. Project with ID ${personal.id} is not a team project.`,
    );

    const a = await create(owner, 'A');
    expect((await owner.client.delete(`/rest/projects/${a.id}?transferId=${a.id}`)).statusCode).toBe(400);
    expect((await owner.client.delete(`/rest/projects/${a.id}?transferId=${randomUUID()}`)).statusCode).toBe(
      404,
    );

    // an admin of A that only views B cannot move A's work into B
    const b = await create(owner, 'B');
    await addToProject(server, owner.tenant.id, a.id, member.user.id, 'project:admin');
    await addToProject(server, owner.tenant.id, b.id, member.user.id, 'project:viewer');
    const denied = await member.client.delete(`/rest/projects/${a.id}?transferId=${b.id}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING_SCOPE);
    expect(await repos().projects.get(owner.tenant.id, a.id)).toBeTruthy();
  });

  it('refuses with 409 naming the data tables whose names clash in the target', async () => {
    const owner = await ws();
    const source = await projectIn(server, owner.tenant.id, 'Source');
    const target = await projectIn(server, owner.tenant.id, 'Target');
    await repos().dataTables.create(owner.tenant.id, source.id, 'orders');
    await repos().dataTables.create(owner.tenant.id, target.id, 'orders');
    const res = await owner.client.delete(`/rest/projects/${source.id}?transferId=${target.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('orders');
    expect(await repos().projects.get(owner.tenant.id, source.id)).toBeTruthy();
  });

  it('wipes in one transaction: a failure on the last rows keeps every workflow and table', async () => {
    const owner = await ws();
    const admin = await realMember(owner);
    const source = await filled(owner, 'Source');
    await addToProject(server, owner.tenant.id, source.project.id, admin.user.id, 'project:admin');
    const { db } = server.ctx.database;
    // the folder delete, the last step before the project row, fails
    await db.execute(
      sql.raw(`create or replace function zz_p6_fail_folder() returns trigger language plpgsql as $$
        begin if old.id = '${source.folder.id}' then raise exception 'zz folder delete failed'; end if; return old; end $$`),
    );
    await db.execute(
      sql.raw(
        'create trigger zz_p6_fail_folder before delete on folders for each row execute function zz_p6_fail_folder()',
      ),
    );
    try {
      const res = await admin.client.delete(`/rest/projects/${source.project.id}`);
      expect(res.statusCode).toBe(500);
    } finally {
      await db.execute(sql.raw('drop trigger if exists zz_p6_fail_folder on folders'));
      await db.execute(sql.raw('drop function if exists zz_p6_fail_folder()'));
    }
    expect(await repos().projects.get(owner.tenant.id, source.project.id)).toBeTruthy();
    expect(await repos().workflows.get(owner.tenant.id, source.wf.id)).toBeTruthy();
    expect(await repos().dataTables.get(owner.tenant.id, source.table.id)).toBeTruthy();
    expect(await repos().credentials.get(owner.tenant.id, source.cred.id)).toBeTruthy();
  });

  it('a workflow created in the project after the delete read its contents goes with the wipe', async () => {
    const owner = await ws();
    const admin = await realMember(owner);
    const source = await filled(owner, 'Source');
    await addToProject(server, owner.tenant.id, source.project.id, admin.user.id, 'project:admin');
    let late: { id: string } | undefined;
    const { workflows } = server.ctx;
    const prepare = workflows.prepareWipe.bind(workflows);
    const spy = vi.spyOn(workflows, 'prepareWipe').mockImplementation(async (tenantId, id) => {
      late ??= await workflowIn(server, owner.tenant.id, source.project.id, { name: 'Late' });
      return prepare(tenantId, id);
    });
    try {
      const res = await admin.client.delete(`/rest/projects/${source.project.id}`);
      expect(res.statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(late).toBeDefined();
    expect(await repos().workflows.get(owner.tenant.id, late!.id)).toBeUndefined();
    expect(await repos().projects.get(owner.tenant.id, source.project.id)).toBeUndefined();
  });

  it('vault connections: an owned one goes, one shared with the project is disabled, every main hears it', async () => {
    const owner = await ws();
    const admin = await realMember(owner);
    const b = await projectIn(server, owner.tenant.id, 'B');
    const c = await projectIn(server, owner.tenant.id, 'C');
    await addToProject(server, owner.tenant.id, b.id, admin.user.id, 'project:admin');
    await addToProject(server, owner.tenant.id, c.id, admin.user.id, 'project:editor');
    const tenantId = owner.tenant.id;
    const connection = (providerKey: string, projectId: string | null) =>
      repos().secrets.create(tenantId, {
        id: randomUUID(),
        providerKey,
        type: 'awsSecretsManager',
        settingsEnc: 'x',
        isEnabled: true,
        createdBy: null,
        projectId,
      });
    const prod = await connection('prod', null);
    await repos().secrets.setShares(tenantId, prod.id, [b.id]);
    await connection('bOwn', b.id);
    const untouched = await connection('elsewhere', null);
    await repos().secrets.setShares(tenantId, untouched.id, [c.id]);
    const heard: string[] = [];
    const stop = await server.ctx.bus.subscribe('secrets:reload', (message) => {
      heard.push(String((message as { providerKey?: string }).providerKey));
    });
    try {
      // a transfer delete drops the vault the same way (as n8n)
      const res = await admin.client.delete(`/rest/projects/${b.id}?transferId=${c.id}`);
      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect([...heard].sort()).toEqual(['bOwn', 'prod']));
    } finally {
      stop();
    }
    expect(await repos().secrets.get(tenantId, 'bOwn')).toBeUndefined();
    expect((await repos().secrets.get(tenantId, 'prod'))?.isEnabled).toBe(false);
    // left with no share and disabled: no project reads its values
    expect(await repos().secrets.accessFor(tenantId, prod.id)).toEqual([]);
    expect((await repos().secrets.get(tenantId, 'elsewhere'))?.isEnabled).toBe(true);
  });

  it('refuses another workspace project with 404', async () => {
    const owner = await ws();
    const other = await ws();
    const foreign = await create(other, 'Foreign');
    const own = await teamProjectOf(server, owner.tenant.id);
    expect((await owner.client.delete(`/rest/projects/${foreign.id}`)).statusCode).toBe(404);
    expect((await owner.client.delete(`/rest/projects/${own}?transferId=${foreign.id}`)).statusCode).toBe(
      404,
    );
  });
});
