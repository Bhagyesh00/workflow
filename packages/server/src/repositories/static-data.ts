/**
 * Workflow static data ($getWorkflowStaticData, polling cursors) saved after a run.
 *
 * STUB from the Phase 2 contract step (C0a): writes the whole object as before. Lane L9 makes
 * `merge` write only the changed top-level keys (removed keys deleted) in one UPDATE, so two runs
 * that change different keys (node:A, node:B) both survive.
 */
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { workflows } from '../db/schema';

type StaticData = Record<string, unknown>;

export class StaticDataRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** save the static data of a run that started from `before` and ended with `after` */
  async merge(tenantId: string, workflowId: string, before: StaticData, after: StaticData): Promise<void> {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await this.db
      .update(workflows)
      .set({ staticData: after })
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, workflowId)));
  }
}
