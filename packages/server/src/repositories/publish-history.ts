/**
 * Publish timeline rows (P3-16): one per publish ('activated') or unpublish ('deactivated').
 * Every read and write is scoped to the tenant; a row only links a version, user and workflow of
 * that tenant. The version link goes NULL when history compaction prunes the version.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { users, workflowPublishHistory, workflowVersions } from '../db/schema';
import { isUuid, now } from './util';

export type PublishEvent = 'activated' | 'deactivated';

export interface PublishTimelineEntry {
  /** the bigserial id as a string (the editor's PublishTimelineEntry.id) */
  id: string;
  event: PublishEvent;
  /** null once the version was pruned ("Published a version") */
  versionId: string | null;
  versionName: string | null;
  userId: string | null;
  userName: string | null;
  createdAt: string;
}

export class PublishHistoryRepository {
  constructor(readonly db: DbOrTx) {}

  /**
   * Adds a row when the workflow exists in the tenant (returns false otherwise). A version that is
   * not a version of this workflow, or a user that no longer exists, is stored as NULL.
   */
  async add(
    tenantId: string,
    entry: { workflowId: string; event: PublishEvent; versionId: string | null; userId?: string | null },
  ): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(entry.workflowId)) return false;
    const versionId = isUuid(entry.versionId) ? entry.versionId : null;
    const userId = isUuid(entry.userId) ? entry.userId : null;
    const result = await this.db.execute(sql`
      INSERT INTO workflow_publish_history (tenant_id, workflow_id, version_id, event, user_id, created_at)
      SELECT w.tenant_id, w.id,
        (SELECT v.id FROM workflow_versions v
          WHERE v.tenant_id = ${tenantId}::uuid AND v.workflow_id = w.id AND v.id = ${versionId}::uuid),
        ${entry.event},
        (SELECT u.id FROM users u WHERE u.id = ${userId}::uuid),
        ${now()}
      FROM workflows w
      WHERE w.tenant_id = ${tenantId}::uuid AND w.id = ${entry.workflowId}::uuid`);
    return (result.rowCount ?? 0) > 0;
  }

  /** newest first */
  async list(
    tenantId: string,
    workflowId: string,
    page: { skip: number; take: number },
  ): Promise<PublishTimelineEntry[]> {
    if (!isUuid(tenantId) || !isUuid(workflowId)) return [];
    const rows = await this.db
      .select({
        id: workflowPublishHistory.id,
        event: workflowPublishHistory.event,
        versionId: workflowVersions.id,
        versionName: workflowVersions.versionName,
        userId: workflowPublishHistory.userId,
        userName: users.name,
        createdAt: workflowPublishHistory.createdAt,
      })
      .from(workflowPublishHistory)
      .leftJoin(
        workflowVersions,
        and(
          eq(workflowVersions.id, workflowPublishHistory.versionId),
          eq(workflowVersions.tenantId, workflowPublishHistory.tenantId),
        ),
      )
      .leftJoin(users, eq(users.id, workflowPublishHistory.userId))
      .where(and(eq(workflowPublishHistory.tenantId, tenantId), eq(workflowPublishHistory.workflowId, workflowId)))
      .orderBy(desc(workflowPublishHistory.id))
      .offset(page.skip)
      .limit(page.take);
    return rows.map((row) => ({
      id: String(row.id),
      event: row.event,
      versionId: row.versionId ?? null,
      versionName: row.versionName ?? null,
      userId: row.userId ?? null,
      userName: row.userName ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
