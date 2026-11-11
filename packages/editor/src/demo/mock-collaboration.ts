/**
 * P6-81 (L14): the demo's collaboration: who has a workflow open (presence) and who holds its write access.
 * The demo has one browser session and the handlers do not see the tab's `push-ref`, so the only person is the
 * signed-in user and its tab (`clientId()`): `open` lists them, `request` and `force` give them the lock, `release`
 * and `close` free it, `heartbeat` keeps it. State lives in `backend.ext.collaboration` (per workflow).
 */
import type { CollaborationState } from '../api/types';
import { clientId } from '../lib/client-id';
import type { MockBackend } from './mock-backend';
import { HttpError, now } from './mock-http';

/** the server's 2 minutes */
const LOCK_MS = 120_000;

interface CollaborationStore {
  /** workflow id -> who has it open and who holds the lock */
  open: Map<string, { userId: string; lock: boolean }>;
}

function storeOf(backend: MockBackend): CollaborationStore {
  backend.ext.collaboration ??= { open: new Map() } satisfies CollaborationStore;
  return backend.ext.collaboration as CollaborationStore;
}

function stateOf(backend: MockBackend, workflowId: string): CollaborationState {
  const { user } = backend.auth();
  const entry = storeOf(backend).open.get(workflowId);
  if (!entry) return { collaborators: [], writeLock: null };
  return {
    collaborators: [{ userId: user.id, name: user.name, email: user.email, lastSeen: now() }],
    writeLock: entry.lock
      ? {
          userId: user.id,
          clientId: clientId(),
          name: user.name,
          expiresAt: new Date(Date.now() + LOCK_MS).toISOString(),
        }
      : null,
  };
}

/** the workflow of the signed-in workspace (404 for another's) */
function workflowOf(backend: MockBackend, id: string): string {
  const { tenant } = backend.auth();
  if (!backend.workflows.some((w) => w.id === id && w.tenantId === tenant.id)) {
    throw new HttpError(404, 'not_found', 'Workflow not found');
  }
  return id;
}

export function registerCollaborationRoutes(backend: MockBackend): void {
  backend.on('POST', '/workflows/:id/presence', ({ params, body }) => {
    const id = workflowOf(backend, params[0] as string);
    const store = storeOf(backend);
    const { user } = backend.auth();
    const action = body.action;
    if (action === 'open') {
      store.open.set(id, store.open.get(id) ?? { userId: user.id, lock: false });
    } else if (action === 'close') {
      store.open.delete(id);
    } else if (action !== 'heartbeat') {
      throw new HttpError(400, 'bad_request', 'Unknown action');
    }
    return stateOf(backend, id);
  });

  backend.on('POST', '/workflows/:id/write-access', ({ params, body }) => {
    const id = workflowOf(backend, params[0] as string);
    const store = storeOf(backend);
    const { user } = backend.auth();
    const entry = store.open.get(id) ?? { userId: user.id, lock: false };
    store.open.set(id, entry);
    const action = body.action;
    if (action === 'request' || action === 'force') entry.lock = true;
    else if (action === 'release') entry.lock = false;
    else if (action !== 'heartbeat') throw new HttpError(400, 'bad_request', 'Unknown action');
    return stateOf(backend, id);
  });
}
