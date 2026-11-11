/**
 * P6-81 (L14): "This workflow was updated" after another user saved it, with a reload action.
 */
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import { useCanEditWorkflow } from '../../features/editor/open-resources';
import { useCollaborationStore } from '../../stores/collaboration-store';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { Button } from '../ui/Button';

export interface WorkflowUpdatedPromptProps {
  workflowId: string;
}

export function WorkflowUpdatedPrompt({ workflowId }: WorkflowUpdatedPromptProps) {
  const openId = useCollaborationStore((s) => s.workflowId);
  const updatedBy = useCollaborationStore((s) => s.updatedBy);
  const collaborators = useCollaborationStore((s) => s.collaborators);
  const dirty = useWorkflowStore((s) => s.dirty);
  const canWrite = useCanEditWorkflow();
  const [busy, setBusy] = useState(false);
  if (openId !== workflowId || !updatedBy) return null;
  const who = collaborators.find((c) => c.userId === updatedBy)?.name || 'Someone else';
  const reload = async () => {
    setBusy(true);
    try {
      const dto = await workflowsApi.get(workflowId);
      useWorkflowStore.getState().load(dto, { readOnly: !canWrite });
      useCollaborationStore.getState().markUpdated(null);
    } catch (error) {
      toast.error("Couldn't load the workflow", errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-line bg-brand-soft px-4 py-2 text-sm text-ink"
      data-testid="workflow-updated-prompt"
    >
      <RefreshCw size={15} className="shrink-0 text-brand" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{who} updated this workflow.</span>{' '}
        {dirty ? 'Reloading drops your unsaved changes.' : 'Reload to see the latest version.'}
      </span>
      <Button size="sm" variant="primary" loading={busy} onClick={() => void reload()}>
        Reload
      </Button>
      <Button size="sm" variant="ghost" onClick={() => useCollaborationStore.getState().markUpdated(null)}>
        Dismiss
      </Button>
    </div>
  );
}
