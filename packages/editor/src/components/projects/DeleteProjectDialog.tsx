/**
 * P6-42: delete a team project: radio Transfer (to another project) or Wipe; wipe needs the text
 * "delete all data".
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { projectsApi } from '../../api/endpoints';
import { useProjects } from '../../api/queries';
import type { ProjectDetail } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Select, TextInput } from '../ui/Field';

export interface DeleteProjectDialogProps {
  project: ProjectDetail;
  onClose(): void;
  onDeleted?(): void;
}

export const WIPE_CONFIRMATION = 'delete all data';

const TARGET_SCOPES = ['workflow:create', 'credential:create', 'dataTable:create'] as const;

export function DeleteProjectDialog({ project, onClose, onDeleted }: DeleteProjectDialogProps) {
  const queryClient = useQueryClient();
  const projects = useProjects();
  const targets = (projects.data ?? []).filter(
    (p) => p.id !== project.id && TARGET_SCOPES.every((s) => p.scopes?.includes(s)),
  );
  const [mode, setMode] = useState<'transfer' | 'wipe'>('transfer');
  const [target, setTarget] = useState('');
  const [confirm, setConfirm] = useState('');
  const targetId = target || targets[0]?.id || '';
  const ready = mode === 'transfer' ? Boolean(targetId) : confirm.trim() === WIPE_CONFIRMATION;

  const remove = useMutation({
    mutationFn: () => projectsApi.remove(project.id, mode === 'transfer' ? targetId : undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success(`Deleted ${project.name}`);
      onDeleted?.();
      onClose();
    },
    onError: (error) => toast.error("Couldn't delete the project", errorMessage(error)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!remove.isPending}
      size="sm"
      title={`Delete ${project.name}`}
      description="Choose what happens to the workflows, credentials, data tables and folders in this project."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!ready}
            loading={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete project
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="delete-mode"
            checked={mode === 'transfer'}
            onChange={() => setMode('transfer')}
          />
          <span>Transfer its workflows, credentials, data tables and folders to another project</span>
        </label>
        {mode === 'transfer' &&
          (targets.length > 0 ? (
            <Select
              aria-label="Transfer to project"
              value={targetId}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-ink-2">No other project can take this work.</p>
          ))}
        <label className="flex items-start gap-2">
          <input type="radio" name="delete-mode" checked={mode === 'wipe'} onChange={() => setMode('wipe')} />
          <span>Delete its workflows, credentials, data tables and folders</span>
        </label>
        {mode === 'wipe' && (
          <div className="flex flex-col gap-1.5">
            <span className="font-semibold text-ink">Type "{WIPE_CONFIRMATION}" to confirm</span>
            <TextInput
              aria-label="Confirmation text"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
