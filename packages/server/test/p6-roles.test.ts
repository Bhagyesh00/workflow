/**
 * P6-32 custom roles (L11): a custom role grants exactly its scopes through `scopesFor`, the allow lists
 * refuse what a custom role may not hold, system roles cannot be edited or deleted, a role in use cannot
 * be deleted (a global one can be reassigned by a holder of `user:changeRole`), and the assignment and
 * member lists answer the editor's shapes. Members are real `member` users with relations.
 */
import { randomUUID } from 'node:crypto';
import { MANDATORY_INSTANCE_SCOPES, type Scope } from '@workflow/workflow';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import {
  addToProject,
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
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

const suffix = () => randomUUID().slice(0, 8);
const name = (base: string) => `${base} ${suffix()}`;

type Owner = Awaited<ReturnType<typeof signup>>;

async function createRole(
  owner: Owner,
  roleType: 'project' | 'global',
  scopes: Scope[],
  displayName = name('Role'),
) {
  return owner.client.data<{ slug: string; displayName: string; scopes: Scope[] }>(
    owner.client.post('/rest/roles', { displayName, roleType, scopes }),
  );
}

/** a real member holding the custom global role `scopes` */
async function memberWithGlobalRole(owner: Owner, scopes: Scope[]) {
  const role = await createRole(owner, 'global', scopes);
  const member = await realMember(owner);
  await server.ctx.repos.memberships.updateRole(owner.tenant.id, member.user.id, role.slug);
  return { member, role };
}

describe('create, scopes and the allow lists', () => {
  it('a custom project role grants exactly its scopes through scopesFor', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const project = await projectIn(server, tenantId, name('Team'));
    const role = await createRole(owner, 'project', ['workflow:read', 'workflow:list', 'workflow:execute']);
    expect(role.slug).toMatch(/^project:/);
    expect(new Set(role.scopes)).toEqual(new Set(['workflow:read', 'workflow:list', 'workflow:execute']));

    const member = await realMember(owner);
    const before = await server.ctx.access.scopesFor(tenantId, member.user.id, { projectId: project.id });
    await addToProject(server, tenantId, project.id, member.user.id, role.slug);
    const after = await server.ctx.access.scopesFor(tenantId, member.user.id, { projectId: project.id });
    expect([...after].filter((s) => !before.has(s)).sort()).toEqual([
      'workflow:execute',
      'workflow:list',
      'workflow:read',
    ]);
    expect(after.has('workflow:update')).toBe(false);
    expect(after.has('workflow:create')).toBe(false);
  });

  it('a custom global role grants its scopes plus the baseline, nothing else', async () => {
    const owner = await signup(server.app);
    const { member, role } = await memberWithGlobalRole(owner, ['variable:list', 'variable:read']);
    expect(role.scopes).toEqual(expect.arrayContaining([...MANDATORY_INSTANCE_SCOPES, 'variable:read']));
    const scopes = await server.ctx.access.globalScopes(owner.tenant.id, role.slug);
    expect([...scopes].sort()).toEqual([...new Set([...role.scopes])].sort());
    expect(scopes.has('variable:create')).toBe(false);
    expect(scopes.has('workflow:create')).toBe(false);
    const me = await member.client.get('/rest/roles');
    expect(me.statusCode).toBe(200);
  });

  it('refuses a scope outside the allow list with n8n text', async () => {
    const owner = await signup(server.app);
    const res = await owner.client.post('/rest/roles', {
      displayName: name('Bad'),
      roleType: 'project',
      scopes: ['workflow:read', 'user:create', 'sourceControl:manage'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(
      'The following scopes are not allowed for project roles: user:create, sourceControl:manage',
    );
    const global = await owner.client.post('/rest/roles', {
      displayName: name('Bad'),
      roleType: 'global',
      scopes: ['workflow:create'],
    });
    expect(global.json().error.message).toBe(
      'The following scopes are not allowed for global roles: workflow:create',
    );
  });

  it('refuses the destination scopes, credential:use and credential:createEndUser in any custom role', async () => {
    const owner = await signup(server.app);
    for (const scope of [
      'eventBusDestination:create',
      'logStreaming:manage',
      'otel:manage',
      'credential:use',
      'credential:createEndUser',
    ] as string[]) {
      for (const roleType of ['project', 'global'] as const) {
        const res = await owner.client.post('/rest/roles', {
          displayName: name('Refused'),
          roleType,
          scopes: [scope],
        });
        expect(res.statusCode, `${roleType} ${scope}`).toBe(400);
        // `credential:use` is no scope of the catalog at all: the body check refuses it first
        if (scope !== 'credential:use') {
          expect(res.json().error.message).toBe(
            `The following scopes are not allowed for ${roleType} roles: ${scope}`,
          );
        }
      }
    }
    expect(await server.ctx.repos.roles.list(owner.tenant.id)).toHaveLength(0);
  });

  it('a name in use is a conflict, with n8n text, also for a system role name', async () => {
    const owner = await signup(server.app);
    const display = name('Auditor');
    await createRole(owner, 'project', ['workflow:read'], display);
    const dup = await owner.client.post('/rest/roles', {
      displayName: display.toUpperCase(),
      roleType: 'global',
      scopes: [],
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toBe(`A role with the name "${display.toUpperCase()}" already exists`);
    const system = await owner.client.post('/rest/roles', {
      displayName: 'Editor',
      roleType: 'project',
      scopes: [],
    });
    expect(system.statusCode).toBe(409);
  });

  it('a project role needs role:manageProject and a global role needs role:manage', async () => {
    const owner = await signup(server.app);
    const plain = await realMember(owner);
    const denied = await plain.client.post('/rest/roles', {
      displayName: name('X'),
      roleType: 'project',
      scopes: [],
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING_SCOPE_MESSAGE);

    const { member: projectOnly } = await memberWithGlobalRole(owner, ['role:manageProject']);
    const okProject = await projectOnly.client.post('/rest/roles', {
      displayName: name('P'),
      roleType: 'project',
      scopes: ['workflow:read'],
    });
    expect(okProject.statusCode).toBe(200);
    const noGlobal = await projectOnly.client.post('/rest/roles', {
      displayName: name('G'),
      roleType: 'global',
      scopes: [],
    });
    expect(noGlobal.statusCode).toBe(403);
    expect(noGlobal.json().error.message).toBe(MISSING_SCOPE_MESSAGE);

    // role:manage covers both types
    const { member: manager } = await memberWithGlobalRole(owner, ['role:manage']);
    const both = await manager.client.post('/rest/roles', {
      displayName: name('Q'),
      roleType: 'project',
      scopes: ['workflow:read'],
    });
    expect(both.statusCode).toBe(200);
  });
});

describe('update and system roles', () => {
  it('updates a custom role, takes effect on the next call, and refuses system roles', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const project = await projectIn(server, tenantId, name('Team'));
    const role = await createRole(owner, 'project', ['workflow:read', 'workflow:list']);
    const member = await realMember(owner);
    await addToProject(server, tenantId, project.id, member.user.id, role.slug);
    const reads = async () =>
      (await server.ctx.access.scopesFor(tenantId, member.user.id, { projectId: project.id })).has(
        'workflow:update',
      );
    expect(await reads()).toBe(false);

    const updated = await owner.client.data<{ scopes: Scope[]; displayName: string }>(
      owner.client.patch(`/rest/roles/${encodeURIComponent(role.slug)}`, {
        displayName: name('Renamed'),
        scopes: ['workflow:read', 'workflow:list', 'workflow:update'],
      }),
    );
    expect(updated.scopes).toContain('workflow:update');
    expect(await reads()).toBe(true);

    for (const slug of ['project:editor', 'admin', 'workflow:owner']) {
      const res = await owner.client.patch(`/rest/roles/${encodeURIComponent(slug)}`, { description: 'x' });
      expect(res.statusCode, slug).toBe(400);
      expect(res.json().error.message).toBe('Cannot update system roles');
    }
    const missing = await owner.client.patch('/rest/roles/project:nope', { description: 'x' });
    expect(missing.statusCode).toBe(404);
    const refused = await owner.client.patch(`/rest/roles/${encodeURIComponent(role.slug)}`, {
      scopes: ['eventBusDestination:create'],
    });
    expect(refused.statusCode).toBe(400);
  });
});

describe('delete guard', () => {
  it('refuses system roles and a role in use, deletes an unused one', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const project = await projectIn(server, tenantId, name('Team'));
    const role = await createRole(owner, 'project', ['workflow:read']);
    const member = await realMember(owner);
    await addToProject(server, tenantId, project.id, member.user.id, role.slug);

    const system = await owner.client.delete('/rest/roles/project:viewer');
    expect(system.statusCode).toBe(400);
    expect(system.json().error.message).toBe('Cannot delete system roles');

    const inUse = await owner.client.delete(`/rest/roles/${encodeURIComponent(role.slug)}`);
    expect(inUse.statusCode).toBe(400);
    expect(inUse.json().error.message).toBe('Cannot delete role assigned to users');
    // reassign is for global roles only
    const reassignProject = await owner.client.delete(
      `/rest/roles/${encodeURIComponent(role.slug)}?reassignRoleSlug=member`,
    );
    expect(reassignProject.statusCode).toBe(400);
    expect(await server.ctx.repos.roles.get(tenantId, role.slug)).toBeDefined();

    await server.ctx.repos.projects.relations.remove(tenantId, project.id, member.user.id);
    const gone = await owner.client.delete(`/rest/roles/${encodeURIComponent(role.slug)}`);
    expect(gone.statusCode).toBe(200);
    expect(await server.ctx.repos.roles.get(tenantId, role.slug)).toBeUndefined();
    const again = await owner.client.delete(`/rest/roles/${encodeURIComponent(role.slug)}`);
    expect(again.statusCode).toBe(404);
  });

  it('reassigns the holders of a global role, only for a holder of user:changeRole', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const role = await createRole(owner, 'global', ['variable:list']);
    const holder = await realMember(owner);
    await server.ctx.repos.memberships.updateRole(tenantId, holder.user.id, role.slug);

    const refused = await owner.client.delete(`/rest/roles/${encodeURIComponent(role.slug)}`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toBe('Cannot delete role assigned to users');

    // a manager of roles without user:changeRole cannot move the holders
    const { member: manager } = await memberWithGlobalRole(owner, ['role:manage']);
    const noChange = await manager.client.delete(
      `/rest/roles/${encodeURIComponent(role.slug)}?reassignRoleSlug=member`,
    );
    expect(noChange.statusCode).toBe(403);
    expect(noChange.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
    expect(await server.ctx.repos.roles.get(tenantId, role.slug)).toBeDefined();

    // never to the owner role, to itself or to a project role
    for (const target of ['owner', role.slug, 'project:editor', 'global:missing']) {
      const bad = await owner.client.delete(
        `/rest/roles/${encodeURIComponent(role.slug)}?reassignRoleSlug=${encodeURIComponent(target)}`,
      );
      expect(bad.statusCode, target).toBe(400);
    }

    const ok = await owner.client.delete(`/rest/roles/${encodeURIComponent(role.slug)}?reassignRoleSlug=member`);
    expect(ok.statusCode).toBe(200);
    expect((await server.ctx.repos.memberships.get(tenantId, holder.user.id))?.role).toBe('member');
    expect(await server.ctx.repos.roles.get(tenantId, role.slug)).toBeUndefined();
    const audit = await server.ctx.database.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'role.deleted')));
    expect(audit).toHaveLength(1);
  });
});

describe('lists', () => {
  it('GET /roles groups system and custom roles with usage counts', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const project = await projectIn(server, tenantId, name('Team'));
    const projectRole = await createRole(owner, 'project', ['workflow:read']);
    const globalRole = await createRole(owner, 'global', ['variable:list']);
    const member = await realMember(owner);
    await addToProject(server, tenantId, project.id, member.user.id, projectRole.slug);
    await server.ctx.repos.memberships.updateRole(tenantId, member.user.id, globalRole.slug);

    const map = await member.client.data<Record<string, any[]>>(member.client.get('/rest/roles?withUsageCount=true'));
    expect(map.global.map((r) => r.slug)).toEqual(['owner', 'admin', 'member', globalRole.slug]);
    expect(map.project.map((r) => r.slug)).toEqual([
      'project:admin',
      'project:editor',
      'project:viewer',
      projectRole.slug,
    ]);
    expect(map.workflow.map((r) => r.slug)).toEqual(['workflow:owner', 'workflow:editor']);
    expect(map.credential.map((r) => r.slug)).toEqual(['credential:owner', 'credential:user']);
    expect(map.secretsProviderConnection).toHaveLength(2);
    const g = map.global.find((r) => r.slug === globalRole.slug);
    expect(g).toMatchObject({ systemRole: false, roleType: 'global', usedByUsers: 1 });
    const p = map.project.find((r) => r.slug === projectRole.slug);
    expect(p).toMatchObject({ usedByUsers: 1, usedByProjects: 1 });
    expect(map.global.find((r) => r.slug === 'owner')).toMatchObject({ systemRole: true, usedByUsers: 1 });

    const bare = await member.client.data<Record<string, any[]>>(member.client.get('/rest/roles'));
    expect(bare.global[0].usedByUsers).toBeUndefined();

    const one = await member.client.data<any>(member.client.get(`/rest/roles/${encodeURIComponent(projectRole.slug)}`));
    expect(one).toMatchObject({ slug: projectRole.slug, systemRole: false, roleType: 'project' });
    const sys = await member.client.data<any>(member.client.get('/rest/roles/project:editor'));
    expect(sys.systemRole).toBe(true);
    expect((await member.client.get('/rest/roles/project:nope')).statusCode).toBe(404);
  });

  it('another workspace never sees a role, and cannot touch it', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const role = await createRole(a, 'project', ['workflow:read']);
    expect((await b.client.get(`/rest/roles/${encodeURIComponent(role.slug)}`)).statusCode).toBe(404);
    expect(
      (await b.client.patch(`/rest/roles/${encodeURIComponent(role.slug)}`, { description: 'x' })).statusCode,
    ).toBe(404);
    expect((await b.client.delete(`/rest/roles/${encodeURIComponent(role.slug)}`)).statusCode).toBe(404);
    const map = await b.client.data<Record<string, any[]>>(b.client.get('/rest/roles'));
    expect(map.project.map((r) => r.slug)).not.toContain(role.slug);
    expect((await b.client.get(`/rest/roles/${encodeURIComponent(role.slug)}/assignments`)).statusCode).toBe(404);
  });

  it('assignments list the projects using a role, limited to those the caller can list', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const shown = await projectIn(server, tenantId, name('Shown'));
    const hidden = await projectIn(server, tenantId, name('Hidden'));
    const role = await createRole(owner, 'project', ['workflow:read', 'project:read', 'project:list']);
    const one = await realMember(owner);
    const two = await realMember(owner);
    await addToProject(server, tenantId, shown.id, one.user.id, role.slug);
    await addToProject(server, tenantId, shown.id, two.user.id, role.slug);
    await addToProject(server, tenantId, hidden.id, two.user.id, role.slug);

    const all = await owner.client.data<{ projects: any[]; totalProjects: number }>(
      owner.client.get(`/rest/roles/${encodeURIComponent(role.slug)}/assignments`),
    );
    expect(all.totalProjects).toBe(2);
    const row = all.projects.find((p) => p.projectId === shown.id);
    expect(row).toMatchObject({ projectName: shown.name, memberCount: 2 });
    expect(typeof row.lastAssigned).toBe('string');

    // a project-role manager who belongs to `shown` only sees that one
    const { member: manager, role: managerRole } = await memberWithGlobalRole(owner, ['role:manageProject']);
    expect(managerRole.slug).toMatch(/^global:/);
    const viewerRole = await createRole(owner, 'project', ['project:read', 'project:list']);
    await addToProject(server, tenantId, shown.id, manager.user.id, viewerRole.slug);
    const limited = await manager.client.data<{ projects: any[]; totalProjects: number }>(
      manager.client.get(`/rest/roles/${encodeURIComponent(role.slug)}/assignments`),
    );
    expect(limited.projects.map((p) => p.projectId)).toEqual([shown.id]);
    expect(limited.totalProjects).toBe(1);

    // a global role is not a project role
    expect((await owner.client.get('/rest/roles/admin/assignments')).statusCode).toBe(404);
  });

  it('project members of a role: the listable project only, 404 for a missing one', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const shown = await projectIn(server, tenantId, name('Shown'));
    const hidden = await projectIn(server, tenantId, name('Hidden'));
    const role = await createRole(owner, 'project', ['project:read', 'project:list']);
    const member = await realMember(owner);
    const other = await realMember(owner);
    await addToProject(server, tenantId, shown.id, member.user.id, role.slug);
    await addToProject(server, tenantId, hidden.id, other.user.id, role.slug);
    const { member: manager } = await memberWithGlobalRole(owner, ['role:manageProject']);
    await addToProject(server, tenantId, shown.id, manager.user.id, role.slug);

    const slug = encodeURIComponent(role.slug);
    const list = await manager.client.data<{ members: any[]; total: number }>(
      manager.client.get(`/rest/roles/${slug}/assignments/${shown.id}/members`),
    );
    expect(list.total).toBe(2);
    expect(list.members.map((m) => m.userId).sort()).toEqual([manager.user.id, member.user.id].sort());
    expect(list.members[0]).toEqual(
      expect.objectContaining({ userId: expect.any(String), name: expect.any(String), email: expect.any(String), role: role.slug }),
    );

    const denied = await manager.client.get(`/rest/roles/${slug}/assignments/${hidden.id}/members`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
    expect((await manager.client.get(`/rest/roles/${slug}/assignments/${randomUUID()}/members`)).statusCode).toBe(404);
    expect((await manager.client.get(`/rest/roles/${slug}/assignments/not-an-id/members`)).statusCode).toBe(404);

    const all = await owner.client.data<{ members: any[] }>(
      owner.client.get(`/rest/roles/${slug}/assignments/${hidden.id}/members`),
    );
    expect(all.members.map((m) => m.userId)).toEqual([other.user.id]);
    // a plain member holds neither scope
    expect((await member.client.get(`/rest/roles/${slug}/assignments`)).statusCode).toBe(403);
  });

  it('members of a global role need role:read', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const role = await createRole(owner, 'global', ['variable:list']);
    const holder = await realMember(owner);
    await server.ctx.repos.memberships.updateRole(tenantId, holder.user.id, role.slug);

    const list = await owner.client.data<{ members: any[]; total: number }>(
      owner.client.get(`/rest/roles/${encodeURIComponent(role.slug)}/members`),
    );
    expect(list.total).toBe(1);
    expect(list.members[0]).toMatchObject({ userId: holder.user.id, email: holder.email, role: role.slug });
    const admins = await owner.client.data<{ members: any[] }>(owner.client.get('/rest/roles/owner/members'));
    expect(admins.members.map((m) => m.userId)).toContain(owner.user.id);

    const plain = await realMember(owner);
    const denied = await plain.client.get(`/rest/roles/${encodeURIComponent(role.slug)}/members`);
    expect(denied.statusCode).toBe(403);
    expect((await owner.client.get('/rest/roles/project:editor/members')).statusCode).toBe(404);
  });
});

describe('a role never gives what its writer lacks (roles-1)', () => {
  it('a holder of role:manage cannot widen its own role nor create a wider one', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const { member: manager, role } = await memberWithGlobalRole(owner, ['role:read', 'role:manage']);
    const slug = encodeURIComponent(role.slug);
    const widen = await manager.client.patch(`/rest/roles/${slug}`, {
      scopes: ['role:read', 'role:manage', 'user:changeRole', 'credential:read'],
    });
    expect(widen.statusCode).toBe(403);
    expect(widen.json().error.message).toBe(
      "Couldn't save the role: you don't have these scopes: user:changeRole, credential:read",
    );
    expect((await server.ctx.repos.roles.get(tenantId, role.slug))?.scopes).not.toContain('user:changeRole');
    expect((await server.ctx.access.globalScopes(tenantId, role.slug)).has('user:changeRole')).toBe(false);

    const wider = await manager.client.post('/rest/roles', {
      displayName: name('Wide'),
      roleType: 'global',
      scopes: ['user:changeRole'],
    });
    expect(wider.statusCode).toBe(403);
    // inside its own scopes it still works, and the owner may widen it
    const narrow = await manager.client.post('/rest/roles', {
      displayName: name('Narrow'),
      roleType: 'global',
      scopes: ['role:read'],
    });
    expect(narrow.statusCode).toBe(200);
    const byOwner = await owner.client.patch(`/rest/roles/${slug}`, {
      scopes: ['role:read', 'role:manage', 'user:changeRole'],
    });
    expect(byOwner.statusCode).toBe(200);
  });

  it('a holder of role:manageProject cannot widen a project role it holds in a project', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const project = await projectIn(server, tenantId, name('Team'));
    const { member: manager } = await memberWithGlobalRole(owner, ['role:manageProject']);
    const role = await createRole(owner, 'project', ['workflow:read']);
    await addToProject(server, tenantId, project.id, manager.user.id, role.slug);
    const slug = encodeURIComponent(role.slug);

    const widen = await manager.client.patch(`/rest/roles/${slug}`, {
      scopes: ['workflow:read', 'workflow:delete'],
    });
    expect(widen.statusCode).toBe(403);
    expect(widen.json().error.message).toBe(
      "Couldn't save the role: you don't have these scopes: workflow:delete",
    );
    const scopes = await server.ctx.access.scopesFor(tenantId, manager.user.id, { projectId: project.id });
    expect(scopes.has('workflow:delete')).toBe(false);

    // a project role no project uses, and a narrower one, still change
    const unused = await createRole(owner, 'project', ['workflow:read']);
    const free = await manager.client.patch(`/rest/roles/${encodeURIComponent(unused.slug)}`, {
      scopes: ['workflow:read', 'workflow:delete'],
    });
    expect(free.statusCode).toBe(200);
    expect((await manager.client.patch(`/rest/roles/${slug}`, { scopes: [] })).statusCode).toBe(200);
  });

  it('reassigning holders: never to a role wider than the caller, never by a holder of the role (n8n)', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const doomed = await createRole(owner, 'global', ['variable:list']);
    const holder = await realMember(owner);
    await server.ctx.repos.memberships.updateRole(tenantId, holder.user.id, doomed.slug);
    const { member: manager } = await memberWithGlobalRole(owner, ['role:manage', 'user:changeRole']);
    const doomedSlug = encodeURIComponent(doomed.slug);

    const toAdmin = await manager.client.delete(`/rest/roles/${doomedSlug}?reassignRoleSlug=admin`);
    expect(toAdmin.statusCode).toBe(403);
    expect(toAdmin.json().error.message).toMatch(/^Couldn't move the members: you don't have these scopes: /);
    expect((await server.ctx.repos.memberships.get(tenantId, holder.user.id))?.role).toBe(doomed.slug);
    expect(await server.ctx.repos.roles.get(tenantId, doomed.slug)).toBeDefined();

    const { member: self, role: own } = await memberWithGlobalRole(owner, ['role:manage', 'user:changeRole']);
    const mine = await self.client.delete(
      `/rest/roles/${encodeURIComponent(own.slug)}?reassignRoleSlug=member`,
    );
    expect(mine.statusCode).toBe(400);
    expect(mine.json().error.message).toBe('Cannot delete role assigned to users');
    expect((await server.ctx.repos.memberships.get(tenantId, self.user.id))?.role).toBe(own.slug);

    // member, the floor every workspace user starts from, still goes
    const ok = await manager.client.delete(`/rest/roles/${doomedSlug}?reassignRoleSlug=member`);
    expect(ok.statusCode).toBe(200);
    expect((await server.ctx.repos.memberships.get(tenantId, holder.user.id))?.role).toBe('member');
  });
});

describe('a pending invitation holds its role', () => {
  it('refuses the delete with the users text, and a reassign moves the invitation', async () => {
    const owner = await signup(server.app);
    const tenantId = owner.tenant.id;
    const role = await createRole(owner, 'global', ['variable:list']);
    const invite = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/members/invite', {
        email: `pending-${suffix()}@example.com`,
        role: role.slug,
      }),
    );
    const slug = encodeURIComponent(role.slug);

    const refused = await owner.client.delete(`/rest/roles/${slug}`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toBe('Cannot delete role assigned to users');
    expect(await server.ctx.repos.roles.get(tenantId, role.slug)).toBeDefined();

    const ok = await owner.client.delete(`/rest/roles/${slug}?reassignRoleSlug=member`);
    expect(ok.statusCode).toBe(200);
    const pending = await server.ctx.repos.invitations.listPending(tenantId);
    expect(pending.find((i) => i.id === invite.id)?.role).toBe('member');
  });
});
