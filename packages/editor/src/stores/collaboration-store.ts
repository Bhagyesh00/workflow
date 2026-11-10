/**
 * P6-81 (L14): who has the open workflow open and who holds its write lock, fed by the presence and
 * write-access answers and by the `collaboratorsChanged`, `writeAccessAcquired`, `writeAccessReleased` and
 * `workflowUpdated` push events. The editor turns read-only while another user or tab holds the lock.
 *
 * stub (L14): the state and its setters are final; L14 adds the heartbeats, the push handling and the
 * read-only rule. Until then nothing writes it, so `lockedByOther` stays false and the editor is unchanged.
 */
import { create } from 'zustand';
import type { Collaborator, WriteLock } from '../api/types';

export interface CollaborationStoreState {
  /** the workflow the editor has open (null outside the editor) */
  workflowId: string | null;
  collaborators: Collaborator[];
  writeLock: WriteLock | null;
  /** another user or another tab holds the lock: the editor is read-only */
  lockedByOther: boolean;
  /** set by `workflowUpdated` from someone else: the "workflow was updated" prompt */
  updatedBy: string | null;
  open(workflowId: string): void;
  setCollaborators(collaborators: Collaborator[]): void;
  setWriteLock(writeLock: WriteLock | null): void;
  markUpdated(userId: string | null): void;
  reset(): void;
}

const EMPTY = {
  workflowId: null,
  collaborators: [],
  writeLock: null,
  lockedByOther: false,
  updatedBy: null,
} satisfies Partial<CollaborationStoreState>;

export const useCollaborationStore = create<CollaborationStoreState>()((set) => ({
  ...EMPTY,
  open: (workflowId) => set({ ...EMPTY, workflowId }),
  setCollaborators: (collaborators) => set({ collaborators }),
  setWriteLock: (writeLock) => set({ writeLock }),
  markUpdated: (updatedBy) => set({ updatedBy }),
  reset: () => set({ ...EMPTY }),
}));
