/**
 * Folder picker for moving a workflow or a folder (P3-07). It is also the keyboard path for
 * drag and drop: browse into folders, then "Move here".
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Folder as FolderIcon, Home } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../api/client';
import { foldersApi, workflowsApi } from '../../api/endpoints';
import { queryKeys, useFolder } from '../../api/queries';
import { toast } from '../../stores/ui-store';
import { FolderDependencyNotice, WorkflowUsedByNotice } from '../dependencies/DependencyDetails';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Callout, PageLoader } from '../ui/misc';

/** `projectId`: the project the item is in, so only that project's folders are offered (P6-43) */
export type MoveTarget =
  | { kind: 'workflow'; ids: string[]; name: string; folderId: string | null; projectId?: string }
  | { kind: 'folder'; id: string; name: string; parentFolderId: string | null; projectId?: string };

export function MoveToFolderDialog({
  open,
  target,
  onClose,
  onMoved,
}: {
  open: boolean;
  target: MoveTarget | null;
  onClose: () => void;
  onMoved?: () => void;
}) {
  const queryClient = useQueryClient();
  const origin = target ? (target.kind === 'workflow' ? target.folderId : target.parentFolderId) : null;
  const [browsing, setBrowsing] = useState<string | null>(origin);
  useEffect(() => {
    if (open) setBrowsing(origin);
  }, [open, origin]);
  const here = useFolder(open ? (browsing ?? undefined) : undefined);
  const projectId = target?.projectId;
  const children = useQuery({
    queryKey: queryKeys.folders({ parentFolderId: browsing ?? 'root', projectId }),
    queryFn: () => foldersApi.list({ parentFolderId: browsing ?? 'root', limit: 250, projectId }),
    enabled: open,
  });
  const move = useMutation({
    mutationFn: async () => {
      if (!target) return;
      if (target.kind === 'workflow') {
        await workflowsApi.move({ workflowIds: target.ids, folderId: browsing });
      } else {
        await foldersApi.update(target.id, { parentFolderId: browsing });
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workflows'] }),
        queryClient.invalidateQueries({ queryKey: ['folders'] }),
        queryClient.invalidateQueries({ queryKey: ['folder'] }),
      ]);
      toast.success('Moved', target?.name);
      onMoved?.();
      onClose();
    },
    onError: (error) => toast.error('Could not move it', errorMessage(error)),
  });
  // a folder cannot go into itself; its subfolders are unreachable because it is hidden here
  const choices = (children.data?.data ?? []).filter(
    (f) => !(target?.kind === 'folder' && f.id === target.id),
  );
  const unchanged = browsing === origin;
  const path = here.data?.path ?? [];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={target ? `Move “${target.name}”` : 'Move'}
      description="Choose the folder to move it to."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => move.mutate()}
            loading={move.isPending}
            disabled={unchanged}
          >
            Move here
          </Button>
        </>
      }
    >
      <nav aria-label="Folder path" className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
          onClick={() => setBrowsing(null)}
        >
          <Home size={13} /> Workflows
        </button>
        {path.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1">
            <ChevronRight size={12} className="text-ink-3" />
            <button
              type="button"
              className="rounded-md px-1.5 py-0.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
              onClick={() => setBrowsing(p.id)}
            >
              {p.name}
            </button>
          </span>
        ))}
        {here.data && (
          <span className="inline-flex items-center gap-1">
            <ChevronRight size={12} className="text-ink-3" />
            <span className="px-1.5 py-0.5 font-semibold" aria-current="location">
              {here.data.name}
            </span>
          </span>
        )}
      </nav>
      {children.isLoading ? (
        <PageLoader />
      ) : children.error ? (
        <Callout tone="err">{errorMessage(children.error)}</Callout>
      ) : choices.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-ink-2">
          No folders here. You can move it here.
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {choices.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-3"
                onClick={() => setBrowsing(f.id)}
              >
                <FolderIcon size={15} className="text-ink-3" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <ChevronRight size={14} className="text-ink-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* P6-86: what uses the item being moved */}
      {open && target?.kind === 'workflow' && target.ids.length === 1 && (
        <WorkflowUsedByNotice workflowId={target.ids[0]} />
      )}
      {open && target?.kind === 'folder' && (
        <FolderDependencyNotice projectId={target.projectId} folderId={target.id} risky={false} />
      )}
    </Dialog>
  );
}
