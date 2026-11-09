/**
 * P6-41, P6-43: the project the user works in. The project pages set it from the route (a project's id, or
 * null on `/home/*` and `/shared/*`); lists and creates read it, so new rows go to the current project and
 * pickers show what that project may use. Null means no project page is open: the server's default applies.
 */
import { create } from 'zustand';

export interface ProjectState {
  currentProjectId: string | null;
  setCurrentProject(projectId: string | null): void;
}

export const useProjectStore = create<ProjectState>()((set) => ({
  currentProjectId: null,
  setCurrentProject: (projectId) =>
    set((state) => (state.currentProjectId === projectId ? state : { currentProjectId: projectId })),
}));
