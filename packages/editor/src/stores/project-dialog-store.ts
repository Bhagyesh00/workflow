/**
 * P6-43, P6-44: the Share and Move dialogs open from anywhere (list menus, the editor's top bar, the command
 * bar) through `openProjectDialog`; `ProjectDialogsHost`, mounted once in App.tsx, renders the open one.
 * One dialog at a time: opening another replaces it.
 */
import { create } from 'zustand';

export type ProjectDialogKind = 'share' | 'move';
export type ProjectDialogResource = 'workflow' | 'credential' | 'folder';

export interface ProjectDialogRequest {
  kind: ProjectDialogKind;
  resource: ProjectDialogResource;
  id: string;
}

export interface ProjectDialogState {
  dialog: ProjectDialogRequest | null;
  open(request: ProjectDialogRequest): void;
  close(): void;
}

export const useProjectDialogStore = create<ProjectDialogState>()((set) => ({
  dialog: null,
  open: (request) => set({ dialog: { kind: request.kind, resource: request.resource, id: request.id } }),
  close: () => set({ dialog: null }),
}));

export function openProjectDialog(request: ProjectDialogRequest): void {
  useProjectDialogStore.getState().open(request);
}

export function closeProjectDialog(): void {
  useProjectDialogStore.getState().close();
}
