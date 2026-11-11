/**
 * P6-76 (L6): Pull from Git. The incoming changes by type; a file with a local change is a conflict, and then
 * the only way on is "Pull and override" behind a confirm (the request carries `force`). The publish choice
 * goes with the request as `autoPublish`. A 409 from the server (the remote moved) shows its text and refreshes
 * the list.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorMessage, isApiError } from '../../api/client';
import { sourceControlApi } from '../../api/endpoints';
import { queryKeys, useSourceControlStatus } from '../../api/queries';
import type { PullResult, PullWorkFolderBody } from '../../api/types';
import { Button } from '../ui/Button';
import { confirmDialog, Dialog } from '../ui/Dialog';
import { FormField, Select } from '../ui/Field';
import { Callout, PageLoader } from '../ui/misc';
import { fileKey, groupFiles, StatusBadge } from './PushModal';

export interface PullModalProps {
  open: boolean;
  onClose(): void;
  onPulled(result: PullResult): void;
}

type AutoPublish = NonNullable<PullWorkFolderBody['autoPublish']>;

export function PullModal({ open, onClose, onPulled }: PullModalProps) {
  const queryClient = useQueryClient();
  const status = useSourceControlStatus('pull', open);
  const [autoPublish, setAutoPublish] = useState<AutoPublish>('none');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAutoPublish('none');
    setError(null);
  }, [open]);

  const files = status.data ?? [];
  const conflicts = files.filter((f) => f.conflict);

  const pull = useMutation({
    mutationFn: (force: boolean) => sourceControlApi.pull({ force, autoPublish }),
    onSuccess: async (result) => {
      // a pull can change workflows, credentials, variables, tags, folders, tables and projects
      await queryClient.invalidateQueries();
      onPulled(result);
    },
    onError: async (e) => {
      setError(errorMessage(e));
      if (isApiError(e, 409)) await queryClient.invalidateQueries({ queryKey: queryKeys.sourceControl });
    },
  });

  const override = async () => {
    const ok = await confirmDialog({
      title: 'Override local changes?',
      description: `${conflicts.length === 1 ? 'One file has' : `${conflicts.length} files have`} local changes. Pulling replaces them with the remote version. This cannot be undone.`,
      confirmLabel: 'Pull and override',
      tone: 'danger',
    });
    if (!ok) return;
    setError(null);
    pull.mutate(true);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Pull from Git"
      description="Bring the remote branch into this workspace. Credentials arrive as stubs: fill in their secrets here."
      size="lg"
      dismissible={!pull.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pull.isPending}>
            Cancel
          </Button>
          {conflicts.length > 0 ? (
            <Button variant="danger" loading={pull.isPending} onClick={() => void override()}>
              Pull and override
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={pull.isPending}
              disabled={files.length === 0}
              onClick={() => {
                setError(null);
                pull.mutate(false);
              }}
            >
              Pull
            </Button>
          )}
        </>
      }
    >
      {status.isLoading ? (
        <PageLoader label="Reading the remote" />
      ) : status.error ? (
        <Callout tone="err">{errorMessage(status.error)}</Callout>
      ) : files.length === 0 ? (
        <p className="text-sm text-ink-2">Nothing to pull. This workspace matches the remote branch.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {conflicts.length > 0 && (
            <Callout
              tone="warn"
              title={`${conflicts.length} ${conflicts.length === 1 ? 'conflict' : 'conflicts'}`}
            >
              The files marked below have local changes. A pull would replace them with the remote version.
            </Callout>
          )}
          <div className="flex max-h-[40vh] flex-col gap-3 overflow-y-auto pr-1">
            {groupFiles(files).map((group) => (
              <section key={group.type} aria-label={group.label}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-2">
                  {group.label}
                </h3>
                <ul className="flex flex-col gap-1 text-sm">
                  {group.files.map((file) => (
                    <li key={fileKey(file)} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <StatusBadge status={file.status} />
                      {file.conflict && <span className="text-xs font-semibold text-warn">conflict</span>}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <FormField label="After the pull" hint="Publishing runs once the files are in.">
            {(id) => (
              <Select
                id={id}
                value={autoPublish}
                onChange={(e) => setAutoPublish(e.target.value as AutoPublish)}
              >
                <option value="none">Keep workflows as they are</option>
                <option value="published">Publish the ones already published here</option>
                <option value="all">Publish every pulled workflow</option>
              </Select>
            )}
          </FormField>
          {error && <Callout tone="err">{error}</Callout>}
        </div>
      )}
    </Dialog>
  );
}
