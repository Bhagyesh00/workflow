/**
 * P5-62: the canvas part of a stream chunk. A `workflow-updated` chunk replaces the nodes and the
 * connections through `applyGraph` (one undo step); when it added nodes, the tidy-up on `deps.flow`
 * lays them out and joins that same undo step. Nodes that show an empty credential slot get the first
 * credential of its type (assign-credentials.ts). Sticky notes stay; pinned data and groups keep only
 * what still has its node. The store (builder-store.ts) takes the snapshot before the first change.
 */
import type { BuilderChunk, WorkflowNodeGroup } from '@workflow/workflow';
import type { CredentialSummary } from '../../api/types';
import { normalizeNodes } from '../../lib/workflow-ops';
import type { BuilderDeps } from '../../stores/builder-store';
import { graphOf, useWorkflowStore } from '../../stores/workflow-store';
import { tidyUp } from '../editor/tidy-up';
import { assignDefaultCredentials } from './assign-credentials';

let turnCredentials: CredentialSummary[] = [];

/** the user's credentials for the running turn (`send` loads them once before it streams) */
export function setBuilderCredentials(credentials: CredentialSummary[]): void {
  turnCredentials = credentials;
}

export function applyBuilderChunk(chunk: BuilderChunk, deps: BuilderDeps | null): void {
  if (chunk.type !== 'workflow-updated') return;
  const store = useWorkflowStore.getState();
  if (store.readOnly) return;
  const current = graphOf(store);
  const incoming = chunk.workflow;
  const rawNodes = Array.isArray(incoming.nodes) ? incoming.nodes : [];
  const nodes = normalizeNodes(
    deps ? assignDefaultCredentials(rawNodes, turnCredentials, deps.descriptions) : rawNodes,
  );
  const names = new Set(nodes.map((n) => n.name));
  const ids = new Set(nodes.map((n) => n.id));
  const pinData = Object.fromEntries(Object.entries(current.pinData).filter(([name]) => names.has(name)));
  const nodeGroups = current.nodeGroups
    .map((g): WorkflowNodeGroup => ({ ...g, nodeIds: g.nodeIds.filter((id) => ids.has(id)) }))
    .filter((g) => g.nodeIds.length > 0);
  const known = new Set(current.nodes.map((n) => n.id));
  const added = nodes.some((n) => !known.has(n.id));

  store.applyGraph({
    nodes,
    connections: incoming.connections ?? {},
    pinData,
    stickyNotes: current.stickyNotes,
    nodeGroups,
  });

  if (!added || !deps?.flow) return;
  const revision = useWorkflowStore.getState().revision;
  tidyUp(deps.flow);
  const after = useWorkflowStore.getState();
  // the layout belongs to this change: drop the history entry the tidy-up pushed, so one undo takes back both
  if (after.revision !== revision && after.past.length > 0) {
    useWorkflowStore.setState({ past: after.past.slice(0, -1) });
  }
}
