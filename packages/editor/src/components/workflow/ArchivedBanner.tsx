/**
 * Banner over the canvas of an archived workflow (read-only), with Restore (P3-07).
 */
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore } from 'lucide-react';
import { useMe } from '../../api/queries';
import { unarchiveWorkflow } from '../../features/workflows/archive-actions';
import { useWorkflowStore } from '../../stores/workflow-store';
import { Button } from '../ui/Button';

export function ArchivedBanner() {
  const id = useWorkflowStore((s) => s.meta.id);
  const isArchived = useWorkflowStore((s) => s.meta.isArchived);
  const canWrite = useMe().data?.role !== 'viewer';
  const queryClient = useQueryClient();
  if (!isArchived || !id) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-line bg-warn-soft px-4 py-2 text-sm text-ink"
    >
      <Archive size={15} className="shrink-0 text-warn" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">This workflow is archived.</span> It is unpublished and read-only.
      </span>
      {canWrite && (
        <Button
          size="sm"
          icon={<ArchiveRestore size={14} />}
          onClick={() => void unarchiveWorkflow(id, { queryClient })}
        >
          Restore
        </Button>
      )}
    </div>
  );
}
