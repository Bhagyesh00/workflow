/**
 * Removing a member (P6-31, L10): DELETE /members/:userId needs `transferToProjectId` or
 * `deleteData: true` (else 400; a named deviation: n8n's `transferId` may be left out). The member's
 * personal project's work moves to the chosen project or is deleted, then the membership goes (the
 * personal project and its relations cascade with it). S2 and S3 call these (P6-02, P6-12, P6-21).
 * Only this workspace is touched: the user, their other memberships and their other personal projects stay.
 */

import { and, eq } from 'drizzle-orm';
import type { ServerContext, ServiceDeps } from '../context';
import type { DbOrTx } from '../db/client';
import { credentials, type ProjectRow, projects, workflows } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { createRepositories } from '../repositories';
import { MISSING_SCOPE_MESSAGE } from './access';
import { withPullWrites } from './protected';
import { policyNodes, publishedPolicyNodes } from './transfer';
import { assertTransferAllowed } from './type-policies/enforce';

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
  await assertProjectWorkAllowed(ctx.serviceDeps, tenantId, personal.id, target.id);
  return target;
}

/**
 * P6-51: the work of project `fromProjectId` (a member's personal project, or a project that is deleted
 * with a transfer): its workflows (all their node types and credential types) and credentials may
 * enter the target project's type policies, else 403 `policy_violation` (or 503 when the check cannot
 * decide). Runs before the first write of `removeMember` and `transferPersonalWork`, so a refusal moves
 * nothing and removes no membership. Judged in the target project, as a move into it: the draft and the
 * published version of each active workflow (the move keeps it published). Called once early as a fast
 * refusal, and again with the move transaction as `tx`, after which the move reads what the check read.
 */
export async function assertProjectWorkAllowed(
  deps: ServiceDeps,
  tenantId: string,
  fromProjectId: string,
  targetProjectId: string,
  tx?: DbOrTx,
): Promise<void> {
  const db = tx ?? deps.database.db;
  if (tx) {
    // inside the move transaction: the source project row is locked (a create into it waits), and the rows
    // read below are locked too, so a save that is running now commits first and is judged
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.tenantId, tenantId), eq(projects.id, fromProjectId)))
      .for('update');
  }
  const workflowWhere = and(eq(workflows.tenantId, tenantId), eq(workflows.projectId, fromProjectId));
  const credentialWhere = and(eq(credentials.tenantId, tenantId), eq(credentials.projectId, fromProjectId));
  const workflowQuery = db
    .select({
      nodes: workflows.nodes,
      active: workflows.active,
      publishedVersionId: workflows.publishedVersionId,
    })
    .from(workflows)
    .where(workflowWhere);
  const credentialQuery = db.select({ type: credentials.type }).from(credentials).where(credentialWhere);
  const rows = tx ? await workflowQuery.for('update') : await workflowQuery;
  const credentialRows = tx ? await credentialQuery.for('update') : await credentialQuery;
  // the draft and the published version: a move keeps an active workflow published (P6-51)
  const nodes = [
    ...rows.flatMap((row) => policyNodes(row.nodes)),
    ...(await publishedPolicyNodes(db, tenantId, rows)),
  ];
  if (nodes.length > 0) {
    await assertTransferAllowed(deps, tenantId, targetProjectId, {
      kind: 'workflow',
      workflow: { nodes },
    });
  }
  for (const credentialType of new Set(credentialRows.map((row) => row.type))) {
    await assertTransferAllowed(deps, tenantId, targetProjectId, { kind: 'credential', credentialType });
  }
}

/**
 * Ends every way in of a member in this workspace: sessions, API keys, and MCP OAuth grants (consents,
 * codes and tokens, which only cascade with the user row and would work again after a new invitation).
 */
async function revokeAccess(tx: DbOrTx, tenantId: string, userId: string): Promise<void> {
  const repos = createRepositories(tx);
  await repos.sessions.deleteForUserInTenant(tenantId, userId);
  await repos.apiKeys.deleteAllForUser(tenantId, userId);
  // P6-02, P6-12 (C0): the four MCP OAuth deletes live in the repository now (a savepoint inside this transaction)
  await repos.mcpOAuth.deleteTokensForUser(tenantId, userId);
}

/**
 * Deletes what the personal project owns, except the project itself (the removal of the membership
 * cascades it). Workflows and data tables go through their services (they stop triggers and drop the
 * tables), credentials and folders through `repos` in the last transaction, which reads the contents
 * again: a workflow or table saved during the wipe refuses with 409 instead of failing the removal.
 */
async function wipeWork(
  ctx: ServerContext,
  tenantId: string,
  actorId: string | null,
  personalId: string,
  finish: (tx: DbOrTx) => Promise<void>,
): Promise<void> {
  const contents = await ctx.repos.projects.contents(tenantId, personalId);
  for (const id of contents.workflowIds) {
    await ctx.workflows.delete(tenantId, id, { userId: actorId ?? undefined }, { force: true });
  }
  for (const table of contents.dataTables) await ctx.dataTables.delete(tenantId, table.id);
  await ctx.database.db.transaction(async (tx) => {
    const repos = createRepositories(tx);
    const left = await repos.projects.contents(tenantId, personalId);
    if (left.workflowIds.length || left.dataTables.length) {
      throw ApiError.conflict("Couldn't delete the work: new work was saved during the removal. Try again.");
    }
    for (const id of left.credentialIds) await repos.credentials.delete(tenantId, id);
    for (const id of left.folderIds) {
      await repos.favorites.removeForResource(tenantId, 'folder', id);
      await repos.folders.delete(tenantId, id);
    }
    await finish(tx);
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
  // P6-02, P6-12, P6-21 (C0): a disabled member can still be removed (REST and public DELETE, SCIM)
  const target = await repos.memberships.getIncludingDisabled(tenantId, userId);
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
    // the scopes on the target first (an unknown id is 404): nothing about a project the caller can't fill
    const scopes = await ctx.access.scopesForAuth(auth, { projectId: choice.transferToProjectId });
    for (const scope of TARGET_SCOPES) if (!scopes.has(scope)) throw missingScope();
    if (personal) destination = await requireTarget(ctx, tenantId, personal, choice.transferToProjectId);
  }

  /** the last step, in one transaction with whatever work was left: the membership and its leftovers */
  const finish = async (tx: DbOrTx): Promise<void> => {
    const txRepos = createRepositories(tx);
    const current = await txRepos.memberships.getIncludingDisabled(tenantId, userId);
    if (!current) throw ApiError.notFound('Member');
    if (current.role === 'owner' && (await txRepos.memberships.lockOwners(tenantId)) <= 1) {
      throw ApiError.conflict('A workspace needs at least one owner');
    }
    if (destination && personal) {
      // P6-51: the final check, in this transaction (work saved since the early check is judged too)
      await assertProjectWorkAllowed(ctx.serviceDeps, tenantId, personal.id, destination.id, tx);
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
    await revokeAccess(tx, tenantId, userId);
    if (!(await txRepos.memberships.remove(tenantId, userId))) throw ApiError.notFound('Member');
  };

  // user management is never refused on a protected workspace: the work moves or goes under the internal
  // write bypass a pull uses, and every step is awaited inside it (decisions, S4 end review call 6)
  await withPullWrites(async () => {
    if (destination || !personal) {
      await ctx.database.db.transaction(finish);
    } else {
      await removeWithWipe(ctx, tenantId, auth.user.id, userId, target.role, personal.id, finish);
    }
  });
  // P6-15: deletes the removed member's private credential entries in this workspace
  await ctx.privateCredentials.afterAccessChange(tenantId, { userId });
}

/** a removal that deletes the personal work: the ways in end first, then the work goes, then `finish` */
async function removeWithWipe(
  ctx: ServerContext,
  tenantId: string,
  actorId: string,
  userId: string,
  role: string,
  personalId: string,
  finish: (tx: DbOrTx) => Promise<void>,
): Promise<void> {
  // Decide before anything is deleted, under the owner lock: the last owner stays, an owner leaves the
  // owner count (so removing another owner at the same time is refused first), and the member's ways in
  // end, so nothing new is saved during the wipe.
  await ctx.database.db.transaction(async (tx) => {
    const txRepos = createRepositories(tx);
    if (role === 'owner') {
      if ((await txRepos.memberships.lockOwners(tenantId)) <= 1) {
        throw ApiError.conflict('A workspace needs at least one owner');
      }
      await txRepos.memberships.updateRole(tenantId, userId, 'member');
    }
    await revokeAccess(tx, tenantId, userId);
  });
  await wipeWork(ctx, tenantId, actorId, personalId, finish);
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
  // SCIM deprovisioning and LDAP reset: never refused on a protected workspace, as a member removal
  if (targetProjectId === null) {
    await withPullWrites(() => wipeWork(ctx, tenantId, null, personal.id, async () => undefined));
    return;
  }
  const target = await requireTarget(ctx, tenantId, personal, targetProjectId);
  await withPullWrites(() =>
    ctx.database.db.transaction(async (tx) => {
      // P6-51: the final check, in the move transaction
      await assertProjectWorkAllowed(ctx.serviceDeps, tenantId, personal.id, target.id, tx);
      await createRepositories(tx).projects.moveResources(tenantId, personal.id, target.id);
    }),
  );
}
