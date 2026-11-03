/**
 * Convert the selected nodes to a sub-workflow (P3-05, as n8n useWorkflowExtraction): extract with
 * @workflow/workflow extractSubWorkflow, create the new workflow in the parent's folder, publish
 * it (a failed publish is logged, the conversion still succeeds), replace the nodes in the parent
 * with one Execute Workflow node via store.applyGraph (one undo step), toast "Created
 * sub-workflow" with "Open in new tab".
 */
import {
  extractSubWorkflow,
  type GroupingProblem,
  type NodeDescriptionLookup,
  validateSelectionForExtraction,
  type WorkflowDefinition,
} from '@workflow/workflow';
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import type { WorkflowDTO } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import type { EditorDeps } from './editor-actions';

export interface ConvertToSubWorkflowInput {
  nodeNames: string[];
  /** the new workflow's name */
  name: string;
}

export interface ConvertToSubWorkflowResult {
  workflowId: string;
  /** the Execute Workflow node that replaced the selection in the parent */
  executeNodeName: string;
}

/** the server's workflow name limit */
export const SUBWORKFLOW_NAME_MAX = 128;
export const DEFAULT_SUBWORKFLOW_NAME = 'My sub-workflow';
const FAILED = 'Could not convert to a sub-workflow';

/** why `name` cannot name the new workflow, or null (the name is trimmed first) */
export function subWorkflowNameError(name: string): string | null {
  const value = name.trim();
  if (!value) return 'Enter a name for the sub-workflow.';
  if (value.length > SUBWORKFLOW_NAME_MAX) return `Use at most ${SUBWORKFLOW_NAME_MAX} characters.`;
  return null;
}

function openDefinition(): WorkflowDefinition {
  const s = useWorkflowStore.getState();
  return {
    id: s.meta.id,
    name: s.meta.name,
    nodes: s.nodes,
    connections: s.connections,
    pinData: s.pinData,
    stickyNotes: s.stickyNotes,
    nodeGroups: s.nodeGroups,
  };
}

function lookupFor(deps: EditorDeps): NodeDescriptionLookup {
  return useWorkflowStore.getState().nodeTypeLookup ?? ((type) => deps.descriptions.get(type));
}

function idsOf(nodeNames: readonly string[]): string[] {
  const wanted = new Set(nodeNames);
  return useWorkflowStore
    .getState()
    .nodes.filter((n) => wanted.has(n.name))
    .map((n) => n.id);
}

/** the extraction rules the selected nodes break; [] = they can be converted */
export function extractionProblems(deps: EditorDeps, nodeNames: readonly string[]): GroupingProblem[] {
  return validateSelectionForExtraction(openDefinition(), idsOf(nodeNames), lookupFor(deps));
}

function openInNewTab(workflowId: string): void {
  window.open(`/workflow/${encodeURIComponent(workflowId)}`, '_blank', 'noopener');
}

export async function convertToSubWorkflow(
  deps: EditorDeps,
  input: ConvertToSubWorkflowInput,
): Promise<ConvertToSubWorkflowResult | null> {
  const store = useWorkflowStore.getState();
  if (store.readOnly) return null;
  const name = input.name.trim();
  const nameError = subWorkflowNameError(name);
  if (nameError) {
    toast.error(FAILED, nameError);
    return null;
  }
  const types = lookupFor(deps);

  let draft: ReturnType<typeof extractSubWorkflow>;
  try {
    draft = extractSubWorkflow({
      definition: openDefinition(),
      nodeIds: idsOf(input.nodeNames),
      name,
      types,
    });
  } catch (error) {
    toast.error(FAILED, errorMessage(error));
    return null;
  }

  let created: WorkflowDTO;
  try {
    created = await workflowsApi.create({
      name,
      nodes: draft.subWorkflow.nodes,
      connections: draft.subWorkflow.connections,
      settings: draft.subWorkflow.settings,
      folderId: store.meta.folderId ?? null,
    });
  } catch (error) {
    toast.error('Could not create the sub-workflow', errorMessage(error));
    return null;
  }

  // published as n8n does, so production callers run it; a failure does not undo the conversion
  try {
    await workflowsApi.activate(created.id, { versionId: created.versionId });
  } catch (error) {
    console.warn(`Could not publish the sub-workflow ${created.id}: ${errorMessage(error)}`);
  }

  // the graph may have changed while the workflow was created: extract again from the current one
  let result: ReturnType<typeof extractSubWorkflow>;
  try {
    result = extractSubWorkflow({
      definition: openDefinition(),
      nodeIds: idsOf(input.nodeNames),
      name,
      newWorkflowId: created.id,
      types,
    });
  } catch (error) {
    toast.error(
      'Could not replace the selected nodes',
      `The sub-workflow "${name}" was created, but the selection changed meanwhile. ${errorMessage(error)}`,
      { label: 'Open in new tab', onClick: () => openInNewTab(created.id) },
    );
    return null;
  }

  const current = useWorkflowStore.getState();
  current.applyGraph(
    {
      nodes: result.parent.nodes,
      connections: result.parent.connections,
      pinData: result.parent.pinData ?? {},
      stickyNotes: current.stickyNotes,
      nodeGroups: result.parent.nodeGroups ?? current.nodeGroups,
    },
    { nodes: [result.executeNodeName], stickies: [], edges: [] },
  );
  toast.success('Created sub-workflow', `"${name}" now runs from the node "${result.executeNodeName}".`, {
    label: 'Open in new tab',
    onClick: () => openInNewTab(created.id),
  });
  return { workflowId: created.id, executeNodeName: result.executeNodeName };
}
