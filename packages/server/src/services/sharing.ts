/**
 * Sharing (P6-29, L9): PUT /workflows/:id/share and /credentials/:id/share with `shareWithIds`, the full
 * list of sharee project ids. Adding needs `<resource>:share`, removing `<resource>:unshare`, each checked
 * on the row for the change the list makes; new shares get `workflow:editor` and `credential:user`
 * (`repos.shares`). A sharee project runs a shared workflow and uses a shared credential but cannot
 * delete, move or share them (the share role masks the project role). The owner's own project in the
 * list is not a share; another workspace's project is 404.
 */
import type { Scope } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { createRepositories } from '../repositories';
import type { ShareKind } from '../repositories/shares';
import { type AccessTarget, MISSING_SCOPE_MESSAGE } from './access';
import { credentialShared, workflowShared } from './share-mails';

/** what a share write changed: the sharee projects added and removed */
interface ShareChange {
  added: string[];
  removed: string[];
}

export class SharingService {
  constructor(readonly deps: ServiceDeps) {}

  async shareWorkflow(auth: AuthContext, workflowId: string, shareWithIds: string[]): Promise<void> {
    const workflow = await this.deps.repos.workflows.get(auth.tenant.id, workflowId);
    if (!workflow) throw ApiError.notFound('Workflow');
    const change = await this.apply(auth, 'workflow', workflow.id, workflow.projectId, shareWithIds);
    // P6-17 (C0): stub (L1) PASSES
    if (change.added.length) {
      await workflowShared(this.deps, auth.tenant.id, auth.user.id, workflow.id, change.added);
    }
  }

  async shareCredential(auth: AuthContext, credentialId: string, shareWithIds: string[]): Promise<void> {
    const credential = await this.deps.repos.credentials.get(auth.tenant.id, credentialId);
    if (!credential) throw ApiError.notFound('Credential');
    const change = await this.apply(auth, 'credential', credential.id, credential.projectId, shareWithIds);
    // P6-17 (C0): stub (L1) PASSES
    if (change.added.length) {
      await credentialShared(this.deps, auth.tenant.id, auth.user.id, credential.id, change.added);
    }
    // P6-15 (C0): entries of users who lost the credential go; stub (L14) PASSES
    if (change.removed.length) {
      await this.deps.context().privateCredentials.afterAccessChange(auth.tenant.id, {
        credentialId: credential.id,
      });
    }
  }

  private async apply(
    auth: AuthContext,
    kind: ShareKind,
    resourceId: string,
    ownerProjectId: string,
    shareWithIds: string[],
  ): Promise<ShareChange> {
    const tenantId = auth.tenant.id;
    const { repos } = this.deps;
    const wanted = [...new Set(shareWithIds)].filter((id) => id !== ownerProjectId);
    for (const projectId of wanted) {
      if (!(await repos.projects.get(tenantId, projectId))) throw ApiError.notFound('Project');
    }
    const target: AccessTarget =
      kind === 'workflow' ? { workflowId: resourceId } : { credentialId: resourceId };
    // one transaction with the resource row locked: the shares the scopes are checked against are the
    // shares the write changes
    return this.deps.database.db.transaction(async (tx): Promise<ShareChange> => {
      const txRepos = createRepositories(tx);
      if (!(await txRepos.shares.lockResource(tenantId, kind, resourceId))) {
        throw ApiError.notFound(kind === 'workflow' ? 'Workflow' : 'Credential');
      }
      const current = (
        kind === 'workflow'
          ? await txRepos.shares.workflowSharesFor(tenantId, resourceId)
          : await txRepos.shares.credentialSharesFor(tenantId, resourceId)
      ).map((share) => share.projectId);
      const added = wanted.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !wanted.includes(id));
      const adds = added.length > 0;
      const removes = removed.length > 0;
      if (!adds && !removes) return { added, removed };

      const held = await this.deps.context().access.scopesForAuth(auth, target);
      const needed: Scope[] = [];
      if (adds) needed.push(`${kind}:share` as Scope);
      if (removes) needed.push(`${kind}:unshare` as Scope);
      if (!needed.every((scope) => held.has(scope))) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);

      await txRepos.shares.set(tenantId, kind, resourceId, wanted);
      return { added, removed };
    });
  }
}
