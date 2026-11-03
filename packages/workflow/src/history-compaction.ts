/**
 * Version history compaction (P3-18), as n8n's history compaction tasks:
 * - optimize (hourly, versions 0.25-2.25 h old): drop a version whose successor only adds to it (gap under 20 min);
 * - trim (daily, versions 6-8 days old): keep one version per time bucket.
 * Never the current, published, named or described version, nor one followed by another author's.
 *
 * C0 STUB: lane L12 writes the body.
 */
import type { Connections, WorkflowNode } from './interfaces';

export type HistoryCompactionMode = 'optimize' | 'trim';

/** one saved version of a workflow (workflow_versions row) */
export interface CompactionVersion {
  id: string;
  createdAt: Date;
  authorId: string | null;
  versionName: string | null;
  description: string | null;
  autosaved: boolean;
  nodes: WorkflowNode[];
  connections: Connections;
  /** = workflows.version_id */
  isCurrent?: boolean;
  /** = workflows.published_version_id */
  isPublished?: boolean;
}

export interface SelectRedundantVersionsOptions {
  mode: HistoryCompactionMode;
  now: Date;
}

/** ids of the versions to delete */
export function selectRedundantVersions(
  _versions: readonly CompactionVersion[],
  _options: SelectRedundantVersionsOptions,
): string[] {
  return [];
}
