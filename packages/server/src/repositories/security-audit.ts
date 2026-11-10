/**
 * P6-54 (L9): the reads of the security audit, page by page (keyset on id, 200 rows a page). Every query
 * filters tenant_id.
 * Stub from C0; L9 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { CredentialRow, WorkflowRow } from '../db/schema';

export const AUDIT_PAGE_SIZE = 200;

export class SecurityAuditRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** workflows after `afterId` (id order), archived ones included */
  async workflowsPage(
    _tenantId: string,
    _afterId: string | null,
    _limit = AUDIT_PAGE_SIZE,
  ): Promise<WorkflowRow[]> {
    throw new Error('not implemented (L9)');
  }

  async credentialsPage(
    _tenantId: string,
    _afterId: string | null,
    _limit = AUDIT_PAGE_SIZE,
  ): Promise<Array<Pick<CredentialRow, 'id' | 'name' | 'type'>>> {
    throw new Error('not implemented (L9)');
  }

  /** ids of the workflows that ran since `since` */
  async workflowIdsRunSince(_tenantId: string, _since: Date): Promise<string[]> {
    throw new Error('not implemented (L9)');
  }
}
