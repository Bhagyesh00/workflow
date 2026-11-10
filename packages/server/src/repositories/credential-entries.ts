/**
 * P6-15 (L14): private credential entries (`credential_user_entries`): one encrypted connection per
 * credential and member, under RLS. Also the few reads around them: the `is_resolvable` flag of a credential,
 * which list rows use one, and the run flag `executions.used_private_credentials`. Every query filters
 * `tenant_id` with a bound value.
 */
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type CredentialUserEntryRow,
  credentials,
  credentialUserEntries,
  executions,
  workflows,
} from '../db/schema';
import { inUuids } from './shares';
import { isUuid, now } from './util';

/** one connection: whose and on which credential */
export interface CredentialEntryKey {
  credentialId: string;
  userId: string;
}

const uuids = (ids: readonly string[]) => [...new Set(ids.filter(isUuid))];

export class CredentialEntryRepository {
  constructor(private readonly db: DbOrTx) {}

  async get(
    tenantId: string,
    credentialId: string,
    userId: string,
  ): Promise<CredentialUserEntryRow | undefined> {
    if (!isUuid(credentialId) || !isUuid(userId)) return undefined;
    const [row] = await this.db
      .select()
      .from(credentialUserEntries)
      .where(
        and(
          eq(credentialUserEntries.tenantId, tenantId),
          eq(credentialUserEntries.credentialId, credentialId),
          eq(credentialUserEntries.userId, userId),
        ),
      );
    return row;
  }

  /** creates or replaces the member's entry */
  async save(tenantId: string, credentialId: string, userId: string, dataEnc: string): Promise<void> {
    const at = now();
    await this.db
      .insert(credentialUserEntries)
      .values({ tenantId, credentialId, userId, dataEnc, createdAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: [credentialUserEntries.credentialId, credentialUserEntries.userId],
        set: { dataEnc, updatedAt: at },
        // the key has no tenant: a row of another workspace is never overwritten
        setWhere: eq(credentialUserEntries.tenantId, tenantId),
      });
  }

  async delete(tenantId: string, credentialId: string, userId: string): Promise<boolean> {
    if (!isUuid(credentialId) || !isUuid(userId)) return false;
    const rows = await this.db
      .delete(credentialUserEntries)
      .where(
        and(
          eq(credentialUserEntries.tenantId, tenantId),
          eq(credentialUserEntries.credentialId, credentialId),
          eq(credentialUserEntries.userId, userId),
        ),
      )
      .returning({ userId: credentialUserEntries.userId });
    return rows.length > 0;
  }

  /** every connection of a credential (switch to fixed, a shared field changed) */
  async deleteForCredential(tenantId: string, credentialId: string): Promise<number> {
    if (!isUuid(credentialId)) return 0;
    const rows = await this.db
      .delete(credentialUserEntries)
      .where(
        and(
          eq(credentialUserEntries.tenantId, tenantId),
          eq(credentialUserEntries.credentialId, credentialId),
        ),
      )
      .returning({ userId: credentialUserEntries.userId });
    return rows.length;
  }

  /** the entries of the given members on the given credentials (access was lost); both lists AND */
  async deleteWhere(
    tenantId: string,
    scope: { userIds?: string[]; credentialIds?: string[] },
  ): Promise<number> {
    const conditions: SQL[] = [eq(credentialUserEntries.tenantId, tenantId)];
    if (scope.userIds) {
      const ids = uuids(scope.userIds);
      if (!ids.length) return 0;
      conditions.push(inArray(credentialUserEntries.userId, ids));
    }
    if (scope.credentialIds) {
      const ids = uuids(scope.credentialIds);
      if (!ids.length) return 0;
      conditions.push(inArray(credentialUserEntries.credentialId, ids));
    }
    if (conditions.length === 1) return 0;
    const rows = await this.db
      .delete(credentialUserEntries)
      .where(and(...conditions))
      .returning({ userId: credentialUserEntries.userId });
    return rows.length;
  }

  /** which of the credentials the member has connected */
  async connectedIds(tenantId: string, userId: string, credentialIds: string[]): Promise<Set<string>> {
    const ids = uuids(credentialIds);
    if (!ids.length || !isUuid(userId)) return new Set();
    const rows = await this.db
      .select({ credentialId: credentialUserEntries.credentialId })
      .from(credentialUserEntries)
      .where(
        and(
          eq(credentialUserEntries.tenantId, tenantId),
          eq(credentialUserEntries.userId, userId),
          inArray(credentialUserEntries.credentialId, ids),
        ),
      );
    return new Set(rows.map((row) => row.credentialId));
  }

  /** how many members connected each credential (absent = none) */
  async countByCredential(tenantId: string, credentialIds: string[]): Promise<Map<string, number>> {
    const ids = uuids(credentialIds);
    if (!ids.length) return new Map();
    const rows = await this.db
      .select({ credentialId: credentialUserEntries.credentialId, count: sql<number>`count(*)::int` })
      .from(credentialUserEntries)
      .where(
        and(eq(credentialUserEntries.tenantId, tenantId), inArray(credentialUserEntries.credentialId, ids)),
      )
      .groupBy(credentialUserEntries.credentialId);
    return new Map(rows.map((row) => [row.credentialId, Number(row.count)]));
  }

  /** the connections of one member, one credential, both, or (no filter) the whole workspace */
  async list(
    tenantId: string,
    scope: { userId?: string; credentialId?: string } = {},
  ): Promise<CredentialEntryKey[]> {
    const conditions: SQL[] = [eq(credentialUserEntries.tenantId, tenantId)];
    if (scope.userId !== undefined) {
      if (!isUuid(scope.userId)) return [];
      conditions.push(eq(credentialUserEntries.userId, scope.userId));
    }
    if (scope.credentialId !== undefined) {
      if (!isUuid(scope.credentialId)) return [];
      conditions.push(eq(credentialUserEntries.credentialId, scope.credentialId));
    }
    return this.db
      .select({ credentialId: credentialUserEntries.credentialId, userId: credentialUserEntries.userId })
      .from(credentialUserEntries)
      .where(and(...conditions));
  }

  /** turns a credential private (true) or back to fixed (false) */
  async setResolvable(tenantId: string, credentialId: string, isResolvable: boolean): Promise<void> {
    if (!isUuid(credentialId)) return;
    await this.db
      .update(credentials)
      .set({ isResolvable, updatedAt: now() })
      .where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, credentialId)));
  }

  /** which of the credentials are private */
  async resolvableIds(tenantId: string, credentialIds: string[]): Promise<Set<string>> {
    const ids = uuids(credentialIds);
    if (!ids.length) return new Set();
    const rows = await this.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenantId, tenantId),
          inArray(credentials.id, ids),
          eq(credentials.isResolvable, true),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  /** the private credentials of the workspace with one of these names */
  async resolvableByName(tenantId: string, names: string[]): Promise<Array<{ id: string; name: string }>> {
    const wanted = [...new Set(names.filter((name) => name !== ''))];
    if (!wanted.length) return [];
    return this.db
      .select({ id: credentials.id, name: credentials.name })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenantId, tenantId),
          inArray(credentials.name, wanted),
          eq(credentials.isResolvable, true),
        ),
      );
  }

  /** the private credentials a project owns or is shared (a project delete must not move them to a personal one) */
  async resolvableInProject(
    tenantId: string,
    projectId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    if (!isUuid(projectId)) return [];
    return this.db
      .select({ id: credentials.id, name: credentials.name })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenantId, tenantId),
          eq(credentials.isResolvable, true),
          eq(credentials.projectId, projectId),
        ),
      );
  }

  /**
   * Which of the workflows name a private credential by id in their nodes (the draft), one query for a page of
   * list rows. A node's credential ref is `{ id, name }` under `credentials.<type>`.
   */
  async workflowsUsingPrivate(tenantId: string, workflowIds: string[]): Promise<Set<string>> {
    const ids = uuids(workflowIds);
    if (!ids.length) return new Set();
    const rows = await this.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, tenantId),
          inUuids(workflows.id, ids),
          sql`exists (select 1 from jsonb_array_elements(case when jsonb_typeof(${workflows.nodes}) = 'array' then ${workflows.nodes} else '[]'::jsonb end) as n(node)
            cross join lateral jsonb_each(case when jsonb_typeof(n.node -> 'credentials') = 'object' then n.node -> 'credentials' else '{}'::jsonb end) as c(slot, ref)
            join ${credentials} on ${credentials.tenantId} = ${tenantId}::uuid and ${credentials.isResolvable} = true
              and ${credentials.id}::text = (case when jsonb_typeof(c.ref) = 'object' then c.ref ->> 'id' end))`,
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  /** the run used a member's own connection (the execution list shows it) */
  async markExecutionUsed(tenantId: string, executionId: string): Promise<void> {
    if (!isUuid(executionId)) return;
    await this.db
      .update(executions)
      .set({ usedPrivateCredentials: true })
      .where(and(eq(executions.tenantId, tenantId), eq(executions.id, executionId)));
  }
}
