/**
 * AI builder sessions (P5-66): one chat per user and workflow. Every query names the tenant, the
 * workflow and the user, so one user never reads another user's chat on the same workflow.
 */
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { workflowBuilderSessions } from '../db/schema';
import { isUuid, now } from './util';

export type BuilderSessionRow = typeof workflowBuilderSessions.$inferSelect;

/** the fields a turn, a truncate, an accepted draft or a compaction may change; absent keys stay */
export type BuilderSessionPatch = Partial<
  Pick<
    BuilderSessionRow,
    | 'messages'
    | 'previousSummary'
    | 'activeVersionCardId'
    | 'resumeAfterRestoreMessageId'
    | 'allowedWebDomains'
  >
>;

export class BuilderSessionRepository {
  constructor(private readonly db: DbOrTx) {}

  private where(tenantId: string, workflowId: string, userId: string) {
    return and(
      eq(workflowBuilderSessions.tenantId, tenantId),
      eq(workflowBuilderSessions.workflowId, workflowId),
      eq(workflowBuilderSessions.userId, userId),
    );
  }

  /** the session, or undefined when the user has none on this workflow */
  async get(tenantId: string, workflowId: string, userId: string): Promise<BuilderSessionRow | undefined> {
    if (!isUuid(tenantId) || !isUuid(workflowId) || !isUuid(userId)) return undefined;
    const [row] = await this.db
      .select()
      .from(workflowBuilderSessions)
      .where(this.where(tenantId, workflowId, userId));
    return row;
  }

  /**
   * Creates the session on first use, else writes only the keys the patch holds (`undefined` keys are
   * left as they are). Returns the row after the write.
   */
  async upsert(
    tenantId: string,
    workflowId: string,
    userId: string,
    patch: BuilderSessionPatch,
  ): Promise<BuilderSessionRow> {
    const values = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as BuilderSessionPatch;
    const [row] = await this.db
      .insert(workflowBuilderSessions)
      .values({ tenantId, workflowId, userId, ...values })
      .onConflictDoUpdate({
        target: [
          workflowBuilderSessions.tenantId,
          workflowBuilderSessions.workflowId,
          workflowBuilderSessions.userId,
        ],
        set: { ...values, updatedAt: now() },
      })
      .returning();
    return row;
  }

  /** removes the whole session (messages, summary, approved web domains); true when there was one */
  async clear(tenantId: string, workflowId: string, userId: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(workflowId) || !isUuid(userId)) return false;
    const rows = await this.db
      .delete(workflowBuilderSessions)
      .where(this.where(tenantId, workflowId, userId))
      .returning({ id: workflowBuilderSessions.id });
    return rows.length > 0;
  }
}
