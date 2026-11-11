/**
 * P6-81 (L14): who has the open workflow open and who holds its write lock, fed by the presence and
 * write-access answers and by the `collaboratorsChanged`, `writeAccessAcquired`, `writeAccessReleased` and
 * `workflowUpdated` push events. The editor turns read-only while another user or tab holds the lock.
 *
 * `startCollaboration` is the session of one open workflow: presence `open`, a write-access `request` for
 * someone who may edit, a heartbeat every 25 seconds (it keeps the lock, which ends 2 minutes after the last
 * one), a new request when the lock is released, and presence `close` on leave (after any call still in flight,
 * and on `pagehide` for a reload or a closed tab). `receiveCollaborationEvent` routes the four push events
 * (components/shell/PushBridge.tsx).
 *
 * The lock is also part of the workflow store's `readOnly` (`setLockReadOnly`), so Save, Publish, the shortcuts,
 * paste, the command bar and every store edit refuse while another user or tab holds it.
 */
import { create } from 'zustand';
import { buildUrl, fetchTransport, getCurrentTenant, getTransport } from '../api/client';
import { collaborationApi } from '../api/endpoints';
import type { CollaborationState, Collaborator, PushEvent, WriteLock } from '../api/types';
import { clientId } from '../lib/client-id';
import { useWorkflowStore } from './workflow-store';

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
  open: (workflowId) => {
    useWorkflowStore.getState().setLockReadOnly(false);
    set({ ...EMPTY, workflowId });
  },
  setCollaborators: (collaborators) => set({ collaborators }),
  setWriteLock: (writeLock) => {
    const lockedByOther = !!writeLock && writeLock.clientId !== clientId();
    // the workflow store first: a subscriber of this store (autosave) judges `readOnly` at once
    useWorkflowStore.getState().setLockReadOnly(lockedByOther);
    set({ writeLock, lockedByOther });
  },
  markUpdated: (updatedBy) => set({ updatedBy }),
  reset: () => {
    useWorkflowStore.getState().setLockReadOnly(false);
    set({ ...EMPTY });
  },
}));

/** how often the open tab says it is still there (the lock ends 2 minutes after the last one) */
export const HEARTBEAT_MS = 25_000;
/** a lock the push names carries no end time: the server's 2 minutes */
const LOCK_MS = 120_000;

interface Session {
  workflowId: string;
  selfUserId: string;
  canWrite: boolean;
}

let session: Session | null = null;

/**
 * The tab goes away (reload, closed tab): presence `close` frees its lock now, not after the 2 minutes. A page
 * that is unloading may not finish an ordinary call, so the browser transport sends it with `keepalive` (and
 * the `push-ref` header, which `sendBeacon` cannot set); another transport (the demo) answers in-process.
 */
function closeOnPageHide(workflowId: string): void {
  const path = `/workflows/${encodeURIComponent(workflowId)}/presence`;
  if (getTransport() !== fetchTransport) {
    void collaborationApi.presence(workflowId, 'close').catch(() => {});
    return;
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    'push-ref': clientId(),
  };
  const tenantId = getCurrentTenant();
  if (tenantId) headers['x-tenant-id'] = tenantId;
  void fetch(buildUrl(path), {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({ action: 'close' }),
    keepalive: true,
  }).catch(() => {});
}

const holdsLock = (): boolean => {
  const lock = useCollaborationStore.getState().writeLock;
  return !!lock && lock.clientId === clientId();
};

/** one of the answers of the presence and write-access calls into the store (an answer of a closed session is dropped) */
function apply(workflowId: string, state: CollaborationState): void {
  if (session?.workflowId !== workflowId) return;
  const store = useCollaborationStore.getState();
  store.setCollaborators(state.collaborators);
  store.setWriteLock(state.writeLock);
}

/** asks for the write lock when this person may edit and nobody holds it */
async function requestWriteIfFree(workflowId: string): Promise<void> {
  const current = session;
  if (current?.workflowId !== workflowId || !current.canWrite) return;
  if (useCollaborationStore.getState().writeLock) return;
  try {
    apply(workflowId, await collaborationApi.writeAccess(workflowId, 'request'));
  } catch {
    // the lock stays as it was; the next heartbeat asks again
  }
}

export interface CollaborationSession {
  /** `canWrite` of the person can change once the workflow's scopes are known */
  setCanWrite(canWrite: boolean): void;
  /** leaves: presence `close` (it frees this tab's lock) and the store is emptied */
  stop(): void;
}

/**
 * Starts the session of the open workflow. The caller names the signed-in user (`selfUserId`, to tell its own
 * saves from another user's) and whether it may edit.
 */
export function startCollaboration(options: Session): CollaborationSession {
  const mine: Session = { ...options };
  session = mine;
  useCollaborationStore.getState().open(mine.workflowId);
  const { workflowId } = mine;

  // the calls of this session still in flight: `close` goes after them, or a request served after it would
  // leave the lock with a tab that has gone (they never reject)
  const inflight = new Set<Promise<void>>();
  const track = (task: Promise<void>): void => {
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  };

  track(
    (async () => {
      try {
        apply(workflowId, await collaborationApi.presence(workflowId, 'open'));
      } catch {
        return; // no presence, no lock: the editor stays as it is
      }
      await requestWriteIfFree(workflowId);
    })(),
  );

  const timer = setInterval(() => {
    track(
      (async () => {
        try {
          if (holdsLock()) apply(workflowId, await collaborationApi.writeAccess(workflowId, 'heartbeat'));
          else apply(workflowId, await collaborationApi.presence(workflowId, 'heartbeat'));
        } catch {
          return;
        }
        await requestWriteIfFree(workflowId);
      })(),
    );
  }, HEARTBEAT_MS);

  const onPageHide = (): void => {
    if (session === mine) closeOnPageHide(workflowId);
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

  return {
    setCanWrite(canWrite) {
      mine.canWrite = canWrite;
      void requestWriteIfFree(workflowId);
    },
    stop() {
      clearInterval(timer);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      if (session === mine) {
        session = null;
        useCollaborationStore.getState().reset();
        const close = () => void collaborationApi.presence(workflowId, 'close').catch(() => {});
        if (inflight.size) void Promise.allSettled([...inflight]).then(close);
        else close();
      }
    },
  };
}

/** takes the lock from its holder (the answer of `force`); false when the call failed */
export async function takeOverWriteAccess(workflowId: string): Promise<boolean> {
  try {
    apply(workflowId, await collaborationApi.writeAccess(workflowId, 'force'));
    return true;
  } catch {
    return false;
  }
}

/** the four push events of the open workflow (any other workflow's, and any other event, is ignored) */
export function receiveCollaborationEvent(event: PushEvent): void {
  const store = useCollaborationStore.getState();
  if (!session || store.workflowId !== session.workflowId) return;
  switch (event.type) {
    case 'collaboratorsChanged':
      if (event.data.workflowId === session.workflowId) store.setCollaborators(event.data.collaborators);
      return;
    case 'writeAccessAcquired': {
      if (event.data.workflowId !== session.workflowId) return;
      const holder = store.collaborators.find((c) => c.userId === event.data.userId);
      store.setWriteLock({
        userId: event.data.userId,
        clientId: event.data.clientId,
        name: holder?.name ?? '',
        expiresAt: new Date(Date.now() + LOCK_MS).toISOString(),
      });
      return;
    }
    case 'writeAccessReleased':
      if (event.data.workflowId !== session.workflowId) return;
      store.setWriteLock(null);
      void requestWriteIfFree(session.workflowId);
      return;
    case 'workflowUpdated':
      if (event.data.workflowId === session.workflowId && event.data.userId !== session.selfUserId) {
        store.markUpdated(event.data.userId);
      }
      return;
    default:
      return;
  }
}
