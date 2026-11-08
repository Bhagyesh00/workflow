/**
 * Workflow commands shared by the editor header, the canvas, the context menu (P3-02) and the
 * command bar (P3-01): add a sticky note, duplicate, download as JSON.
 */
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import type { WorkflowDTO } from '../../api/types';
import { downloadJson, safeFileName } from '../../lib/format';
import { withFreshWebhookIds } from '../../lib/workflow-ops';
import { refuseWhileReviewing } from '../../stores/builder-store';
import { toast } from '../../stores/ui-store';
import { toWorkflowBody, useWorkflowStore } from '../../stores/workflow-store';
import type { EditorDeps } from './editor-actions';

const STICKY_WIDTH = 260;
const STICKY_HEIGHT = 160;

/**
 * Add a sticky note around `position` (flow coordinates), or around the middle of the visible
 * canvas (as the canvas button always did). Returns the new sticky's id (null when read-only).
 */
export function addStickyAt(
  flow: { screenToFlowPosition(point: { x: number; y: number }): { x: number; y: number } },
  position?: [number, number],
): string | null {
  const store = useWorkflowStore.getState();
  if (store.readOnly) return null;
  const center = position
    ? { x: position[0], y: position[1] }
    : flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2.5 });
  return store.addSticky({
    content: '## Note\nDescribe what this part of the workflow does.',
    position: [Math.round(center.x - 120), Math.round(center.y - 80)],
    width: STICKY_WIDTH,
    height: STICKY_HEIGHT,
  });
}

/** Save a copy of the open workflow (fresh webhook ids) and open it. */
export async function duplicateWorkflow(deps: Pick<EditorDeps, 'navigate'>): Promise<WorkflowDTO | null> {
  // P5-62: a copy would save the AI draft under review
  if (refuseWhileReviewing()) return null;
  try {
    const s = useWorkflowStore.getState();
    const body = toWorkflowBody(s);
    const dto = await workflowsApi.create({
      ...body,
      nodes: withFreshWebhookIds(body.nodes),
      name: `${s.meta.name} copy`,
    });
    toast.success('Workflow duplicated', dto.name);
    deps.navigate(`/workflow/${encodeURIComponent(dto.id)}`);
    return dto;
  } catch (error) {
    toast.error('Could not duplicate the workflow', errorMessage(error));
    return null;
  }
}

/** Download the open workflow (as on the canvas, unsaved edits included) as a JSON file. */
export function downloadWorkflow(): void {
  const s = useWorkflowStore.getState();
  downloadJson(`${safeFileName(s.meta.name)}.json`, {
    name: s.meta.name,
    nodes: s.nodes,
    connections: s.connections,
    settings: s.meta.settings,
    pinData: s.pinData,
    stickyNotes: s.stickyNotes,
    ...(s.nodeGroups.length ? { nodeGroups: s.nodeGroups } : {}),
  });
}
