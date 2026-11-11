/**
 * Moves between projects (P6-30, L9): previews and transfers of a workflow, a credential and a folder
 * (its whole tree). Needs `<resource>:move` on the source (the route's gate) and `<resource>:create` on
 * the destination (checked here). Steps: unpublish if active, drop all shares, set `project_id`, share the
 * chosen credentials into the destination, set the folder, try to republish (a refused republish leaves it
 * unpublished). A credential's destination must reach every vault its data names
 * (`SecretsManager.assertProjectAccess`, L8). No data table move (n8n has none). Previews are advisory:
 * they say what would stay unpublished and why; the PUT decides.
 */
import type { Scope, WorkflowDefinition } from '@workflow/workflow';
import { and, eq, inArray } from 'drizzle-orm';
import type { ServiceDeps } from '../context';
import { credentialShares, folders, type WorkflowRow, workflowShares, workflows } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { createRepositories } from '../repositories';
import { MISSING_SCOPE_MESSAGE } from './access';
import { assertCredentialsUsable } from './credential-usable';
import { loadPublishedDefinition, publishedDefinition } from './published-workflow';
import { assertTransferAllowed, filterAvailable } from './type-policies/enforce';
import { violationMessage } from './type-policies/errors';
import {
  ENFORCEMENT_DEADLINE_MS,
  type PolicyKind,
  type PolicyWorkflow,
  type TypePolicyViolation,
} from './type-policies/types';

/** one reason a move leaves something restricted (the editor's `PolicyViolation`) */
export interface PolicyViolation {
  kind: string;
  checkId: string;
  message: string;
  subject?: string;
  subjectType?: string;
  scope?: string;
  projectId?: string;
}

/** the answer of the three previews */
export interface TransferPreview {
  restricted: PolicyViolation[];
  checkFailed: boolean;
  unpublishReasons?: PolicyViolation[];
  workflowsToUnpublish?: Array<{ id: string; name: string }>;
}

/** PUT /workflows/:id/transfer */
export interface WorkflowTransferInput {
  destinationProjectId: string;
  /** credential ids the move shares into the destination */
  shareCredentials?: string[];
  destinationParentFolderId?: string;
}

/** PUT /credentials/:id/transfer */
export interface CredentialTransferInput {
  destinationProjectId: string;
}

/** PUT /folders/:id/transfer (the whole tree) */
export interface FolderTransferInput {
  destinationProjectId: string;
  destinationParentFolderId?: string;
  shareCredentials?: string[];
}

export const SAME_WORKFLOW_DESTINATION =
  "You can't transfer a workflow into the same destination it already belongs to.";
export const SAME_CREDENTIAL_DESTINATION =
  "You can't transfer a credential into the project that's already owning it.";
export const SAME_FOLDER_DESTINATION =
  "You can't transfer a folder into the project that's already owning it.";

type Resource = 'workflow' | 'credential' | 'folder';

/** a transfer preview row: S1's `PolicyViolation` plus the rule and opt-in the editor reads */
type RestrictedRow = PolicyViolation & { matchedRuleId?: string; optInAvailable?: boolean };

/** the nodes a policy check reads out of a stored `nodes` column (anything else is skipped) */
function policyNodes(nodes: readonly unknown[]): PolicyWorkflow['nodes'] {
  const out: Array<PolicyWorkflow['nodes'][number]> = [];
  for (const raw of nodes) {
    if (typeof raw !== 'object' || raw === null) continue;
    const node = raw as { name?: unknown; type?: unknown; credentials?: unknown };
    if (typeof node.type !== 'string') continue;
    const credentials =
      typeof node.credentials === 'object' && node.credentials !== null && !Array.isArray(node.credentials)
        ? (node.credentials as Record<string, never>)
        : undefined;
    out.push({ name: typeof node.name === 'string' ? node.name : '', type: node.type, credentials });
  }
  return out;
}
type Tx = Parameters<typeof createRepositories>[0];

export class TransferService {
  constructor(readonly deps: ServiceDeps) {}

  async previewWorkflow(
    auth: AuthContext,
    workflowId: string,
    destinationProjectId: string,
  ): Promise<TransferPreview> {
    const row = await this.deps.repos.workflows.get(auth.tenant.id, workflowId);
    if (!row) throw ApiError.notFound('Workflow');
    await this.requireProject(auth, destinationProjectId);
    await this.requireCreate(auth, 'workflow', destinationProjectId);
    const unpublishReasons = row.active ? await this.previewBlockers(auth, row, destinationProjectId) : [];
    const policy = await this.previewTypes(
      auth,
      destinationProjectId,
      { nodes: policyNodes(row.nodes) },
      row.id,
    );
    return { restricted: policy.restricted, checkFailed: policy.checkFailed, unpublishReasons };
  }

  async previewCredential(
    auth: AuthContext,
    credentialId: string,
    destinationProjectId: string,
  ): Promise<TransferPreview> {
    const row = await this.deps.repos.credentials.get(auth.tenant.id, credentialId);
    if (!row) throw ApiError.notFound('Credential');
    await this.requireProject(auth, destinationProjectId);
    await this.requireCreate(auth, 'credential', destinationProjectId);
    const restricted: PolicyViolation[] = [];
    const policy = await this.previewTypes(auth, destinationProjectId, { credentialType: row.type }, row.id);
    restricted.push(...policy.restricted);
    try {
      await this.deps
        .context()
        .secrets.assertProjectAccess(auth.tenant.id, destinationProjectId, row.secretKeys ?? []);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      restricted.push({
        kind: 'secretAccess',
        checkId: 'secretAccess',
        message: error.message,
        subject: row.id,
        subjectType: 'credential',
        projectId: destinationProjectId,
      });
    }
    return { restricted, checkFailed: policy.checkFailed };
  }

  async previewFolder(
    auth: AuthContext,
    folderId: string,
    destinationProjectId: string,
  ): Promise<TransferPreview> {
    const folder = await this.deps.repos.folders.get(auth.tenant.id, folderId);
    if (!folder) throw ApiError.notFound('Folder');
    await this.requireProject(auth, destinationProjectId);
    await this.requireCreate(auth, 'folder', destinationProjectId);
    const inTree = await this.workflowsInTree(auth.tenant.id, folderId);
    const policy = await this.previewTypes(
      auth,
      destinationProjectId,
      { nodes: inTree.flatMap((w) => policyNodes(w.nodes)) },
      folderId,
    );
    const active = inTree.filter((w) => w.active);
    const stay: Array<{ id: string; name: string }> = [];
    for (const workflow of active) {
      if ((await this.previewBlockers(auth, workflow, destinationProjectId)).length) {
        stay.push({ id: workflow.id, name: workflow.name });
      }
    }
    return { restricted: policy.restricted, checkFailed: policy.checkFailed, workflowsToUnpublish: stay };
  }

  async transferWorkflow(auth: AuthContext, workflowId: string, input: WorkflowTransferInput): Promise<void> {
    const tenantId = auth.tenant.id;
    const row = await this.deps.repos.workflows.get(tenantId, workflowId);
    if (!row) throw ApiError.notFound('Workflow');
    const destination = input.destinationProjectId;
    await this.requireProject(auth, destination);
    await this.requireCreate(auth, 'workflow', destination);
    if (row.projectId === destination) throw ApiError.badRequest(SAME_WORKFLOW_DESTINATION);
    await this.requireFolder(tenantId, destination, input.destinationParentFolderId);
    const shareIds = await this.checkShareCredentials(auth, input.shareCredentials);
    // P6-51: the destination project's type policies, before the first write
    await assertTransferAllowed(this.deps, tenantId, destination, {
      kind: 'workflow',
      workflow: { nodes: policyNodes(row.nodes) },
    });

    // the version that runs now is the one that runs again (never the draft)
    const publishedVersionId = row.active ? row.publishedVersionId : null;
    await this.unpublish(auth, workflowId, publishedVersionId);
    await this.deps.database.db.transaction(async (tx) => {
      await tx
        .delete(workflowShares)
        .where(and(eq(workflowShares.tenantId, tenantId), eq(workflowShares.workflowId, workflowId)));
      await tx
        .update(workflows)
        .set({
          projectId: destination,
          folderId: input.destinationParentFolderId ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, workflowId)));
      await this.shareCredentialsInto(tx, tenantId, shareIds, destination);
      await createRepositories(tx).audit.add(tenantId, {
        userId: auth.user.id,
        action: 'workflow.transferred',
        resourceType: 'workflow',
        resourceId: workflowId,
        metadata: { from: row.projectId, to: destination },
      });
    });
    if (publishedVersionId)
      await this.tryRepublish(auth, workflowId, publishedVersionId, destination, shareIds);
  }

  async transferCredential(
    auth: AuthContext,
    credentialId: string,
    input: CredentialTransferInput,
  ): Promise<void> {
    const tenantId = auth.tenant.id;
    // P6-15: first, a private credential's move rules (personal target, `credential:createEndUser`)
    await this.deps
      .context()
      .privateCredentials.assertMovable(auth, credentialId, input.destinationProjectId);
    const row = await this.deps.repos.credentials.get(tenantId, credentialId);
    if (!row) throw ApiError.notFound('Credential');
    const destination = input.destinationProjectId;
    await this.requireProject(auth, destination);
    await this.requireCreate(auth, 'credential', destination);
    if (row.projectId === destination) throw ApiError.badRequest(SAME_CREDENTIAL_DESTINATION);
    await this.deps.context().secrets.assertProjectAccess(tenantId, destination, row.secretKeys ?? []);
    // P6-51: the destination project's type policies, before the first write
    await assertTransferAllowed(this.deps, tenantId, destination, {
      kind: 'credential',
      credentialType: row.type,
    });

    await this.deps.database.db.transaction(async (tx) => {
      await tx
        .delete(credentialShares)
        .where(and(eq(credentialShares.tenantId, tenantId), eq(credentialShares.credentialId, credentialId)));
      const repos = createRepositories(tx);
      await repos.credentials.update(tenantId, credentialId, { projectId: destination });
      await repos.audit.add(tenantId, {
        userId: auth.user.id,
        action: 'credential.transferred',
        resourceType: 'credential',
        resourceId: credentialId,
        metadata: { from: row.projectId, to: destination },
      });
    });
    // P6-15: deletes private credential entries no one can reach after the move
    await this.deps.context().privateCredentials.afterAccessChange(tenantId, { credentialId });
  }

  async transferFolder(auth: AuthContext, folderId: string, input: FolderTransferInput): Promise<void> {
    const tenantId = auth.tenant.id;
    const { repos } = this.deps;
    const folder = await repos.folders.get(tenantId, folderId);
    if (!folder) throw ApiError.notFound('Folder');
    const destination = input.destinationProjectId;
    await this.requireProject(auth, destination);
    await this.requireCreate(auth, 'folder', destination);
    if (folder.projectId === destination) throw ApiError.badRequest(SAME_FOLDER_DESTINATION);
    await this.requireFolder(tenantId, destination, input.destinationParentFolderId);
    const shareIds = await this.checkShareCredentials(auth, input.shareCredentials);

    const treeIds = await repos.folders.subtreeIds(tenantId, folderId);
    const inTree = await this.workflowsInTree(tenantId, folderId);
    // P6-51: every workflow of the tree is judged as one, in the destination project, before the first write
    await assertTransferAllowed(this.deps, tenantId, destination, {
      kind: 'workflow',
      workflow: { nodes: inTree.flatMap((w) => policyNodes(w.nodes)) },
    });
    const wasActive = inTree.flatMap((w) =>
      w.active && w.publishedVersionId ? [{ id: w.id, versionId: w.publishedVersionId }] : [],
    );
    for (const w of wasActive) await this.unpublish(auth, w.id, w.versionId);
    await this.deps.database.db.transaction(async (tx) => {
      const ids = inTree.map((w) => w.id);
      if (ids.length) {
        await tx
          .delete(workflowShares)
          .where(and(eq(workflowShares.tenantId, tenantId), inArray(workflowShares.workflowId, ids)));
        await tx
          .update(workflows)
          .set({ projectId: destination, updatedAt: new Date() })
          .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.id, ids)));
      }
      await tx
        .update(folders)
        .set({ projectId: destination, updatedAt: new Date() })
        .where(and(eq(folders.tenantId, tenantId), inArray(folders.id, treeIds)));
      await tx
        .update(folders)
        .set({ parentFolderId: input.destinationParentFolderId ?? null })
        .where(and(eq(folders.tenantId, tenantId), eq(folders.id, folderId)));
      await this.shareCredentialsInto(tx, tenantId, shareIds, destination);
      await createRepositories(tx).audit.add(tenantId, {
        userId: auth.user.id,
        action: 'folder.transferred',
        resourceType: 'folder',
        resourceId: folderId,
        metadata: { from: folder.projectId, to: destination, workflows: ids.length },
      });
    });
    for (const w of wasActive) await this.tryRepublish(auth, w.id, w.versionId, destination, shareIds);
  }

  // -------------------------------------------------------------------------------------------

  /**
   * P6-51: the node and credential types of a move that the destination project does not allow, for a
   * preview: the same decision as `assertTransferAllowed`, with no audit row and no refusal. A check that
   * fails or misses its deadline sets `checkFailed` (the lists can be incomplete).
   */
  private async previewTypes(
    auth: AuthContext,
    projectId: string,
    what: { nodes?: PolicyWorkflow['nodes']; credentialType?: string },
    subject: string,
  ): Promise<{ restricted: PolicyViolation[]; checkFailed: boolean }> {
    const tenantId = auth.tenant.id;
    const seen = new Set<string>();
    const nodeTypes: string[] = [];
    const credentialTypes: string[] = [];
    for (const node of what.nodes ?? []) {
      if (!seen.has(`node:${node.type}`)) {
        seen.add(`node:${node.type}`);
        nodeTypes.push(node.type);
      }
      for (const type of Object.keys(node.credentials ?? {})) {
        if (seen.has(`credential:${type}`)) continue;
        seen.add(`credential:${type}`);
        credentialTypes.push(type);
      }
    }
    if (what.credentialType !== undefined) credentialTypes.push(what.credentialType);
    const judge = async (kind: PolicyKind, types: string[]): Promise<RestrictedRow[]> => {
      if (types.length === 0) return [];
      const rows = await filterAvailable(this.deps, tenantId, projectId, kind, types);
      return rows
        .filter((row) => !row.available)
        .map((row) => {
          const violation: TypePolicyViolation = {
            kind: kind === 'credential' ? 'credential-type-unavailable' : 'node-type-unavailable',
            type: row.type,
            scope: row.scope ?? 'workspace',
            matchedRuleId: null,
            optInAvailable: row.optInAvailable ?? false,
          };
          return {
            kind: violation.kind,
            checkId: kind === 'credential' ? 'credentialTypePolicy' : 'nodeTypePolicy',
            // a project denial never names the project
            message: violationMessage([violation]),
            subject,
            subjectType: what.credentialType !== undefined ? 'credential' : 'workflow',
            scope: violation.scope,
            optInAvailable: violation.optInAvailable,
          };
        });
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = Promise.all([judge('node', nodeTypes), judge('credential', credentialTypes)]);
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('deadline missed')),
          ENFORCEMENT_DEADLINE_MS.workflowTransfer,
        );
        timer.unref?.();
      });
      const [nodes, credentials] = await Promise.race([work, deadline]);
      return { restricted: [...nodes, ...credentials], checkFailed: false };
    } catch (error) {
      this.deps.logger.warn(
        { tenantId, deadlineMissed: error instanceof Error && error.message === 'deadline missed' },
        'The type policy preview failed',
      );
      return { restricted: [], checkFailed: true };
    } finally {
      clearTimeout(timer);
    }
  }

  private async requireProject(auth: AuthContext, projectId: string): Promise<void> {
    if (!(await this.deps.repos.projects.get(auth.tenant.id, projectId))) throw ApiError.notFound('Project');
  }

  /** `<resource>:create` in the destination project (the route checked `:move` on the source) */
  private async requireCreate(auth: AuthContext, resource: Resource, projectId: string): Promise<void> {
    const held = await this.deps.context().access.scopesForAuth(auth, { projectId });
    if (!held.has(`${resource}:create` as Scope)) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
  }

  private async requireFolder(tenantId: string, projectId: string, folderId?: string): Promise<void> {
    if (!folderId) return;
    const folder = await this.deps.repos.folders.get(tenantId, folderId);
    if (!folder || folder.projectId !== projectId) throw ApiError.notFound('Folder');
  }

  /** each id is a credential of the workspace the caller may share; returns the unique ids */
  private async checkShareCredentials(auth: AuthContext, ids?: string[]): Promise<string[]> {
    const unique = [...new Set(ids ?? [])];
    for (const id of unique) {
      const row = await this.deps.repos.credentials.get(auth.tenant.id, id);
      if (!row) throw ApiError.notFound('Credential');
      const held = await this.deps.context().access.scopesForAuth(auth, { credentialId: id });
      if (!held.has('credential:share')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    }
    return unique;
  }

  /** adds `projectId` to the share list of each credential (its owner project needs no share) */
  private async shareCredentialsInto(
    tx: Tx,
    tenantId: string,
    credentialIds: string[],
    projectId: string,
  ): Promise<void> {
    const repos = createRepositories(tx);
    for (const id of credentialIds) {
      const row = await repos.credentials.get(tenantId, id);
      if (!row || row.projectId === projectId) continue;
      const current = (await repos.shares.credentialSharesFor(tenantId, id)).map((s) => s.projectId);
      await repos.shares.set(tenantId, 'credential', id, [...new Set([...current, projectId])]);
    }
  }

  private async workflowsInTree(tenantId: string, folderId: string): Promise<WorkflowRow[]> {
    const treeIds = await this.deps.repos.folders.subtreeIds(tenantId, folderId);
    if (!treeIds.length) return [];
    return this.deps.database.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.folderId, treeIds)));
  }

  /** the blockers of a preview: the published version of `row` is what would run again */
  private async previewBlockers(
    auth: AuthContext,
    row: WorkflowRow,
    projectId: string,
  ): Promise<PolicyViolation[]> {
    const definition = await loadPublishedDefinition(this.deps.repos, auth.tenant.id, row).catch(() => null);
    if (!definition) {
      return [
        {
          kind: 'publishing',
          checkId: 'publishedVersion',
          message: 'The published version could not be loaded',
          subject: row.id,
          subjectType: 'workflow',
          projectId,
        },
      ];
    }
    return this.republishBlockers(auth, row.id, definition, projectId, []);
  }

  /** why the published `definition` could not be published again in `projectId` once `allow` credentials are shared there */
  private async republishBlockers(
    auth: AuthContext,
    workflowId: string,
    definition: WorkflowDefinition,
    projectId: string,
    allow: string[],
  ): Promise<PolicyViolation[]> {
    const out: PolicyViolation[] = [];
    const held = await this.deps.context().access.scopesForAuth(auth, { projectId });
    if (!held.has('workflow:publish')) {
      out.push({
        kind: 'publishing',
        checkId: 'workflowPublish',
        message: 'Publishing workflows is not allowed in the destination project',
        subject: workflowId,
        subjectType: 'workflow',
        scope: 'workflow:publish',
        projectId,
      });
    }
    try {
      await assertCredentialsUsable({ repos: this.deps.repos }, auth.tenant.id, projectId, definition, {
        allow,
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      out.push({
        kind: 'credentialAccess',
        checkId: 'credentialUsable',
        message: error.message,
        subject: workflowId,
        subjectType: 'workflow',
        projectId,
      });
    }
    return out;
  }

  /** unpublishes before a move; the timeline gets the 'deactivated' event as a publish would */
  private async unpublish(auth: AuthContext, workflowId: string, versionId: string | null): Promise<void> {
    const context = this.deps.context();
    await context.activeWorkflows.deactivate(auth.tenant.id, workflowId);
    if (!versionId) return;
    await context.publishHistory.record('deactivated', {
      tenantId: auth.tenant.id,
      workflowId,
      versionId,
      userId: auth.user.id,
    });
  }

  /**
   * Publishes `versionId` (the version that was published before the move, not the draft) again after a
   * move; a refusal leaves the workflow unpublished. A success goes on the timeline and the audit log.
   */
  private async tryRepublish(
    auth: AuthContext,
    workflowId: string,
    versionId: string,
    projectId: string,
    allow: string[],
  ): Promise<void> {
    const tenantId = auth.tenant.id;
    const { repos, logger } = this.deps;
    const row = await repos.workflows.get(tenantId, workflowId);
    const version = row ? await repos.versions.get(tenantId, workflowId, versionId) : null;
    if (!row || !version) return;
    const definition = publishedDefinition(row, version);
    if ((await this.republishBlockers(auth, workflowId, definition, projectId, allow)).length) return;
    const context = this.deps.context();
    try {
      await context.activeWorkflows.activate(tenantId, workflowId, { versionId });
    } catch (error) {
      logger.info({ err: error, workflowId }, 'The workflow stays unpublished after the move');
      await context.activeWorkflows.deactivate(tenantId, workflowId).catch(() => undefined);
      return;
    }
    await context.publishHistory.record('activated', {
      tenantId,
      workflowId,
      versionId,
      userId: auth.user.id,
    });
    await repos.audit.add(tenantId, {
      userId: auth.user.id,
      action: 'workflow.activated',
      resourceType: 'workflow',
      resourceId: workflowId,
      metadata: { versionId, reason: 'transfer' },
    });
  }
}
