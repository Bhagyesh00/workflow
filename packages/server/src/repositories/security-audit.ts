/**
 * P6-54 (L9): the reads of the security audit, page by page (keyset on id, 200 rows a page). Every query
 * filters tenant_id with a bound value.
 */
import { and, asc, eq, gt, gte, isNotNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type CredentialRow, credentials, executions, type WorkflowRow, workflows } from '../db/schema';
import { isUuid } from './util';

export const AUDIT_PAGE_SIZE = 200;

export class SecurityAuditRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** workflows after `afterId` (id order), archived ones included */
  async workflowsPage(
    tenantId: string,
    afterId: string | null,
    limit = AUDIT_PAGE_SIZE,
  ): Promise<WorkflowRow[]> {
    if (afterId !== null && !isUuid(afterId)) return [];
    return this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.tenantId, tenantId), afterId ? gt(workflows.id, afterId) : undefined))
      .orderBy(asc(workflows.id))
      .limit(Math.min(Math.max(limit, 1), AUDIT_PAGE_SIZE));
  }

  async credentialsPage(
    tenantId: string,
    afterId: string | null,
    limit = AUDIT_PAGE_SIZE,
  ): Promise<Array<Pick<CredentialRow, 'id' | 'name' | 'type'>>> {
    if (afterId !== null && !isUuid(afterId)) return [];
    return this.db
      .select({ id: credentials.id, name: credentials.name, type: credentials.type })
      .from(credentials)
      .where(and(eq(credentials.tenantId, tenantId), afterId ? gt(credentials.id, afterId) : undefined))
      .orderBy(asc(credentials.id))
      .limit(Math.min(Math.max(limit, 1), AUDIT_PAGE_SIZE));
  }

  /** ids of the workflows that ran since `since` */
  async workflowIdsRunSince(tenantId: string, since: Date): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ workflowId: executions.workflowId })
      .from(executions)
      .where(
        and(
          eq(executions.tenantId, tenantId),
          isNotNull(executions.workflowId),
          gte(executions.createdAt, since),
        ),
      );
    return rows.map((row) => row.workflowId as string);
  }
}
