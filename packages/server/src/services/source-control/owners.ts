/**
 * P6-74 (L3): the project a pulled file lands in. A personal owner maps by email to that member's personal project
 * in this tenant (the tenant's memberships, `repos.projects.getPersonal`); an email of no member falls back to the
 * puller's personal project; a team owner maps through the id map, the project created when missing. Every lookup
 * carries the tenant id, so a member or project of another workspace is never found.
 */
import type { ServiceDeps } from '../../context';
import { projects } from '../../db/schema';
import type { SyncIdMap } from './id-map';
import type { FileOwner } from './import-schemas';

/** the member's personal project, made on first use (the membership exists) */
async function personalProjectOf(
  deps: ServiceDeps,
  tenantId: string,
  userId: string,
): Promise<string | undefined> {
  const { repos } = deps;
  const existing = await repos.projects.getPersonal(tenantId, userId);
  if (existing) return existing.id;
  const user = await repos.users.get(userId);
  if (!user || !(await repos.memberships.getIncludingDisabled(tenantId, userId))) return undefined;
  return (await repos.projects.ensurePersonal(tenantId, { id: user.id, name: user.name })).id;
}

/** returns a project id of `tenantId` */
export async function resolveOwner(
  deps: ServiceDeps,
  tenantId: string,
  owner: FileOwner,
  puller: { userId: string },
  map: SyncIdMap,
): Promise<string> {
  const { repos } = deps;
  if (owner.type === 'personal') {
    const email = owner.personalEmail.trim().toLowerCase();
    const members = await repos.memberships.listForTenant(tenantId);
    const member = members.find((m) => m.email.toLowerCase() === email);
    if (member) {
      const projectId = await personalProjectOf(deps, tenantId, member.userId);
      if (projectId) return projectId;
    }
    const fallback = await personalProjectOf(deps, tenantId, puller.userId);
    if (!fallback) throw new Error('The puller has no personal project in this workspace');
    return fallback;
  }

  // a team owner: the mapped project (made with the id the map holds when the row is not there yet), else a project
  // of this workspace with the git id, else a new team project
  const name = owner.teamName.slice(0, 255) || 'Team project';
  const mapped = map.localIdFor('project', owner.teamId);
  if (mapped) {
    const project = await repos.projects.get(tenantId, mapped);
    if (project) return project.id;
    await deps.database.db
      .insert(projects)
      .values({ id: mapped, tenantId, name, type: 'team', creatorId: puller.userId })
      .onConflictDoNothing();
    const made = await repos.projects.get(tenantId, mapped);
    if (!made) throw new Error('The team project could not be made');
    return made.id;
  }
  const direct = await repos.projects.get(tenantId, owner.teamId);
  if (direct && direct.type === 'team') {
    map.record('project', owner.teamId, direct.id, {});
    return direct.id;
  }
  const created = await repos.projects.create(tenantId, { name, type: 'team', creatorId: puller.userId });
  map.record('project', owner.teamId, created.id, {});
  return created.id;
}
