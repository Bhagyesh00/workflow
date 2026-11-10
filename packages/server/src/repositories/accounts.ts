/** Tenants, users, memberships, sessions, invitations and API keys. */
import { and, asc, count, desc, eq, gt, ilike, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
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

  /**
   * P6-17: sets `settings.firstProductionFailure` once, in one UPDATE that runs only while the key is absent,
   * so of two workers that fail at the same time exactly one gets true (and sends the mail)
   */
  async markFirstProductionFailure(tenantId: string): Promise<boolean> {
    if (!isUuid(tenantId)) return false;
    const mark = { firstProductionFailure: { at: now().toISOString() } };
    const rows = await this.db
      .update(tenants)
      .set({ settings: sql`${tenants.settings} || ${JSON.stringify(mark)}::jsonb` })
      .where(and(eq(tenants.id, tenantId), sql`not (${tenants.settings} ? 'firstProductionFailure')`))
      .returning({ id: tenants.id });
    return rows.length > 0;
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

  /** P6-19: the account's own name (PATCH /auth/me) */
  async updateName(userId: string, name: string): Promise<UserRow | undefined> {
    if (!isUuid(userId)) return undefined;
    const [row] = await this.db.update(users).set({ name }).where(eq(users.id, userId)).returning();
    return row;
  }

  /** P6-19: a confirmed email change; stored lower case, as `create` */
  async updateEmail(userId: string, email: string): Promise<UserRow | undefined> {
    if (!isUuid(userId)) return undefined;
    const [row] = await this.db
      .update(users)
      .set({ email: email.toLowerCase() })
      .where(eq(users.id, userId))
      .returning();
    return row;
  }

  /** P6-19: a new password hash (reset or change); the caller ends the other sessions */
  async updatePassword(userId: string, passwordHash: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const rows = await this.db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  /** P6-02: the workspace whose SCIM client manages this account, or null */
  async setManagedBy(userId: string, tenantId: string | null): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const rows = await this.db
      .update(users)
      .set({ managedByTenantId: tenantId })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    return rows.length > 0;
  }
}

export interface MemberRecord {
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: Date;
  /** P6-02, P6-12: set while the member is disabled (the row stays; `get` does not find it) */
  disabledAt: Date | null;
  /** P6-20: updated at most once a day by the session load (`touchLastActive`) */
  lastActiveAt: Date | null;
  /** P6-01: the member may still sign in with a password while SSO is on */
  allowSsoManualLogin: boolean;
}

/** a membership read that also finds a disabled row */
export interface MembershipState {
  role: Role;
  disabledAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class MembershipRepository {
  constructor(private readonly db: DbOrTx) {}

  async add(tenantId: string, userId: string, role: Role): Promise<void> {
    await this.db
      .insert(memberships)
      .values({ tenantId, userId, role })
      .onConflictDoUpdate({ target: [memberships.tenantId, memberships.userId], set: { role } });
  }

  /**
   * The member's role; a disabled membership (P6-02, P6-12) is not found, so every session, API key, push
   * stream and access check refuses it. Only removal, the role PATCH and invite read `getIncludingDisabled`.
   */
  async get(tenantId: string, userId: string): Promise<{ role: Role } | undefined> {
    if (!isUuid(tenantId) || !isUuid(userId)) return undefined;
    const [row] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, userId),
          isNull(memberships.disabledAt),
        ),
      );
    return row;
  }

  /** the membership even when disabled; only where a disabled member must still be found */
  async getIncludingDisabled(tenantId: string, userId: string): Promise<MembershipState | undefined> {
    if (!isUuid(tenantId) || !isUuid(userId)) return undefined;
    const [row] = await this.db
      .select({ role: memberships.role, disabledAt: memberships.disabledAt })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
    return row;
  }

  /** the user's own tenants (scoped by user, used for the tenant switcher); disabled memberships are left out */
  async listForUser(userId: string) {
    return this.db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, role: memberships.role })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, userId), isNull(memberships.disabledAt)))
      .orderBy(asc(memberships.createdAt), asc(tenants.id));
  }

  /** P6-02, P6-12: disables the membership (kept, not found by `get`); true when it was enabled before */
  async disable(tenantId: string, userId: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(userId)) return false;
    const rows = await this.db
      .update(memberships)
      .set({ disabledAt: now() })
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, userId),
          isNull(memberships.disabledAt),
        ),
      )
      .returning({ userId: memberships.userId });
    return rows.length > 0;
  }

  /** P6-02, P6-12: enables a disabled membership; true when it was disabled before */
  async enable(tenantId: string, userId: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(userId)) return false;
    const rows = await this.db
      .update(memberships)
      .set({ disabledAt: null })
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, userId),
          isNotNull(memberships.disabledAt),
        ),
      )
      .returning({ userId: memberships.userId });
    return rows.length > 0;
  }

  /** P6-20: last active, written only when the stored value is older than a day (one conditional UPDATE) */
  async touchLastActive(tenantId: string, userId: string, at: Date): Promise<void> {
    if (!isUuid(tenantId) || !isUuid(userId)) return;
    await this.db
      .update(memberships)
      .set({ lastActiveAt: at })
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, userId),
          or(isNull(memberships.lastActiveAt), lt(memberships.lastActiveAt, new Date(at.getTime() - DAY_MS))),
        ),
      );
  }

  /** P6-01: lets the member sign in with a password while SSO is on */
  async setAllowSsoManualLogin(tenantId: string, userId: string, allow: boolean): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(userId)) return false;
    const rows = await this.db
      .update(memberships)
      .set({ allowSsoManualLogin: allow })
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .returning({ userId: memberships.userId });
    return rows.length > 0;
  }

  /** P6-02: the SCIM client's id (unique per workspace), null clears it */
  async setExternalId(tenantId: string, userId: string, externalId: string | null): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(userId)) return false;
    const rows = await this.db
      .update(memberships)
      .set({ externalId })
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .returning({ userId: memberships.userId });
    return rows.length > 0;
  }

  /** P6-02: the member a SCIM client knows by its own id; finds a disabled member too (SCIM `active: false`) */
  async getByExternalId(
    tenantId: string,
    externalId: string,
  ): Promise<{ userId: string; role: Role; disabledAt: Date | null } | undefined> {
    if (!isUuid(tenantId)) return undefined;
    const [row] = await this.db
      .select({ userId: memberships.userId, role: memberships.role, disabledAt: memberships.disabledAt })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.externalId, externalId)));
    return row;
  }

  async listForTenant(tenantId: string): Promise<MemberRecord[]> {
    return this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        joinedAt: memberships.createdAt,
        disabledAt: memberships.disabledAt,
        lastActiveAt: memberships.lastActiveAt,
        allowSsoManualLogin: memberships.allowSsoManualLogin,
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

  /**
   * Counts the workspace's owners and locks their rows until the transaction ends, so two removals or
   * role changes cannot both take the last owner away (P6-31). Call it inside a transaction.
   */
  async lockOwners(tenantId: string): Promise<number> {
    const rows = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'owner')))
      .for('update');
    return rows.length;
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

  /** `authMethod` (default 'password') and `mfaVerified` (default false) are columns of the row (P6-01, P6-18) */
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

  /** P6-18, P6-19: ends every other session of the user (password change, MFA on), keeping this one */
  async deleteForUserExcept(userId: string, sessionId: string): Promise<number> {
    if (!isUuid(userId)) return 0;
    const rows = await this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, sessionId)))
      .returning({ id: sessions.id });
    return rows.length;
  }

  /** P6-19: ends every session of the user in every workspace (password reset, email change) */
  async deleteForUser(userId: string): Promise<number> {
    if (!isUuid(userId)) return 0;
    const rows = await this.db
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    return rows.length;
  }

  /** P6-18: the session passed the MFA step (enforced MFA set up after sign-in) */
  async setMfaVerified(id: string): Promise<void> {
    await this.db.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, id));
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

  /** P6-20: one invitation of the workspace, pending or not */
  async get(tenantId: string, id: string) {
    if (!isUuid(tenantId) || !isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, id)));
    return row;
  }

  /**
   * P6-20: a new token and expiry on a pending invitation (resend, copy link); the old link stops working.
   * Undefined when the invitation is not pending in this workspace.
   */
  async rotate(tenantId: string, id: string, tokenHash: string, expiresAt: Date) {
    if (!isUuid(tenantId) || !isUuid(id)) return undefined;
    const [row] = await this.db
      .update(invitations)
      .set({ tokenHash, expiresAt })
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, id), isNull(invitations.acceptedAt)))
      .returning();
    return row;
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

/** what a key list shows: never the hash */
const apiKeyListColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  audience: apiKeys.audience,
  lastUsedAt: apiKeys.lastUsedAt,
  createdAt: apiKeys.createdAt,
  /** P6-21: null = never expires */
  expiresAt: apiKeys.expiresAt,
};

/** P6-21: a key row of the list, never the hash */
export type ApiKeyListRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  audience: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
};

/** P6-21: a key of the workspace's list (`apiKey:manage`), with its owner */
export type ApiKeyWithOwnerRow = ApiKeyListRow & { userId: string; ownerName: string; ownerEmail: string };

/** P5-04: the audience of a key on the API keys page; MCP keys use `mcp-server-api` */
export const PUBLIC_API_AUDIENCE = 'public-api';

export class ApiKeyRepository {
  constructor(private readonly db: DbOrTx) {}

  /**
   * `audience` defaults to `public-api` in the database when the input leaves it out (P5-04); `expiresAt`
   * (P6-21) null or absent = never expires
   */
  async create(input: typeof apiKeys.$inferInsert) {
    const [row] = await this.db.insert(apiKeys).values(input).returning();
    return row;
  }

  /** the user's keys of one audience; the API keys page lists `public-api` only, so an MCP key never shows */
  async list(tenantId: string, userId: string, audience: string = PUBLIC_API_AUDIENCE) {
    return this.db
      .select(apiKeyListColumns)
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.userId, userId), eq(apiKeys.audience, audience)))
      .orderBy(desc(apiKeys.createdAt));
  }

  /** deletes one key of the given audience, so the API keys page cannot delete an MCP key */
  async delete(
    tenantId: string,
    userId: string,
    id: string,
    audience: string = PUBLIC_API_AUDIENCE,
  ): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(apiKeys)
      .where(
        and(
          eq(apiKeys.tenantId, tenantId),
          eq(apiKeys.userId, userId),
          eq(apiKeys.id, id),
          eq(apiKeys.audience, audience),
        ),
      )
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }

  /** P5-04: the user's newest key of one audience (the MCP key: one per user), without its hash */
  async getForUser(tenantId: string, userId: string, audience: string) {
    const [row] = await this.db
      .select(apiKeyListColumns)
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.userId, userId), eq(apiKeys.audience, audience)))
      .orderBy(desc(apiKeys.createdAt))
      .limit(1);
    return row;
  }

  /** P5-04: deletes every key of the user in one audience (MCP key rotate and revoke); true when any went */
  async deleteForUser(tenantId: string, userId: string, audience: string): Promise<boolean> {
    const rows = await this.db
      .delete(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.userId, userId), eq(apiKeys.audience, audience)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }

  /** P6-31: deletes every key of the user in the workspace, whatever its audience (the member was removed) */
  async deleteAllForUser(tenantId: string, userId: string): Promise<number> {
    const rows = await this.db
      .delete(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.userId, userId)))
      .returning({ id: apiKeys.id });
    return rows.length;
  }

  /** lookup by sha256(key); the hash is the capability. The row holds `audience`: the caller checks it */
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

  /** P6-21: the owner's own `public-api` key: name and scopes; undefined when not theirs or not found */
  async update(
    tenantId: string,
    userId: string,
    id: string,
    patch: { name?: string; scopes?: string[] },
  ): Promise<ApiKeyListRow | undefined> {
    if (!isUuid(id)) return undefined;
    const set: Partial<typeof apiKeys.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.scopes !== undefined) set.scopes = patch.scopes;
    const where = and(
      eq(apiKeys.tenantId, tenantId),
      eq(apiKeys.userId, userId),
      eq(apiKeys.id, id),
      eq(apiKeys.audience, PUBLIC_API_AUDIENCE),
    );
    if (!Object.keys(set).length) {
      const [row] = await this.db.select(apiKeyListColumns).from(apiKeys).where(where);
      return row;
    }
    const [row] = await this.db.update(apiKeys).set(set).where(where).returning(apiKeyListColumns);
    return row;
  }

  /**
   * P6-21: a new secret on the same row (new prefix and hash; name, scopes and expiry kept); the owner's own
   * `public-api` key only. The service refuses an expired key before it calls this.
   */
  async rotate(
    tenantId: string,
    userId: string,
    id: string,
    secret: { prefix: string; keyHash: string },
  ): Promise<ApiKeyListRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .update(apiKeys)
      .set({ prefix: secret.prefix, keyHash: secret.keyHash, lastUsedAt: null })
      .where(
        and(
          eq(apiKeys.tenantId, tenantId),
          eq(apiKeys.userId, userId),
          eq(apiKeys.id, id),
          eq(apiKeys.audience, PUBLIC_API_AUDIENCE),
        ),
      )
      .returning(apiKeyListColumns);
    return row;
  }

  /** P6-21: every `public-api` key of the workspace with its owner (`apiKey:manage`); MCP keys never show */
  async listAll(
    tenantId: string,
    filter: { userId?: string; name?: string } = {},
  ): Promise<ApiKeyWithOwnerRow[]> {
    const conditions = [eq(apiKeys.tenantId, tenantId), eq(apiKeys.audience, PUBLIC_API_AUDIENCE)];
    if (filter.userId) {
      if (!isUuid(filter.userId)) return [];
      conditions.push(eq(apiKeys.userId, filter.userId));
    }
    if (filter.name) conditions.push(ilike(apiKeys.name, `%${filter.name.replace(/[\\%_]/g, '\\$&')}%`));
    return this.db
      .select({
        ...apiKeyListColumns,
        userId: apiKeys.userId,
        ownerName: users.name,
        ownerEmail: users.email,
      })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(and(...conditions))
      .orderBy(desc(apiKeys.createdAt));
  }

  /** P6-21: an admin deletes any `public-api` key of the workspace; the deleted row, so the owner can be told */
  async deleteAny(
    tenantId: string,
    id: string,
  ): Promise<{ id: string; userId: string; name: string } | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .delete(apiKeys)
      .where(
        and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, id), eq(apiKeys.audience, PUBLIC_API_AUDIENCE)),
      )
      .returning({ id: apiKeys.id, userId: apiKeys.userId, name: apiKeys.name });
    return row;
  }

  /**
   * P6-21: removes the given scopes from every `public-api` key of the user in the workspace (a role change
   * took them away); the number of keys that changed
   */
  async stripScopes(tenantId: string, userId: string, scopes: string[]): Promise<number> {
    if (!scopes.length || !isUuid(userId)) return 0;
    const drop = sql`array[${sql.join(
      scopes.map((s) => sql`${s}`),
      sql`, `,
    )}]::text[]`;
    const rows = await this.db
      .update(apiKeys)
      .set({ scopes: sql`array(select s from unnest(${apiKeys.scopes}) as s where s <> all(${drop}))` })
      .where(
        and(
          eq(apiKeys.tenantId, tenantId),
          eq(apiKeys.userId, userId),
          eq(apiKeys.audience, PUBLIC_API_AUDIENCE),
          sql`${apiKeys.scopes} && ${drop}`,
        ),
      )
      .returning({ id: apiKeys.id });
    return rows.length;
  }
}
