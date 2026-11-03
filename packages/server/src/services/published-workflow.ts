/**
 * The published copy of a workflow (P3-10, as n8n getPublishedWorkflowData).
 *
 * `workflows.published_version_id` points at a row of `workflow_versions`. Production reads that
 * version's graph (nodes, connections, sticky notes, groups); settings, pin data, static data and the
 * name stay live on the workflows row, so a settings change applies without a publish and static
 * data written by runs is never rolled back. Manual runs and test webhooks use the draft.
 */
import type {
  Connections,
  ExecutionMode,
  StickyNote,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeGroup,
} from '@workflow/workflow';
import type { WorkflowRow, WorkflowVersionRow } from '../db/schema';
import type { Repositories } from '../repositories';
import { toDefinition } from './workflow-model';

export type PublishedVersion = Pick<
  WorkflowVersionRow,
  'id' | 'nodes' | 'connections' | 'stickyNotes' | 'nodeGroups'
>;

/** the definition production runs: the version's graph with the live settings and data of `row` */
export function publishedDefinition(row: WorkflowRow, version: PublishedVersion): WorkflowDefinition {
  return {
    ...toDefinition(row),
    nodes: structuredClone(version.nodes as WorkflowNode[]),
    connections: structuredClone(version.connections as Connections),
    stickyNotes: structuredClone((version.stickyNotes ?? []) as StickyNote[]),
    nodeGroups: structuredClone((version.nodeGroups ?? []) as WorkflowNodeGroup[]),
    versionId: version.id,
  };
}

/**
 * The published definition of `row`, or null when it is not published. A pointer to a version that
 * no longer exists fails closed: production never falls back to the draft of a published workflow.
 */
export async function loadPublishedDefinition(
  repos: Pick<Repositories, 'versions'>,
  tenantId: string,
  row: WorkflowRow,
): Promise<WorkflowDefinition | null> {
  if (!row.publishedVersionId) return null;
  const version = await repos.versions.get(tenantId, row.id, row.publishedVersionId);
  if (!version) throw new Error(`The published version of workflow "${row.name}" no longer exists`);
  return publishedDefinition(row, version);
}

/** root modes that run the drafts of the workflows they call (editor runs, test webhooks, chat) */
export function runsDrafts(rootMode: ExecutionMode | undefined): boolean {
  return rootMode === 'manual' || rootMode === 'chat';
}

/**
 * What a run whose root has `rootMode` executes of a workflow it loads from the database (a
 * sub-workflow, the error workflow, a retry with the current workflow): the draft for a manual or
 * chat root, otherwise the published version, and the draft when the workflow was never published
 * (our leniency: n8n refuses "Workflow is not active and cannot be executed.").
 */
export async function runtimeDefinition(
  repos: Pick<Repositories, 'versions'>,
  tenantId: string,
  row: WorkflowRow,
  rootMode: ExecutionMode | undefined,
): Promise<WorkflowDefinition> {
  if (runsDrafts(rootMode)) return toDefinition(row);
  return (await loadPublishedDefinition(repos, tenantId, row)) ?? toDefinition(row);
}
