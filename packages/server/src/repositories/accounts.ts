/** Tenants, users, memberships, sessions, invitations and API keys. */
import { and, asc, count, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  apiKeys,
  invitations,
  memberships,
  type Role,
  sessions,
  type TenantRow,
  tenants,
  type UserRow,
  users,
} from '../db/schema';
import { isUuid, now } from './util';

export class TenantRepository {
  constructor(private readonly db: DbOrTx) {}

  async create(input: { name: string; slug: string; plan: string }): Promise<TenantRow> {
    const [row] = await this.db.insert(tenants).values(input).returning();
    return row;
  }

  async get(tenantId: string): Promise<TenantRow | undefined> {
    if (!isUuid(tenantId)) return undefined;
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId));
    return row;
  }

  async getBySlug(slug: string): Promise<TenantRow | undefined> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.slug, slug));
    return row;
  }

  async slugExists(slug: string): Promise<boolean> {
    const [row] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
    return Boolean(row);
  }

  async updateSettings(tenantId: string, settings: Record<string, unknown>): Promise<TenantRow | undefined> {
    const [row] = await this.db.update(tenants).set({ settings }).where(eq(tenants.id, tenantId)).returning();
    return row;
  }

  async delete(tenantId: string): Promise<boolean> {
    const rows = await this.db.delete(tenants).where(eq(tenants.id, tenantId)).returning({ id: tenants.id });
    return rows.length > 0;
  }

  async update(tenantId: string, patch: Partial<Pick<TenantRow, 'name' | 'plan' | 'settings'>>) {
    const [row] = await this.db.update(tenants).set(patch).where(eq(tenants.id, tenantId)).returning();
    return row;
  }
}

export class UserRepository {
  constructor(private readonly db: DbOrTx) {}

  async create(input: { email: string; name: string; passwordHash: string }): Promise<UserRow> {
    const [row] = await this.db
      .insert(users)
      .values({ ...input, email: input.email.toLowerCase() })
      .returning();
    return row;
  }

  async getByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    return row;
  }

  async get(userId: string): Promise<UserRow | undefined> {
    if (!isUuid(userId)) return undefined;
    const [row] = await this.db.select().from(users).where(eq(users.id, userId));
    return row;
  }

  async touchLogin(userId: string): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: now() }).where(eq(users.id, userId));
  }
}

export interface MemberRecord {
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: Date;
}

export class MembershipRepository {
  constructor(private readonly db: DbOrTx) {}

  async add(tenantId: string, userId: string, role: Role): Promise<void> {
    await this.db
      .insert(memberships)
      .values({ tenantId, userId, role })
      .onConflictDoUpdate({ target: [memberships.tenantId, memberships.userId], set: { role } });
  }

  async get(tenantId: string, userId: string): Promise<{ role: Role } | undefined> {
    if (!isUuid(tenantId) || !isUuid(userId)) return undefined;
    const [row] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
    return row;
  }

  /** the user's own tenants (scoped by user, used for the tenant switcher) */
  async listForUser(userId: string) {
    return this.db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, role: memberships.role })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(memberships.createdAt), asc(tenants.id));
  }

  async listForTenant(tenantId: string): Promise<MemberRecord[]> {
    return this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, tenantId))
      .orderBy(asc(memberships.createdAt));
  }

  async updateRole(tenantId: string, userId: string, role: Role): Promise<boolean> {
    const rows = await this.db
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .returning({ userId: memberships.userId });
    return rows.length > 0;
  }

  async remove(tenantId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .returning({ userId: memberships.userId });
    return rows.length > 0;
  }

  async countOwners(tenantId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'owner')));
    return Number(row?.n ?? 0);
  }
}

export class SessionRepository {
  constructor(private readonly db: DbOrTx) {}

  async create(input: typeof sessions.$inferInsert): Promise<void> {
    await this.db.insert(sessions).values(input);
  }

  /** lookup by sha256(token); the hash is the capability */
  async get(id: string) {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now())));
    return row;
  }

  async extend(id: string, expiresAt: Date): Promise<void> {
    await this.db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
  }

  async switchTenant(id: string, tenantId: string): Promise<void> {
    await this.db.update(sessions).set({ tenantId }).where(eq(sessions.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, id));
  }

  async deleteForUserInTenant(tenantId: string, userId: string): Promise<void> {
    await this.db.delete(sessions).where(and(eq(sessions.tenantId, tenantId), eq(sessions.userId, userId)));
  }

  async deleteExpired(): Promise<number> {
    const rows = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, now()))
      .returning({ id: sessions.id });
    return rows.length;
  }
}

export class InvitationRepository {
  constructor(private readonly db: DbOrTx) {}

  async create(input: typeof invitations.$inferInsert) {
    const [row] = await this.db.insert(invitations).values(input).returning();
    return row;
  }

  /** lookup by sha256(token); the hash is the capability */
  async getPendingByTokenHash(tokenHash: string) {
    const [row] = await this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, now()),
        ),
      );
    return row;
  }

  async markAccepted(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(invitations)
      .set({ acceptedAt: now() })
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, id), isNull(invitations.acceptedAt)))
      .returning({ id: invitations.id });
    return rows.length > 0;
  }

  async listPending(tenantId: string) {
    return this.db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, now()),
        ),
      )
      .orderBy(desc(invitations.createdAt));
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, id)))
      .returning({ id: invitations.id });
    return rows.length > 0;
  }
}

export class ApiKeyRepository {
  constructor(private readonly db: DbOrTx) {}

  async create(input: typeof apiKeys.$inferInsert) {
    const [row] = await this.db.insert(apiKeys).values(input).returning();
    return row;
  }

  async list(tenantId: string, userId: string) {
    return this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.userId, userId)))
      .orderBy(desc(apiKeys.createdAt));
  }

  async delete(tenantId: string, userId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.userId, userId), eq(apiKeys.id, id)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }

  /** lookup by sha256(key); the hash is the capability */
  async getByHash(keyHash: string) {
    const [row] = await this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
    return row;
  }

  async touch(tenantId: string, id: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: now() })
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, id)));
  }
}
