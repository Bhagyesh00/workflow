/**
 * Archive, unarchive and delete workflows (P3-07, n8n rules): archive unpublishes first;
 * unarchive does not republish; the editor deletes only archived workflows (confirm first).
 * Used by the editor header, the workflows list and the command bar.
 */
import type { QueryClient } from '@tanstack/react-query';
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { Me, WorkflowDTO } from '../../api/types';
import { confirmDialog } from '../../components/ui/Dialog';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

export interface WorkflowActionDeps {
  navigate?: (to: string) => void;
  queryClient?: QueryClient;
}

async function refresh(deps: WorkflowActionDeps | undefined): Promise<void> {
  const client = deps?.queryClient;
  if (!client) return;
  await Promise.all([
    client.invalidateQueries({ queryKey: ['workflows'] }),
    client.invalidateQueries({ queryKey: ['folders'] }),
    client.invalidateQueries({ queryKey: ['folder'] }),
    client.invalidateQueries({ queryKey: queryKeys.favorites }),
  ]);
}

/** Resolves with the archived workflow, or null when it failed (toast shown). */
export async function archiveWorkflow(id: string, deps?: WorkflowActionDeps): Promise<WorkflowDTO | null> {
  const store = useWorkflowStore.getState();
  const name = store.meta.id === id ? store.meta.name : undefined;
  const ok = await confirmDialog({
    title: name ? `Archive “${name}”?` : 'Archive this workflow?',
    description: 'It is unpublished and becomes read-only. You can restore it later.',
    confirmLabel: 'Archive workflow',
  });
  if (!ok) return null;
  try {
    const dto = await workflowsApi.archive(id);
    const current = useWorkflowStore.getState();
    if (current.meta.id === id) {
      current.setPublished(null);
      current.setArchived(true);
    }
    await refresh(deps);
    toast.success('Workflow archived', dto.name);
    return dto;
  } catch (error) {
    toast.error('Could not archive the workflow', errorMessage(error));
    return null;
  }
}

export async function unarchiveWorkflow(id: string, deps?: WorkflowActionDeps): Promise<WorkflowDTO | null> {
  try {
    const dto = await workflowsApi.unarchive(id);
    const current = useWorkflowStore.getState();
    if (current.meta.id === id) {
      // back to the role's own read-only state; a viewer stays read-only
      const me = deps?.queryClient?.getQueryData<Me>(queryKeys.me);
      current.setArchived(false, me?.role === 'viewer');
    }
    await refresh(deps);
    toast.success('Workflow restored', `${dto.name} stays unpublished`);
    return dto;
  } catch (error) {
    toast.error('Could not restore the workflow', errorMessage(error));
    return null;
  }
}

/** Asks first; resolves true when the archived workflow was deleted. */
export async function deleteArchivedWorkflow(id: string, deps?: WorkflowActionDeps): Promise<boolean> {
  const store = useWorkflowStore.getState();
  const name = store.meta.id === id ? store.meta.name : undefined;
  const ok = await confirmDialog({
    title: name ? `Delete “${name}”?` : 'Delete this workflow?',
    description: 'This cannot be undone.',
    confirmLabel: 'Delete workflow',
    tone: 'danger',
  });
  if (!ok) return false;
  try {
    await workflowsApi.remove(id);
    await refresh(deps);
    toast.success('Workflow deleted');
    deps?.navigate?.('/workflows');
    return true;
  } catch (error) {
    toast.error('Could not delete the workflow', errorMessage(error));
    return false;
  }
}
