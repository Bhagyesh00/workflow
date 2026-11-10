/**
 * P6-05 (L11): the insights tables (`insights_metadata`, `insights_by_period`, migration 0033). Every query
 * filters tenant_id. Raw `pg` returns bigint `value` as a string; drizzle's mode 'number' maps it.
 * Stub from C0; L11 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { InsightsByPeriodRow, InsightsMetadataRow } from '../db/schema';

/** one bucket to add (`value` is added to an existing row of the same key) */
export interface InsightsPeriodInput {
  tenantId: string;
  metaId: number;
  type: InsightsByPeriodRow['type'];
  periodUnit: InsightsByPeriodRow['periodUnit'];
  periodStart: Date;
  value: number;
}

export class InsightsRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** one row per workflow, name and project kept current; answers the ids by workflow id */
  async upsertMetadata(
    _rows: Array<{
      tenantId: string;
      workflowId: string;
      workflowName: string;
      projectId: string | null;
      projectName: string | null;
    }>,
  ): Promise<Map<string, number>> {
    throw new Error('not implemented (L11)');
  }

  /** one sorted multi-row upsert (adds `value` on conflict) */
  async addPeriods(_rows: InsightsPeriodInput[]): Promise<void> {
    throw new Error('not implemented (L11)');
  }

  async metadataOf(_tenantId: string, _workflowIds: string[]): Promise<InsightsMetadataRow[]> {
    throw new Error('not implemented (L11)');
  }

  /** rolls `from` buckets older than `before` into `to` buckets; answers the rows compacted */
  async compact(
    _from: InsightsByPeriodRow['periodUnit'],
    _to: InsightsByPeriodRow['periodUnit'],
    _before: Date,
    _batchSize: number,
  ): Promise<number> {
    throw new Error('not implemented (L11)');
  }

  /** system level: deletes buckets older than `before` across tenants */
  async prune(_before: Date): Promise<number> {
    throw new Error('not implemented (L11)');
  }

  async earliestPeriod(_tenantId: string): Promise<Date | null> {
    throw new Error('not implemented (L11)');
  }
}
