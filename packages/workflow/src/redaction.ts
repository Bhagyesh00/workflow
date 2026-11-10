/**
 * Execution data redaction (P6-53): the policy math shared by the server (snapshot at start, read, push)
 * and the editor (workflow settings, the floor notice). Isomorphic: the editor bundles this file, so no
 * Node.js import.
 *
 * A run is in one of two channels: `manual` (a run started from the editor) or `production` (every other
 * mode). A workflow's policy says which channels are redacted; the workspace floor is the least every
 * workflow must redact. A sub-workflow reports what it redacts to its caller through its task metadata
 * (`subWorkflowRedaction`) and which credentials it used (`usedCredentialIds`).
 */
import type { RunData, WorkflowNode } from './interfaces';

/** a workflow's redaction policy; `manual-only` is legacy (the settings UI cannot pick it: manual needs production) */
export type RedactionPolicy = 'none' | 'manual-only' | 'non-manual' | 'all';

/** the workspace floor: no workflow may redact less than this */
export type RedactionFloor = 'off' | 'production' | 'all';

/** which run channels are redacted */
export interface RedactionChannels {
  production: boolean;
  manual: boolean;
}

/** what a sub-workflow run reports to its caller's task metadata */
export interface SubWorkflowReport {
  /** credential ids the sub-run's nodes reference or used, deeper sub-runs included */
  usedCredentialIds: string[];
  /** channels the caller inherits; absent when the sub-run redacts nothing it passes up */
  subWorkflowRedaction?: RedactionChannels;
}

export function policyToChannels(policy: RedactionPolicy | undefined): RedactionChannels {
  return {
    production: policy === 'all' || policy === 'non-manual',
    manual: policy === 'all' || policy === 'manual-only',
  };
}

export function floorToChannels(floor: RedactionFloor | undefined): RedactionChannels {
  return { production: floor === 'production' || floor === 'all', manual: floor === 'all' };
}

/** true when the policy leaves a channel unredacted that the floor redacts */
export function isWeakerThanFloor(
  policy: RedactionPolicy | undefined,
  floor: RedactionFloor | undefined,
): boolean {
  const own = policyToChannels(policy);
  const min = floorToChannels(floor);
  return (min.production && !own.production) || (min.manual && !own.manual);
}

/** the strictest of both, per channel; never lowers a channel of `a` */
export function mergeChannels(a: RedactionChannels, b?: RedactionChannels): RedactionChannels {
  if (!b) return { production: a.production, manual: a.manual };
  return { production: a.production || b.production, manual: a.manual || b.manual };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** each task's metadata; run data is stored JSON, so every level is checked */
function eachTaskMetadata(
  runData: RunData | undefined,
  visit: (metadata: Record<string, unknown>) => void,
): void {
  if (!isRecord(runData)) return;
  for (const tasks of Object.values(runData)) {
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      if (isRecord(task) && isRecord(task.metadata)) visit(task.metadata);
    }
  }
}

/** union of the tasks' `metadata.subWorkflowRedaction` (both false when no task reports one) */
export function reportedChannels(runData: RunData | undefined): RedactionChannels {
  const out: RedactionChannels = { production: false, manual: false };
  eachTaskMetadata(runData, (metadata) => {
    const reported = metadata.subWorkflowRedaction;
    if (!isRecord(reported)) return;
    if (reported.production === true) out.production = true;
    if (reported.manual === true) out.manual = true;
  });
  return out;
}

/** union of the tasks' `metadata.usedCredentialIds`, sorted, without duplicates */
export function reportedCredentialIds(runData: RunData | undefined): string[] {
  const ids = new Set<string>();
  eachTaskMetadata(runData, (metadata) => {
    const used = metadata.usedCredentialIds;
    if (!Array.isArray(used)) return;
    for (const id of used) if (typeof id === 'string' && id) ids.add(id);
  });
  return [...ids].sort();
}

/** credential ids the nodes reference (disabled nodes included), sorted, without duplicates */
export function nodeCredentialIds(
  nodes: ReadonlyArray<Pick<WorkflowNode, 'credentials'>> | undefined,
): string[] {
  const ids = new Set<string>();
  for (const node of nodes ?? []) {
    if (!isRecord(node.credentials)) continue;
    for (const ref of Object.values(node.credentials)) {
      if (isRecord(ref) && typeof ref.id === 'string' && ref.id) ids.add(ref.id);
    }
  }
  return [...ids].sort();
}
