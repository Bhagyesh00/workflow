/**
 * P6-05 (L11): the insights buffer of one process (mains and workers alike). `record` (called in `finish`
 * and `afterCrash`, C0d1) applies `countingFacts` and adds to a map keyed by tenant, workflow, type and hour;
 * it never throws, never awaits and reads nothing. A flush every `config.insights.flushIntervalSeconds` or
 * at `flushBatchSize` keys writes one sorted multi-row upsert (and the metadata upsert on a name or project
 * change); a failed flush puts the facts back. `stop` ends the timer and flushes what is left; `close`
 * (context.ts) flushes it.
 */
import type { ServiceDeps } from '../../context';
import type { InsightsPeriodInput } from '../../repositories/insights';
import {
  countingFacts,
  INSIGHT_TYPES,
  type InsightRun,
  type InsightType,
  MAX_INSIGHT_BUCKET_VALUE,
} from './rules';

const HOUR_MS = 3_600_000;
/** the foreign key error of Postgres: a metadata row (or the workspace) is gone */
const FOREIGN_KEY_VIOLATION = '23503';
/** the workflows the flush remembers (name and project), so an unchanged one costs no metadata write */
const KNOWN_LIMIT = 20_000;

interface Bucket {
  tenantId: string;
  workflowId: string;
  type: InsightType;
  hour: number;
  value: number;
}

interface Known {
  metaId: number;
  name: string;
  projectId: string | null;
  projectName: string | null;
}

const bucketKey = (b: Pick<Bucket, 'tenantId' | 'workflowId' | 'type' | 'hour'>) =>
  `${b.tenantId}|${b.workflowId}|${b.type}|${b.hour}`;

const sameTenantWorkflow = (tenantId: string, workflowId: string) => `${tenantId}|${workflowId}`;

const code = (error: unknown): string | undefined => {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const value = e?.code ?? e?.cause?.code;
  return typeof value === 'string' ? value : undefined;
};

export class InsightsCollector {
  private buffer = new Map<string, Bucket>();
  private timer: NodeJS.Timeout | undefined;
  private scheduled: NodeJS.Immediate | undefined;
  /** flushes run one after the other, so two never write the same buckets at once */
  private chain: Promise<void> = Promise.resolve();
  private readonly known = new Map<string, Known>();

  constructor(readonly deps: ServiceDeps) {}

  /** adds what the run counts; nothing is awaited, read or thrown */
  record(run: InsightRun): void {
    try {
      const facts = countingFacts(run);
      if (facts.length === 0 || !run.workflowId) return;
      const hour = Math.floor((run.endedAt ?? run.startedAt).getTime() / HOUR_MS) * HOUR_MS;
      if (!Number.isFinite(hour)) return;
      for (const fact of facts) {
        const bucket = { tenantId: run.tenantId, workflowId: run.workflowId, type: fact.type, hour };
        const key = bucketKey(bucket);
        const held = this.buffer.get(key);
        if (held) held.value = Math.min(MAX_INSIGHT_BUCKET_VALUE, held.value + fact.value);
        else this.buffer.set(key, { ...bucket, value: fact.value });
      }
      if (this.buffer.size >= this.deps.config.insights.flushBatchSize) this.scheduleFlush();
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'Insights could not count the run');
    }
  }

  start(): void {
    if (this.timer) return;
    const every = Math.max(1, this.deps.config.insights.flushIntervalSeconds) * 1000;
    this.timer = setInterval(() => {
      this.flush().catch((error) =>
        this.deps.logger.warn({ err: error }, 'Insights could not be written, will try again'),
      );
    }, every);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    await this.flush();
  }

  /** writes the buffer; a failure puts the facts back and rejects, the next flush tries again */
  flush(): Promise<void> {
    const run = this.chain.then(() => this.flushOnce());
    // the chain goes on after a failed flush; the caller still sees the failure
    this.chain = run.catch(() => {});
    return run;
  }

  /** the buffer is full: flush soon, outside `record` */
  private scheduleFlush(): void {
    if (this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.flush().catch((error) =>
        this.deps.logger.warn({ err: error }, 'Insights could not be written, will try again'),
      );
    });
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.size === 0) return;
    const batch = this.buffer;
    this.buffer = new Map();
    try {
      await this.write(batch);
    } catch (error) {
      if (code(error) === FOREIGN_KEY_VIOLATION) {
        // a metadata row or the workspace is gone: forget what is remembered and look again once
        this.known.clear();
        try {
          await this.write(batch);
          return;
        } catch (second) {
          if (code(second) === FOREIGN_KEY_VIOLATION) {
            this.deps.logger.warn(
              { buckets: batch.size },
              'Insights dropped facts of workflows that are gone',
            );
            return;
          }
          this.putBack(batch);
          throw second;
        }
      }
      this.putBack(batch);
      throw error;
    }
  }

  private putBack(batch: Map<string, Bucket>): void {
    for (const [key, bucket] of batch) {
      const held = this.buffer.get(key);
      if (held) held.value = Math.min(MAX_INSIGHT_BUCKET_VALUE, held.value + bucket.value);
      else this.buffer.set(key, bucket);
    }
  }

  private async write(batch: Map<string, Bucket>): Promise<void> {
    const buckets = [...batch.values()];
    const metaIds = await this.resolveMeta(buckets);
    const rows: InsightsPeriodInput[] = [];
    let dropped = 0;
    for (const b of buckets) {
      const metaId = metaIds.get(sameTenantWorkflow(b.tenantId, b.workflowId));
      if (metaId === undefined) {
        dropped++;
        continue;
      }
      rows.push({
        tenantId: b.tenantId,
        metaId,
        type: INSIGHT_TYPES[b.type],
        periodUnit: 0,
        periodStart: new Date(b.hour),
        value: b.value,
      });
    }
    rows.sort(
      (a, b) =>
        (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0) ||
        a.metaId - b.metaId ||
        a.type - b.type ||
        a.periodStart.getTime() - b.periodStart.getTime(),
    );
    await this.deps.repos.insights.addPeriods(rows);
    if (dropped)
      this.deps.logger.warn({ buckets: dropped }, 'Insights dropped facts of workflows that are gone');
  }

  /**
   * The metadata id of each workflow in the batch. A workflow whose name or project changed since the last
   * flush (or that was not seen yet) is upserted; a workflow that is gone keeps its row if it has one, and
   * its facts are dropped if it has none.
   */
  private async resolveMeta(buckets: Bucket[]): Promise<Map<string, number>> {
    const byTenant = new Map<string, Set<string>>();
    for (const b of buckets) {
      const set = byTenant.get(b.tenantId) ?? new Set<string>();
      set.add(b.workflowId);
      byTenant.set(b.tenantId, set);
    }
    const { insights } = this.deps.repos;
    const ids = new Map<string, number>();
    const toWrite: Array<{
      tenantId: string;
      workflowId: string;
      workflowName: string;
      projectId: string | null;
      projectName: string | null;
    }> = [];
    for (const [tenantId, workflowIds] of byTenant) {
      const infos = new Map((await insights.workflowInfos(tenantId, [...workflowIds])).map((i) => [i.id, i]));
      const gone: string[] = [];
      for (const workflowId of workflowIds) {
        const info = infos.get(workflowId);
        if (!info) {
          gone.push(workflowId);
          continue;
        }
        const key = sameTenantWorkflow(tenantId, workflowId);
        const known = this.known.get(key);
        if (
          known &&
          known.name === info.name.slice(0, 128) &&
          known.projectId === info.projectId &&
          known.projectName === info.projectName
        ) {
          ids.set(key, known.metaId);
        } else {
          toWrite.push({
            tenantId,
            workflowId,
            workflowName: info.name.slice(0, 128),
            projectId: info.projectId,
            projectName: info.projectName,
          });
        }
      }
      for (const meta of await insights.metadataOf(tenantId, gone)) {
        if (meta.workflowId) ids.set(sameTenantWorkflow(tenantId, meta.workflowId), meta.id);
      }
    }
    if (toWrite.length > 0) {
      const written = await insights.upsertMetadata(toWrite);
      if (this.known.size > KNOWN_LIMIT) this.known.clear();
      for (const w of toWrite) {
        const metaId = written.get(w.workflowId);
        if (metaId === undefined) continue;
        const key = sameTenantWorkflow(w.tenantId, w.workflowId);
        ids.set(key, metaId);
        this.known.set(key, {
          metaId,
          name: w.workflowName,
          projectId: w.projectId,
          projectName: w.projectName,
        });
      }
    }
    return ids;
  }
}
