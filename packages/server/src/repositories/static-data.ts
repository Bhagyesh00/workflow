/**
 * Workflow static data ($getWorkflowStaticData, polling cursors) saved after a run.
 *
 * `merge` writes only the top-level keys a run changed and deletes the keys it removed, in one
 * UPDATE on the jsonb column. Two runs that change different keys (node:A, node:B) both survive;
 * two runs that change the same key may lose an update, as in n8n.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { workflows } from '../db/schema';

type StaticData = Record<string, unknown>;

export class StaticDataRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** the static data stored for a workflow, or undefined when the workflow does not exist */
  async get(tenantId: string, workflowId: string): Promise<StaticData | undefined> {
    const [row] = await this.db
      .select({ staticData: workflows.staticData })
      .from(workflows)
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, workflowId)));
    return row?.staticData;
  }

  /** save the static data of a run that started from `before` and ended with `after` */
  async merge(tenantId: string, workflowId: string, before: StaticData, after: StaticData): Promise<void> {
    const changed: StaticData = {};
    for (const key of Object.keys(after)) {
      if (!(key in before) || JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changed[key] = after[key];
      }
    }
    const removed = Object.keys(before).filter((key) => !(key in after));
    if (!Object.keys(changed).length && !removed.length) return;
    const removedKeys = removed.length
      ? sql`ARRAY[${sql.join(
          removed.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[]`
      : sql`ARRAY[]::text[]`;
    await this.db
      .update(workflows)
      .set({
        staticData: sql`(coalesce(${workflows.staticData}, '{}'::jsonb) - ${removedKeys}) || ${JSON.stringify(changed)}::jsonb`,
      })
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, workflowId)));
  }
}
