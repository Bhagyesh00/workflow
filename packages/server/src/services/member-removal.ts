/**
 * Removing a member (P6-31, L10): DELETE /members/:userId needs `transferToProjectId` or
 * `deleteData: true` (else 400; a named deviation: n8n's `transferId` may be left out). The member's
 * personal project's work moves to the chosen project or is deleted, then the membership goes (the
 * personal project and its relations cascade with it). S2 and S3 call these (P6-02, P6-12, P6-21).
 * Only this workspace is touched: the user, their other memberships and their other personal projects stay.
 */
import type { ServerContext } from '../context';
import type { ProjectRow } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { createRepositories, type Repositories } from '../repositories';
import { MISSING_SCOPE_MESSAGE } from './access';

/** the caller's choice for the removed member's personal work */
export type MemberRemovalChoice = { transferToProjectId: string } | { deleteData: true };

/** the scopes the caller needs on the project that receives the work (as deleting a project with a transfer) */
const TARGET_SCOPES = ['credential:create', 'workflow:create', 'dataTable:create'] as const;

function missingScope(): ApiError {
  return new ApiError(403, 'forbidden', MISSING_SCOPE_MESSAGE);
}

/** the target project of a move: it exists in the workspace, is not the personal project itself, and takes the tables */
async function requireTarget(
  ctx: ServerContext,
  tenantId: string,
  personal: ProjectRow,
  targetProjectId: string,
): Promise<ProjectRow> {
  const target = await ctx.repos.projects.get(tenantId, targetProjectId);
  if (!target) throw ApiError.notFound('Project');
  if (target.id === personal.id) {
    throw ApiError.badRequest("Can't move the work of a member into the member's own personal project.");
  }
  const contents = await ctx.repos.projects.contents(tenantId, personal.id);
  const clashes = await ctx.repos.projects.dataTableNamesIn(
    tenantId,
    target.id,
    contents.dataTables.map((table) => table.name),
  );
  if (clashes.length) {
    throw ApiError.conflict(
      `Can't move the work. The target project already has data tables named: ${clashes.join(', ')}. Rename them first.`,
      { dataTables: clashes },
    );
  }
  return target;
}

/**
 * Deletes what the personal project owns, except the project itself (the removal of the membership
 * cascades it). Workflows and data tables go through their services (they stop triggers and drop the
 * tables), credentials and folders through `repos`.
 */
async function wipeWork(
  ctx: ServerContext,
  tenantId: string,
  actorId: string | null,
  personalId: string,
  finish: (repos: Repositories) => Promise<void>,
): Promise<void> {
  const contents = await ctx.repos.projects.contents(tenantId, personalId);
  for (const id of contents.workflowIds) {
    await ctx.workflows.delete(tenantId, id, { userId: actorId ?? undefined }, { force: true });
  }
  for (const table of contents.dataTables) await ctx.dataTables.delete(tenantId, table.id);
  await ctx.database.db.transaction(async (tx) => {
    const repos = createRepositories(tx);
    for (const id of contents.credentialIds) await repos.credentials.delete(tenantId, id);
    for (const id of contents.folderIds) {
      await repos.favorites.removeForResource(tenantId, 'folder', id);
      await repos.folders.delete(tenantId, id);
    }
    await finish(repos);
  });
}

/**
 * Removes a member from the caller's workspace. The caller needs `user:delete` (the route's gate) and, for a
 * move, `credential:create`, `workflow:create` and `dataTable:create` on the target project. Only owners
 * remove owners, and the last owner stays. The member's sessions and API keys in this workspace go with them.
 */
export async function removeMember(
  ctx: ServerContext,
  auth: AuthContext,
  userId: string,
  choice: MemberRemovalChoice,
): Promise<void> {
  const tenantId = auth.tenant.id;
  const { repos } = ctx;
  const target = await repos.memberships.get(tenantId, userId);
  if (!target) throw ApiError.notFound('Member');
  if (target.role === 'owner' && auth.role !== 'owner') {
    throw ApiError.forbidden('Only owners can remove owners');
  }
  // checked again under a lock in the last transaction; this one spares the work of a refused removal
  if (target.role === 'owner' && (await repos.memberships.countOwners(tenantId)) <= 1) {
    throw ApiError.conflict('A workspace needs at least one owner');
  }
  const personal = await repos.projects.getPersonal(tenantId, userId);

  let destination: ProjectRow | undefined;
  if ('transferToProjectId' in choice) {
    if (personal) destination = await requireTarget(ctx, tenantId, personal, choice.transferToProjectId);
    else if (!(await repos.projects.get(tenantId, choice.transferToProjectId))) {
      throw ApiError.notFound('Project');
    }
    const scopes = await ctx.access.scopesForAuth(auth, { projectId: choice.transferToProjectId });
    for (const scope of TARGET_SCOPES) if (!scopes.has(scope)) throw missingScope();
  }

  /** the last step, in one transaction with whatever work was left: the membership and its leftovers */
  const finish = async (txRepos: Repositories): Promise<void> => {
    if (target.role === 'owner' && (await txRepos.memberships.lockOwners(tenantId)) <= 1) {
      throw ApiError.conflict('A workspace needs at least one owner');
    }
    if (destination && personal) {
      const moved = await txRepos.projects.moveResources(tenantId, personal.id, destination.id);
      await txRepos.audit.add(tenantId, {
        userId: auth.user.id,
        action: 'member.removed',
        resourceType: 'user',
        resourceId: userId,
        metadata: { transferToProjectId: destination.id, moved },
      });
    } else {
      await txRepos.audit.add(tenantId, {
        userId: auth.user.id,
        action: 'member.removed',
        resourceType: 'user',
        resourceId: userId,
        metadata: { deleteData: true },
      });
    }
    await txRepos.sessions.deleteForUserInTenant(tenantId, userId);
    await txRepos.apiKeys.deleteAllForUser(tenantId, userId);
    if (!(await txRepos.memberships.remove(tenantId, userId))) throw ApiError.notFound('Member');
  };

  if (destination || !personal) {
    await ctx.database.db.transaction(async (tx) => finish(createRepositories(tx)));
    return;
  }
  await wipeWork(ctx, tenantId, auth.user.id, personal.id, finish);
}

/**
 * Moves the work of a member's personal project to `targetProjectId`, or deletes it when null
 * (`repos.projects.moveResources`). The personal project and the membership stay; no scope is checked
 * (the caller did). A target with a data table of the same name refuses with 409.
 */
export async function transferPersonalWork(
  ctx: ServerContext,
  tenantId: string,
  userId: string,
  targetProjectId: string | null,
): Promise<void> {
  const personal = await ctx.repos.projects.getPersonal(tenantId, userId);
  if (!personal) return;
  if (targetProjectId === null) {
    await wipeWork(ctx, tenantId, null, personal.id, async () => undefined);
    return;
  }
  const target = await requireTarget(ctx, tenantId, personal, targetProjectId);
  await ctx.database.db.transaction(async (tx) => {
    await createRepositories(tx).projects.moveResources(tenantId, personal.id, target.id);
  });
}
