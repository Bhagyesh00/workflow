/**
 * P6-05 (L11): the insights tables (`insights_metadata`, `insights_by_period`, migration 0033). Every query
 * filters tenant_id, except the system-level compaction and prune. Raw `pg` returns bigint `value` as a
 * string; sums are cast to double precision in SQL so the callers get numbers.
 */
import { and, eq, inArray, min, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type InsightsByPeriodRow,
  type InsightsMetadataRow,
  insightsByPeriod,
  insightsMetadata,
  projects,
  workflows,
} from '../db/schema';

/** one bucket to add (`value` is added to an existing row of the same key) */
export interface InsightsPeriodInput {
  tenantId: string;
  metaId: number;
  type: InsightsByPeriodRow['type'];
  periodUnit: InsightsByPeriodRow['periodUnit'];
  periodStart: Date;
  value: number;
}

/** what a workflow is now: its name and the project that owns it */
export interface InsightsWorkflowInfo {
  id: string;
  name: string;
  projectId: string;
  projectName: string | null;
}

const UNIT_NAMES = { 1: 'day', 2: 'week' } as const;

/** one advisory lock for the compaction, cluster wide */
const COMPACTION_LOCK = 'insights:compaction';

/** rows of `upsertMetadata` per statement (5 parameters each) */
const METADATA_CHUNK = 2000;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class InsightsRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** one row per workflow, name and project kept current; answers the ids by workflow id */
  async upsertMetadata(
    rows: Array<{
      tenantId: string;
      workflowId: string;
      workflowName: string;
      projectId: string | null;
      projectName: string | null;
    }>,
  ): Promise<Map<string, number>> {
    const ids = new Map<string, number>();
    // sorted, so two processes writing the same rows take the row locks in one order
    const sorted = [...rows].sort(
      (a, b) => byText(a.tenantId, b.tenantId) || byText(a.workflowId, b.workflowId),
    );
    for (let i = 0; i < sorted.length; i += METADATA_CHUNK) {
      const chunk = sorted.slice(i, i + METADATA_CHUNK);
      const written = await this.db
        .insert(insightsMetadata)
        .values(
          chunk.map((r) => ({
            tenantId: r.tenantId,
            workflowId: r.workflowId,
            workflowName: r.workflowName.slice(0, 128),
            projectId: r.projectId,
            projectName: r.projectName?.slice(0, 255) ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [insightsMetadata.tenantId, insightsMetadata.workflowId],
          set: {
            workflowName: sql`excluded.workflow_name`,
            projectId: sql`excluded.project_id`,
            projectName: sql`excluded.project_name`,
          },
        })
        .returning({ id: insightsMetadata.id, workflowId: insightsMetadata.workflowId });
      for (const w of written) if (w.workflowId) ids.set(w.workflowId, w.id);
    }
    return ids;
  }

  /**
   * One sorted multi-row upsert (adds `value` on conflict). Rows with one key are added together first, so
   * the statement never touches a row twice. The rows travel as one json parameter.
   */
  async addPeriods(rows: InsightsPeriodInput[]): Promise<void> {
    if (rows.length === 0) return;
    const json = JSON.stringify(
      rows.map((r) => ({
        tenant_id: r.tenantId,
        meta_id: r.metaId,
        type: r.type,
        period_unit: r.periodUnit,
        period_start: r.periodStart.toISOString(),
        value: r.value,
      })),
    );
    await this.db.execute(sql`
      insert into insights_by_period (tenant_id, meta_id, type, period_unit, period_start, value)
      select x.tenant_id, x.meta_id, x.type, x.period_unit, x.period_start, sum(x.value)
      from jsonb_to_recordset(${json}::jsonb) as x(
        tenant_id uuid, meta_id bigint, type smallint, period_unit smallint, period_start timestamptz, value bigint
      )
      group by x.tenant_id, x.meta_id, x.type, x.period_unit, x.period_start
      order by x.tenant_id, x.meta_id, x.type, x.period_unit, x.period_start
      on conflict (tenant_id, meta_id, type, period_unit, period_start)
      do update set value = insights_by_period.value + excluded.value
    `);
  }

  async metadataOf(tenantId: string, workflowIds: string[]): Promise<InsightsMetadataRow[]> {
    if (workflowIds.length === 0) return [];
    return this.db
      .select()
      .from(insightsMetadata)
      .where(and(eq(insightsMetadata.tenantId, tenantId), inArray(insightsMetadata.workflowId, workflowIds)));
  }

  /** the workflows of the workspace among `ids` with their project (the flush's metadata check) */
  async workflowInfos(tenantId: string, ids: string[]): Promise<InsightsWorkflowInfo[]> {
    if (ids.length === 0) return [];
    return this.db
      .select({
        id: workflows.id,
        name: workflows.name,
        projectId: workflows.projectId,
        projectName: projects.name,
      })
      .from(workflows)
      .leftJoin(
        projects,
        and(eq(projects.tenantId, workflows.tenantId), eq(projects.id, workflows.projectId)),
      )
      .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.id, ids)));
  }

  /**
   * Rolls up to `batchSize` `from` buckets older than `before` into `to` buckets (the bucket start is the
   * day or the week, weeks from Monday, in UTC; a bucket that exists gets the value added) and removes them,
   * in one transaction under the compaction lock. Answers the rows compacted; 0 when there is nothing left
   * or another process holds the lock.
   */
  async compact(
    from: InsightsByPeriodRow['periodUnit'],
    to: InsightsByPeriodRow['periodUnit'],
    before: Date,
    batchSize: number,
  ): Promise<number> {
    const unit = UNIT_NAMES[to as 1 | 2];
    if (!unit) throw new Error('Insights compaction rolls hours into days and days into weeks');
    const limit = Math.max(1, Math.trunc(batchSize) || 1);
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext(${COMPACTION_LOCK})) as locked`,
      );
      if (!locked.rows[0]?.locked) return 0;
      const result = await tx.execute<{ moved: string }>(sql`
        with batch as (
          select id, tenant_id, meta_id, type, value,
            (date_trunc(${sql.raw(`'${unit}'`)}, period_start at time zone 'UTC') at time zone 'UTC') as new_start
          from insights_by_period
          where period_unit = ${from} and period_start < ${before.toISOString()}::timestamptz
          order by period_start, id
          limit ${limit}
          for update
        ),
        rolled as (
          select tenant_id, meta_id, type, new_start, sum(value) as value
          from batch
          group by tenant_id, meta_id, type, new_start
        ),
        added as (
          insert into insights_by_period (tenant_id, meta_id, type, period_unit, period_start, value)
          select tenant_id, meta_id, type, ${to}::smallint, new_start, value
          from rolled
          order by tenant_id, meta_id, type, new_start
          on conflict (tenant_id, meta_id, type, period_unit, period_start)
          do update set value = insights_by_period.value + excluded.value
          returning 1
        ),
        removed as (
          delete from insights_by_period where id in (select id from batch) returning 1
        )
        select (select count(*) from removed)::text as moved, (select count(*) from added) as added
      `);
      return Number(result.rows[0]?.moved ?? 0);
    });
  }

  /**
   * System level: deletes buckets older than `before` across tenants, then the metadata rows of workflows
   * that no longer exist and have no bucket left. Answers the buckets deleted.
   */
  async prune(before: Date): Promise<number> {
    const removed = await this.db
      .delete(insightsByPeriod)
      .where(sql`${insightsByPeriod.periodStart} < ${before.toISOString()}::timestamptz`)
      .returning({ id: insightsByPeriod.id });
    await this.db.execute(sql`
      delete from insights_metadata m
      where m.workflow_id is null
        and not exists (
          select 1 from insights_by_period p where p.tenant_id = m.tenant_id and p.meta_id = m.id
        )
    `);
    return removed.length;
  }

  async earliestPeriod(tenantId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ first: min(insightsByPeriod.periodStart) })
      .from(insightsByPeriod)
      .where(eq(insightsByPeriod.tenantId, tenantId));
    return row?.first ? new Date(row.first) : null;
  }
}
