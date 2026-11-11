/**
 * P6-48 (L1): the type policy tables (`type_policy_scopes`, `type_policies`, `type_policy_attachments`,
 * migration 0032). Every query filters tenant_id. The attachment's policy key is NO ACTION and deferred, so
 * an attached policy's delete fails at COMMIT (or at the statement after `SET CONSTRAINTS ALL IMMEDIATE`).
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type TypePolicyAttachmentRow,
  type TypePolicyRow,
  type TypePolicyScopeRow,
  typePolicies,
  typePolicyAttachments,
  typePolicyScopes,
} from '../db/schema';
import { isUuid } from './util';

export type TypePolicyKindValue = TypePolicyScopeRow['kind'];

/** one tenant's three tables at once, for the snapshot */
export interface TenantTypePolicyRows {
  scopes: TypePolicyScopeRow[];
  policies: TypePolicyRow[];
  attachments: TypePolicyAttachmentRow[];
}

export class TypePolicyRepository {
  constructor(protected readonly db: DbOrTx) {}

  async getScope(
    tenantId: string,
    kind: TypePolicyKindValue,
    projectId: string | null,
  ): Promise<TypePolicyScopeRow | undefined> {
    if (projectId !== null && !isUuid(projectId)) return undefined;
    const [row] = await this.db
      .select()
      .from(typePolicyScopes)
      .where(
        and(
          eq(typePolicyScopes.tenantId, tenantId),
          eq(typePolicyScopes.kind, kind),
          projectId === null ? isNull(typePolicyScopes.projectId) : eq(typePolicyScopes.projectId, projectId),
        ),
      )
      .limit(1);
    return row;
  }

  async getScopeById(tenantId: string, scopeId: string): Promise<TypePolicyScopeRow | undefined> {
    if (!isUuid(scopeId)) return undefined;
    const [row] = await this.db
      .select()
      .from(typePolicyScopes)
      .where(and(eq(typePolicyScopes.tenantId, tenantId), eq(typePolicyScopes.id, scopeId)))
      .limit(1);
    return row;
  }

  /** inserts at version 1 when `expectedVersion` is 0, else updates where the version matches; undefined when stale */
  async writeScope(
    tenantId: string,
    input: {
      kind: TypePolicyKindValue;
      projectId: string | null;
      defaultAction: TypePolicyScopeRow['defaultAction'];
      expectedVersion: number;
    },
  ): Promise<TypePolicyScopeRow | undefined> {
    const { kind, projectId, defaultAction, expectedVersion } = input;
    if (expectedVersion === 0) {
      const [inserted] = await this.db
        .insert(typePolicyScopes)
        .values({ tenantId, kind, projectId, defaultAction, version: 1 })
        .onConflictDoNothing()
        .returning();
      if (inserted) return inserted;
    }
    const [updated] = await this.db
      .update(typePolicyScopes)
      .set({ defaultAction, version: sql`${typePolicyScopes.version} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(typePolicyScopes.tenantId, tenantId),
          eq(typePolicyScopes.kind, kind),
          projectId === null ? isNull(typePolicyScopes.projectId) : eq(typePolicyScopes.projectId, projectId),
          eq(typePolicyScopes.version, expectedVersion),
        ),
      )
      .returning();
    return updated;
  }

  /** raises one scope's version (its attachments changed); undefined when the version is stale */
  async touchScope(
    tenantId: string,
    scopeId: string,
    expectedVersion: number,
  ): Promise<TypePolicyScopeRow | undefined> {
    const [row] = await this.db
      .update(typePolicyScopes)
      .set({ version: sql`${typePolicyScopes.version} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(typePolicyScopes.tenantId, tenantId),
          eq(typePolicyScopes.id, scopeId),
          eq(typePolicyScopes.version, expectedVersion),
        ),
      )
      .returning();
    return row;
  }

  /** a document changed: the scopes that attach it get a new version */
  async bumpScopes(tenantId: string, scopeIds: string[]): Promise<void> {
    if (scopeIds.length === 0) return;
    await this.db
      .update(typePolicyScopes)
      .set({ version: sql`${typePolicyScopes.version} + 1`, updatedAt: new Date() })
      .where(and(eq(typePolicyScopes.tenantId, tenantId), inArray(typePolicyScopes.id, scopeIds)));
  }

  async listPolicies(tenantId: string, kind: TypePolicyKindValue): Promise<TypePolicyRow[]> {
    return this.db
      .select()
      .from(typePolicies)
      .where(and(eq(typePolicies.tenantId, tenantId), eq(typePolicies.kind, kind)))
      .orderBy(asc(typePolicies.createdAt), asc(typePolicies.name));
  }

  async getPolicy(tenantId: string, policyId: string): Promise<TypePolicyRow | undefined> {
    if (!isUuid(policyId)) return undefined;
    const [row] = await this.db
      .select()
      .from(typePolicies)
      .where(and(eq(typePolicies.tenantId, tenantId), eq(typePolicies.id, policyId)))
      .limit(1);
    return row;
  }

  /** the tenant's documents among `policyIds` (an id of another tenant is absent) */
  async getPolicies(tenantId: string, policyIds: string[]): Promise<TypePolicyRow[]> {
    const valid = policyIds.filter(isUuid);
    if (valid.length === 0) return [];
    return this.db
      .select()
      .from(typePolicies)
      .where(and(eq(typePolicies.tenantId, tenantId), inArray(typePolicies.id, valid)));
  }

  async insertPolicy(
    tenantId: string,
    input: { kind: TypePolicyKindValue; name: string; description: string | null; rules: unknown[] },
  ): Promise<TypePolicyRow> {
    const [row] = await this.db
      .insert(typePolicies)
      .values({
        tenantId,
        kind: input.kind,
        name: input.name,
        description: input.description,
        rules: input.rules,
        version: 1,
      })
      .returning();
    return row;
  }

  /** undefined when the version is stale */
  async updatePolicy(
    tenantId: string,
    policyId: string,
    patch: { name?: string; description?: string | null; rules?: unknown[] },
    expectedVersion: number,
  ): Promise<TypePolicyRow | undefined> {
    if (!isUuid(policyId)) return undefined;
    const [row] = await this.db
      .update(typePolicies)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.rules !== undefined ? { rules: patch.rules } : {}),
        version: sql`${typePolicies.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(typePolicies.tenantId, tenantId),
          eq(typePolicies.id, policyId),
          eq(typePolicies.version, expectedVersion),
        ),
      )
      .returning();
    return row;
  }

  /** false when the policy is gone or its version is not `expectedVersion` */
  async deletePolicy(tenantId: string, policyId: string, expectedVersion: number): Promise<boolean> {
    if (!isUuid(policyId)) return false;
    const rows = await this.db
      .delete(typePolicies)
      .where(
        and(
          eq(typePolicies.tenantId, tenantId),
          eq(typePolicies.id, policyId),
          eq(typePolicies.version, expectedVersion),
        ),
      )
      .returning({ id: typePolicies.id });
    return rows.length > 0;
  }

  /** floors first, then by priority */
  async listAttachments(tenantId: string, scopeId: string): Promise<TypePolicyAttachmentRow[]> {
    if (!isUuid(scopeId)) return [];
    return this.db
      .select()
      .from(typePolicyAttachments)
      .where(and(eq(typePolicyAttachments.tenantId, tenantId), eq(typePolicyAttachments.scopeId, scopeId)))
      .orderBy(desc(typePolicyAttachments.isFloor), asc(typePolicyAttachments.priority));
  }

  async replaceAttachments(
    tenantId: string,
    scopeId: string,
    rows: Array<{ policyId: string; priority: number; isFloor: boolean }>,
  ): Promise<TypePolicyAttachmentRow[]> {
    await this.db
      .delete(typePolicyAttachments)
      .where(and(eq(typePolicyAttachments.tenantId, tenantId), eq(typePolicyAttachments.scopeId, scopeId)));
    if (rows.length > 0) {
      await this.db.insert(typePolicyAttachments).values(
        rows.map((r) => ({
          tenantId,
          scopeId,
          policyId: r.policyId,
          priority: r.priority,
          isFloor: r.isFloor,
        })),
      );
    }
    return this.listAttachments(tenantId, scopeId);
  }

  /** the scopes that attach a policy (a delete is refused while any does) */
  async scopesAttaching(tenantId: string, policyId: string): Promise<string[]> {
    if (!isUuid(policyId)) return [];
    const rows = await this.db
      .select({ scopeId: typePolicyAttachments.scopeId })
      .from(typePolicyAttachments)
      .where(and(eq(typePolicyAttachments.tenantId, tenantId), eq(typePolicyAttachments.policyId, policyId)));
    return rows.map((r) => r.scopeId);
  }

  async loadTenant(tenantId: string): Promise<TenantTypePolicyRows> {
    const [scopes, policies, attachments] = await Promise.all([
      this.db.select().from(typePolicyScopes).where(eq(typePolicyScopes.tenantId, tenantId)),
      this.db.select().from(typePolicies).where(eq(typePolicies.tenantId, tenantId)),
      this.db
        .select()
        .from(typePolicyAttachments)
        .where(eq(typePolicyAttachments.tenantId, tenantId))
        .orderBy(desc(typePolicyAttachments.isFloor), asc(typePolicyAttachments.priority)),
    ]);
    return { scopes, policies, attachments };
  }
}
