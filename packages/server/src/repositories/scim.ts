/**
 * P6-02 (L13): a workspace's SCIM token (`scim_tokens`, one per workspace), stored as SHA-256 with its last
 * four characters. The raw token is never stored.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { memberships, type Role, type ScimTokenRow, scimTokens, tenants, users } from '../db/schema';
import { isUuid } from './util';

/** a member of the workspace as the SCIM client sees it (a disabled member too) */
export interface ScimMember {
  userId: string;
  email: string;
  name: string;
  role: Role;
  externalId: string | null;
  disabledAt: Date | null;
  createdAt: Date;
  managedByTenantId: string | null;
}

export class ScimRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** the workspace's token row (no secret in it: hash and hint only) */
  async get(tenantId: string): Promise<ScimTokenRow | undefined> {
    if (!isUuid(tenantId)) return undefined;
    const [row] = await this.db.select().from(scimTokens).where(eq(scimTokens.tenantId, tenantId));
    return row;
  }

  /** replaces the workspace's token (mint, rotate): one row per workspace, the old hash stops working */
  async save(
    tenantId: string,
    input: { tokenHash: string; tokenHint: string; createdBy: string | null },
  ): Promise<ScimTokenRow> {
    const [row] = await this.db
      .insert(scimTokens)
      .values({ tenantId, ...input })
      .onConflictDoUpdate({
        target: scimTokens.tenantId,
        set: { ...input, createdAt: new Date() },
      })
      .returning();
    return row;
  }

  async delete(tenantId: string): Promise<boolean> {
    if (!isUuid(tenantId)) return false;
    const rows = await this.db
      .delete(scimTokens)
      .where(eq(scimTokens.tenantId, tenantId))
      .returning({ tenantId: scimTokens.tenantId });
    return rows.length > 0;
  }

  /** system level: the token by its hash, before the workspace is known (the bearer names it) */
  async getByHash(tokenHash: string): Promise<ScimTokenRow | undefined> {
    const [row] = await this.db.select().from(scimTokens).where(eq(scimTokens.tokenHash, tokenHash));
    return row;
  }

  private memberSelect() {
    return this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        externalId: memberships.externalId,
        disabledAt: memberships.disabledAt,
        createdAt: memberships.createdAt,
        managedByTenantId: users.managedByTenantId,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId));
  }

  /** one member of the workspace, disabled or not */
  async getMember(tenantId: string, userId: string): Promise<ScimMember | undefined> {
    if (!isUuid(tenantId) || !isUuid(userId)) return undefined;
    const [row] = await this.memberSelect().where(
      and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
    );
    return row;
  }

  /** the member whose email is `email` (case-insensitive) in the workspace */
  async getMemberByEmail(tenantId: string, email: string): Promise<ScimMember | undefined> {
    if (!isUuid(tenantId)) return undefined;
    const [row] = await this.memberSelect().where(
      and(eq(memberships.tenantId, tenantId), sql`lower(${users.email}) = ${email.toLowerCase()}`),
    );
    return row;
  }

  /** the members of the workspace in creation order, optionally those with one email or one SCIM id */
  async listMembers(
    tenantId: string,
    query: { userName?: string; externalId?: string; offset: number; limit: number },
  ): Promise<{ total: number; rows: ScimMember[] }> {
    if (!isUuid(tenantId)) return { total: 0, rows: [] };
    const where = and(
      eq(memberships.tenantId, tenantId),
      query.userName === undefined ? undefined : sql`lower(${users.email}) = ${query.userName.toLowerCase()}`,
      query.externalId === undefined ? undefined : eq(memberships.externalId, query.externalId),
    );
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(where);
    const rows =
      query.limit === 0
        ? []
        : await this.memberSelect()
            .where(where)
            .orderBy(asc(memberships.createdAt), asc(memberships.userId))
            .limit(query.limit)
            .offset(query.offset);
    return { total: count?.n ?? 0, rows };
  }

  /** the first active owner of the workspace (the home of work with no valid transfer target) */
  async firstOwner(tenantId: string): Promise<string | undefined> {
    if (!isUuid(tenantId)) return undefined;
    const [row] = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.role, 'owner'),
          sql`${memberships.disabledAt} is null`,
        ),
      )
      .orderBy(asc(memberships.createdAt), asc(memberships.userId))
      .limit(1);
    return row?.userId;
  }

  /** removes the account itself (its memberships, tokens and identities go with it) */
  async deleteUser(userId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const rows = await this.db.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
    return rows.length > 0;
  }

  /**
   * merges `patch` into `tenants.settings.scim` in one UPDATE (the rest of the settings and any other writer
   * of the same object stay)
   */
  async patchSettings(tenantId: string, patch: Record<string, unknown>): Promise<void> {
    if (!isUuid(tenantId)) return;
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), '{scim}', coalesce(${tenants.settings} -> 'scim', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
  }
}
