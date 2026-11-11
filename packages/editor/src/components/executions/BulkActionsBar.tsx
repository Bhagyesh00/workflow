/**
 * P6-85 (L17): stop or delete the selected runs, or every run matching the filter. The server checks each
 * run (`workflow:execute` to stop, `execution:delete` to delete) and answers how many it acted on; the
 * buttons are offered by the caller's scope in the list's project.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { type ExecutionBulkFilter, executionBulkApi } from '../../api/endpoints';
import { toast } from '../../stores/ui-store';
import { useProjectListScope } from '../projects/ProjectFilter';
import { Button } from '../ui/Button';
import { confirmDialog } from '../ui/Dialog';

export interface BulkActionsBarProps {
  /** the picked run ids; empty with `allMatching` means the whole filter */
  selectedIds: string[];
  /** the list's filter */
  filter: ExecutionBulkFilter;
  allMatching: boolean;
  /** clears the selection after an action */
  onClear(): void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function BulkActionsBar({
  selectedIds,
  filter,
  allMatching,
  onClear,
}: BulkActionsBarProps): ReactNode {
  const client = useQueryClient();
  const { canCreate } = useProjectListScope('executions');
  const covered = allMatching ? 'every run matching the filters' : plural(selectedIds.length, 'selected run');
  const refresh = () => client.invalidateQueries({ queryKey: ['executions'] });

  const stop = useMutation({
    mutationFn: () => executionBulkApi.stopMany(allMatching ? filter : { ids: selectedIds }),
    onSuccess: ({ stopped }) => {
      toast.success(stopped === 0 ? 'No run was running' : `Stopped ${plural(stopped, 'run')}`);
      onClear();
      void refresh();
    },
    onError: (error) => toast.error("Couldn't stop the runs", errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: () => executionBulkApi.deleteMany(allMatching ? { filters: filter } : { ids: selectedIds }),
    onSuccess: ({ deleted }) => {
      toast.success(`Deleted ${plural(deleted, 'run')}`);
      onClear();
      void refresh();
    },
    onError: (error) => toast.error("Couldn't delete the runs", errorMessage(error)),
  });

  if (!allMatching && selectedIds.length === 0) return null;
  const mayStop = canCreate('workflow:execute');
  const mayDelete = canCreate('execution:delete');

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-2 text-sm"
    >
      <span className="font-semibold">
        {allMatching ? 'All matching runs' : `${selectedIds.length} selected`}
      </span>
      <Button
        size="sm"
        disabled={!mayStop}
        title={mayStop ? undefined : 'You need permission to run workflows here'}
        loading={stop.isPending}
        onClick={() => {
          void confirmDialog({
            title: 'Stop runs',
            description: `Stop ${covered} that are still running or waiting? Runs you may not stop stay as they are.`,
            confirmLabel: 'Stop',
          }).then((ok) => {
            if (ok) stop.mutate();
          });
        }}
      >
        Stop
      </Button>
      <Button
        size="sm"
        variant="danger"
        disabled={!mayDelete}
        title={mayDelete ? undefined : 'You need permission to delete runs here'}
        loading={remove.isPending}
        onClick={() => {
          void confirmDialog({
            title: 'Delete runs',
            description: `Delete ${covered}? Runs you may not delete stay. This can't be undone.`,
            confirmLabel: 'Delete',
            tone: 'danger',
          }).then((ok) => {
            if (ok) remove.mutate();
          });
        }}
      >
        Delete
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
    </div>
  );
}
