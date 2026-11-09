/**
 * Custom roles (P6-32): a workspace's own project or global roles, each with its scope list. System roles
 * (owner, admin, member, the project roles) live in code (`@workflow/workflow` role maps), never here.
 * Every query filters tenant_id.
 */
import type { Scope } from '@workflow/workflow';
import { and, asc, count, countDistinct, desc, eq, max, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type CustomRoleRow,
  memberships,
  type ProjectIcon,
  projectRelations,
  projects,
  roles,
  users,
} from '../db/schema';
import { isUuid, now } from './util';

export type RoleType = 'project' | 'global';

export interface RoleCreateInput {
  slug: string;
  displayName: string;
  description?: string | null;
  roleType: RoleType;
  scopes: Scope[];
}

export interface RolePatch {
  displayName?: string;
  description?: string | null;
  scopes?: Scope[];
}

export class RoleRepository {
  constructor(private readonly db: DbOrTx) {}

  async get(tenantId: string, slug: string): Promise<CustomRoleRow | undefined> {
    const [row] = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.slug, slug)));
    return row;
  }

  /** the workspace's custom roles, of one type when given, by display name */
  async list(tenantId: string, roleType?: RoleType): Promise<CustomRoleRow[]> {
    const conditions = [eq(roles.tenantId, tenantId)];
    if (roleType) conditions.push(eq(roles.roleType, roleType));
    return this.db
      .select()
      .from(roles)
      .where(and(...conditions))
      .orderBy(asc(roles.displayName), asc(roles.slug));
  }

  /** the caller checked the scopes against the allow list; a taken slug or name is a unique violation */
  async create(tenantId: string, input: RoleCreateInput): Promise<CustomRoleRow> {
    const [row] = await this.db
      .insert(roles)
      .values({
        tenantId,
        slug: input.slug,
        displayName: input.displayName,
        description: input.description ?? null,
        roleType: input.roleType,
        scopes: [...new Set(input.scopes)],
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    return row;
  }

  async update(tenantId: string, slug: string, patch: RolePatch): Promise<CustomRoleRow | undefined> {
    const set: Partial<typeof roles.$inferInsert> = { updatedAt: now() };
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.scopes !== undefined) set.scopes = [...new Set(patch.scopes)];
    const [row] = await this.db
      .update(roles)
      .set(set)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.slug, slug)))
      .returning();
    return row;
  }

  /** true when a row went; the caller has checked `usageCount` (or reassigned the holders) first */
  async delete(tenantId: string, slug: string): Promise<boolean> {
    const rows = await this.db
      .delete(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.slug, slug)))
      .returning({ slug: roles.slug });
    return rows.length > 0;
  }

  /**
   * How many hold the role in this workspace: members with it as their workspace role plus project
   * relations with it as their project role (a slug is one or the other, so one count is 0).
   */
  async usageCount(tenantId: string, slug: string): Promise<number> {
    const [members] = await this.db
      .select({ n: count() })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, slug)));
    const [relations] = await this.db
      .select({ n: count() })
      .from(projectRelations)
      .where(and(eq(projectRelations.tenantId, tenantId), eq(projectRelations.role, slug)));
    return (members?.n ?? 0) + (relations?.n ?? 0);
  }

  /** holders per role slug: workspace members with it, and users and projects holding it as a project role */
  async usageBySlug(
    tenantId: string,
  ): Promise<Map<string, { users: number; projects: number }>> {
    const out = new Map<string, { users: number; projects: number }>();
    const members = await this.db
      .select({ role: memberships.role, n: count() })
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId))
      .groupBy(memberships.role);
    for (const row of members) out.set(row.role, { users: row.n, projects: 0 });
    const relations = await this.db
      .select({
        role: projectRelations.role,
        users: countDistinct(projectRelations.userId),
        projects: countDistinct(projectRelations.projectId),
      })
      .from(projectRelations)
      .where(eq(projectRelations.tenantId, tenantId))
      .groupBy(projectRelations.role);
    for (const row of relations) out.set(row.role, { users: row.users, projects: row.projects });
    return out;
  }

  /** the workspace members whose workspace role is `slug`, by name */
  async membersWithRole(
    tenantId: string,
    slug: string,
  ): Promise<Array<{ userId: string; name: string; email: string; role: string }>> {
    return this.db
      .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, slug)))
      .orderBy(asc(users.name), asc(users.email));
  }

  /** the members of one project holding the project role `slug` */
  async projectMembersWithRole(
    tenantId: string,
    projectId: string,
    slug: string,
  ): Promise<Array<{ userId: string; name: string; email: string; role: string }>> {
    if (!isUuid(projectId)) return [];
    return this.db
      .select({ userId: users.id, name: users.name, email: users.email, role: projectRelations.role })
      .from(projectRelations)
      .innerJoin(users, eq(users.id, projectRelations.userId))
      .where(
        and(
          eq(projectRelations.tenantId, tenantId),
          eq(projectRelations.projectId, projectId),
          eq(projectRelations.role, slug),
        ),
      )
      .orderBy(asc(users.name), asc(users.email));
  }

  /** the projects with at least one member holding the project role `slug`, by name */
  async assignmentsOf(
    tenantId: string,
    slug: string,
  ): Promise<
    Array<{
      projectId: string;
      projectName: string;
      projectIcon: ProjectIcon | null;
      memberCount: number;
      lastAssigned: Date | null;
    }>
  > {
    return this.db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        projectIcon: projects.icon,
        memberCount: sql<number>`count(*)::int`,
        lastAssigned: max(projectRelations.createdAt),
      })
      .from(projectRelations)
      .innerJoin(
        projects,
        and(eq(projects.tenantId, projectRelations.tenantId), eq(projects.id, projectRelations.projectId)),
      )
      .where(and(eq(projectRelations.tenantId, tenantId), eq(projectRelations.role, slug)))
      .groupBy(projects.id, projects.name, projects.icon)
      .orderBy(asc(projects.name), desc(projects.id));
  }

  /** moves every member holding workspace role `from` to `to`; returns how many moved */
  async reassignMembers(tenantId: string, from: string, to: string): Promise<number> {
    const rows = await this.db
      .update(memberships)
      .set({ role: to })
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, from)))
      .returning({ userId: memberships.userId });
    return rows.length;
  }
}
