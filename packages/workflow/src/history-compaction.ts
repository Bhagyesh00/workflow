/**
 * Version history compaction (P3-18), as n8n's history compaction tasks:
 * - optimize (hourly, versions 0.25-2.25 h old): drop a version whose successor only adds to it (gap under 20 min);
 * - trim (daily, versions 6-8 days old): keep one version per time bucket.
 * Never the current, published, named or described version, nor one followed by another author's.
 *
 * Pure selection: the caller loads the versions of ONE workflow (the window plus at least the
 * first version after it, so the newest one in the window can be compared with its successor),
 * calls `selectRedundantVersions` and deletes the ids it returns.
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
  /** workflow-level content of the version; a field the caller leaves out is not compared */
  name?: string;
  settings?: Record<string, unknown>;
  stickyNotes?: readonly unknown[];
  nodeGroups?: readonly unknown[];
}

/** what `isAdditiveChange` compares: nodes and connections, plus the optional workflow fields */
export interface CompactionContent {
  nodes: readonly WorkflowNode[];
  connections: Connections;
  name?: string;
  settings?: Record<string, unknown>;
  stickyNotes?: readonly unknown[];
  nodeGroups?: readonly unknown[];
}

export interface SelectRedundantVersionsOptions {
  mode: HistoryCompactionMode;
  now: Date;
  /** versions younger than this are left alone (default: optimize 0.25 h, trim 6 days) */
  minimumAgeMs?: number;
  /** how far back from `now - minimumAgeMs` the pass looks (default: optimize 2 h, trim 2 days) */
  windowMs?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** optimize: a version is only merged into a successor saved less than this later */
export const OPTIMIZE_MAX_GAP_MS = 20 * MINUTE;

export const COMPACTION_DEFAULTS: Record<HistoryCompactionMode, { minimumAgeMs: number; windowMs: number }> =
  {
    optimize: { minimumAgeMs: 0.25 * HOUR, windowMs: 2 * HOUR },
    trim: { minimumAgeMs: 6 * DAY, windowMs: 2 * DAY },
  };

/** trim: the bucket size by the number of versions in the window (largest threshold first) */
export const TRIM_BUCKETS: ReadonlyArray<{ minVersions: number; bucketMs: number }> = [
  { minVersions: 10_000, bucketMs: 10 * HOUR },
  { minVersions: 5000, bucketMs: 5 * HOUR },
  { minVersions: 1000, bucketMs: 2 * HOUR },
  { minVersions: 100, bucketMs: 10 * MINUTE },
  { minVersions: 0, bucketMs: MINUTE },
];

export function trimBucketMs(versionCount: number): number {
  for (const bucket of TRIM_BUCKETS) if (versionCount >= bucket.minVersions) return bucket.bucketMs;
  return MINUTE;
}

/** the window of versions a pass looks at: [start, end], both inclusive */
export function compactionWindow(options: SelectRedundantVersionsOptions): { start: Date; end: Date } {
  const defaults = COMPACTION_DEFAULTS[options.mode];
  const minimumAgeMs = options.minimumAgeMs ?? defaults.minimumAgeMs;
  const windowMs = options.windowMs ?? defaults.windowMs;
  const end = new Date(options.now.getTime() - minimumAgeMs);
  return { start: new Date(end.getTime() - windowMs), end };
}

/** a version the passes never remove */
export function isProtectedVersion(version: CompactionVersion): boolean {
  return Boolean(
    version.isCurrent || version.isPublished || version.versionName !== null || version.description !== null,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `after` keeps everything `before` has: equal values, longer text that starts with the old text,
 * arrays that keep every item in place and may append, objects that keep every key and may add
 * keys. A missing or undefined value in `before` may be filled in.
 */
function isAdditiveValue(before: unknown, after: unknown): boolean {
  if (before === undefined) return true;
  if (Object.is(before, after)) return true;
  if (typeof before === 'string') return typeof after === 'string' && after.startsWith(before);
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length < before.length) return false;
    return before.every((item, i) => isAdditiveValue(item, after[i]));
  }
  if (isPlainObject(before)) {
    if (!isPlainObject(after)) return false;
    return Object.keys(before).every((key) => isAdditiveValue(before[key], after[key]));
  }
  return false;
}

function connectionKeys(connections: Connections): Set<string> {
  const keys = new Set<string>();
  for (const [source, byType] of Object.entries(connections ?? {})) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      (outputs ?? []).forEach((destinations, outputIndex) => {
        for (const d of destinations ?? []) {
          keys.add(JSON.stringify([source, type, outputIndex, d.node, d.type, d.index]));
        }
      });
    }
  }
  return keys;
}

/**
 * The change from `before` to `after` only adds: every node stays (same id, name, type and
 * version) with its settings kept or grown, every connection stays, new nodes and connections may
 * appear. Node positions are layout and do not count. The workflow name must stay; settings,
 * sticky notes and groups follow the same keep-or-grow rule as node content. A workflow field is
 * compared only when both sides carry it.
 */
export function isAdditiveChange(before: CompactionContent, after: CompactionContent): boolean {
  if (before.name !== undefined && after.name !== undefined && before.name !== after.name) return false;
  for (const key of ['settings', 'stickyNotes', 'nodeGroups'] as const) {
    if (before[key] === undefined || after[key] === undefined) continue;
    if (!isAdditiveValue(before[key], after[key])) return false;
  }
  const afterById = new Map(after.nodes.map((n) => [n.id, n]));
  for (const node of before.nodes) {
    const next = afterById.get(node.id);
    if (
      !next ||
      next.name !== node.name ||
      next.type !== node.type ||
      next.typeVersion !== node.typeVersion
    ) {
      return false;
    }
    const { position: _p, ...beforeContent } = node;
    const { position: _q, ...afterContent } = next;
    if (!isAdditiveValue(beforeContent, afterContent)) return false;
  }
  const afterConnections = connectionKeys(after.connections);
  for (const key of connectionKeys(before.connections)) if (!afterConnections.has(key)) return false;
  return true;
}

/** ids of the versions to delete */
export function selectRedundantVersions(
  versions: readonly CompactionVersion[],
  options: SelectRedundantVersionsOptions,
): string[] {
  const sorted = [...versions].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const { start, end } = compactionWindow(options);
  const inWindow = (v: CompactionVersion) =>
    v.createdAt.getTime() >= start.getTime() && v.createdAt.getTime() <= end.getTime();

  /** may go when the pass picks it: not protected, and its successor is by the same author */
  const removable = (index: number): boolean => {
    const version = sorted[index];
    const next = sorted[index + 1];
    if (!next || isProtectedVersion(version)) return false;
    return (next.authorId ?? null) === (version.authorId ?? null);
  };

  const dropped: string[] = [];
  if (options.mode === 'optimize') {
    sorted.forEach((version, i) => {
      if (!inWindow(version) || !removable(i)) return;
      const next = sorted[i + 1];
      if (next.createdAt.getTime() - version.createdAt.getTime() >= OPTIMIZE_MAX_GAP_MS) return;
      if (isAdditiveChange(version, next)) dropped.push(version.id);
    });
    return dropped;
  }

  // trim: one version per bucket, the newest; buckets are aligned to the epoch
  const candidates = sorted.map((v, i) => ({ v, i })).filter(({ v }) => inWindow(v));
  const bucketMs = trimBucketMs(candidates.length);
  const newestPerBucket = new Map<number, number>();
  for (const { v, i } of candidates) newestPerBucket.set(Math.floor(v.createdAt.getTime() / bucketMs), i);
  for (const { v, i } of candidates) {
    if (newestPerBucket.get(Math.floor(v.createdAt.getTime() / bucketMs)) === i) continue;
    if (removable(i)) dropped.push(v.id);
  }
  return dropped;
}
