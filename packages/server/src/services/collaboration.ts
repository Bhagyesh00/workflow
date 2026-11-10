/**
 * P6-81 (L14): who has a workflow open and who may write it. State in Redis (queue mode) or memory, the
 * tenant in the key (the Redis-or-memory pattern of services/form-auth.ts). Presence expires 15 minutes
 * after the last heartbeat, the write lock 2 minutes after (n8n collaboration.state.ts:38, :196). Changes
 * are pushed with `{ workflowId }`, so S1's filter drops users who cannot read the workflow.
 * - `assertWritable` (the seven editor write routes, C0d2): no client id passes; another user's lock 423;
 *   the same user's other tab 409.
 * - `assertNoLock` (MCP and Assistant writes, `AssistantDrafts.accept`): 423 "Cannot modify workflow while
 *   it is being edited by a user in the editor." while any lock is held.
 * - `workflowSaved` (after `WorkflowService.update`, C0d2) pushes `workflowUpdated`; never throws.
 * Stub from C0: every method PASSES (no presence, no lock) until L14.
 */
import type { ServiceDeps } from '../context';
import type { UserRow } from '../db/schema';

/** someone with the workflow open */
export interface Collaborator {
  userId: string;
  name: string;
  email: string;
  /** ISO time of the last heartbeat */
  lastSeen: string;
}

/** who may write the workflow now */
export interface WriteLock {
  userId: string;
  /** the holding tab's `push-ref` */
  clientId: string;
  name: string;
  /** ISO */
  expiresAt: string;
}

/** the answer of POST /workflows/:id/presence and /write-access */
export interface CollaborationState {
  collaborators: Collaborator[];
  writeLock: WriteLock | null;
}

/** what a collaborator shows (a `UserRow` fits) */
export type CollaborationUser = Pick<UserRow, 'id' | 'email'> & {
  firstName?: string | null;
  lastName?: string | null;
};

/** the write routes that check the lock (a restore checks as `save`) */
export type WorkflowWriteAction = 'save' | 'delete' | 'archive' | 'unarchive' | 'publish' | 'unpublish';

const EMPTY = (): CollaborationState => ({ collaborators: [], writeLock: null });

export class CollaborationService {
  constructor(readonly deps: ServiceDeps) {}

  /** POST presence `open` */
  async opened(
    _tenantId: string,
    _workflowId: string,
    _user: CollaborationUser,
    _clientId: string,
  ): Promise<CollaborationState> {
    // stub (L14): PASSES, no one else is there
    return EMPTY();
  }

  /** POST presence `close` (also releases this tab's lock) */
  async closed(
    _tenantId: string,
    _workflowId: string,
    _userId: string,
    _clientId: string,
  ): Promise<CollaborationState> {
    // stub (L14): PASSES
    return EMPTY();
  }

  /** POST presence `heartbeat`, and write-access `heartbeat` (keeps the lock) */
  async heartbeat(
    _tenantId: string,
    _workflowId: string,
    _user: CollaborationUser,
    _clientId: string,
  ): Promise<CollaborationState> {
    // stub (L14): PASSES
    return EMPTY();
  }

  /** write-access `request` (`force`: take over another user's lock) */
  async requestWrite(
    _tenantId: string,
    _workflowId: string,
    _user: CollaborationUser,
    _clientId: string,
    _options: { force?: boolean } = {},
  ): Promise<CollaborationState> {
    // stub (L14): PASSES
    return EMPTY();
  }

  /** write-access `release` */
  async release(
    _tenantId: string,
    _workflowId: string,
    _userId: string,
    _clientId: string,
  ): Promise<CollaborationState> {
    // stub (L14): PASSES
    return EMPTY();
  }

  /**
   * the editor write routes: `clientId` is the request's `push-ref` header (absent passes). The workflow id is
   * unique across workspaces; L14 keys the lock by the workflow's tenant.
   */
  async assertWritable(
    _user: Pick<UserRow, 'id'>,
    _clientId: string | string[] | undefined,
    _workflowId: string,
    _action: WorkflowWriteAction,
  ): Promise<void> {
    // stub (L14): PASSES
  }

  /** MCP and Assistant writes: 423 while any lock is held */
  async assertNoLock(_tenantId: string, _workflowId: string): Promise<void> {
    // stub (L14): PASSES
  }

  /** after a save: pushes `workflowUpdated` to the others; never throws */
  workflowSaved(_tenantId: string, _workflowId: string, _userId?: string): void {
    // stub (L14): PASSES, a no-op
  }
}
