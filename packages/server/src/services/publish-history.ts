/**
 * Publish timeline (P3-16): record every publish / unpublish; list newest first.
 *
 * `record` runs after the publish or unpublish itself has happened, so it never fails the
 * request: a write error is logged (ids only) and swallowed.
 */
import type { ServiceDeps } from '../context';
import type { PublishEvent, PublishTimelineEntry } from '../repositories';

export class PublishHistoryService {
  constructor(readonly deps: ServiceDeps) {}

  async record(
    event: PublishEvent,
    entry: { tenantId: string; workflowId: string; versionId: string | null; userId?: string | null },
  ): Promise<void> {
    try {
      await this.deps.repos.publishHistory.add(entry.tenantId, {
        workflowId: entry.workflowId,
        event,
        versionId: entry.versionId,
        userId: entry.userId ?? null,
      });
    } catch (error) {
      this.deps.logger.warn(
        { err: error, tenantId: entry.tenantId, workflowId: entry.workflowId, event },
        'Could not record the publish timeline event',
      );
    }
  }

  async list(
    tenantId: string,
    workflowId: string,
    page: { skip: number; take: number },
  ): Promise<{ data: PublishTimelineEntry[] }> {
    const skip = Math.max(0, Math.trunc(page.skip) || 0);
    const take = Math.min(100, Math.max(1, Math.trunc(page.take) || 20));
    return { data: await this.deps.repos.publishHistory.list(tenantId, workflowId, { skip, take }) };
  }
}
