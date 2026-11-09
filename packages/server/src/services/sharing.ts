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
import type { ShareKind } from '../repositories/shares';
import { type AccessTarget, MISSING_SCOPE_MESSAGE } from './access';

export class SharingService {
  constructor(readonly deps: ServiceDeps) {}

  async shareWorkflow(auth: AuthContext, workflowId: string, shareWithIds: string[]): Promise<void> {
    const workflow = await this.deps.repos.workflows.get(auth.tenant.id, workflowId);
    if (!workflow) throw ApiError.notFound('Workflow');
    await this.apply(auth, 'workflow', workflow.id, workflow.projectId, shareWithIds);
  }

  async shareCredential(auth: AuthContext, credentialId: string, shareWithIds: string[]): Promise<void> {
    const credential = await this.deps.repos.credentials.get(auth.tenant.id, credentialId);
    if (!credential) throw ApiError.notFound('Credential');
    await this.apply(auth, 'credential', credential.id, credential.projectId, shareWithIds);
  }

  private async apply(
    auth: AuthContext,
    kind: ShareKind,
    resourceId: string,
    ownerProjectId: string,
    shareWithIds: string[],
  ): Promise<void> {
    const tenantId = auth.tenant.id;
    const { repos } = this.deps;
    const wanted = [...new Set(shareWithIds)].filter((id) => id !== ownerProjectId);
    for (const projectId of wanted) {
      if (!(await repos.projects.get(tenantId, projectId))) throw ApiError.notFound('Project');
    }
    const current = (
      kind === 'workflow'
        ? await repos.shares.workflowSharesFor(tenantId, resourceId)
        : await repos.shares.credentialSharesFor(tenantId, resourceId)
    ).map((share) => share.projectId);
    const adds = wanted.some((id) => !current.includes(id));
    const removes = current.some((id) => !wanted.includes(id));
    if (!adds && !removes) return;

    const target: AccessTarget = kind === 'workflow' ? { workflowId: resourceId } : { credentialId: resourceId };
    const held = await this.deps.context().access.scopesForAuth(auth, target);
    const needed: Scope[] = [];
    if (adds) needed.push(`${kind}:share` as Scope);
    if (removes) needed.push(`${kind}:unshare` as Scope);
    if (!needed.every((scope) => held.has(scope))) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);

    await repos.shares.set(tenantId, kind, resourceId, wanted);
  }
}
