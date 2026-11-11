/**
 * P6-78, P6-79 (L7 owns this file after C0): the protected workspace. A tenant whose settings hold
 * `sourceControl.readOnly: true` refuses direct changes (decisions section H): manual runs, workflow,
 * credential, variable, folder, project and data table structure writes, and Git push. Pulls still write:
 * they run inside `withPullWrites`, an internal flag on one `AsyncLocalStorage` that no request can set.
 *
 * Every wired service method calls `assertTenantWritable` first; `setReadOnly` is the one writer of the flag.
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
  | 'credentialMove'
  | 'variableCreate'
  | 'variableDelete'
  | 'variableRename'
  | 'variableMove'
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
  credentialMove: `Cannot move credentials to another project on a protected workspace. ${READ_ONLY}`,
  variableCreate: `Cannot create variables on a protected workspace. ${READ_ONLY}`,
  variableDelete: `Cannot delete variables on a protected workspace. ${READ_ONLY}`,
  variableRename: `Cannot rename variables on a protected workspace. ${READ_ONLY}`,
  variableMove: `Cannot move variables on a protected workspace. ${READ_ONLY}`,
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

/** one bypass: `active` is switched off when its `withPullWrites` returns */
type PullWriteScope = { active: boolean };

const pullWrites = new AsyncLocalStorage<PullWriteScope>();

/**
 * runs `fn` as an internal write (a pull, or a member removal's work): the locks let it through while `fn` runs.
 * Work started inside that outlives it (a timer, a Cron, a trigger, a run in the background) inherits the store,
 * so the store carries a flag that is switched off when `fn` settles: such work sees no bypass afterwards.
 */
export async function withPullWrites<T>(fn: () => Promise<T>): Promise<T> {
  const scope: PullWriteScope = { active: true };
  try {
    return await pullWrites.run(scope, fn);
  } finally {
    scope.active = false;
  }
}

/** true while a `withPullWrites` call runs (in its own work), false everywhere else and after it returns */
export function inPullWrite(): boolean {
  return pullWrites.getStore()?.active === true;
}

/**
 * throws `ProtectedWorkspaceError(action)` when `isProtected(settings)` and the caller is not a pull's write
 * (`inPullWrite()`); the one place the refusal is decided
 */
export function assertNotProtected(
  settings: TenantSettings | null | undefined,
  action: ProtectedAction,
): void {
  if (inPullWrite()) return;
  if (isProtected(settings)) throw new ProtectedWorkspaceError(action);
}

/**
 * reads the tenant's settings once and calls `assertNotProtected`; passes without a read inside a pull's write.
 * Wired first in every refused service method (workflows, archive, credentials, folders, variables, projects,
 * data tables). The row is read on every call, so a switch turned on or off takes effect on the next call.
 */
export async function assertTenantWritable(
  deps: ServiceDeps,
  tenantId: string,
  action: ProtectedAction,
): Promise<void> {
  if (inPullWrite()) return;
  const tenant = await deps.repos.tenants.get(tenantId);
  assertNotProtected(tenant?.settings as TenantSettings | null | undefined, action);
}

/**
 * turns the protected switch on or off: one `mergeSettings` statement that writes only the `sourceControl` key,
 * so a racing PATCH /settings (which never writes it) cannot undo it, and one audit row for each call
 */
export async function setReadOnly(deps: ServiceDeps, auth: AuthContext, value: boolean): Promise<void> {
  const tenantId = auth.tenant.id;
  await deps.repos.tenants.mergeSettings(tenantId, { sourceControl: { readOnly: value } });
  await deps.repos.audit.add(tenantId, {
    userId: auth.user.id,
    action: 'source_control.read_only_changed',
    resourceType: 'source_control',
    resourceId: tenantId,
    metadata: { readOnly: value },
  });
}
