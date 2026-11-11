/**
 * P6-74 (L3): the project a pulled file lands in. A personal owner maps by email to that member's personal project
 * in this tenant (the tenant's memberships, `repos.projects.getPersonal`); an email of no member falls back to the
 * puller's personal project; a team owner maps through the id map (or a team project of this tenant that carries the
 * git id). A team project that is still missing is made through `ProjectService.create` with the puller's auth
 * (the team project limit, the creator's project admin relation and the audit row apply), never by a raw insert;
 * `findOwner` only looks up and never makes one (a puller limited to some projects). Every lookup carries the tenant
 * id, so a member or project of another workspace is never found.
 */
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';
import type { SyncIdMap } from './id-map';
import type { FileOwner } from './import-schemas';

/** who pulls: a new team project is made with `auth` (`ProjectService.create`) */
export interface OwnerPuller {
  userId: string;
  auth?: AuthContext;
}

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

/** the puller's auth in this workspace: the one given, else read from its membership (an internal caller) */
async function pullerAuth(deps: ServiceDeps, tenantId: string, puller: OwnerPuller): Promise<AuthContext> {
  if (puller.auth) {
    if (puller.auth.tenant.id !== tenantId) throw new Error('The puller`s auth is of another workspace');
    return puller.auth;
  }
  const { repos } = deps;
  const [tenant, user, membership] = await Promise.all([
    repos.tenants.get(tenantId),
    repos.users.get(puller.userId),
    repos.memberships.get(tenantId, puller.userId),
  ]);
  if (!tenant || !user || !membership) throw new Error('The puller is not a member of this workspace');
  return { tenant, user, role: membership.role };
}

/** a project id of `tenantId` for `owner`, or undefined when a team owner has no project here yet (never makes one) */
export async function findOwner(
  deps: ServiceDeps,
  tenantId: string,
  owner: FileOwner,
  puller: OwnerPuller,
  map: SyncIdMap,
): Promise<string | undefined> {
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
  // a team owner: the mapped project, else a team project of this workspace with the git id (the first pusher)
  const mapped = map.localIdFor('project', owner.teamId);
  if (mapped) {
    const project = await repos.projects.get(tenantId, mapped);
    if (project) return project.id;
  }
  const direct = await repos.projects.get(tenantId, owner.teamId);
  if (direct && direct.type === 'team') {
    map.record('project', owner.teamId, direct.id, {});
    return direct.id;
  }
  return undefined;
}

/** returns a project id of `tenantId`; a missing team project is made through the project service and mapped */
export async function resolveOwner(
  deps: ServiceDeps,
  tenantId: string,
  owner: FileOwner,
  puller: OwnerPuller,
  map: SyncIdMap,
): Promise<string> {
  const found = await findOwner(deps, tenantId, owner, puller, map);
  if (found) return found;
  if (owner.type !== 'team') throw new Error('The owner has no project in this workspace');
  const auth = await pullerAuth(deps, tenantId, puller);
  const name = owner.teamName.slice(0, 255) || 'Team project';
  const created = await deps.context().projects.create(auth, { name });
  map.record('project', owner.teamId, created.id, {});
  return created.id;
}
