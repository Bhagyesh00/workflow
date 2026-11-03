/**
 * Drag a workflow or folder row onto a folder row or a breadcrumb item to move it (P3-07).
 * Native HTML5 drag and drop: no library. The Move dialog stays the keyboard path.
 *
 * Browsers hide the drag data until the drop, so the item being dragged is also kept in a module
 * variable that dragover reads.
 */
import type { QueryClient } from '@tanstack/react-query';
import { type DragEvent, useCallback, useState } from 'react';
import { errorMessage } from '../../api/client';
import { foldersApi, workflowsApi } from '../../api/endpoints';
import { toast } from '../../stores/ui-store';

export const DRAG_MIME = 'application/x-workflow-resource';

export type DragItem =
  | { type: 'workflow'; id: string; name: string; folderId: string | null }
  | { type: 'folder'; id: string; name: string; parentFolderId: string | null };

/** where an item can be dropped: a folder (null = the top level) and the ids from the top level down to it */
export interface DropTarget {
  folderId: string | null;
  /** the ids of the target's ancestors and the target itself (empty for the top level) */
  path: string[];
}

let dragging: DragItem | null = null;

/** the item being dragged right now, if any */
export function currentDrag(): DragItem | null {
  return dragging;
}

export function parentOf(item: DragItem): string | null {
  return item.type === 'workflow' ? item.folderId : item.parentFolderId;
}

/**
 * Whether `item` may be dropped on `target`: not onto the folder it is already in, not a folder
 * onto itself or one of its subfolders.
 */
export function canDrop(item: DragItem, target: DropTarget): boolean {
  if (parentOf(item) === target.folderId) return false;
  if (item.type === 'folder' && target.path.includes(item.id)) return false;
  return true;
}

/** Move the dropped item. Resolves true when it moved; shows a toast either way. */
export async function dropItem(
  item: DragItem,
  target: DropTarget,
  deps: { queryClient: QueryClient; targetName?: string },
): Promise<boolean> {
  if (!canDrop(item, target)) return false;
  try {
    if (item.type === 'workflow') {
      await workflowsApi.move({ workflowIds: [item.id], folderId: target.folderId });
    } else {
      await foldersApi.update(item.id, { parentFolderId: target.folderId });
    }
    await Promise.all([
      deps.queryClient.invalidateQueries({ queryKey: ['workflows'] }),
      deps.queryClient.invalidateQueries({ queryKey: ['folders'] }),
      deps.queryClient.invalidateQueries({ queryKey: ['folder'] }),
    ]);
    toast.success('Moved', `${item.name} to ${deps.targetName ?? 'the top level'}`);
    return true;
  } catch (error) {
    toast.error('Could not move it', errorMessage(error));
    return false;
  }
}

/** props for a row that can be dragged; `enabled` is false for viewers and read-only pages */
export function dragProps(item: DragItem, enabled: boolean) {
  if (!enabled) return {};
  return {
    draggable: true as const,
    onDragStart: (event: DragEvent) => {
      dragging = item;
      event.dataTransfer?.setData(DRAG_MIME, JSON.stringify(item));
      event.dataTransfer?.setData('text/plain', item.name);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => {
      dragging = null;
    },
  };
}

/** props and state for a folder row or breadcrumb item that accepts drops */
export function useDropTarget(
  target: DropTarget,
  onDrop: (item: DragItem) => void,
  enabled: boolean,
): { over: boolean; props: Record<string, unknown> } {
  const [over, setOver] = useState(false);
  const accepts = useCallback(() => {
    const item = dragging;
    return enabled && item !== null && canDrop(item, target);
  }, [enabled, target]);
  if (!enabled) return { over: false, props: {} };
  return {
    over,
    props: {
      onDragEnter: (event: DragEvent) => {
        if (!accepts()) return;
        event.preventDefault();
        setOver(true);
      },
      onDragOver: (event: DragEvent) => {
        if (!accepts()) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        setOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        // moving between children of the same target is not leaving it
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      },
      onDrop: (event: DragEvent) => {
        setOver(false);
        const item = dragging;
        if (!item || !accepts()) return;
        event.preventDefault();
        dragging = null;
        onDrop(item);
      },
    },
  };
}
