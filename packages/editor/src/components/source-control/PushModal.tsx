/**
 * P6-76 (L6): Push to Git. The changed files by type with checkboxes and a filter, a commit message, Push.
 * The request names only (id, type) of each picked file; the server builds the paths. "View diff" opens the
 * remote diff of a workflow. A refusal (a protected branch, a conflict) shows the server's text here.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileDiff } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../api/client';
import { sourceControlApi } from '../../api/endpoints';
import { queryKeys, useSourceControlStatus } from '../../api/queries';
import type { PushResult, SourceControlledFile, SourceControlledFileType } from '../../api/types';
import { Button, IconButton } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Checkbox, FormField, TextInput } from '../ui/Field';
import { Badge, Callout, PageLoader } from '../ui/misc';
import { RemoteDiffDialog } from './RemoteDiffDialog';

export interface PushModalProps {
  open: boolean;
  onClose(): void;
  onPushed(result: PushResult): void;
}

/** the heading of each kind of file, in the order the lists show them */
export const FILE_TYPE_LABELS: ReadonlyArray<readonly [SourceControlledFileType, string]> = [
  ['workflow', 'Workflows'],
  ['credential', 'Credentials'],
  ['variables', 'Variables'],
  ['tags', 'Tags'],
  ['folders', 'Folders'],
  ['datatable', 'Data tables'],
  ['project', 'Projects'],
];

const STATUS_TONE: Record<SourceControlledFile['status'], 'ok' | 'warn' | 'err' | 'neutral'> = {
  new: 'ok',
  created: 'ok',
  modified: 'warn',
  renamed: 'warn',
  conflicted: 'err',
  deleted: 'err',
  unknown: 'neutral',
};

export const fileKey = (file: Pick<SourceControlledFile, 'id' | 'type'>) => `${file.type}:${file.id}`;

/** the files grouped by type, in the heading order; types with no file are left out */
export function groupFiles(
  files: SourceControlledFile[],
): Array<{ type: SourceControlledFileType; label: string; files: SourceControlledFile[] }> {
  return FILE_TYPE_LABELS.map(([type, label]) => ({
    type,
    label,
    files: files.filter((f) => f.type === type),
  })).filter((group) => group.files.length > 0);
}

export function StatusBadge({ status }: { status: SourceControlledFile['status'] }): ReactNode {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}

export function PushModal({ open, onClose, onPushed }: PushModalProps) {
  const queryClient = useQueryClient();
  const status = useSourceControlStatus('push', open);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<SourceControlledFile | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked(new Set());
    setMessage('');
    setFilter('');
    setError(null);
  }, [open]);

  const files = status.data ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () => files.filter((f) => !needle || f.name.toLowerCase().includes(needle)),
    [files, needle],
  );
  const groups = groupFiles(visible);
  const chosen = files.filter((f) => picked.has(fileKey(f)));

  const push = useMutation({
    mutationFn: () =>
      sourceControlApi.push({
        commitMessage: message.trim(),
        fileNames: chosen.map(({ id, type }) => ({ id, type })),
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.sourceControl });
      onPushed(result);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const toggle = (file: SourceControlledFile, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(fileKey(file));
      else next.delete(fileKey(file));
      return next;
    });
  const allVisiblePicked = visible.length > 0 && visible.every((f) => picked.has(fileKey(f)));
  const toggleAll = (on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      for (const f of visible) {
        if (on) next.add(fileKey(f));
        else next.delete(fileKey(f));
      }
      return next;
    });

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Push to Git"
        description="Pick what goes to the remote branch. Credentials are pushed as stubs: no secret leaves the workspace."
        size="lg"
        dismissible={!push.isPending}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={push.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={push.isPending}
              disabled={chosen.length === 0 || message.trim() === ''}
              onClick={() => {
                setError(null);
                push.mutate();
              }}
            >
              Push
            </Button>
          </>
        }
      >
        {status.isLoading ? (
          <PageLoader label="Reading the changes" />
        ) : status.error ? (
          <Callout tone="err">{errorMessage(status.error)}</Callout>
        ) : files.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing to push. This workspace matches the remote branch.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <FormField label="Filter files" className="min-w-48 flex-1">
                {(id) => (
                  <TextInput
                    id={id}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Name contains"
                  />
                )}
              </FormField>
              <Checkbox
                label="Select all"
                checked={allVisiblePicked}
                disabled={visible.length === 0}
                onChange={(e) => toggleAll(e.target.checked)}
              />
            </div>
            <div className="flex max-h-[40vh] flex-col gap-3 overflow-y-auto pr-1">
              {groups.length === 0 && <p className="text-sm text-ink-2">No file matches the filter.</p>}
              {groups.map((group) => (
                <section key={group.type} aria-label={group.label}>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-2">
                    {group.label}
                  </h3>
                  <ul className="flex flex-col gap-1">
                    {group.files.map((file) => (
                      <li key={fileKey(file)} className="flex items-center gap-2">
                        <Checkbox
                          className="min-w-0 flex-1"
                          label={
                            <>
                              <span className="truncate">{file.name}</span>{' '}
                              <StatusBadge status={file.status} />
                            </>
                          }
                          checked={picked.has(fileKey(file))}
                          onChange={(e) => toggle(file, e.target.checked)}
                        />
                        {file.type === 'workflow' && (
                          <IconButton
                            label={`View diff of ${file.name}`}
                            size="sm"
                            onClick={() => setDiffFile(file)}
                          >
                            <FileDiff size={14} />
                          </IconButton>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <FormField label="Commit message">
              {(id) => (
                <TextInput
                  id={id}
                  value={message}
                  maxLength={1000}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Describe the change"
                />
              )}
            </FormField>
            {error && <Callout tone="err">{error}</Callout>}
          </div>
        )}
      </Dialog>
      <RemoteDiffDialog file={diffFile} onClose={() => setDiffFile(null)} />
    </>
  );
}
