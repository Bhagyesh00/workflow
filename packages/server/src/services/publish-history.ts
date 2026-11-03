/**
 * Publish timeline (P3-16): record every publish / unpublish; list newest first.
 *
 * C0 STUB: lane L12 writes the bodies (record is a no-op, list is empty).
 */
import type { ServiceDeps } from '../context';
import type { PublishEvent, PublishTimelineEntry } from '../repositories';

export class PublishHistoryService {
  constructor(readonly deps: ServiceDeps) {}

  async record(
    _event: PublishEvent,
    _entry: { tenantId: string; workflowId: string; versionId: string | null; userId?: string | null },
  ): Promise<void> {}

  async list(
    _tenantId: string,
    _workflowId: string,
    _page: { skip: number; take: number },
  ): Promise<{ data: PublishTimelineEntry[] }> {
    return { data: [] };
  }
}
