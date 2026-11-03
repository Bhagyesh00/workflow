/**
 * Publish timeline rows (P3-16): one per publish ('activated') or unpublish ('deactivated').
 *
 * C0 STUB: lane L12 writes the bodies (and may add methods).
 */
import type { DbOrTx } from '../db/client';

export type PublishEvent = 'activated' | 'deactivated';

export interface PublishTimelineEntry {
  id: number;
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

  async add(
    _tenantId: string,
    _entry: { workflowId: string; event: PublishEvent; versionId: string | null; userId?: string | null },
  ): Promise<void> {
    throw new Error('not implemented (L12)');
  }

  /** newest first */
  async list(
    _tenantId: string,
    _workflowId: string,
    _page: { skip: number; take: number },
  ): Promise<PublishTimelineEntry[]> {
    throw new Error('not implemented (L12)');
  }
}
