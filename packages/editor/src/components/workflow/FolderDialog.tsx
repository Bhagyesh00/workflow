/**
 * Create, rename and delete a folder (P3-07). The name rule is the server's (and n8n's): trimmed,
 * 1 to 128 characters, none of [ ] ^ \ / : * ? " < > |, not only dots, no leading dot.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../api/client';
import { foldersApi } from '../../api/endpoints';
import { useFolder } from '../../api/queries';
import type { Folder } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { FormField, TextInput } from '../ui/Field';
import { Callout } from '../ui/misc';

export const FOLDER_NAME_MAX = 128;
const FORBIDDEN = /[[\]^\\/:*?"<>|]/;

/** Why `name` is not a valid folder name, or null. The name is trimmed first. */
export function folderNameError(name: string): string | null {
  const value = name.trim();
  if (!value) return 'Enter a folder name.';
  if (value.length > FOLDER_NAME_MAX) return `Use at most ${FOLDER_NAME_MAX} characters.`;
  if (FORBIDDEN.test(value)) return 'The name cannot contain [ ] ^ \\ / : * ? " < > |';
  if (/^\.+$/.test(value)) return 'The name cannot be only dots.';
  if (value.startsWith('.')) return 'The name cannot start with a dot.';
  return null;
}

function refreshFolders(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['folders'] }),
    queryClient.invalidateQueries({ queryKey: ['folder'] }),
    queryClient.invalidateQueries({ queryKey: ['favorites'] }),
    queryClient.invalidateQueries({ queryKey: ['workflows'] }),
  ]);
}

export type FolderDialogProps =
  | {
      mode: 'create';
      open: boolean;
      onClose: () => void;
      parentFolderId: string | null;
      /** P6-43: the project a top-level folder goes to (a subfolder follows its parent) */
      projectId?: string;
      onDone?: (f: Folder) => void;
    }
  | { mode: 'rename'; open: boolean; onClose: () => void; folder: Folder; onDone?: (f: Folder) => void };

export function FolderDialog(props: FolderDialogProps) {
  const { open, onClose, onDone } = props;
  const queryClient = useQueryClient();
  const initial = props.mode === 'rename' ? props.folder.name : '';
  const [name, setName] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(initial);
      setTouched(false);
      setServerError(null);
    }
  }, [open, initial]);
  const invalid = folderNameError(name);
  const save = useMutation({
    mutationFn: () =>
      props.mode === 'create'
        ? foldersApi.create({
            name: name.trim(),
            parentFolderId: props.parentFolderId,
            ...(props.parentFolderId || !props.projectId ? {} : { projectId: props.projectId }),
          })
        : foldersApi.update(props.folder.id, { name: name.trim() }),
    onSuccess: async (folder) => {
      await refreshFolders(queryClient);
      toast.success(props.mode === 'create' ? 'Folder created' : 'Folder renamed', folder.name);
      onDone?.(folder);
      onClose();
    },
    onError: (error) => setServerError(errorMessage(error)),
  });
  const submit = () => {
    setTouched(true);
    if (invalid || save.isPending) return;
    setServerError(null);
    save.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={props.mode === 'create' ? 'New folder' : 'Rename folder'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={save.isPending}>
            {props.mode === 'create' ? 'Create folder' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormField label="Folder name" error={touched ? invalid : null}>
          {(id) => (
            <TextInput
              id={id}
              data-autofocus
              value={name}
              maxLength={FOLDER_NAME_MAX + 20}
              onChange={(e) => {
                setName(e.target.value);
                setServerError(null);
              }}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && Boolean(invalid)}
            />
          )}
        </FormField>
        {serverError && <Callout tone="err">{serverError}</Callout>}
      </form>
    </Dialog>
  );
}

/**
 * Delete a folder. Shows how many workflows and subfolders it holds; the choice is to move the
 * content up one level (nothing is archived) or to archive its workflows and delete everything inside.
 */
export function DeleteFolderDialog({
  open,
  folder,
  onClose,
  onDeleted,
}: {
  open: boolean;
  folder: Folder;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useFolder(open ? folder.id : undefined);
  const [choice, setChoice] = useState<'move' | 'archive'>('move');
  useEffect(() => {
    if (open) setChoice('move');
  }, [open]);
  const workflows = detail.data?.workflowCount ?? 0;
  const subfolders = detail.data?.subFolderCount ?? 0;
  const parent = folder.parentFolderId ?? 'root';
  const remove = useMutation({
    mutationFn: () => foldersApi.remove(folder.id, choice === 'move' ? parent : undefined),
    onSuccess: async () => {
      await refreshFolders(queryClient);
      toast.success('Folder deleted', folder.name);
      onDeleted?.();
      onClose();
    },
    onError: (error) => toast.error('Could not delete the folder', errorMessage(error)),
  });
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Delete “${folder.name}”?`}
      description={
        detail.data
          ? `It holds ${plural(workflows, 'workflow')} and ${plural(subfolders, 'subfolder')}.`
          : 'Checking what is inside.'
      }
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => remove.mutate()}
            loading={remove.isPending}
            disabled={!detail.data}
          >
            Delete folder
          </Button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-2.5">
        <legend className="sr-only">What happens to the content</legend>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="radio"
            name="folder-delete"
            className="mt-0.5 accent-[var(--wf-brand)]"
            checked={choice === 'move'}
            onChange={() => setChoice('move')}
          />
          <span>
            <span className="font-semibold">
              Move the content to {folder.parentFolderId ? 'the parent folder' : 'the top level'}
            </span>
            <span className="block text-xs text-ink-2">Workflows and subfolders are kept as they are.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="radio"
            name="folder-delete"
            className="mt-0.5 accent-[var(--wf-brand)]"
            checked={choice === 'archive'}
            onChange={() => setChoice('archive')}
          />
          <span>
            <span className="font-semibold">
              Archive {plural(workflows, 'workflow')} and delete {plural(subfolders, 'subfolder')}
            </span>
            <span className="block text-xs text-ink-2">
              The workflows are unpublished and archived at the top level. You can restore them later.
            </span>
          </span>
        </label>
      </fieldset>
    </Dialog>
  );
}
