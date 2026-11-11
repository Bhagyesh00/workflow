/**
 * P6-86: which dependency dialog is open. The "Dependencies" dialog of a resource (workflow header menu) and the
 * unpublish dialog, which `unpublishWorkflow` opens and waits on before it unpublishes. Rendered by
 * `DependencyDialogsHost` in the shell.
 */
import { create } from 'zustand';
import type { DependencyDetail, DependencyResourceKind } from '../api/types';

export type DependencyDialogRequest =
  | { type: 'details'; kind: DependencyResourceKind; id: string; name: string }
  | {
      type: 'unpublish';
      workflowId: string;
      name: string;
      /** published workflows that call this one or name it as their error workflow */
      dependents: DependencyDetail[];
      resolve(ok: boolean): void;
    };

interface DependencyDialogState {
  request: DependencyDialogRequest | null;
  open(request: DependencyDialogRequest): void;
  /** closes the dialog; an unpublish request in flight is answered false */
  close(): void;
}

export const useDependencyDialogStore = create<DependencyDialogState>()((set, get) => ({
  request: null,
  open(request) {
    const current = get().request;
    if (current?.type === 'unpublish') current.resolve(false);
    set({ request });
  },
  close() {
    const current = get().request;
    if (current?.type === 'unpublish') current.resolve(false);
    set({ request: null });
  },
}));

/** the dialog that lists what uses (and what is used by) a resource */
export function openDependencyDetails(kind: DependencyResourceKind, id: string, name: string): void {
  useDependencyDialogStore.getState().open({ type: 'details', kind, id, name });
}

/** resolves true when the user confirms the unpublish despite the published workflows that depend on it */
export function confirmUnpublish(
  workflowId: string,
  name: string,
  dependents: DependencyDetail[],
): Promise<boolean> {
  return new Promise<boolean>((resolve) =>
    useDependencyDialogStore.getState().open({ type: 'unpublish', workflowId, name, dependents, resolve }),
  );
}
