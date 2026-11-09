/**
 * Custom roles (P6-32): a workspace's own project or global roles, each with its scope list. System roles
 * (owner, admin, member, the project roles) live in code (`@workflow/workflow` role maps), never here.
 * Every query filters tenant_id.
 */
import type { Scope } from '@workflow/workflow';
import { and, asc, count, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type CustomRoleRow, memberships, projectRelations, roles } from '../db/schema';
import { now } from './util';

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
}
