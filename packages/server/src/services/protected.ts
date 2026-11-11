/**
 * P6-78, P6-79 (L7 owns this file after C0): the protected workspace. A tenant whose settings hold
 * `sourceControl.readOnly: true` refuses direct changes (decisions section H): manual runs, workflow,
 * credential, variable, folder, project and data table structure writes, and Git push. Pulls still write:
 * they run inside `withPullWrites`, an internal flag on one `AsyncLocalStorage` that no request can set.
 *
 * C0 (commit 0): the names, texts, error, `isProtected` and the pull flag are final. `assertNotProtected`,
 * `assertTenantWritable` and `setReadOnly` are stubs that PASS (every wired service method calls
 * `assertTenantWritable` first); L7 fills them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import type { TenantSettings } from '../plans';

/** every write a protected workspace refuses (decisions H); retry, publish, row writes are not here */
export type ProtectedAction =
  | 'manualRun'
  | 'workflowCreate'
  | 'workflowUpdate'
  | 'workflowDelete'
  | 'workflowArchive'
  | 'workflowRestore'
  | 'credentialCreate'
  | 'variableCreate'
  | 'variableDelete'
  | 'variableRename'
  | 'folderCreate'
  | 'folderUpdate'
  | 'folderDelete'
  | 'projectCreate'
  | 'dataTableCreate'
  | 'dataTableStructure'
  | 'push';

const READ_ONLY = 'This workspace is in read-only mode.';

/** the message each refusal carries; `manualRun` and `push` are n8n's texts ("instance" reads "workspace") */
export const PROTECTED_TEXT: Record<ProtectedAction, string> = {
  manualRun: `Cannot run workflows manually on a protected workspace. ${READ_ONLY}`,
  workflowCreate: `Cannot create workflows on a protected workspace. ${READ_ONLY}`,
  workflowUpdate: `Cannot change workflows on a protected workspace. ${READ_ONLY}`,
  workflowDelete: `Cannot delete workflows on a protected workspace. ${READ_ONLY}`,
  workflowArchive: `Cannot archive workflows on a protected workspace. ${READ_ONLY}`,
  workflowRestore: `Cannot restore workflows on a protected workspace. ${READ_ONLY}`,
  credentialCreate: `Cannot create credentials on a protected workspace. ${READ_ONLY}`,
  variableCreate: `Cannot create variables on a protected workspace. ${READ_ONLY}`,
  variableDelete: `Cannot delete variables on a protected workspace. ${READ_ONLY}`,
  variableRename: `Cannot rename variables on a protected workspace. ${READ_ONLY}`,
  folderCreate: `Cannot create folders on a protected workspace. ${READ_ONLY}`,
  folderUpdate: `Cannot change folders on a protected workspace. ${READ_ONLY}`,
  folderDelete: `Cannot delete folders on a protected workspace. ${READ_ONLY}`,
  projectCreate: `Cannot create projects on a protected workspace. ${READ_ONLY}`,
  dataTableCreate: `Cannot create data tables on a protected workspace. ${READ_ONLY}`,
  dataTableStructure: `Cannot change the structure of data tables on a protected workspace. ${READ_ONLY}`,
  push: 'Cannot push onto read-only branch.',
};

/** a write refused on a protected workspace: 403 `workspace_protected`; `push` is 400, as n8n */
export class ProtectedWorkspaceError extends ApiError {
  constructor(readonly action: ProtectedAction) {
    super(action === 'push' ? 400 : 403, 'workspace_protected', PROTECTED_TEXT[action]);
    this.name = 'ProtectedWorkspaceError';
  }
}

/** the one source of the flag: `sourceControl.readOnly === true`; no other key counts */
export function isProtected(settings: TenantSettings | null | undefined): boolean {
  return settings?.sourceControl?.readOnly === true;
}

const pullWrites = new AsyncLocalStorage<true>();

/** runs `fn` as a pull's write: the locks let it through (and every promise started inside it) */
export function withPullWrites<T>(fn: () => Promise<T>): Promise<T> {
  return pullWrites.run(true, fn);
}

/** true inside `withPullWrites` (and in work started there), false everywhere else */
export function inPullWrite(): boolean {
  return pullWrites.getStore() === true;
}

/**
 * stub (L7), PASSES in C0: throws `ProtectedWorkspaceError(action)` when `isProtected(settings)` and not
 * `inPullWrite()`
 */
export function assertNotProtected(
  _settings: TenantSettings | null | undefined,
  _action: ProtectedAction,
): void {
  // stub (L7): passes
}

/**
 * stub (L7), PASSES in C0: reads the tenant's settings and calls `assertNotProtected`. Wired first in every
 * refused service method (workflows, archive, credentials, folders, variables, projects, data tables).
 */
export async function assertTenantWritable(
  _deps: ServiceDeps,
  _tenantId: string,
  _action: ProtectedAction,
): Promise<void> {
  // stub (L7): passes
}

/**
 * stub (L7), PASSES in C0 with no write: L7 writes one
 * `deps.repos.tenants.mergeSettings(auth.tenant.id, { sourceControl: { readOnly: value } })`
 * (`sourceControl` holds only that key)
 */
export async function setReadOnly(_deps: ServiceDeps, _auth: AuthContext, _value: boolean): Promise<void> {
  // stub (L7): passes, no write
}
