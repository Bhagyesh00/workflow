/**
 * Version history compaction (P3-18): hourly optimize and daily trim on the leader, with
 * config.historyCompaction; started and stopped with the Pruner.
 *
 * A pass reads the versions of one workflow at a time, tenant by tenant, lets
 * `selectRedundantVersions` pick the redundant ones and deletes them in batches. The delete
 * re-checks every rule in SQL, so a version that became current, published, named, described or
 * pinned by an open review between the read and the delete stays. Timeline rows and review
 * requests that point at a removed version keep their row (FK set null); executions keep the id.
 */
import {
  type CompactionVersion,
  compactionWindow,
  type Connections,
  type HistoryCompactionMode,
  selectRedundantVersions,
  type WorkflowNode,
} from '@workflow/workflow';
import { and, asc, eq, gt, gte, lte, sql } from 'drizzle-orm';
import type { ServiceDeps } from '../context';
import { workflowReviewRequests, workflows, workflowVersions } from '../db/schema';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** how often each pass runs */
export const COMPACTION_INTERVALS: Record<HistoryCompactionMode, number> = {
  optimize: HOUR,
  trim: DAY,
};

const versionColumns = {
  id: workflowVersions.id,
  createdAt: workflowVersions.createdAt,
  authorId: workflowVersions.authorId,
  versionName: workflowVersions.versionName,
  description: workflowVersions.description,
  autosaved: workflowVersions.autosaved,
};

const contentColumns = {
  ...versionColumns,
  name: workflowVersions.name,
  nodes: workflowVersions.nodes,
  connections: workflowVersions.connections,
  settings: workflowVersions.settings,
  stickyNotes: workflowVersions.stickyNotes,
  nodeGroups: workflowVersions.nodeGroups,
};

export class HistoryCompactionService {
  private timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<HistoryCompactionMode>();
  /** set by start(); a started service that was stopped ends a running pass at the next batch */
  private started = false;
  private stopped = false;

  constructor(readonly deps: ServiceDeps) {}

  start(): void {
    if (this.timers.length) return;
    this.started = true;
    this.stopped = false;
    for (const mode of ['optimize', 'trim'] as const) {
      const timer = setInterval(() => void this.runScheduled(mode), COMPACTION_INTERVALS[mode]);
      timer.unref?.();
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.started) this.stopped = true;
  }

  /** one pass over every tenant; returns the number of versions removed */
  async runOnce(mode: HistoryCompactionMode, now: Date = new Date()): Promise<number> {
    const options = { mode, now, ...this.windowMs(mode) };
    const { start, end } = compactionWindow(options);
    const { db } = this.deps.database;
    const { batchSize: size, batchDelayMs } = this.deps.config.historyCompaction;
    const batchSize = Math.max(1, Math.trunc(size) || 1);

    let removed = 0;
    let scanned = 0;
    const tenants = await db
      .selectDistinct({ tenantId: workflowVersions.tenantId })
      .from(workflowVersions)
      .where(and(gte(workflowVersions.createdAt, start), lte(workflowVersions.createdAt, end)));

    for (const { tenantId } of tenants) {
      const inTenant = await db
        .selectDistinct({ workflowId: workflowVersions.workflowId })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenantId, tenantId),
            gte(workflowVersions.createdAt, start),
            lte(workflowVersions.createdAt, end),
          ),
        );
      for (const { workflowId } of inTenant) {
        if (this.stopped) return this.finish(mode, removed);
        const ids = await this.redundantIds(tenantId, workflowId, options, { start, end });
        for (let i = 0; i < ids.length; i += batchSize) {
          removed += await this.deleteVersions(tenantId, workflowId, ids.slice(i, i + batchSize));
          if (i + batchSize < ids.length) await this.pause(batchDelayMs);
          if (this.stopped) return this.finish(mode, removed);
        }
        scanned++;
        if (scanned % batchSize === 0) await this.pause(batchDelayMs);
      }
    }
    return this.finish(mode, removed);
  }

  private async runScheduled(mode: HistoryCompactionMode): Promise<void> {
    // a slow pass is never overlapped by the next tick of the same mode
    if (this.running.has(mode)) return;
    this.running.add(mode);
    try {
      await this.runOnce(mode);
    } catch (error) {
      this.deps.logger.warn({ err: error, mode }, 'History compaction failed');
    } finally {
      this.running.delete(mode);
    }
  }

  private finish(mode: HistoryCompactionMode, removed: number): number {
    if (removed) this.deps.logger.info({ mode, removed }, 'Compacted the workflow version history');
    return removed;
  }

  private windowMs(mode: HistoryCompactionMode): { minimumAgeMs: number; windowMs: number } {
    const c = this.deps.config.historyCompaction;
    return mode === 'optimize'
      ? { minimumAgeMs: c.optimizingMinimumAgeHours * HOUR, windowMs: c.optimizingTimeWindowHours * HOUR }
      : { minimumAgeMs: c.trimmingMinimumAgeDays * DAY, windowMs: c.trimmingTimeWindowDays * DAY };
  }

  /**
   * The versions of one workflow in the window plus the first one after it (the newest version in
   * the window is compared with its successor), with the current, published and review-pinned marks.
   */
  private async redundantIds(
    tenantId: string,
    workflowId: string,
    options: { mode: HistoryCompactionMode; now: Date; minimumAgeMs: number; windowMs: number },
    window: { start: Date; end: Date },
  ): Promise<string[]> {
    const { db } = this.deps.database;
    const [pointers] = await db
      .select({ versionId: workflows.versionId, publishedVersionId: workflows.publishedVersionId })
      .from(workflows)
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, workflowId)));
    if (!pointers) return [];

    // trim compares authors and times only; optimize compares content
    const columns = options.mode === 'optimize' ? contentColumns : versionColumns;
    const scope = and(eq(workflowVersions.tenantId, tenantId), eq(workflowVersions.workflowId, workflowId));
    const order = [asc(workflowVersions.createdAt), asc(workflowVersions.id)];
    const inWindow = await db
      .select(columns)
      .from(workflowVersions)
      .where(and(scope, gte(workflowVersions.createdAt, window.start), lte(workflowVersions.createdAt, window.end)))
      .orderBy(...order);
    if (!inWindow.length) return [];
    const successor = await db
      .select(columns)
      .from(workflowVersions)
      .where(and(scope, gt(workflowVersions.createdAt, window.end)))
      .orderBy(...order)
      .limit(1);

    const pinned = new Set(
      (
        await db
          .select({ versionId: workflowReviewRequests.workflowVersionId })
          .from(workflowReviewRequests)
          .where(
            and(
              eq(workflowReviewRequests.tenantId, tenantId),
              eq(workflowReviewRequests.workflowId, workflowId),
              eq(workflowReviewRequests.state, 'open'),
            ),
          )
      ).map((row) => row.versionId),
    );

    const versions: CompactionVersion[] = [...inWindow, ...successor].map((row) => {
      const content = row as Partial<Record<keyof typeof contentColumns, unknown>>;
      return {
        id: row.id,
        createdAt: row.createdAt,
        authorId: row.authorId,
        versionName: row.versionName,
        description: row.description,
        autosaved: row.autosaved,
        nodes: (content.nodes as WorkflowNode[] | undefined) ?? [],
        connections: (content.connections as Connections | undefined) ?? {},
        ...(content.name !== undefined && { name: content.name as string }),
        ...(content.settings !== undefined && { settings: content.settings as Record<string, unknown> }),
        ...(content.stickyNotes !== undefined && { stickyNotes: content.stickyNotes as unknown[] }),
        ...(content.nodeGroups !== undefined && { nodeGroups: content.nodeGroups as unknown[] }),
        isCurrent: row.id === pointers.versionId,
        isPublished: row.id === pointers.publishedVersionId,
      };
    });
    return selectRedundantVersions(versions, options).filter((id) => !pinned.has(id));
  }

  /** deletes the given versions of one workflow, re-checking every rule; returns how many went */
  private async deleteVersions(tenantId: string, workflowId: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const result = await this.deps.database.db.execute(sql`
      DELETE FROM workflow_versions v
      WHERE v.tenant_id = ${tenantId}::uuid
        AND v.workflow_id = ${workflowId}::uuid
        AND v.id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        AND v.version_name IS NULL
        AND v.description IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM workflows w
          WHERE w.tenant_id = v.tenant_id AND w.id = v.workflow_id
            AND (w.version_id = v.id OR w.published_version_id = v.id))
        AND NOT EXISTS (
          SELECT 1 FROM workflow_review_requests r
          WHERE r.tenant_id = v.tenant_id AND r.workflow_version_id = v.id AND r.state = 'open')`);
    return result.rowCount ?? 0;
  }

  private async pause(ms: number): Promise<void> {
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
